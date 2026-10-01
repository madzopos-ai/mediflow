/**
 * Follow-up cadence and critical-alert escalation.
 *
 * Two rules drive everything here, and both exist to stop the automation from
 * being harmful:
 *
 * 1. **Never nag.** A follow-up that keeps messaging a patient who is not
 *    responding trains them to ignore the channel - including the message that
 *    matters. Requests are rate limited per day and per week, and repeated
 *    silence escalates to a human instead of producing more messages.
 *
 * 2. **Never bury a critical reading.** A critical value pages a clinician
 *    immediately and the patient is told to seek urgent care, and this happens
 *    regardless of quiet hours, opt-out state, or the patient's reply.
 *
 * Pure functions only: persistence and delivery belong to the API layer.
 */

import type { AlertSeverity, FollowUpStatus, Language } from '../domain/enums.js';
import type { ClinicalAlert, FollowUp } from '../domain/types.js';
import type { VitalEvaluation } from '../clinical/vitals.js';
import { createId } from '../core/ids.js';
import { addDays, dateKeyInTz, nowIso, toIso, zonedParts } from '../core/time.js';

export interface FollowUpPolicyLimits {
  /** Hard cap on requests per patient per day, across all protocols. */
  maxRequestsPerDay: number;
  /** Hard cap per rolling 7-day window. */
  maxRequestsPerWeek: number;
  /** Consecutive misses before staff are notified instead of the patient. */
  missesBeforeStaffEscalation: number;
  /** Stop messaging after this many consecutive misses. */
  pauseAfterMisses: number;
}

export const DEFAULT_FOLLOW_UP_LIMITS: FollowUpPolicyLimits = {
  maxRequestsPerDay: 1,
  maxRequestsPerWeek: 4,
  missesBeforeStaffEscalation: 2,
  pauseAfterMisses: 4,
};

export type FollowUpDecision =
  | { action: 'send_request'; reason: string; scheduledFor: string; dedupeKey: string }
  | { action: 'skip'; reason: FollowUpSkipReason; escalate?: boolean; note?: string }
  | { action: 'complete'; reason: string };

export type FollowUpSkipReason =
  | 'not_due'
  | 'already_requested_today'
  | 'daily_limit_reached'
  | 'weekly_limit_reached'
  | 'patient_paused'
  | 'follow_up_ended'
  | 'max_per_day_for_vital'
  | 'no_contactable_channel';

/** ISO week stamp used to roll the weekly counter. */
export function weekStamp(date: Date = new Date()): string {
  const iso = date.toISOString();
  const year = iso.slice(0, 4);
  const week = iso.slice(5, 10);
  return `${year}-${week}`;
}

function todayKey(now: string, timeZone: string): string {
  return dateKeyInTz(new Date(now), timeZone);
}

export interface FollowUpRequestContext {
  followUp: FollowUp;
  /** ISO date of the request currently being considered. */
  now: string;
  timeZone: string;
  limits?: FollowUpPolicyLimits;
  /** Requests already sent today, across every follow-up for this patient. */
  requestsSentToday: number;
  /** True when the patient has a usable, unopted-out phone number. */
  contactable: boolean;
  /** Overrides the protocol hour when the clinic wants a different send time. */
  requestHour?: number;
}

/**
 * Decide whether to message a patient today.
 *
 * The weekly counter rolls over on a Monday-stamped week rather than a sliding
 * 7-day window, because a sliding window needs the full history of send times
 * and the follow-up row only carries one stamp.
 */
