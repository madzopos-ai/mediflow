/**
 * SMS fallback for the WhatsApp gateway (e.g. Twilio).
 *
 * WhatsApp delivery can fail for reasons outside our control: the session is
 * logged out, the phone is offline, or Meta throttles the number. For routine
 * chatter a parked `failed` row is acceptable. For safety-critical traffic -
 * patient access codes and high-priority reminders (critical vitals,
 * appointment/medication reminders) - a silent failure is a patient-safety
 * failure, so the gateway falls back to SMS instead of parking the row.
 *
 * No new runtime dependency: the Twilio Messages API is plain HTTPS + Basic
 * auth, called with the global `fetch` and an explicit timeout. Any other
 * provider with an HTTPS API can implement the same `sendSms` signature.
 *
 * Configuration (per gateway process, env vars or gateway-config.json `sms`
 * block): TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER.
 * When unconfigured, `isSmsConfigured()` is false and the gateway keeps the
 * old behaviour (park as `failed` after MAX_ATTEMPTS).
 */

export interface SmsConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export function loadSmsConfig(env: NodeJS.ProcessEnv = process.env): SmsConfig | null {
  const accountSid = (env.TWILIO_ACCOUNT_SID ?? '').trim();
  const authToken = (env.TWILIO_AUTH_TOKEN ?? '').trim();
  const fromNumber = (env.TWILIO_FROM_NUMBER ?? '').trim();
  if (!accountSid || !authToken || !fromNumber) return null;
  return { accountSid, authToken, fromNumber };
}

export function isSmsConfigured(config: SmsConfig | null): boolean {
  return config !== null;
}

/**
 * Templates that must never fail silently. `access_code` rows are written by
 * the API when the clinic onboards a patient by SMS-capable channel; the rest
 * are the safety-critical / time-sensitive WhatsApp templates.
 */
const HIGH_PRIORITY_TEMPLATES = new Set([
  'access_code',
  'access-code',
  'vitals_critical_alert',
  'appointment_reminder',
  'medication_schedule',
  'followup_checkin',
  'waitlist_slot_offer',
]);

export function isHighPriority(template: string | null | undefined, priority?: string | null): boolean {
  if (priority === 'high' || priority === 'urgent') return true;
  if (!template) return false;
  return HIGH_PRIORITY_TEMPLATES.has(template);
}

export async function sendSms(config: SmsConfig, to: string, body: string): Promise<string | null> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`;
  const credentials = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
  const params = new URLSearchParams({ To: to, From: config.fromNumber, Body: body });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${credentials}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Twilio ${response.status}: ${text.slice(0, 200)}`);
    }
    const parsed = (await response.json()) as { sid?: string };
    return typeof parsed.sid === 'string' ? parsed.sid : null;
  } finally {
    clearTimeout(timer);
  }
}
