/**
 * One clinic's WhatsApp session: outbox drain + inbound routing.
 *
 * Outbound: a Firestore listener on `queued` rows. Each row is claimed with a
 * transaction (status queued -> sending) so two gateway replicas cannot send
 * it twice, then delivered over Baileys, then marked sent with the provider
 * id. Three failed attempts move it to `failed` with the reason - a poison
 * message must park visibly, not spin forever.
 *
 * Inbound: the sender's number resolves to a patient by exact E.164 match,
 * the message lands in the patient's thread (created on first contact), and
 * the thread's unread counter rises. If the text parses as vital readings,
 * they are recorded and a critical value raises an alert - the same safety
 * path as the API, evaluated with the same shared library.
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type AnyMessageContent,
} from '@whiskeysockets/baileys';
import { applicationDefault, cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import {
  evaluateVital,
  parseVitalsReply,
  vitalLabel,
  type ParsedReply,
  type VitalKind,
} from '@mediflow/shared';

import type { ClinicConfig } from './index.js';
import type { SessionRegistry } from './registry.js';
import { startApiPoll } from './apiPoll.js';
import { isHighPriority, isSmsConfigured, sendSms } from './sms.js';

const MAX_ATTEMPTS = 3;

/** Reconnect schedule: 5s, 10s, 20s … capped at 5min, plus up to 5s jitter. */
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;
/** A logged-out session needs human re-pairing: park the loop, don't hot-spin. */
const LOGGED_OUT_PARK_MS = 10 * 60_000;

function backoffDelay(attempt: number): number {
  const exponential = RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6);
  const capped = Math.min(exponential, RECONNECT_MAX_MS);
  return capped + Math.floor(Math.random() * 5_000);
}

function adminFor(clinic: ClinicConfig): Firestore {
  const name = `gateway-${clinic.clinicId}`;
  const existing = getApps().find((a) => a.name === name);
  if (existing) return getFirestore(existing);
  // With no key path, fall back to the ambient credential. This is the normal
  // case on a platform host: Render mounts the service account or exposes it
  // through the metadata server, and requiring a file path would force a
  // key onto disk just to name it.
  const key = clinic.serviceAccountPath
    ? (JSON.parse(readFileSync(clinic.serviceAccountPath, 'utf8')) as Parameters<typeof cert>[0])
    : null;
  const app: App = initializeApp(
    { credential: key ? cert(key) : applicationDefault(), projectId: clinic.projectId },
    name,
  );
  return getFirestore(app);
}

