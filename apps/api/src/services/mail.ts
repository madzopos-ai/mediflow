/**
 * Outbound email, for password resets.
 *
 * Deliberately dependency-free: a small SMTP client over `node:net` and
 * `node:tls`, driven entirely by environment variables. Adding nodemailer for
 * one transactional message would pull a package tree into a service that
 * otherwise installs clean with no native modules, and this keeps the failure
 * mode obvious - if SMTP is not configured, the caller finds out loudly rather
 * than discovering weeks later that no mail was ever sent.
 *
 * `SMTP_HOST` unset means no transport. The reset route then refuses to issue a
 * token, because a token nobody can receive is indistinguishable from a working
 * reset to the person waiting for the email.
 */

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export interface MailConfig {
  host: string;
  port: number;
  /** `true` wraps the socket in TLS from the start (465), otherwise STARTTLS (587/25). */
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export type MailResult = { ok: true } | { ok: false; error: string };

/** Reads SMTP settings from the environment, or null when unconfigured. */
export function loadMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const rawPort = (env.SMTP_PORT ?? '').trim();
  const port = Number.parseInt(rawPort, 10);
  return {
    host,
    port: Number.isInteger(port) && port > 0 ? port : 587,
    // 465 is implicit TLS; 587/25 want STARTTLS first.
    secure: rawPort === '465',
    user: env.SMTP_USER?.trim() || null,
    pass: env.SMTP_PASS || null,
    from: env.MAIL_FROM?.trim() || env.SMTP_USER?.trim() || 'no-reply@localhost',
  };
}

const CRLF = '\r\n';

/**
 * Header injection guard.
 *
 * A newline inside a `To:` or `From:` would let a caller append headers of its
 * own, and the SMTP server would relay them. Escape before formatting, not after.
 */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * A line-buffered SMTP conversation.
 *
 * SMTP replies are line oriented and multi-line replies continue while the 4th
 * character is a `-`, so the read side has to buffer partial chunks rather than
 * treating one `data` event as one reply.
 */
class SmtpSession {
  private buffer = '';
  private readonly queued: string[] = [];
  private readonly waiting: ((line: string) => void)[] = [];

  constructor(private readonly socket: Socket | TLSSocket) {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf(CRLF);
      while (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + CRLF.length);
        const waiter = this.waiting.shift();
        if (waiter) waiter(line);
        else this.queued.push(line);
        index = this.buffer.indexOf(CRLF);
      }
    });
    this.socket.on('error', () => {
      // Release any pending read so the caller sees an error, not a hang.
      while (this.waiting.length) this.waiting.shift()?.('');
      this.queued.push('421 connection closed');
    });
  }

  private nextLine(): Promise<string> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string>((resolve) => this.waiting.push(resolve));
  }

  /** Sends a command and waits for a reply whose code satisfies `expected`. */
  async command(line: string, expected: (code: string) => boolean): Promise<string> {
    this.socket.write(line + CRLF);
    return this.reply(expected, line);
  }

  /** Reads a full reply (following `250-` continuations) and checks its code. */
  async reply(expected: (code: string) => boolean, context: string): Promise<string> {
    const parts: string[] = [];
    for (;;) {
      const line = await this.nextLine();
      parts.push(line);
      if (line.length < 4 || line[3] !== '-') break;
    }
    const reply = parts.join(' ');
    const code = reply.slice(0, 3);
    if (!expected(code)) {
      throw new Error(`SMTP ${code || '???'} after "${context}": ${reply.slice(0, 200)}`);
    }
    return code;
  }

  writeRaw(text: string): void {
    this.socket.write(text);
  }

  end(): void {
    this.socket.end();
    this.socket.destroy();
  }
}

function authSequence(config: MailConfig): { line: string; ok: (code: string) => boolean }[] {
  if (!config.user) return [];
  return [
    { line: 'AUTH LOGIN', ok: (c) => c === '334' },
    { line: Buffer.from(config.user).toString('base64'), ok: (c) => c === '334' },
    { line: Buffer.from(config.pass ?? '').toString('base64'), ok: (c) => c === '235' },
  ];
}

/**
 * Sends one message, or resolves to an error rather than throwing.
 *
 * Callers treat a failure as fatal to the request: telling someone "check your
 * email" when nothing was sent is how you get a support ticket instead of a
 * working reset.
 */
export async function sendMail(config: MailConfig, message: MailMessage): Promise<MailResult> {
  const to = headerValue(message.to);
  const from = headerValue(config.from);
  if (!to || !from) return { ok: false, error: 'missing recipient or sender' };

  const body = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${headerValue(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    message.text,
  ].join(CRLF);

  try {
    return config.secure ? await deliver(config, body, to, from, true) : await deliver(config, body, to, from, false);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function deliver(
  config: MailConfig,
  body: string,
  to: string,
  from: string,
  secure: boolean,
): Promise<MailResult> {
  let socket: Socket | TLSSocket;
  if (secure) {
    const tls = tlsConnect({ host: config.host, port: config.port, servername: config.host });
    await new Promise<void>((resolve, reject) => {
      tls.once('secureConnect', () => resolve());
      tls.once('error', reject);
    });
    socket = tls;
  } else {
    const plain = netConnect({ host: config.host, port: config.port });
    await new Promise<void>((resolve, reject) => {
      plain.once('connect', () => resolve());
      plain.once('error', reject);
    });
    socket = plain;
  }

  const smtp = new SmtpSession(socket);
  try {
    await smtp.reply((c) => c === '220', 'connect');
    await smtp.command('EHLO mediflow', (c) => c === '250');

    if (!secure) {
      // Upgrade before the password crosses the wire, so AUTH is never sent in
      // the clear on an unencrypted connection.
      await smtp.command('STARTTLS', (c) => c === '220');
      const upgraded = tlsConnect({ socket: socket as Socket, servername: config.host });
      await new Promise<void>((resolve, reject) => {
        upgraded.once('secureConnect', () => resolve());
        upgraded.once('error', reject);
      });
      // The plain socket's listeners must not keep consuming the stream.
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket = upgraded;
      const secured = new SmtpSession(upgraded);
      await secured.command('EHLO mediflow', (c) => c === '250');
      for (const step of authSequence(config)) {
        await secured.command(step.line, step.ok);
      }
      await secured.command(`MAIL FROM:<${from}>`, (c) => c === '250');
      await secured.command(`RCPT TO:<${to}>`, (c) => c === '250' || c === '251');
      await secured.command('DATA', (c) => c === '354');
      secured.writeRaw(body + CRLF + '.' + CRLF);
      await secured.reply((c) => c === '250', 'DATA');
      secured.writeRaw('QUIT' + CRLF);
      secured.end();
      return { ok: true };
    }

    for (const step of authSequence(config)) {
      await smtp.command(step.line, step.ok);
    }
    await smtp.command(`MAIL FROM:<${from}>`, (c) => c === '250');
    await smtp.command(`RCPT TO:<${to}>`, (c) => c === '250' || c === '251');
    await smtp.command('DATA', (c) => c === '354');
    smtp.writeRaw(body + CRLF + '.' + CRLF);
    await smtp.reply((c) => c === '250', 'DATA');
    smtp.writeRaw('QUIT' + CRLF);
    smtp.end();
    return { ok: true };
  } catch (error) {
    smtp.end();
    throw error;
  }
}
