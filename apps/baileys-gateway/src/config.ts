/**
 * Gateway configuration resolution.
 *
 * Split out from `index.ts` because that file calls `main()` at import time, so
 * anything it exports is only reachable by booting a server. Resolving config is
 * pure and worth testing on its own: the "configured vs idling" decision is what
 * an operator debugs from a Render log, and getting it wrong looks exactly like
 * a working service that serves nothing.
 *
 * Two sources, in order:
 *
 *  1. `gateway-config.json`, for many clinics. Gitignored, since it names
 *     service-account paths and phone numbers.
 *  2. A single clinic from environment variables, for platform hosts where a
 *     config file is awkward to mount and a key on disk is a secret to avoid.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSmsConfig, type SmsConfig } from './sms.js';

export interface ClinicConfig {
  clinicId: string;
  projectId: string;
  /**
   * Service-account JSON for this clinic's Firebase project.
   *
   * Empty means "use the ambient credential" - `GOOGLE_APPLICATION_CREDENTIALS`
   * or the platform metadata service - which is the normal case when the clinic
   * came from environment variables.
   */
  serviceAccountPath: string;
  /** WhatsApp number of the clinic, digits only, for pairing. */
  phoneNumber: string;
  /** Directory where the Baileys session persists. */
  sessionDir: string;
  /** Optional per-clinic SMS fallback (Twilio). Falls back to env when absent. */
  sms?: SmsConfig;
}

export interface GatewayConfig {
  clinics: ClinicConfig[];
  /** Process-wide SMS fallback (Twilio); env vars (TWILIO_*) win when both are set. */
  sms?: SmsConfig;
}

/** Where the config came from, so the boot log can say which file was read. */
export interface LoadedConfig {
  config: GatewayConfig;
  source: string;
  /** True when nothing configured any clinic and the gateway is idling. */
  unconfigured: boolean;
  /** Env names for a partially set env clinic, so the log can name them. */
  missingEnv: string[];
}

/** Directory of the config module, so a deployed bundle finds its sibling files. */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Config file candidates, most specific first.
 *
 * `gateway-config.json` is gitignored on purpose: it names service-account
 * paths and clinic phone numbers, so it is filled in per environment rather
 * than committed. The example is checked second so a container that only
 * carries the tracked files still boots, and `../..` covers the repo-root
 * relative layout used by local `npm run dev` from the monorepo root.
 */
export function candidatePaths(env: NodeJS.ProcessEnv): string[] {
  const explicit = env.GATEWAY_CONFIG?.trim();
  if (explicit) return [resolve(explicit)];
  return [
    resolve('gateway-config.json'),
    resolve(here, '../gateway-config.json'),
    resolve(here, '../gateway-config.example.json'),
    resolve('../../gateway-config.json'),
    resolve('../../gateway-config.example.json'),
  ];
}

function readConfigFile(path: string): GatewayConfig {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GatewayConfig> | null;
  if (!parsed || typeof parsed !== 'object') return { clinics: [] };
  // Default first so a file with no `clinics` key is treated as empty rather
  // than leaving the field undefined for callers to trip over.
  return { ...parsed, clinics: Array.isArray(parsed.clinics) ? parsed.clinics : [] };
}

/**
 * A template clinic is not a configured clinic.
 *
 * The shipped example is full of `your-firebase-project-id`-style values, and
 * treating one as real would take the gateway down inside Firebase init instead
 * of idling with an explanation. This is why an untouched example config
 * reports "no clinics configured" rather than a Firebase error.
 */
export function isPlaceholderClinic(clinic: ClinicConfig): boolean {
  // `serviceAccountPath` is excluded from the empty check on purpose. It is
  // optional and empty means "use the ambient credential", so a clinic
  // configured from environment variables always has it empty. Including it
  // here would filter out every env-configured clinic and the gateway would
  // idle forever while claiming it had no configuration.
  const required = [clinic.clinicId, clinic.projectId, clinic.phoneNumber];
  return required.some((value) => {
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

/** Env var name -> the clinic field it supplies, for the single-clinic env path. */
export const ENV_CLINIC_FIELDS = [
  { env: 'GATEWAY_CLINIC_ID', field: 'clinicId' },
  { env: 'GATEWAY_PROJECT_ID', field: 'projectId' },
  { env: 'GATEWAY_PHONE_NUMBER', field: 'phoneNumber' },
] as const satisfies readonly { env: string; field: keyof ClinicConfig }[];

/**
 * Single clinic from environment variables, or null with the names still missing.
 *
 * All of the identity fields are required together. A partial set is reported
 * as absent rather than half-configured, so the gateway either runs a complete
 * clinic or idles while naming exactly which variable to set - the failure an
 * operator actually hits on a platform host.
 */
export function envClinic(env: NodeJS.ProcessEnv): { clinic: ClinicConfig | null; missing: string[] } {
  const values = new Map<string, string>();
  const missing: string[] = [];
  for (const { env: name, field } of ENV_CLINIC_FIELDS) {
    const value = env[name]?.trim();
    if (value) values.set(field, value);
    else missing.push(name);
  }
  if (missing.length > 0) return { clinic: null, missing };

  // Optional: Firebase Admin finds credentials from GOOGLE_APPLICATION_CREDENTIALS
  // or its own metadata service, so a path is only needed when the key sits at
  // a non-standard place.
  const serviceAccountPath = env.GATEWAY_SERVICE_ACCOUNT_PATH?.trim();
  const clinicId = values.get('clinicId') as string;

  const clinic: ClinicConfig = {
    clinicId,
    projectId: values.get('projectId') as string,
    serviceAccountPath: serviceAccountPath || '',
    phoneNumber: values.get('phoneNumber') as string,
    sessionDir: env.GATEWAY_SESSION_DIR?.trim() || resolve('sessions', clinicId),
  };
  return { clinic, missing: [] };
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
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const explicit = env.GATEWAY_CONFIG?.trim();
  const found = candidatePaths(env).find((p) => existsSync(p));

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

  // Env clinic applies when the file supplied nothing, and also overrides a
  // same-id file entry, so an operator can move to env without deleting a file
  // first. Env wins: it is the deliberate platform setting.
  const { clinic: fromEnv, missing } = envClinic(env);
  if (fromEnv) {
    const merged = [...config.clinics.filter((c) => c.clinicId !== fromEnv.clinicId), fromEnv];
    config = { ...config, clinics: merged };
    source = `${source} + env clinic ${fromEnv.clinicId}`;
  }

  if (config.clinics.length === 0) {
    return { config, source, unconfigured: true, missingEnv: missing };
  }

  // Env wins over the file so secrets can come from the platform, not disk.
  const envSms = loadSmsConfig(env);
  const fallbackSms = envSms ?? config.sms ?? null;
  if (fallbackSms) {
    // Process-wide default, then let each clinic opt out or override.
    config = {
      ...config,
      sms: fallbackSms,
      clinics: config.clinics.map((clinic) => ({ ...clinic, sms: clinic.sms ?? fallbackSms })),
    };
  }

  return { config, source, unconfigured: false, missingEnv: [] };
}
