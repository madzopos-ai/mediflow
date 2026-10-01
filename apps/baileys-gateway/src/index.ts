/**
 * Baileys gateway entry point.
 *
 * One long-lived process per reseller server, serving every clinic from a
 * single place. Each clinic keeps its own WhatsApp session (pair once, the
 * credentials persist in its session directory) and its own Firestore outbox;
 * this process drains `queued` rows and routes inbound messages back into
 * threads.
 *
 * Configuration lives in one JSON file (see gateway-config.example.json):
 * which clinics, which Firebase project each belongs to, and where the
 * service-account keys and session directories are.
 *
 * Run: `npm run dev --workspace @mediflow/baileys-gateway`
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runClinic } from './clinic.js';
import { loadSmsConfig, type SmsConfig } from './sms.js';

export interface ClinicConfig {
  clinicId: string;
  projectId: string;
  /** Service-account JSON for this clinic's Firebase project. */
  serviceAccountPath: string;
  /** WhatsApp number of the clinic, digits only, for pairing. */
  phoneNumber: string;
  /** Directory where the Baileys session persists. */
  sessionDir: string;
  /** Optional per-clinic SMS fallback (Twilio). Falls back to env when absent. */
  sms?: SmsConfig;
}

interface GatewayConfig {
  clinics: ClinicConfig[];
  /** Process-wide SMS fallback; env vars (TWILIO_*) win when both are set. */
  sms?: SmsConfig;
}

/** Where the config came from, so the boot log can say which file was read. */
interface LoadedConfig {
  config: GatewayConfig;
  source: string;
  /** True when nothing configured any clinic and the gateway is idling. */
  unconfigured: boolean;
}

/** Directory of this module, so a deployed bundle finds its sibling files. */
const here = dirname(fileURLToPath(import.meta.url));

/** Keeps the idle loop referenced so the interval is not collected. */
const IDLE_TICK_MS = 1 << 30;

/**
 * Config file candidates, most specific first.
 *
 * `gateway-config.json` is gitignored on purpose: it names service-account
 * paths and clinic phone numbers, so it is filled in per environment rather
 * than committed. The example is checked second so a container that only
 * carries the tracked files still boots, and `../..` covers the repo-root
 * relative layout used by local `npm run dev` from the monorepo root.
 */
function candidatePaths(env: NodeJS.ProcessEnv): string[] {
  const explicit = env.GATEWAY_CONFIG?.trim();
  if (explicit) return [resolve(explicit)];
  return [
    resolve('gateway-config.json'),
    resolve(here, '../gateway-config.json'),
    resolve('gateway-config.example.json'),
    resolve(here, '../gateway-config.example.json'),
    resolve('../../gateway-config.json'),
    resolve('../../gateway-config.example.json'),
  ];
}

function readConfigFile(path: string): GatewayConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as GatewayConfig;
}

/**
 * Whether a clinic entry is real or still the example's placeholder.
 *
 * Falling back to `gateway-config.example.json` is only safe if its clinic is
 * recognised as a template. Without this check the gateway would treat
 * "your-firebase-project-id" as a project, fail to initialise Firebase, and
 * exit on a config error that reads like a credential problem. Idling with a
 * clear log is the honest state for a copy-paste template.
 */
function isPlaceholderClinic(clinic: ClinicConfig): boolean {
  const fields = [clinic.clinicId, clinic.projectId, clinic.serviceAccountPath, clinic.phoneNumber];
  return fields.some((value) => {
    const text = String(value ?? '').toLowerCase();
    return (
      text.length === 0 ||
      text.includes('your-') ||
      text.includes('your_') ||
      text.includes('xxxx') ||
      text.includes('example') ||
      text.includes('placeholder') ||
      text.includes('changeme')
    );
  });
}

/**
 * Resolves the gateway config, degrading instead of throwing.
 *
 * A missing or empty config used to be a hard throw, which crashed the process
 * on boot. That is the wrong failure mode for a platform host: a deploy with no
 * WhatsApp gateway yet should stay up and idle, so the rest of the stack keeps
 * serving and the gateway can pick up its config on the next restart. Queued
 * outbox rows are not lost - they stay `queued` in Firestore and drain as soon
 * as a clinic is configured.
 *
 * An explicit `GATEWAY_CONFIG` that does not exist still throws: that is a
 * deliberate operator setting, and silently ignoring it would hide a typo
 * behind an idle process.
 */
function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const explicit = env.GATEWAY_CONFIG?.trim();
  const paths = candidatePaths(env);
  const found = paths.find((p) => existsSync(p));

  let config: GatewayConfig = { clinics: [] };
  let source = 'defaults (no config file)';

  if (found) {
    config = readConfigFile(found);
    source = found;
    if (!Array.isArray(config.clinics)) config.clinics = [];
  } else if (explicit) {
    throw new Error(`GATEWAY_CONFIG points at ${explicit}, which does not exist.`);
  }

  // A template clinic is not a configured clinic: report it as unconfigured so
  // the gateway idles with instructions rather than failing Firebase init.
  const usable = config.clinics.filter((clinic) => !isPlaceholderClinic(clinic));
  if (usable.length !== config.clinics.length) {
    config = { ...config, clinics: usable };
  }

  if (config.clinics.length === 0) {
    return { config, source, unconfigured: true };
  }

  // Env wins over the file so secrets can come from the platform, not disk.
  const envSms = loadSmsConfig(env);
  const fallbackSms = envSms ?? config.sms ?? null;
  if (fallbackSms) {
    for (const clinic of config.clinics) {
      if (!clinic.sms) clinic.sms = fallbackSms;
    }
  }
  return { config, source, unconfigured: false };
}

/**
 * Holds the process open when no clinic is configured.
 *
 * A gateway that exits 0 immediately looks like a crash to a platform host and
 * gets restarted in a loop, and to an operator it looks like the service is
 * running. Staying up with an explicit log line is the honest middle: the
 * process is alive, serving nothing, and says so on every boot.
 *
 * The hold is a real timer rather than a never-resolving promise on purpose: a
 * pending promise does not keep the Node event loop alive, so with nothing else
 * scheduled the process would drain its queue and exit 0 anyway - the exact
 * crash-loop this is meant to avoid.
 */
function idle(): Promise<void> {
  return new Promise(() => {
    setInterval(() => {}, IDLE_TICK_MS);
  });
}

async function main(): Promise<void> {
  const { config, source, unconfigured } = loadConfig();

  if (unconfigured) {
    process.stdout.write(
      'Gateway has no clinics configured. Idling.\n' +
        '  Set GATEWAY_CONFIG, or copy gateway-config.example.json to gateway-config.json and fill it in.\n' +
        '  Queued outbox messages are kept in Firestore and will be sent once a clinic is configured.\n',
    );
    await idle();
    return;
  }

  process.stdout.write(
    `Starting gateway for ${config.clinics.length} clinic(s) from ${source}.\n`,
  );

  // Each clinic runs independently: one clinic's logout or network drop must
  // never take the others down with it. A rejected runClinic is logged and
  // does not end the process, so the surviving clinics keep draining.
  await Promise.all(
    config.clinics.map((clinic) =>
      runClinic(clinic).catch((error: unknown) => {
        process.stderr.write(
          `[${clinic.clinicId}] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }),
    ),
  );
}

void main();
