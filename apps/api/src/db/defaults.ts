/**
 * Default clinic configuration.
 *
 * A new clinic must be usable immediately, so these defaults are deliberately
 * conservative: reminders on, marketing off, deposits off, and quiet hours
 * outside waking hours. Anything that could send a patient an unexpected
 * message or hold money is opt-in.
 */

import type {
  BookingPolicy,
  ClinicSchedule,
  ClinicSettings,
  FeatureToggles,
  FollowUpPolicy,
  ReminderPolicy,
  WorkingHours,
} from '@mediflow/shared';

const BREAKS: WorkingHours['breaks'] = [{ start: '12:30', end: '13:30', label: 'Lunch break' }];
const BREAKS_AR: WorkingHours['breaks'] = [{ start: '12:30', end: '13:30', label: 'استراحة الغداء' }];

/** Sunday-Thursday 09:00-17:00, Friday half day, Saturday closed. */
export function defaultWorkingHours(locale: 'en' | 'ar' = 'en'): WorkingHours[] {
  const breaks = locale === 'ar' ? BREAKS_AR : BREAKS;
  return [
    { weekday: 0, enabled: true, start: '09:00', end: '17:00', breaks },
    { weekday: 1, enabled: true, start: '09:00', end: '17:00', breaks },
    { weekday: 2, enabled: true, start: '09:00', end: '17:00', breaks },
    { weekday: 3, enabled: true, start: '09:00', end: '17:00', breaks },
    { weekday: 4, enabled: true, start: '09:00', end: '17:00', breaks },
    { weekday: 5, enabled: true, start: '09:00', end: '13:00', breaks: [] },
    { weekday: 6, enabled: false, start: '09:00', end: '13:00', breaks: [] },
  ];
}

export function defaultSchedule(clinicId: string, locale: 'en' | 'ar' = 'en'): ClinicSchedule {
  const now = new Date().toISOString();
  return {
    // One schedule row per clinic, keyed by clinic id so it needs no lookup.
    id: `sched_${clinicId}`,
    clinicId,
    workingHours: defaultWorkingHours(locale),
    slotDurationMinutes: 20,
    bufferMinutes: 10,
    maxDailyAppointments: 24,
    holidays: [],
    blockedWindows: [],
    slotIntervalMinutes: 20,
    allowWalkIn: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function defaultBookingPolicy(): BookingPolicy {
  return {
    enabled: true,
    minNoticeHours: 2,
    maxAdvanceDays: 60,
    holdMinutes: 15,
    autoConfirmWithoutDeposit: true,
    requirePhoneVerification: false,
    allowWaitlistJoin: true,
    bufferMinutes: 10,
  };
}

export function defaultReminderPolicy(): ReminderPolicy {
  return {
    enabled: true,
    defaultOffsetsMinutes: [1440, 120],
    channels: ['whatsapp'],
    template: 'appointment_reminder',
    // Extra nudges for chronic / high-risk patients only.
    chronicExtraOffsetsMinutes: [4320, 60],
    quietHours: { startHour: 22, endHour: 7 },
    minLeadMinutes: 30,
    paused: false,
  };
}

export function defaultFollowUpPolicy(): FollowUpPolicy {
  return {
    enabled: true,
    defaultIntervalDays: 7,
    requestAfterHours: 9,
    noReplyEscalationHours: 24,
    maxRequestsPerWeek: 3,
  };
}

export function defaultFeatureToggles(): FeatureToggles {
  return {
    requireDepositOnBooking: false,
    defaultDepositAmountMinor: 0,
    defaultDepositMethod: 'none',
    allowCashInsteadOfDeposit: true,
    automatedWhatsappReminders: true,
    automatedMedicationNotifications: false,
    automatedChronicFollowUps: true,
    criticalValueAlerts: true,
    publicBookingLink: true,
    ePrescriptions: false,
    // Decision support stays on rules until a provider is configured, and
    // always requires a doctor to sign off.
    aiDecisionSupport: true,
    aiVoiceSummaries: false,
    requireDepositToConfirmAppointment: false,
  };
}

export function defaultSettings(): ClinicSettings {
  return {
    features: defaultFeatureToggles(),
    reminders: defaultReminderPolicy(),
    followUps: defaultFollowUpPolicy(),
    booking: defaultBookingPolicy(),
    whatsapp: {
      enabled: true,
      provider: 'simulator',
      senderPhoneId: null,
      displayName: null,
      defaultDialCode: '966',
      maxRetries: 5,
      retryBackoffSeconds: 60,
      sessionLabel: null,
      alertRecipients: [],
    },
    ai: {
      enabled: false,
      provider: 'rules_only',
      model: 'rules-only',
      temperature: 0,
      requireDoctorApproval: true,
      maxTokens: 1500,
      deIdentify: true,
    },
    finance: {
      currency: 'USD',
      defaultConsultationFeeMinor: 0,
      taxPercent: 0,
      receiptPrefix: 'RCP',
      paymentReminderAfterDays: 7,
    },
    notifications: {
      doctorAlertChannel: 'whatsapp',
      criticalAlertChannel: 'whatsapp',
      inApp: true,
      quietHours: { startHour: 22, endHour: 7 },
    },
  };
}
