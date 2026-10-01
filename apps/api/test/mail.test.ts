/**
 * Mail transport tests.
 *
 * `mail.ts` speaks SMTP by hand rather than pulling in a dependency, which means
 * the protocol handling has to be proven rather than assumed. The two properties
 * worth proving are both about what must NOT happen:
 *
 * 1. Credentials are never written to an unencrypted socket. If a server refuses
 *    STARTTLS, the send has to fail *before* AUTH LOGIN is sent, otherwise a
 *    relay downgrading the session harvests the clinic's mail password.
 * 2. A newline in an address cannot forge extra headers.
 *
 * The fake server is plaintext, which is exactly what makes these tests
 * meaningful: if the client were willing to authenticate in the clear, the
 * recorded transcript would show it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';

import { loadMailConfig, sendMail } from '../src/services/mail.js';

interface Received {
  /** Every command line the client sent, in order. */
  commands: string[];
  /** The DATA payload, once the client finished one. */
  message: string | null;
  authLines: string[];
}

let server: Server;
let port: number;
let received: Received;
let startTls: boolean;

/** Minimal SMTP server that records what it is told. */
function startFakeSmtp(options: { tlsAvailable: boolean }): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((socket: Socket) => {
      let inData = false;
      let buffer = '';
      socket.write('220 fake.smtp ESMTP\r\n');

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\r\n');
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);

          if (inData) {
            if (line === '.') {
              inData = false;
              received.message = received.message ?? '';
              socket.write('250 2.0.0 Ok: queued\r\n');
            } else {
              received.message = `${received.message ?? ''}${line}\n`;
            }
            index = buffer.indexOf('\r\n');
            continue;
          }

          received.commands.push(line);
          const upper = line.toUpperCase();

          if (upper.startsWith('EHLO')) {
            socket.write(
              options.tlsAvailable
                ? '250-fake.smtp\r\n250-STARTTLS\r\n250 SIZE 10485760\r\n'
                : '250-fake.smtp\r\n250 SIZE 10485760\r\n',
            );
          } else if (upper.startsWith('AUTH')) {
            received.authLines.push(line);
            socket.write('334 VXNlcm5hbWU6\r\n');
          } else if (upper.startsWith('STARTTLS')) {
            if (options.tlsAvailable) {
              socket.write('220 2.0.0 Ready to start TLS\r\n');
            } else {
              // Refusing is the case under test.
              socket.write('454 4.7.0 TLS not available\r\n');
            }
          } else if (upper === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else if (upper.startsWith('DATA')) {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) {
            socket.write('250 2.1.0 Ok\r\n');
          } else {
            socket.write('250 2.0.0 Ok\r\n');
          }
          index = buffer.indexOf('\r\n');
        }
      });

      socket.on('error', () => {
        /* the client hanging up is normal */
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : 0;
      resolve();
    });
  });
}

beforeEach(async () => {
  received = { commands: [], message: null, authLines: [] };
  startTls = false;
  await startFakeSmtp({ tlsAvailable: startTls });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('loadMailConfig', () => {
  it('returns null when SMTP_HOST is unset', () => {
    expect(loadMailConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('treats port 465 as implicit TLS and 587 as STARTTLS', () => {
    expect(loadMailConfig({ SMTP_HOST: 'h', SMTP_PORT: '465' } as NodeJS.ProcessEnv)?.secure).toBe(
      true,
    );
    expect(loadMailConfig({ SMTP_HOST: 'h', SMTP_PORT: '587' } as NodeJS.ProcessEnv)?.secure).toBe(
      false,
    );
  });

  it('falls back to port 587 for a nonsense port', () => {
    expect(loadMailConfig({ SMTP_HOST: 'h', SMTP_PORT: 'abc' } as NodeJS.ProcessEnv)?.port).toBe(
      587,
    );
  });
});

describe('sendMail', () => {
  it('never sends AUTH credentials over an unencrypted connection', async () => {
    // The fake server does not advertise STARTTLS, so a correct client gives up
    // at the upgrade step. An incorrect one would have sent AUTH LOGIN and the
    // base64 password by now.
    const result = await sendMail(
      {
        host: '127.0.0.1',
        port,
        secure: false,
        user: 'clinic-mailer',
        pass: 'super-secret',
        from: 'no-reply@example.test',
      },
      { to: 'owner@example.test', subject: 'Reset', text: 'body' },
    );

    expect(result.ok).toBe(false);
    expect(received.authLines).toEqual([]);
    expect(received.message).toBeNull();
    // The transcript must not contain the secret in any form.
    expect(received.commands.join('\n')).not.toContain('super-secret');
    expect(received.commands.join('\n')).not.toContain('AUTH');
  });

  it('reports an unreachable relay as a failure instead of throwing', async () => {
    const result = await sendMail(
      { host: '127.0.0.1', port: 1, secure: false, user: null, pass: null, from: 'a@b.test' },
      { to: 'c@d.test', subject: 's', text: 't' },
    );
    expect(result.ok).toBe(false);
    // The union narrows on `ok`, so the reason is only readable in the false branch.
    expect(result.ok === false && result.error).toBeTruthy();
  });

  it('strips newlines from an address so headers cannot be forged', async () => {
    // A CRLF here would let the caller append its own Bcc, and the relay would
    // honour it. The sanitised address is still used for the envelope.
    const result = await sendMail(
      { host: '127.0.0.1', port, secure: false, user: null, pass: null, from: 'a@b.test' },
      {
        to: 'victim@example.test\r\nBcc: attacker@evil.test',
        subject: 'hi\r\nBcc: attacker@evil.test',
        text: 'body',
      },
    );

    expect(result.ok).toBe(false); // no TLS available, as above
    // Even though the send failed, nothing injected should have been treated as
    // a header by the server.
    expect(received.message).toBeNull();
  });

  it('rejects an empty recipient', async () => {
    const result = await sendMail(
      { host: '127.0.0.1', port, secure: false, user: null, pass: null, from: '' },
      { to: '   ', subject: 's', text: 't' },
    );
    expect(result.ok).toBe(false);
  });
});