export function toJid(e164: string): string {
  return `${e164.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
}

function fromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const digits = jid.split('@')[0]?.replace(/[^0-9]/g, '') ?? '';
  return digits ? `+${digits}` : null;
}

/**
 * Forwards one inbound patient message to the API's booking conversation.
 *
 * Silent when unconfigured (no MEDIFLOW_API_URL): pairing-only deployments
 * have no booking flow and must not log errors about it. Anything else that
 * fails is logged and dropped - the socket loop is more important than one
 * booking hint, and the patient can always write again.
 */
export async function forwardToApi(clinicId: string, sender: string, text: string): Promise<void> {
  const base = (process.env['MEDIFLOW_API_URL'] ?? '').trim().replace(/\/+$/, '');
  if (!base) return;
  const token = (process.env['GATEWAY_ADMIN_TOKEN'] ?? '').trim();
  if (!token) return;
  const res = await fetch(`${base}/gateway/inbound`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clinicId, from: sender, text: text.slice(0, 2000) }),
  });
  if (!res.ok) {
    throw new Error(`API ${res.status} on /gateway/inbound`);
  }
}

function messageText(message: Record<string, unknown> | undefined): string | null {
  if (!message) return null;
  const conversation = message['conversation'];
  if (typeof conversation === 'string' && conversation.trim() !== '') return conversation;
  const extended = message['extendedTextMessage'] as Record<string, unknown> | undefined;
  const text = extended?.['text'];
  return typeof text === 'string' && text.trim() !== '' ? text : null;
}

interface OutboxRow {
  to: string;
  body: string;
  template: string;
  threadId?: string;
  attempts: number;
  priority?: string;
}

export async function runClinic(clinic: ClinicConfig, registry: SessionRegistry): Promise<void> {
  const db = adminFor(clinic);
  const outbox = () => db.collection('clinics').doc(clinic.clinicId).collection('outbox');

  registry.declare(clinic.clinicId, clinic.phoneNumber);

  let attempt = 0;
  for (;;) {
    const startedAt = Date.now();
    try {
      await connectAndServe(db, clinic, outbox, registry);
      // A long-lived session that eventually drops is a network blip: reset
      // the backoff. A session that dies instantly is a config/auth problem:
      // keep backing off so logs stay readable and Firestore isn't hammered.
      attempt = Date.now() - startedAt > 60_000 ? 0 : attempt + 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('logged out')) {
        registry.patch(clinic.clinicId, { state: 'logged-out', lastError: 'Session ended on the phone. Pair again.', qr: null });
        process.stderr.write(
          `[${clinic.clinicId}] logged out - delete ${clinic.sessionDir} and pair again. Parking for 10min.\n`,
        );
        await new Promise((r) => setTimeout(r, LOGGED_OUT_PARK_MS));
        attempt = 0;
        continue;
      }
      attempt += 1;
      const delay = backoffDelay(attempt);
      registry.patch(clinic.clinicId, { state: 'error', lastError: message.slice(0, 300), qr: null });
      process.stderr.write(
        `[${clinic.clinicId}] connection lost: ${message} - reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt}).\n`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function connectAndServe(
  db: Firestore,
  clinic: ClinicConfig,
  outbox: () => FirebaseFirestore.CollectionReference,
  registry: SessionRegistry,
): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(clinic.sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state });
  sock.ev.on('creds.update', saveCreds);

  registry.patch(clinic.clinicId, {
    registered: state.creds.registered,
    state: state.creds.registered ? 'connecting' : 'pairing',
    lastError: null,
  });

  // Expose the live socket so the HTTP layer can mint a pairing code on
  // demand. Registered per clinic and dropped on close, so a request that
  // arrives between reconnects fails loudly instead of hanging on a dead sock.
  registry.setRequester(clinic.clinicId, (phoneNumber) => sock.requestPairingCode(phoneNumber));

  // First run: print a pairing code too, so an operator can still pair from a
  // terminal when the web app is not yet in use. The QR (surfaced over HTTP)
  // is the path the UI drives; both produce the same linked session.
  if (!state.creds.registered) {
    try {
      const code = await sock.requestPairingCode(clinic.phoneNumber);
      registry.setPairingCode(clinic.clinicId, code);
      process.stdout.write(`[${clinic.clinicId}] pairing code for +${clinic.phoneNumber}: ${code}\n`);
    } catch (error) {
      process.stderr.write(
        `[${clinic.clinicId}] pairing failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  // --- API outbox poll ---
  // Same sending job as the Firestore drain below, but the queue lives in the
  // API's SQLite outbox and this gateway polls it. This is what lets the
  // gateway sit on a home PC behind NAT: every connection is outbound.
  let apiConnected = false;
  let stopApiPoll: () => void = () => undefined;
  {
    const apiUrl = (process.env['MEDIFLOW_API_URL'] ?? '').trim().replace(/\/+$/, '');
    const adminToken = (process.env['GATEWAY_ADMIN_TOKEN'] ?? '').trim();
    const rawMs = Number(process.env['GATEWAY_API_POLL_MS'] ?? '');
    stopApiPoll = startApiPoll({
      apiUrl,
      adminToken,
      clinicId: clinic.clinicId,
      intervalMs: Number.isInteger(rawMs) && rawMs > 0 ? rawMs : 15_000,
      isConnected: () => apiConnected,
      send: async (to, body) => {
        const sent = await sock.sendMessage(toJid(to), { text: body } satisfies AnyMessageContent);
        return sent?.key.id ?? null;
      },
      log: (message) => process.stdout.write(`${message}\n`),
      logError: (message) => process.stderr.write(`${message}\n`),
    });
  }

  // --- manual-send sweep ---
  // Rows the doctor already sent from the WhatsApp app carry `manualSentAt`
  // (clients may not flip `status` themselves). Park them as sent so the
  // drain below never delivers them a second time.
  try {
    const manual = await outbox().where('status', '==', 'queued').get();
    for (const d of manual.docs) {
      if (!d.data()?.['manualSentAt']) continue;
      await d.ref.update({
        status: 'sent',
        sentAt: new Date().toISOString(),
        providerMessageId: 'manual:wa.me',
        lastError: null,
        updatedAt: new Date().toISOString(),
      });
      process.stdout.write(`[${clinic.clinicId}] manual-sweep ${d.id}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `[${clinic.clinicId}] manual sweep failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  // --- outbound drain ---
  const stopDrain = outbox()
    .where('status', '==', 'queued')
    .onSnapshot((snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== 'added') continue;
        const ref = change.doc.ref;
        const row = change.doc.data() as Partial<OutboxRow>;
        void (async () => {
          // Claim first: only the worker whose transaction flips queued ->
          // sending owns this row.
          const claimed = await db.runTransaction(async (tx) => {
            const fresh = await tx.get(ref);
            if (fresh.data()?.['status'] !== 'queued') return false;
            tx.update(ref, { status: 'sending', updatedAt: new Date().toISOString() });
            return true;
          });
          if (!claimed) return;

          try {
            const sent = await sock.sendMessage(toJid(String(row.to ?? '')), {
              text: String(row.body ?? ''),
            } satisfies AnyMessageContent);
            const providerId = sent?.key.id ?? null;
            await ref.update({
              status: 'sent',
              sentAt: new Date().toISOString(),
              providerMessageId: providerId,
              lastError: null,
              updatedAt: new Date().toISOString(),
            });
            if (row.threadId) {
              await markThreadMessageSent(db, clinic.clinicId, row.threadId, String(row.body ?? ''));
            }
            process.stdout.write(`[${clinic.clinicId}] sent ${ref.id}\n`);
          } catch (error) {
            const attempts = Number(row.attempts ?? 0) + 1;
            const failed = attempts >= MAX_ATTEMPTS;
            if (failed && isHighPriority(row.template, row.priority) && isSmsConfigured(clinic.sms ?? null)) {
              // Last resort for safety-critical traffic: deliver by SMS rather
              // than parking the row. The status records the channel so the
              // staff console can show "sent by SMS" instead of "sent".
              try {
                const sid = await sendSms(clinic.sms as NonNullable<ClinicConfig['sms']>, String(row.to ?? ''), String(row.body ?? ''));
                await ref.update({
                  status: 'sent-via-sms',
                  attempts,
                  sentAt: new Date().toISOString(),
                  providerMessageId: sid,
                  lastError: null,
                  updatedAt: new Date().toISOString(),
                });
                process.stdout.write(`[${clinic.clinicId}] sms-fallback ${ref.id} (${sid ?? 'no-sid'})\n`);
                return;
              } catch (smsError) {
                await ref.update({
                  status: 'failed',
                  attempts,
                  lastError: `wa: ${String(error instanceof Error ? error.message : error).slice(0, 150)} | sms: ${String(smsError instanceof Error ? smsError.message : smsError).slice(0, 150)}`,
                  updatedAt: new Date().toISOString(),
                });
                return;
              }
            }
            await ref.update({
              status: failed ? 'failed' : 'queued',
              attempts,
              lastError: String(error instanceof Error ? error.message : error).slice(0, 300),
              updatedAt: new Date().toISOString(),
            });
          }
        })().catch((error: unknown) => {
          process.stderr.write(`[${clinic.clinicId}] drain error: ${String(error).slice(0, 200)}\n`);
        });
      }
    });

  // --- inbound routing ---
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const text = messageText(msg.message as Record<string, unknown> | undefined);
      const sender = fromJid(msg.key.remoteJid ?? undefined);
      if (!text || !sender) continue;
      void handleInbound(db, clinic.clinicId, sender, text).catch((error: unknown) => {
        process.stderr.write(`[${clinic.clinicId}] inbound error: ${String(error).slice(0, 200)}\n`);
      });
      // Booking conversations live in the API (it owns appointments and the
      // schedule); the gateway just ferries the raw text. Fire-and-forget by
      // design: a booking hint must never break the socket loop.
      void forwardToApi(clinic.clinicId, sender, text).catch((error: unknown) => {
        process.stderr.write(`[${clinic.clinicId}] api-forward error: ${String(error).slice(0, 200)}\n`);
      });
    }
  });

  // Block until the connection closes, then let the outer loop reconnect.
  await new Promise<void>((resolve, reject) => {
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr, isNewLogin }) => {
      // Baileys emits a fresh QR here on every rotation until a phone scans
      // one. Publishing it is what lets the web app render a scannable code
      // without anyone reading Render's logs.
      if (qr) {
        registry.setQr(clinic.clinicId, qr);
      }
      if (connection === 'open') {
        apiConnected = true;
        // `registered` is the authoritative paired flag: it flips when Baileys
        // persists real credentials, not when the socket opens. The QR is
        // cleared here because an open connection means pairing finished, and a
        // stale code left in the payload would have the UI keep offering a
        // pairing flow for a session that is already live.
        registry.patch(clinic.clinicId, {
          state: 'connected',
          registered: true,
          connectedAt: new Date().toISOString(),
          qr: null,
          qrUpdatedAt: null,
          pairingCode: null,
          lastError: null,
        });
        if (isNewLogin) {
          process.stdout.write(`[${clinic.clinicId}] WhatsApp linked.\n`);
        } else {
          process.stdout.write(`[${clinic.clinicId}] WhatsApp connected.\n`);
        }
      }
      if (connection === 'connecting') {
        apiConnected = false;
        registry.patch(clinic.clinicId, { state: state.creds.registered ? 'connecting' : 'pairing' });
      }
      if (connection === 'close') {
        apiConnected = false;
        stopApiPoll();
        stopDrain();
        registry.clearRequester(clinic.clinicId);
        registry.patch(clinic.clinicId, { state: 'disconnected', qr: null, qrUpdatedAt: null });
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          reject(new Error('logged out - delete the session directory and pair again'));
          return;
        }
        resolve();
      }
    });
  });
}