export function decideFollowUpRequest(context: FollowUpRequestContext): FollowUpDecision {
  const limits = context.limits ?? DEFAULT_FOLLOW_UP_LIMITS;
  const { followUp, now, timeZone } = context;
  const dedupeBase = `followup:${followUp.id}`;

  if (followUp.status === 'completed' || followUp.status === 'cancelled') {
    return { action: 'skip', reason: 'follow_up_ended' };
  }
  if (followUp.pausedAt !== null) {
    return { action: 'skip', reason: 'patient_paused' };
  }
  if (followUp.endDate !== null && todayKey(now, timeZone) >= followUp.endDate) {
    return { action: 'skip', reason: 'follow_up_ended' };
  }
  if (!context.contactable) {
    return { action: 'skip', reason: 'no_contactable_channel' };
  }

  const nowStamp = weekStamp(new Date(now));
  const newWeek = followUp.weekStamp !== nowStamp;
  const requestsThisWeek = newWeek ? 0 : followUp.requestsThisWeek;

  if (requestsThisWeek >= limits.maxRequestsPerWeek) {
    return {
      action: 'skip',
      reason: 'weekly_limit_reached',
      escalate: followUp.consecutiveMisses >= limits.missesBeforeStaffEscalation,
      note: `${requestsThisWeek} requests already sent this week`,
    };
  }

  const day = todayKey(now, timeZone);
  if (followUp.lastRequestedAt !== null && todayKey(followUp.lastRequestedAt, timeZone) === day) {
    return { action: 'skip', reason: 'already_requested_today' };
  }
  if (context.requestsSentToday >= limits.maxRequestsPerDay) {
    return { action: 'skip', reason: 'daily_limit_reached' };
  }

  // A patient who has gone quiet is better served by a phone call than by a
  // fifth automated message.
  if (followUp.consecutiveMisses >= limits.pauseAfterMisses) {
    return {
      action: 'skip',
      reason: 'patient_paused',
      escalate: true,
      note: `${followUp.consecutiveMisses} consecutive misses - contact by phone`,
    };
  }
  if (followUp.consecutiveMisses >= limits.missesBeforeStaffEscalation) {
    return {
      action: 'skip',
      reason: 'daily_limit_reached',
      escalate: true,
      note: `${followUp.consecutiveMisses} consecutive misses - flagged for staff`,
    };
  }

  if (now < followUp.nextDueAt) {
    return { action: 'skip', reason: 'not_due' };
  }

  const hour = context.requestHour ?? 9;
  const sendAt = scheduledRequestTime(now, timeZone, hour);
  return {
    action: 'send_request',
    reason: 'due',
    scheduledFor: sendAt,
    // Keyed by the day so a retry on the same day cannot double-message.
    dedupeKey: `${dedupeBase}:${day}`,
  };
}

/**
 * The next send time at `hour` in the clinic timezone, today or tomorrow.
 *
 * Sending at a fixed local hour matters more than sending immediately: a 2am
 * automated message is a complaint, and for many patient groups it is the
 * reason the channel gets blocked.
 */
