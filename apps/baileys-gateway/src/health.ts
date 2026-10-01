/**
 * Health endpoint for the platform host.
 *
 * Render (and most PaaS providers) treat a service as failed when nothing is
 * listening on the port: the deploy is a worker by nature, so it has no HTTP
 * surface of its own and the port scan times out. A tiny listener answers the
 * scan and doubles as a real readiness probe.
 *
 * It binds before the config is even read, so an unconfigured or partly
 * configured gateway still answers `/health` and the deploy is judged on the
 * process being up rather than on whether WhatsApp is paired yet. That is the
 * right split: a gateway with no clinic is a valid, idle state.
 *
 * Node's own `http` is used rather than Express. This is one static JSON route
 * in a service whose only other dependency is a WhatsApp library, and Express
 * would add roughly sixty transitive packages for no behaviour we need.
 */

import { createServer, type Server, type ServerResponse } from 'node:http';

export interface HealthState {
  /** True once the config has been read and the clinics are running. */
  configured: boolean;
  clinicCount: number;
  /** Where the config came from, for diagnosing a mis-set GATEWAY_CONFIG. */
  source: string;
}

const DEFAULT_PORT = 10_000;

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    // content-length must be a string; a number serialises but the type is strict.
    'content-length': String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

/**
 * Starts the health listener.
 *
 * `0.0.0.0` is deliberate: a server bound to loopback is unreachable from
 * outside the container, which is indistinguishable from not listening at all
 * and produces exactly the port-scan timeout this replaces.
 */
export function startHealthServer(state: HealthState, env: NodeJS.ProcessEnv = process.env): Server {
  const raw = env.PORT?.trim();
  const port = raw ? Number(raw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`PORT is not a valid port number: ${JSON.stringify(raw)}`);
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/health' || path === '/healthz') {
      // `ok` means the process is up, which is the only thing a port scan can
      // actually verify. Clinic state is reported alongside it rather than
      // folded into the status, so a correctly-idle gateway still reads `ok`
      // instead of looking like a failed deploy.
      json(res, 200, { status: 'ok', configured: state.configured, clinics: state.clinicCount });
      return;
    }
    if (path === '/') {
      json(res, 200, { status: 'ok', service: 'mediflow-baileys-gateway', configured: state.configured, clinics: state.clinicCount });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });

  // A bind failure is a real deployment error (usually a taken port), and
  // swallowing it would put us straight back to a silent port-scan timeout.
  server.on('error', (error: unknown) => {
    process.stderr.write(`health server error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });

  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`Health endpoint listening on 0.0.0.0:${port} (/health)\n`);
  });

  return server;
}
