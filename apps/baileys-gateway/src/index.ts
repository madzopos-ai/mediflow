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

import { readFileSync } from 'node:fs';

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

function loadConfig(): GatewayConfig {
  const path = process.env.GATEWAY_CONFIG ?? './gateway-config.json';
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as GatewayConfig;
  if (!Array.isArray(parsed.clinics) || parsed.clinics.length === 0) {
    throw new Error(`No clinics in ${path}. Copy gateway-config.example.json first.`);
  }
  // Env wins over the file so secrets can come from the platform, not disk.
  const envSms = loadSmsConfig();
  const fallbackSms = envSms ?? parsed.sms ?? null;
  if (fallbackSms) {
    for (const clinic of parsed.clinics) {
      if (!clinic.sms) clinic.sms = fallbackSms;
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  const config = loadConfig();
  process.stdout.write(`Starting gateway for ${config.clinics.length} clinic(s).\n`);
  // Each clinic runs independently: one clinic's logout or network drop must
  // never take the others down with it.
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