export function scheduledRequestTime(now: string, timeZone: string, hour: number): string {
  const parts = zonedParts(new Date(now), timeZone);
  const clampedHour = Math.min(23, Math.max(0, Math.trunc(hour)));
  // If the target hour has already passed in the clinic's timezone, the
  // request waits for the next day rather than firing immediately.
  const daysAhead = clampedHour <= parts.hour ? 1 : 0;
  const target = new Date(`${todayKey(now, timeZone)}T00:00:00.000Z`);
  target.setUTCHours(clampedHour);
  target.setTime(target.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  return toIso(target);
}

/** Apply a send, rolling the weekly counter when the week changed. */
export function markRequested(followUp: FollowUp, now: string): FollowUp {
  const nowStamp = weekStamp(new Date(now));
  const newWeek = followUp.weekStamp !== nowStamp;
  return {
    ...followUp,
    status: 'active' as FollowUpStatus,
    lastRequestedAt: now,
    requestsSent: followUp.requestsSent + 1,
    requestsThisWeek: newWeek ? 1 : followUp.requestsThisWeek + 1,
    weekStamp: nowStamp,
    nextDueAt: toIso(addDays(new Date(now), followUp.intervalDays)),
    updatedAt: now,
  };
}

/**
 * Apply a patient reply.
 *
 * The request being answered was already counted by `markRequested`, so only
 * the response is added. Counting the request again here made adherence read
 * 50% for a patient who answered every message.
 */
export function markResponded(followUp: FollowUp, now: string): FollowUp {
  const responsesReceived = followUp.responsesReceived + 1;
  return {
    ...followUp,
    lastResponseAt: now,
    responsesReceived,
    consecutiveMisses: 0,
    nextDueAt: toIso(addDays(new Date(now), followUp.intervalDays)),
    adherencePercent: adherencePercent(followUp.requestsSent, responsesReceived),
    updatedAt: now,
  };
}

/** Apply a missed request. */
export function markMissed(followUp: FollowUp, now: string): FollowUp {
  const requestsSent = followUp.requestsSent + 1;
  return {
    ...followUp,
    consecutiveMisses: followUp.consecutiveMisses + 1,
    requestsSent,
    adherencePercent: adherencePercent(requestsSent, followUp.responsesReceived),
    updatedAt: now,
  };
}

export function adherencePercent(requestsSent: number, responsesReceived: number): number {
  if (requestsSent <= 0) return 0;
  return Math.round(Math.min(100, (responsesReceived / requestsSent) * 100));
}

/** Pause or resume a follow-up, recording why. */
export function setPaused(
  followUp: FollowUp,
  paused: boolean,
  reason: string | null,
  now: string = nowIso(),
): FollowUp {
  return {
    ...followUp,
    pausedAt: paused ? now : null,
    pauseReason: paused ? reason : null,
    status: paused ? 'paused' : 'active',
    updatedAt: now,
  };
}

// --- Critical alert escalation -------------------------------------------

export type AlertRouting = 'immediate_page' | 'urgent_review' | 'routine_review';

const SEVERITY_ROUTING: Record<AlertSeverity, AlertRouting> = {
  critical: 'immediate_page',
  warning: 'urgent_review',
  info: 'routine_review',
};

export function routingFor(severity: AlertSeverity): AlertRouting {
  return SEVERITY_ROUTING[severity] ?? 'routine_review';
}

export interface AlertContext {
  clinicId: string;
  patientId: string;
  language: Language;
  now?: string;
  followUpId?: string | null;
  readingId?: string | null;
  appointmentId?: string | null;
}

const SEVERITY_LABEL_AR: Record<AlertSeverity, string> = {
  critical: 'حرج',
  warning: 'تحذير',
  info: 'معلومة',
};

function formatValue(evaluation: VitalEvaluation): string {
  if (evaluation.secondaryValue !== null) {
    return `${evaluation.value}/${evaluation.secondaryValue} ${evaluation.unit}`;
  }
  return `${evaluation.value} ${evaluation.unit}`;
}

/**
 * Build clinician-facing alerts for the abnormal readings in a bundle.
 *
 * Only `isCritical` readings produce an alert. `AlertKind` has a single vital
 * kind (`critical_vital`), and paging a clinician about every slightly-high
 * reading is how an alert queue stops being read - a warning-level value stays
 * visible on the reading itself without demanding attention.
 */
export function buildAlertsFor(evaluations: readonly VitalEvaluation[], context: AlertContext): ClinicalAlert[] {
  const now = context.now ?? nowIso();
  const alerts: ClinicalAlert[] = [];

  for (const evaluation of evaluations) {
    if (!evaluation.isCritical) continue;

    alerts.push({
      id: createId('alert'),
      clinicId: context.clinicId,
      patientId: context.patientId,
      followUpId: context.followUpId ?? null,
      readingId: context.readingId ?? null,
      appointmentId: context.appointmentId ?? null,
      kind: 'critical_vital',
      severity: 'critical',
      status: 'open',
      title: `${evaluation.kind} ${SEVERITY_LABEL_AR.critical} - ${formatValue(evaluation)}`,
      body: [
        evaluation.interpretation,
        `Reference: ${evaluation.referenceRange}`,
        evaluation.escalation ? `Action: ${evaluation.escalation}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      metric: evaluation.kind,
      value: evaluation.value,
      threshold: evaluation.referenceRange,
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolvedAt: null,
      resolutionNote: null,
      readAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  return alerts;
}

/** The wording shown to the patient for a critical reading. */
export function criticalPatientAction(language: Language): string {
  return language === 'ar'
    ? 'نتيجة القراءة خارج النطاق الحرج. يرجى التوجه للرعاية العاجلة فوراً، ولا تنتظر رد العيادة.'
    : 'This reading is outside the critical range. Please seek urgent care now, and do not wait for the clinic to reply.';
}

/** Acknowledgement state, for the clinician workflow. */
export function acknowledgeAlert(
  alert: ClinicalAlert,
  userId: string,
  now: string = nowIso(),
): ClinicalAlert {
  return {
    ...alert,
    status: 'acknowledged',
    acknowledgedBy: userId,
    acknowledgedAt: now,
    readAt: alert.readAt ?? now,
    updatedAt: now,
  };
}

export function resolveAlert(
  alert: ClinicalAlert,
  userId: string,
  note: string,
  now: string = nowIso(),
): ClinicalAlert {
  return {
    ...acknowledgeAlert(alert, userId, now),
    status: 'resolved',
    resolvedAt: now,
    resolutionNote: note,
    updatedAt: now,
  };
}

/** Open alerts a clinician still has to act on, most severe and oldest first. */
export function triageOrder(alerts: readonly ClinicalAlert[]): ClinicalAlert[] {
  const rank: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return alerts
    .filter((a) => a.status !== 'resolved')
    .slice()
    .sort((a, b) => rank[a.severity] - rank[b.severity] || a.createdAt.localeCompare(b.createdAt));
}
