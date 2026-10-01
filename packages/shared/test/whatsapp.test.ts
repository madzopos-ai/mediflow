/**
 * Tests for the WhatsApp automation layer.
 *
 * These cover the failure modes that are invisible in review and expensive in
 * production: an opt-out keyword that silently stops matching, a reminder sent
 * twice because a worker re-ran, a critical reading queued behind a backlog, or
 * a follow-up that keeps messaging a patient who stopped replying.
 */

import { describe, expect, it } from 'vitest';

import {
  OPT_IN_TEMPLATE,
  OPT_OUT_TEMPLATE,
  renderDefinition,
  renderTemplate,
  templateLibraryStats,
  templatePlaceholders,
  validateTemplateLibrary,
  WHATSAPP_TEMPLATES,
} from '../src/whatsapp/templates.js';
import { foldArabic, isAutomationBlocked, requiresHumanReview, routeInbound } from '../src/whatsapp/commands.js';
import {
  applySendResult,
  backoffDelaySeconds,
  claimDueMessages,
  DEFAULT_RETRY_POLICY,
  enqueueMessage,
  messagesNeedingReview,
  orderForSending,
  summariseOutbox,
  toE164,
  type ConsentState,
  type OutboxStore,
} from '../src/whatsapp/outbox.js';
import {
  adherencePercent,
  buildAlertsFor,
  criticalPatientAction,
  decideFollowUpRequest,
  markMissed,
  markRequested,
  markResponded,
  routingFor,
  scheduledRequestTime,
  setPaused,
  triageOrder,
} from '../src/whatsapp/care.js';
import type { OutboxMessage } from '../src/domain/types.js';
import type { FollowUp } from '../src/domain/types.js';
import { evaluateVitals } from '../src/clinical/vitals.js';

const CLINIC = 'clinic_1';
const PATIENT = 'patient_1';
const NOW = '2026-03-10T08:00:00.000Z';
const TZ = 'Asia/Riyadh';

/** In-memory store so the queue rules can be tested without a database. */
class MemoryStore implements OutboxStore {
  rows: OutboxMessage[] = [];

  async getByDedupeKey(clinicId: string, dedupeKey: string): Promise<OutboxMessage | null> {
    return this.rows.find((r) => r.clinicId === clinicId && r.dedupeKey === dedupeKey) ?? null;
  }
  async insert(message: OutboxMessage): Promise<void> {
    this.rows.push(message);
  }
  async update(message: OutboxMessage): Promise<void> {
    this.rows = this.rows.map((r) => (r.id === message.id ? message : r));
  }
  async listDue(clinicId: string, now: string, limit: number): Promise<OutboxMessage[]> {
    return this.rows
      .filter((r) => r.clinicId === clinicId && r.status === 'pending' && r.scheduledFor <= now)
      .slice(0, limit);
  }
}

const OK_CONSENT: ConsentState = { optedOut: false, channelEnabled: true };
const OPTED_OUT: ConsentState = { optedOut: true, channelEnabled: true };

function enqueueInput(overrides: Partial<Parameters<typeof enqueueMessage>[0]> = {}) {
  return {
    clinicId: CLINIC,
    patientId: PATIENT,
    to: '+966500000000',
    body: 'Hello',
    language: 'en' as const,
    channel: 'whatsapp' as const,
    template: 'appointment_reminder' as const,
    dedupeKey: 'reminder:appt_1:24h',
    ...overrides,
  };
}

