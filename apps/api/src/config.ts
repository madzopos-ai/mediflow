/**
 * Runtime configuration.
 *
 * Secrets are read once, validated, and never logged. A weak or missing
 * JWT secret is a fatal boot error rather than a warning: a server that starts
 * with a guessable signing key would silently accept forged tokens.
 */

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  host: string;
  port: number;
  databaseFile: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  corsOrigins: string[];
  whatsappProvider: 'simulator' | 'cloud' | 'baileys';
  whatsappCloudToken: string | null;
  whatsappCloudPhoneNumberId: string | null;
  baileysSessionDir: string;
  /** Base URL of the Baileys gateway, for pairing endpoints. Null when unset. */
  gatewayUrl: string | null;
  /**
   * The gateway's admin token.
   *
   * It lives only here, never in the browser bundle: the token grants access to
   * every clinic's pairing material on the gateway, so shipping it to clients
   * would let any signed-in user read another clinic's QR. The API proxies the
   * call and scopes it to the caller's own clinic.
   */
  gatewayAdminToken: string | null;
  publicBookingEnabled: boolean;
  defaultTimezone: string;
  reminderWorkerEnabled: boolean;
  workerIntervalMs: number;
  encryptionKey: string;
  maxUploadBytes: number;
  logLevel: string;
}

export class ConfigError extends Error {}

function required(name: string, value: string | undefined, minLength = 32): string {
  if (!value || value.length < minLength) {
    throw new ConfigError(
      `${name} is missing or shorter than ${minLength} characters. ` +
        'Set it in the environment before starting the server.',
    );
  }
  return value;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(`${name} must be an integer.`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = (env.NODE_ENV ?? 'development') as Config['nodeEnv'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new ConfigError('NODE_ENV must be development, test, or production.');
  }
  const isProduction = nodeEnv === 'production';

  // A fixed development secret keeps `npm run dev` frictionless, but it is
  // rejected outright in production.
  const jwtSecret = isProduction
    ? required('JWT_SECRET', env.JWT_SECRET)
    : env.JWT_SECRET || 'dev-only-insecure-secret-do-not-use-in-production';

  if (isProduction && jwtSecret.includes('dev-only-insecure')) {
    throw new ConfigError('JWT_SECRET still holds the development default.');
  }

  const encryptionKey = isProduction
    ? required('ENCRYPTION_KEY', env.ENCRYPTION_KEY)
    : env.ENCRYPTION_KEY || 'dev-only-encryption-key-32-bytes!!';

  const provider = (env.WHATSAPP_PROVIDER ?? 'simulator') as Config['whatsappProvider'];
  if (!['simulator', 'cloud', 'baileys'].includes(provider)) {
    throw new ConfigError('WHATSAPP_PROVIDER must be simulator, cloud, or baileys.');
  }
  if (isProduction && provider === 'simulator') {
    throw new ConfigError('WHATSAPP_PROVIDER=simulator is not allowed in production.');
  }

  return {
    nodeEnv,
    isProduction,
    host: env.HOST ?? '0.0.0.0',
    port: int('PORT', env.PORT, 4000),
    databaseFile: env.DATABASE_FILE ?? './data/mediflow.db',
    jwtSecret,
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? '12h',
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    whatsappProvider: provider,
    whatsappCloudToken: env.WHATSAPP_CLOUD_TOKEN ?? null,
    whatsappCloudPhoneNumberId: env.WHATSAPP_CLOUD_PHONE_NUMBER_ID ?? null,
    baileysSessionDir: env.BAILEYS_SESSION_DIR ?? './data/baileys',
    gatewayUrl: (env.GATEWAY_URL ?? '').trim().replace(/\/+$/, '') || null,
    gatewayAdminToken: (env.GATEWAY_ADMIN_TOKEN ?? '').trim() || null,
    publicBookingEnabled: bool(env.PUBLIC_BOOKING_ENABLED, true),
    defaultTimezone: env.DEFAULT_TIMEZONE ?? 'UTC',
    reminderWorkerEnabled: bool(env.REMINDER_WORKER_ENABLED, !isProduction),
    workerIntervalMs: int('REMINDER_WORKER_INTERVAL_MS', env.REMINDER_WORKER_INTERVAL_MS, 30_000),
    encryptionKey,
    maxUploadBytes: int('MAX_UPLOAD_BYTES', env.MAX_UPLOAD_BYTES, 15 * 1024 * 1024),
    logLevel: env.LOG_LEVEL ?? (isProduction ? 'info' : 'warn'),
  };
}