async function markThreadMessageSent(
  db: Firestore,
  clinicId: string,
  threadId: string,
  body: string,
): Promise<void> {
  const messages = db.collection('clinics').doc(clinicId).collection('threads').doc(threadId).collection('messages');
  const snap = await messages.where('body', '==', body).where('status', '==', 'queued').limit(1).get();
  for (const d of snap.docs) {
    await d.ref.update({ status: 'sent', updatedAt: new Date().toISOString() });
  }
}

async function findPatientByPhone(
  db: Firestore,
  clinicId: string,
  e164: string,
): Promise<{ id: string; fullName: string } | null> {
  const patients = db.collection('clinics').doc(clinicId).collection('patients');
  for (const field of ['whatsappNumber', 'phone']) {
    const snap = await patients.where(field, '==', e164).limit(1).get();
    const first = snap.docs[0];
    if (first) {
      const data = first.data();
      return { id: first.id, fullName: String(data['fullName'] ?? e164) };
    }
  }
  return null;
}

async function ensureThread(db: Firestore, clinicId: string, patientId: string | null): Promise<string> {
  const threads = db.collection('clinics').doc(clinicId).collection('threads');
  if (patientId) {
    const existing = await threads.where('patientId', '==', patientId).limit(1).get();
    if (!existing.empty) return existing.docs[0]?.id as string;
  }
  const ref = await threads.add({
    patientId,
    channel: 'whatsapp',
    unreadCount: 0,
    lastMessageAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
  return ref.id;
}

async function handleInbound(db: Firestore, clinicId: string, sender: string, text: string): Promise<void> {
  const now = new Date().toISOString();
  const patient = await findPatientByPhone(db, clinicId, sender);
  const threadId = await ensureThread(db, clinicId, patient?.id ?? null);
  const thread = db.collection('clinics').doc(clinicId).collection('threads').doc(threadId);

  await thread.collection('messages').add({
    direction: 'inbound',
    body: text,
    status: 'received',
    sender,
    createdAt: now,
  });
  await thread.update({ lastMessageAt: now, unreadCount: FieldValue.increment(1) });

  // A readings text is charted immediately; a critical value raises an alert
  // for a human. Anything else just waits in the thread for staff.
  if (!patient) return;
  const parsed: ParsedReply | null = parseVitalsReply(text);
  if (!parsed || parsed.readings.length === 0) return;

  for (const reading of parsed.readings) {
    await db
      .collection('clinics')
      .doc(clinicId)
      .collection('vitals')
      .add({
        patientId: patient.id,
        kind: reading.kind,
        value: reading.value,
        secondaryValue: reading.secondaryValue ?? null,
        unit: reading.unit ?? '',
        measuredAt: now,
        source: 'whatsapp',
        createdAt: now,
      });
  }
  const kinds = parsed.readings.map((r) => vitalLabel(r.kind as VitalKind)).join(', ');
  await thread.collection('messages').add({
    direction: 'outbound',
    body: `Thanks ${patient.fullName}, we received your readings (${kinds}). A clinician will review them.`,
    status: 'queued-gateway',
    createdAt: now,
  });

  for (const reading of parsed.readings) {
    const evaluation = evaluateVital({ kind: reading.kind as VitalKind, value: reading.value });
    if (!evaluation.isCritical) continue;
    await db.collection('clinics').doc(clinicId).collection('alerts').add({
      patientId: patient.id,
      patientName: patient.fullName,
      kind: 'critical_reading',
      severity: 'critical',
      status: 'open',
      title: `Critical ${String(reading.kind)} from WhatsApp`,
      body: evaluation.interpretation,
      createdAt: now,
      updatedAt: now,
    });
  }
}