function followUp(overrides: Partial<FollowUp> = {}): FollowUp {
  return {
    id: 'fu_1',
    clinicId: CLINIC,
    patientId: PATIENT,
    protocolId: null,
    diagnosisId: null,
    name: 'BP check',
    status: 'active',
    trigger: 'interval',
    intervalDays: 7,
    startDate: '2026-03-01',
    endDate: null,
    nextDueAt: '2026-03-10T07:00:00.000Z',
    lastRequestedAt: null,
    lastResponseAt: null,
    requestsThisWeek: 0,
    weekStamp: null,
    requestsSent: 0,
    responsesReceived: 0,
    consecutiveMisses: 0,
    adherencePercent: 0,
    pausedAt: null,
    pauseReason: null,
    notes: null,
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('template library', () => {
  it('has no internal inconsistencies', () => {
    expect(validateTemplateLibrary()).toEqual([]);
    expect(templateLibraryStats()).toEqual({ total: Object.keys(WHATSAPP_TEMPLATES).length, problems: 0 });
  });

  it('declares every placeholder it uses', () => {
    for (const key of Object.keys(WHATSAPP_TEMPLATES) as (keyof typeof WHATSAPP_TEMPLATES)[]) {
      expect(templatePlaceholders(key).undeclared).toEqual([]);
    }
  });

  it('renders both languages', () => {
    const vars = { patientName: 'Sara', clinicName: 'Al Noor', date: '12 May', time: '10:30' };
    const en = renderTemplate('appointment_confirm', 'en', vars);
    const ar = renderTemplate('appointment_confirm', 'ar', vars);
    expect(en.ok && en.body).toContain('Sara');
    expect(ar.ok && ar.body).toContain('Sara');
  });

  it('drops optional values without leaving punctuation behind', () => {
    const result = renderTemplate('appointment_confirm', 'en', {
      patientName: 'Sara',
      clinicName: 'Al Noor',
      date: '12 May',
      time: '10:30',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).not.toContain('undefined');
    expect(result.body).not.toContain('{{');
    expect(result.body).not.toMatch(/\.\s*\./);
    expect(result.body).not.toMatch(/^\s*[.,:;-]+$/m);
    expect(result.body).not.toMatch(/\n{3,}/);
  });

  it('keeps optional values when supplied', () => {
    const result = renderTemplate('appointment_confirm', 'en', {
      patientName: 'Sara',
      clinicName: 'Al Noor',
      date: '12 May',
      time: '10:30',
      doctorName: 'Dr Ahmed',
    });
    expect(result.ok && result.body).toContain('Dr Ahmed');
  });

  it('reports missing required variables instead of throwing', () => {
    const result = renderTemplate('appointment_confirm', 'en', { patientName: 'Sara' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([...result.missing].sort()).toEqual(['clinicName', 'date', 'time']);
  });

  it('carries the opt-out instruction on automated patient messages', () => {
    for (const [key, definition] of Object.entries(WHATSAPP_TEMPLATES)) {
      if (definition.safetyCritical || definition.staffAuthored) continue;
      expect(definition.en, key).toContain('STOP');
    }
  });

  it('exempts safety-critical messages from opt-out wording by design', () => {
    // A patient who replies STOP must still receive a critical reading alert.
    expect(WHATSAPP_TEMPLATES.vitals_critical_alert.safetyCritical).toBe(true);
    expect(WHATSAPP_TEMPLATES.vitals_critical_alert.en).not.toContain('STOP');
  });

  it('renders the opt-out confirmation', () => {
    const result = renderDefinition(OPT_OUT_TEMPLATE, 'en', { clinicName: 'Al Noor' });
    expect(result.ok && result.body).toContain('Al Noor');
  });

  it('renders the opt-in confirmation', () => {
    const result = renderDefinition(OPT_IN_TEMPLATE, 'ar', { clinicName: 'Al Noor' });
    expect(result.ok && result.body).toContain('Al Noor');
    // Arabic patients are told how to opt back out, not to opt in.
    expect(result.ok && result.body).toContain('STOP');
  });
});

describe('Arabic folding', () => {
  it('normalises orthographic variants', () => {
    // إيقاف and ايقاف must fold to the same string.
    expect(foldArabic('\u0625\u064A\u0642\u0627\u0639')).toBe(foldArabic('\u0627\u064A\u0642\u0627\u0639'));
    // ة and ه
    expect(foldArabic('\u0627\u0644\u0645\u062A\u0627\u0628\u0639\u0629')).toBe(foldArabic('\u0627\u0644\u0645\u062A\u0627\u0628\u0639\u0647'));
  });
});

describe('inbound routing', () => {
  it('honours English opt-out keywords', () => {
    for (const text of ['STOP', 'stop', 'Unsubscribe', 'QUIT']) {
      expect(routeInbound(text).kind, text).toBe('opt_out');
    }
  });

  it('honours Arabic opt-out keywords including hamza variants', () => {
    const stop = '\u0625\u064A\u0642\u0627\u0639'; // إيقاف
    const tawaqquf = '\u062A\u0648\u0642\u0641'; // توقف
    expect(routeInbound(stop).kind).toBe('opt_out');
    expect(routeInbound(tawaqquf).kind).toBe('opt_out');
  });

  it('keeps readings when an opt-out arrives alongside them', () => {
    // "stop - blood pressure 150 90", carrying a diacritic the patient typed:
    // compliance keyword plus real data, both must survive.
    const text = '\u062A\u0648\u0642\u064F\u0641 \u0627\u0644\u0636\u063A\u0637 150 90';
    const intent = routeInbound(text);
    expect(intent.kind).toBe('opt_out_with_readings');
    if (intent.kind !== 'opt_out_with_readings') return;
    expect(intent.parse.readings.length).toBeGreaterThan(0);
  });

  it('routes START to opt-in', () => {
    expect(routeInbound('START').kind).toBe('opt_in');
  });

  it('reads a bare number as a slot choice only when slots were offered', () => {
    expect(routeInbound('2', { pendingSlotOffer: true }).kind).toBe('slot_choice');
    // Without a pending offer the same message must not be swallowed as a slot.
    expect(routeInbound('2', {}).kind).not.toBe('slot_choice');
  });

  it('accepts an Arabic slot choice', () => {
    const text = '\u0627\u0644\u062E\u064A\u0627\u0631 3'; // الخيار 3
    const intent = routeInbound(text, { pendingSlotOffer: true });
    expect(intent.kind).toBe('slot_choice');
    if (intent.kind !== 'slot_choice') return;
    expect(intent.option).toBe(3);
  });

  it('confirms and cancels against an active appointment prompt', () => {
    expect(routeInbound('YES', { awaitingAppointmentResponse: true }).kind).toBe('confirm');
    expect(routeInbound('\u0646\u0639\u0645', { awaitingAppointmentResponse: true }).kind).toBe('confirm'); // نعم
    expect(routeInbound('CANCEL', { awaitingAppointmentResponse: true }).kind).toBe('cancel');
  });

  it('does not cancel on a long message that merely contains the word', () => {
    const text = 'I cannot come on Tuesday, will I get a refund?';
    expect(routeInbound(text, { awaitingAppointmentResponse: true }).kind).not.toBe('cancel');
  });

  it('escalates English chest pain to a human', () => {
    const intent = routeInbound('I have chest pain');
    expect(intent.kind).toBe('vitals');
    expect(requiresHumanReview(intent)).toBe(true);
    expect(isAutomationBlocked(intent)).toBe(true);
  });

  it('escalates Arabic chest pain written with an inserted severity word', () => {
    // "severe pain in the chest" never contains the literal "pain in the chest".
    const text = '\u0639\u0646\u062F\u064A \u0623\u0644\u0645 \u0634\u062F\u064A\u062F \u0641\u064A \u0627\u0644\u0635\u062F\u0631';
    expect(requiresHumanReview(routeInbound(text))).toBe(true);
  });

  it('escalates Arabic breathlessness', () => {
    const text = '\u0645\u0627 \u0627\u0642\u062F\u0631 \u0627\u062A\u0646\u0641\u0633';
    expect(requiresHumanReview(routeInbound(text))).toBe(true);
  });

  it('does not escalate a mild complaint', () => {
    const mildHeadache = '\u0639\u0646\u062F\u064A \u0635\u062F\u0627\u0639 \u062E\u0641\u064A\u0641'; // صداع خفيف
    const intent = routeInbound(mildHeadache);
    expect(requiresHumanReview(intent)).toBe(false);
  });

  it('parses vitals from an Arabic message', () => {
    const text = '\u0627\u0644\u0636\u063A\u0637 150 90'; // الضغط 150 90
    const intent = routeInbound(text);
    expect(intent.kind).toBe('vitals');
    if (intent.kind !== 'vitals') return;
    expect(intent.parse.readings.length).toBeGreaterThanOrEqual(1);
  });
});

describe('outbox', () => {
  it('validates and normalises phone numbers', () => {
    expect(toE164('+966500000000')).toBe('+966500000000');
    expect(toE164('+966 50 000 0000')).toBe('+966500000000');
    expect(toE164('0500000000')).toBeNull();
    expect(toE164('nonsense')).toBeNull();
  });

  it('enqueues a message', async () => {
    const store = new MemoryStore();
    const result = await enqueueMessage(enqueueInput(), store, OK_CONSENT, DEFAULT_RETRY_POLICY, NOW);
    expect(result.status).toBe('enqueued');
    expect(store.rows).toHaveLength(1);
  });

  it('collapses a duplicate enqueue so a re-run worker cannot double message', async () => {
    const store = new MemoryStore();
    await enqueueMessage(enqueueInput(), store, OK_CONSENT, DEFAULT_RETRY_POLICY, NOW);
    const second = await enqueueMessage(enqueueInput(), store, OK_CONSENT, DEFAULT_RETRY_POLICY, NOW);
    expect(second.status).toBe('duplicate');
    expect(store.rows).toHaveLength(1);
  });

  it('rejects a message to a patient who opted out', async () => {
    const store = new MemoryStore();
    const result = await enqueueMessage(enqueueInput(), store, OPTED_OUT, DEFAULT_RETRY_POLICY, NOW);
    expect(result).toEqual({ status: 'rejected', reason: 'opted_out' });
    expect(store.rows).toHaveLength(0);
  });

  it('still delivers a safety-critical message to an opted-out patient', async () => {
    const store = new MemoryStore();
    const result = await enqueueMessage(
      enqueueInput({ template: 'critical_alert', safetyCritical: true, dedupeKey: 'critical:reading_1' }),
      store,
      OPTED_OUT,
      DEFAULT_RETRY_POLICY,
      NOW,
    );
    expect(result.status).toBe('enqueued');
  });

  it('rejects an unusable recipient and an empty body', async () => {
    const store = new MemoryStore();
    expect((await enqueueMessage(enqueueInput({ to: 'nope' }), store, OK_CONSENT, DEFAULT_RETRY_POLICY, NOW)).status).toBe('rejected');
    expect((await enqueueMessage(enqueueInput({ body: '  ' }), store, OK_CONSENT, DEFAULT_RETRY_POLICY, NOW)).status).toBe('rejected');
    expect((await enqueueMessage(enqueueInput({ dedupeKey: '' }), store, OK_CONSENT, DEFAULT_RETRY_POLICY, NOW)).status).toBe('rejected');
  });

  it('backs off exponentially and caps the delay', () => {
    expect(backoffDelaySeconds(1)).toBe(60);
    expect(backoffDelaySeconds(2)).toBe(120);
    expect(backoffDelaySeconds(3)).toBe(240);
    expect(backoffDelaySeconds(50)).toBe(DEFAULT_RETRY_POLICY.maxDelaySeconds);
  });

  it('reschedules a retryable failure', () => {
    const store = new MemoryStore();
    const message: OutboxMessage = {
      ...({
        id: 'msg_1',
        clinicId: CLINIC,
        channel: 'whatsapp',
        to: '+966500000000',
        body: 'hi',
        template: 'appointment_reminder',
        payload: {},
        status: 'pending',
        scheduledFor: NOW,
        attempts: 0,
        maxAttempts: 5,
        lastAttemptAt: null,
        sentAt: null,
        lastError: null,
        providerMessageId: null,
        appointmentId: null,
        patientId: PATIENT,
        dedupeKey: 'k',
        lockedBy: null,
        lockedAt: null,
        correlationId: null,
        priority: 50,
        createdAt: NOW,
        updatedAt: NOW,
      } satisfies OutboxMessage),
    };
    const result = applySendResult(message, { ok: false, error: 'timeout' }, DEFAULT_RETRY_POLICY, NOW);
    expect(result.nextStatus).toBe('pending');
    expect(result.message.attempts).toBe(1);
    expect(result.message.scheduledFor).not.toBe(NOW);
    expect(result.needsReview).toBe(false);
  });

  it('marks a non-retryable failure terminal immediately', () => {
    const store = new MemoryStore();
    void store;
    const message = {
      id: 'msg_2',
      clinicId: CLINIC,
      channel: 'whatsapp' as const,
      to: '+966500000000',
      body: 'hi',
      template: 'appointment_reminder' as const,
      payload: {},
      status: 'pending' as const,
      scheduledFor: NOW,
      attempts: 0,
      maxAttempts: 5,
      lastAttemptAt: null,
      sentAt: null,
      lastError: null,
      providerMessageId: null,
      appointmentId: null,
      patientId: PATIENT,
      dedupeKey: 'k2',
      lockedBy: null,
      lockedAt: null,
      correlationId: null,
      priority: 50,
      createdAt: NOW,
      updatedAt: NOW,
    } satisfies OutboxMessage;
    const result = applySendResult(message, { ok: false, error: 'invalid recipient', retryable: false }, DEFAULT_RETRY_POLICY, NOW);
    expect(result.nextStatus).toBe('dead');
    expect(result.needsReview).toBe(true);
  });

  it('sends a critical alert ahead of a reminder backlog', async () => {
    const store = new MemoryStore();
    await enqueueMessage(
      enqueueInput({ dedupeKey: 'reminder:1', scheduledFor: '2026-03-10T00:00:00.000Z' }),
      store,
      OK_CONSENT,
      DEFAULT_RETRY_POLICY,
      NOW,
    );
    await enqueueMessage(
      enqueueInput({ dedupeKey: 'critical:1', template: 'critical_alert', safetyCritical: true }),
      store,
      OK_CONSENT,
      DEFAULT_RETRY_POLICY,
      NOW,
    );
    const order = orderForSending(store.rows);
    expect(order[0]?.dedupeKey).toBe('critical:1');
  });

  it('claims a batch and marks it processing', async () => {
    const store = new MemoryStore();
    await enqueueMessage(enqueueInput(), store, OK_CONSENT, DEFAULT_RETRY_POLICY, NOW);
    const claimed = await claimDueMessages(CLINIC, store, NOW, 'worker-1');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.message.status).toBe('processing');
    expect(claimed[0]?.message.lockedBy).toBe('worker-1');
    expect(claimed[0]?.providerIdempotencyKey).toContain('reminder:appt_1:24h');
  });

  it('summarises and surfaces messages needing review', () => {
    const base = { clinicId: CLINIC, channel: 'whatsapp', to: '+9665', body: 'x', template: 'custom', payload: {}, scheduledFor: NOW, maxAttempts: 5, lastAttemptAt: null, sentAt: null, providerMessageId: null, appointmentId: null, patientId: PATIENT, dedupeKey: null, lockedBy: null, lockedAt: null, correlationId: null, priority: 50, createdAt: NOW, updatedAt: NOW } as const;
    const rows: OutboxMessage[] = [
      { ...base, id: 'a', status: 'pending', attempts: 0, lastError: null },
      { ...base, id: 'b', status: 'dead', attempts: 5, lastError: 'gave up' },
    ];
    expect(summariseOutbox(rows)).toEqual({ pending: 1, processing: 0, sent: 0, failed: 0, dead: 1 });
    expect(messagesNeedingReview(rows).map((m) => m.id)).toEqual(['b']);
  });
});

describe('follow-up cadence', () => {
  const base = { now: NOW, timeZone: TZ, requestsSentToday: 0, contactable: true };

  it('sends when due', () => {
    const decision = decideFollowUpRequest({ ...base, followUp: followUp() });
    expect(decision.action).toBe('send_request');
  });

  it('does not send before the due time', () => {
    const decision = decideFollowUpRequest({
      ...base,
      followUp: followUp({ nextDueAt: '2026-03-20T07:00:00.000Z' }),
    });
    expect(decision).toEqual({ action: 'skip', reason: 'not_due' });
  });

  it('sends at most one request per day', () => {
    const decision = decideFollowUpRequest({
      ...base,
      followUp: followUp({ lastRequestedAt: NOW }),
    });
    expect(decision).toEqual({ action: 'skip', reason: 'already_requested_today' });
  });

  it('enforces the weekly cap', () => {
    const decision = decideFollowUpRequest({
      ...base,
      followUp: followUp({ requestsThisWeek: 4, weekStamp: weekStampOf(NOW) }),
    });
    expect(decision.action).toBe('skip');
    if (decision.action !== 'skip') return;
    expect(decision.reason).toBe('weekly_limit_reached');
  });

  it('resets the weekly counter on a new week', () => {
    const decision = decideFollowUpRequest({
      ...base,
      followUp: followUp({ requestsThisWeek: 9, weekStamp: '1999-01-01' }),
    });
    expect(decision.action).toBe('send_request');
  });

  it('stops messaging a patient who has gone quiet and escalates instead', () => {
    const decision = decideFollowUpRequest({
      ...base,
      followUp: followUp({ consecutiveMisses: 4 }),
    });
    expect(decision.action).toBe('skip');
    if (decision.action !== 'skip') return;
    expect(decision.escalate).toBe(true);
  });

  it('flags a patient with two misses for staff attention', () => {
    const decision = decideFollowUpRequest({ ...base, followUp: followUp({ consecutiveMisses: 2 }) });
    expect(decision.action).toBe('skip');
    if (decision.action !== 'skip') return;
    expect(decision.escalate).toBe(true);
  });

  it('respects a pause and an ended follow-up', () => {
    expect(decideFollowUpRequest({ ...base, followUp: followUp({ pausedAt: NOW }) })).toEqual({
      action: 'skip',
      reason: 'patient_paused',
    });
    expect(
      decideFollowUpRequest({ ...base, followUp: followUp({ status: 'completed' }) }),
    ).toEqual({ action: 'skip', reason: 'follow_up_ended' });
  });

  it('skips a patient with no usable channel', () => {
    expect(decideFollowUpRequest({ ...base, contactable: false, followUp: followUp() })).toEqual({
      action: 'skip',
      reason: 'no_contactable_channel',
    });
  });

  it('defers a request to the configured hour in clinic time', () => {
    // 08:00 UTC is 11:00 in Riyadh, so a 09:00 local request waits for tomorrow.
    const later = scheduledRequestTime(NOW, TZ, 9);
    expect(new Date(later).getTime()).toBeGreaterThan(new Date(NOW).getTime());
    // A request hour that has already passed today also waits.
    expect(new Date(scheduledRequestTime(NOW, TZ, 20)).getTime()).toBeGreaterThan(new Date(NOW).getTime());
  });

  it('rolls counters on request, response and miss', () => {
    let fu = followUp();
    fu = markRequested(fu, NOW);
    expect(fu.requestsSent).toBe(1);
    expect(fu.requestsThisWeek).toBe(1);
    expect(fu.nextDueAt > NOW).toBe(true);

    fu = markResponded(fu, '2026-03-11T08:00:00.000Z');
    expect(fu.consecutiveMisses).toBe(0);
    expect(fu.responsesReceived).toBe(1);
    expect(fu.adherencePercent).toBe(100);

    fu = markMissed(fu, '2026-03-18T08:00:00.000Z');
    expect(fu.consecutiveMisses).toBe(1);
    expect(fu.adherencePercent).toBe(50);
  });

  it('computes adherence without exceeding 100', () => {
    expect(adherencePercent(0, 0)).toBe(0);
    expect(adherencePercent(2, 5)).toBe(100);
    expect(adherencePercent(4, 1)).toBe(25);
  });

  it('pauses and resumes with a reason', () => {
    const paused = setPaused(followUp(), true, 'patient travelling', NOW);
    expect(paused.status).toBe('paused');
    expect(paused.pauseReason).toBe('patient travelling');
    const resumed = setPaused(paused, false, null, NOW);
    expect(resumed.status).toBe('active');
    expect(resumed.pausedAt).toBeNull();
  });
});

function weekStampOf(iso: string): string {
  return `${iso.slice(0, 4)}-${iso.slice(5, 10)}`;
}

describe('critical alerts', () => {
  it('raises an alert for a critical reading', () => {
    const evals = evaluateVitals([
      { kind: 'spo2', value: 88 },
      { kind: 'fasting_glucose', value: 100 },
    ]);
    const alerts = buildAlertsFor(evals, { clinicId: CLINIC, patientId: PATIENT, language: 'en' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe('critical_vital');
    expect(alerts[0]?.severity).toBe('critical');
    expect(alerts[0]?.status).toBe('open');
    expect(alerts[0]?.value).toBe(88);
  });

  it('does not raise an alert for a normal reading', () => {
    const evals = evaluateVitals([{ kind: 'fasting_glucose', value: 95 }]);
    expect(buildAlertsFor(evals, { clinicId: CLINIC, patientId: PATIENT, language: 'en' })).toEqual([]);
  });

  it('routes critical to an immediate page', () => {
    expect(routingFor('critical')).toBe('immediate_page');
    expect(routingFor('warning')).toBe('urgent_review');
    expect(routingFor('info')).toBe('routine_review');
  });

  it('sorts critical alerts first', () => {
    const evals = evaluateVitals([{ kind: 'spo2', value: 85 }, { kind: 'pulse', value: 190 }]);
    const alerts = buildAlertsFor(evals, { clinicId: CLINIC, patientId: PATIENT, language: 'en' });
    const ordered = triageOrder(alerts);
    expect(ordered.length).toBeGreaterThan(0);
    expect(ordered[0]?.severity).toBe('critical');
  });

  it('tells the patient to seek urgent care, in both languages', () => {
    expect(criticalPatientAction('en')).toContain('urgent care');
    expect(criticalPatientAction('ar').length).toBeGreaterThan(10);
  });
});
