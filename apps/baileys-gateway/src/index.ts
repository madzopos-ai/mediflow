/**
 * Baileys gateway entry point.
 *
 * One long-lived process per reseller server, serving every clinic from a
 * single place. Each clinic keeps its own WhatsApp session (pair once, the
 * credentials persist in its session directory) and its own Firestore outbox;
 * this process drains `queued` rows and routes inbound messages back into
 * threads.
 *
 * Configuration is resolved in `config.ts`, from a `gateway-config.json` file
 * for many clinics or from environment variables for a single clinic.
 *
 * Run: `npm run dev --workspace @mediflow/baileys-gateway`
 */

import { runClinic } from './clinic.js';
import { startServer, type HealthState } from './http.js';
import { SessionRegistry } from './registry.js';
import { ENV_CLINIC_FIELDS, loadConfig } from './config.js';

export type { ClinicConfig, GatewayConfig, LoadedConfig } from './config.js';
export { ENV_CLINIC_FIELDS, envClinic, loadConfig } from './config.js';

/**
 * Holds the process open when no clinic is configured.
 *
 * A gateway that exits 0 immediately looks like a crash to a platform host and
 * gets restarted in a loop, and to an operator it looks like the service is
 * running. Staying up with an explicit log line is the honest middle: the
 * process is alive, serving nothing, and says so on every boot.
 *
 * The health server's listening socket is what actually keeps the event loop
 * alive here, which is the honest way to do it: we are not holding the process
 * open on an inert timer, we are up because something is genuinely listening.
 */
function idle(): Promise<void> {
  return new Promise(() => {
    // Intentionally never resolves. The open listener above keeps the loop
    // running; this promise just parks `main` so it does not fall through.
  });
}

/**
 * Explains an idle gateway in terms the operator can act on.
 *
 * "No clinics configured" on its own sent someone looking for a clinic to add.
 * Naming the exact env vars, and which of them are present but incomplete,
 * turns a dead end into a two-minute fix.
 */
function idleReport(missingEnv: string[]): string {
  const envNames = ENV_CLINIC_FIELDS.map((f) => f.env).join(', ');
  const partial = missingEnv.length > 0 && missingEnv.length < ENV_CLINIC_FIELDS.length;
  return (
    'Gateway has no clinics configured. Idling.\n' +
    `  For one clinic, set all three of: ${envNames}\n` +
    '  For several, set GATEWAY_CONFIG to a gateway-config.json path, or copy ' +
    'gateway-config.example.json to gateway-config.json and fill it in.\n' +
    (partial ? `  Env clinic is partially set, still missing: ${missingEnv.join(', ')}\n` : '') +
    '  Queued outbox messages are kept in Firestore and will be sent once a clinic is configured.\n'
  );
}

async function main(): Promise<void> {
  // Bind before reading the config so a slow, missing, or unconfigured file
  // still leaves the port open. If loadConfig throws afterwards the process
  // exits and the deploy fails loudly, which is correct for a real config error
  // - but "no config yet" must never look like a dead service.
  const registry = new SessionRegistry();
  const health: HealthState = { configured: false, clinicCount: 0, source: 'starting' };
  const server = startServer({
    health,
    registry,
    adminToken: process.env.GATEWAY_ADMIN_TOKEN?.trim() || null,
    env: process.env,
  });

  const { config, source, unconfigured, missingEnv } = loadConfig();
  health.configured = !unconfigured;
  health.clinicCount = config.clinics.length;
  health.source = source;

  // Declare every clinic up front so the pairing UI can list them and show
  // `pending`, even for a clinic whose socket has not come up yet or whose
  // service-account key is missing.
  for (const clinic of config.clinics) {
    registry.declare(clinic.clinicId, clinic.phoneNumber);
  }

  if (unconfigured) {
    process.stdout.write(idleReport(missingEnv));
    await idle();
    return;
  }

  process.stdout.write(`Starting gateway for ${config.clinics.length} clinic(s) from ${source}.\n`);

  // Each clinic runs independently: one clinic's logout or network drop must
  // never take the others down with it. A rejected runClinic is logged and
  // does not end the process, so the surviving clinics keep draining.
  await Promise.all(
    config.clinics.map((clinic) =>
      runClinic(clinic, registry).catch((error: unknown) => {
        registry.patch(clinic.clinicId, {
          state: 'error',
          lastError: error instanceof Error ? error.message : String(error),
        });
        process.stderr.write(
          `[${clinic.clinicId}] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }),
    ),
  );

  // Every clinic loop is infinite, so this is unreachable in practice. If all of
  // them ever did settle, keep the HTTP surface up rather than exiting 0 into a
  // restart loop with the port already closed.
  await new Promise<void>((resolve) => {
    server.once('close', resolve);
  });
}

void main();
