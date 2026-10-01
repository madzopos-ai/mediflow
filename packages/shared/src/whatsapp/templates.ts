/**
 * WhatsApp message templates.
 *
 * Every outbound patient message is rendered from this registry rather than
 * being assembled ad hoc, so that:
 *   - a missing placeholder is caught in tests instead of reaching a patient,
 *   - Arabic and English stay in sync (a template cannot exist in one language
 *     only - the type system enforces both),
 *   - opt-out wording is consistent, which is a legal requirement, not a
 *     stylistic choice.
 *
 * Placeholders use `{{name}}` and are substituted verbatim. The template owns
 * all punctuation and phrasing; the caller supplies display-ready values
 * (for example `doctorName` arrives already formatted as "Dr Ahmed" or
 * "د. أحمد" for the patient's language). This keeps rendering predictable -
 * an earlier design that auto-inserted sentence punctuation produced outputs
 * like "10:30.. Dr Ahmed".
 */

import type { Language, ReminderTemplate } from '../domain/enums.js';

export interface TemplateDefinition {
  /** Placeholders that must be supplied. */
  required: readonly string[];
  /** Placeholders substituted when present, dropped cleanly when absent. */
  optional: readonly string[];
  en: string;
  ar: string;
  /** Short label for the admin UI. */
  label: string;
  /**
   * Safety-critical messages are delivered even when a patient has opted out of
   * marketing, because an abnormal reading that goes undelivered is a patient
   * safety failure, not a spam preference. This flag is what exempts a
   * template from the opt-out wording check below.
   */
  safetyCritical?: boolean;
  /**
   * Body text is written by clinic staff, so the library cannot enforce
   * wording on content it does not own. The editor surfaces the opt-out
   * requirement instead of the template validator.
   */
  staffAuthored?: boolean;
}

export const WHATSAPP_TEMPLATES: Record<ReminderTemplate, TemplateDefinition> = {
  appointment_confirm: {
    label: 'Appointment confirmation',
    required: ['patientName', 'clinicName', 'date', 'time'],
    optional: ['doctorName', 'location', 'depositNote', 'cancelUrl'],
    en: `Hello {{patientName}}, your appointment at {{clinicName}} is confirmed for {{date}} at {{time}}.
{{doctorName}}
{{location}}
{{depositNote}}
Need to change it? {{cancelUrl}}
Reply CANCEL to cancel, or RESCHEDULE to pick another time.

To stop these messages reply STOP.`,
    ar: `مرحباً {{patientName}}، تم تأكيد موعدك في {{clinicName}} يوم {{date}} الساعة {{time}}.
{{doctorName}}
{{location}}
{{depositNote}}
هل تحتاج لتغييره؟ {{cancelUrl}}
أرسل CANCEL للإلغاء، أو RESCHEDULE لاختيار وقت آخر.

لإيقاف هذه الرسائل أرسل STOP.`,
  },
  appointment_cancel: {
    label: 'Appointment cancellation',
    required: ['patientName', 'clinicName', 'date', 'time'],
    optional: ['reason', 'rebookUrl', 'feeNote'],
    en: `Hello {{patientName}}, your appointment at {{clinicName}} on {{date}} at {{time}} has been cancelled.
{{reason}}
{{feeNote}}
You are welcome to rebook: {{rebookUrl}}

To stop these messages reply STOP.`,
    ar: `مرحباً {{patientName}}، تم إلغاء موعدك في {{clinicName}} يوم {{date}} الساعة {{time}}.
{{reason}}
{{feeNote}}
يمكنك الحجز مرة أخرى: {{rebookUrl}}

لإيقاف هذه الرسائل أرسل STOP.`,
  },
  appointment_reschedule: {
    label: 'Reschedule options',
    required: ['patientName', 'clinicName', 'date', 'time'],
    optional: ['options', 'bookingUrl'],
    en: `Hello {{patientName}}, let us move your {{date}} {{time}} appointment at {{clinicName}}.

Available times:
{{options}}

Or book online: {{bookingUrl}}

To stop these messages reply STOP.`,
    ar: `مرحباً {{patientName}}، لنغيّر موعدك يوم {{date}} الساعة {{time}} في {{clinicName}}.

الأوقات المتاحة:
{{options}}

أو احجز عبر الإنترنت: {{bookingUrl}}

لإيقاف هذه الرسائل أرسل STOP.`,
  },
  appointment_reminder: {
    label: 'Appointment reminder',
    required: ['patientName', 'clinicName', 'date', 'time'],
    optional: ['doctorName', 'leadTime', 'location', 'prepNote'],
    en: `Hello {{patientName}}, this is a reminder of your appointment at {{clinicName}} {{leadTime}}on {{date}} at {{time}}.
{{doctorName}}
{{location}}
{{prepNote}}
Reply YES to confirm, or CANCEL if you cannot attend.

To stop these messages reply STOP.`,
    ar: `مرحباً {{patientName}}، تذكير بموعدك في {{clinicName}} {{leadTime}}يوم {{date}} الساعة {{time}}.
{{doctorName}}
{{location}}
{{prepNote}}
أرسل YES للتأكيد، أو CANCEL إذا لم تستطع الحضور.

لإيقاف هذه الرسائل أرسل STOP.`,
  },
  medication_schedule: {
    label: 'Medication schedule',
    required: ['patientName', 'drugName'],
    optional: ['dose', 'frequency', 'dates', 'instructions', 'refillAt'],
    en: `Hello {{patientName}}, your medication schedule:

{{drugName}}
{{dose}}
{{frequency}}
{{dates}}
{{instructions}}
{{refillAt}}

Take it exactly as prescribed and contact the clinic if you feel unwell.

To stop these messages reply STOP.`,
    ar: `مرحباً {{patientName}}، جدول دواءك:

{{drugName}}
{{dose}}
{{frequency}}
{{dates}}
{{instructions}}
{{refillAt}}

تناوله حسب الوصفة تماماً وتواصل مع العيادة إذا شعرت بتوعك.

لإيقاف هذه الرسائل أرسل STOP.`,
  },
  vitals_request: {
    label: 'Vitals request',
    required: ['patientName', 'vitalList'],
    optional: ['clinicName', 'example', 'deadline', 'instructions'],
    en: `Hello {{patientName}}, please send us your readings for today from {{clinicName}}.

{{vitalList}}

Just reply with the numbers, for example {{example}}.
{{deadline}}
{{instructions}}
We will review them and contact you if anything needs attention.

To stop these messages reply STOP.`,
    ar: `مرحباً {{patientName}}، نرجو إرسال قراءاتك لليوم من {{clinicName}}.

{{vitalList}}

أرسل الأرقام فقط، مثل {{example}}.
{{deadline}}
{{instructions}}
سنراجعها ونتواصل معك إذا لزم الأمر.

لإيقاف هذه الرسائل أرسل STOP.`,
  },
  vitals_ack: {
    label: 'Vitals received',
    required: ['patientName', 'summary'],
    optional: ['advice', 'nextRequest'],
    en: `Hello {{patientName}}, we received your readings: {{summary}}.
{{advice}}
{{nextRequest}}

Thank you for keeping your log up to date.

To stop these messages reply STOP.`,
    ar: `مرحباً {{patientName}}، استلمنا قراءاتك: {{summary}}.
{{advice}}
{{nextRequest}}

شكراً لالتزامك بتسجيل قراءاتك.

لإيقاف هذه الرسائل أرسل STOP.`,
  },
  vitals_critical_alert: {
    label: 'Critical reading acknowledgement to patient',
    required: ['patientName', 'reading', 'action'],
    optional: ['clinicPhone'],
    // No STOP wording on purpose: this goes out even if the patient opted out.
    safetyCritical: true,
    en: `Hello {{patientName}}, we have received your reading: {{reading}}.

{{action}}

A doctor from the clinic will contact you shortly. If you feel very unwell, do not wait for us.
{{clinicPhone}}`,
    ar: `مرحباً {{patientName}}، استلمنا قراءتك: {{reading}}.

{{action}}

سيتواصل معك طبيب من العيادة قريباً. وإذا شعرت بتوعك شديد فلا تنتظرنا.
{{clinicPhone}}`,
  },
  waitlist_slot_offer: {
    label: 'Waitlist slot offer',
    required: ['patientName', 'clinicName', 'date', 'time', 'expiresIn'],
    optional: ['doctorName'],
    en: `Hello {{patientName}}, good news - a slot opened at {{clinicName}} on {{date}} at {{time}}.
{{doctorName}}
Reply YES within {{expiresIn}} to take it, or NO to stay on the list.

To stop these messages reply STOP.`,
    ar: `مرحباً {{patientName}}، خبر جيد - توفر موعد في {{clinicName}} يوم {{date}} الساعة {{time}}.
{{doctorName}}
أرسل YES خلال {{expiresIn}} لحجزه، أو NO للبقاء في قائمة الانتظار.

لإيقاف هذه الرسائل أرسل STOP.`,
  },
  followup_checkin: {
    label: 'Follow-up check-in',
    required: ['patientName', 'clinicName'],
    optional: ['daysSinceVisit', 'question', 'prompt'],
    en: `Hello {{patientName}}, it has been {{daysSinceVisit}} since your last visit at {{clinicName}}.

{{question}}

{{prompt}}

To stop these messages reply STOP.`,
    ar: `مرحباً {{patientName}}، مضى {{daysSinceVisit}} على زيارتك الأخيرة في {{clinicName}}.

{{question}}

{{prompt}}

لإيقاف هذه الرسائل أرسل STOP.`,
  },
  payment_reminder: {
    label: 'Payment reminder',
    required: ['patientName', 'clinicName', 'amount', 'dueDate'],
    optional: ['invoiceNumber', 'itemsSummary', 'paymentUrl'],
    en: `Hello {{patientName}}, a friendly reminder that {{amount}} is outstanding on your account at {{clinicName}}, due by {{dueDate}}.
{{invoiceNumber}}
{{itemsSummary}}
Pay here: {{paymentUrl}}

To stop these messages reply STOP.`,
    ar: `مرحباً {{patientName}}، تذكير بأن المبلغ {{amount}} مستحق على حسابك في {{clinicName}} بتاريخ {{dueDate}}.
{{invoiceNumber}}
{{itemsSummary}}
الدفع عبر: {{paymentUrl}}

لإيقاف هذه الرسائل أرسل STOP.`,
  },
  birthday_wish: {
    label: 'Birthday message',
    required: ['patientName', 'clinicName'],
    optional: ['age'],
    en: `Happy birthday {{patientName}}{{age}}! Wishing you good health from everyone at {{clinicName}}.

To stop these messages reply STOP.`,
    ar: `عيد ميلاد سعيد {{patientName}}{{age}}! نتمنى لك الصحة من كل فريق {{clinicName}}.

لإيقاف هذه الرسائل أرسل STOP.`,
  },
  custom: {
    label: 'Custom message',
    required: ['body'],
    optional: [],
    staffAuthored: true,
    en: '{{body}}',
    ar: '{{body}}',
  },
};

/** Sent when a patient replies with an opt-out keyword. Required by law in most markets. */
export const OPT_OUT_TEMPLATE: TemplateDefinition = {
  label: 'Opt-out confirmation',
  required: ['clinicName'],
  optional: [],
  en: `You will no longer receive messages from {{clinicName}}. Your care is unaffected.

Reply START to receive messages again.`,
  ar: `لن تصلك رسائل من {{clinicName}} بعد الآن. لن يتأثر رعايتك الطبية.

أرسل START لاستقبال الرسائل مرة أخرى.`,
};

/** Sent when a patient reverses a previous opt-out. */
export const OPT_IN_TEMPLATE: TemplateDefinition = {
  label: 'Opt-in confirmation',
  required: ['clinicName'],
  optional: [],
  en: `Thank you - messages from {{clinicName}} are switched back on. Reply STOP at any time to stop.`,
  ar: `شكراً لك - تم تفعيل رسائل {{clinicName}} مرة أخرى. أرسل STOP في أي وقت لإيقافها.`,
};

export type RenderResult =
  | { ok: true; body: string; language: Language }
  | { ok: false; missing: readonly string[]; language: Language };

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function placeholdersIn(body: string): Set<string> {
  const found = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name) found.add(name);
  }
  return found;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === '';
}

function substitute(body: string, vars: Readonly<Record<string, unknown>>): string {
  return body.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name];
    return isBlank(value) ? '' : String(value).trim();
  });
}

/**
 * Tidy the rendered text.
 *
 * Optional placeholders sit on their own lines, so dropping one leaves a blank
 * line. Any punctuation that ended up orphaned next to a dropped value (for
 * example "confirmed for {{date}} at {{time}}." followed by a missing
 * `{{doctorName}}` line) is removed rather than shipped to a patient.
 */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    // Drop lines left with nothing but punctuation, and any dangling
    // separator that a dropped value orphaned.
    .filter((line) => line !== '' && !/^[.,:;!?\-–—]+$/.test(line))
    .join('\n')
    // Collapse a doubled full stop produced by adjacent optional sentences.
    .replace(/\.\s*\.(?=\s|$)/g, '.')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Every placeholder a template actually uses, in either language. */
export function templatePlaceholders(template: ReminderTemplate): {
  required: string[];
  optional: string[];
  undeclared: string[];
} {
  const definition = WHATSAPP_TEMPLATES[template];
  const used = new Set<string>();
  for (const body of [definition.en, definition.ar]) {
    for (const name of placeholdersIn(body)) used.add(name);
  }

  const required = definition.required.filter((n) => used.has(n));
  const optional = definition.optional.filter((n) => used.has(n));
  const undeclared = [...used].filter((n) => !required.includes(n) && !optional.includes(n));

  return { required, optional, undeclared };
}

/** Render a template. Reports missing required variables instead of throwing. */
export function renderTemplate(
  template: ReminderTemplate,
  language: Language,
  vars: Readonly<Record<string, unknown>>,
): RenderResult {
  const definition = WHATSAPP_TEMPLATES[template];
  const body = language === 'ar' ? definition.ar : definition.en;

  const missing = templatePlaceholders(template).required.filter((name) => isBlank(vars[name]));
  if (missing.length) {
    return { ok: false, missing, language };
  }
  return { ok: true, body: tidy(substitute(body, vars)), language };
}

/** Render a bare template such as the opt-out confirmation. */
export function renderDefinition(
  definition: TemplateDefinition,
  language: Language,
  vars: Readonly<Record<string, unknown>>,
): RenderResult {
  const body = language === 'ar' ? definition.ar : definition.en;
  const missing = [...placeholdersIn(body)].filter((name) => isBlank(vars[name]));
  if (missing.length) {
    return { ok: false, missing, language };
  }
  return { ok: true, body: tidy(substitute(body, vars)), language };
}

/**
 * Fallback used when a template cannot be rendered.
 *
 * Sending a degraded but truthful message beats sending a broken one, but the
 * fallback must still carry the opt-out line.
 */
export function renderFallback(language: Language, clinicName: string): string {
  return language === 'ar'
    ? `رسالة من ${clinicName}.\n\nلإيقاف هذه الرسائل أرسل STOP.`
    : `A message from ${clinicName}.\n\nReply STOP to stop these messages.`;
}

/**
 * Consistency check for the template library.
 *
 * A template that uses an undeclared placeholder, declares a variable it never
 * uses, or whose two languages have drifted apart is a bug: the drift is
 * invisible in review and ships a broken message to a patient.
 */
export function validateTemplateLibrary(): { template: string; problem: string }[] {
  const problems: { template: string; problem: string }[] = [];

  for (const [key, definition] of Object.entries(WHATSAPP_TEMPLATES) as [ReminderTemplate, TemplateDefinition][]) {
    const enUsed = placeholdersIn(definition.en);
    const arUsed = placeholdersIn(definition.ar);

    for (const name of enUsed) {
      if (!arUsed.has(name)) {
        problems.push({ template: key, problem: `placeholder {{${name}}} is missing from the Arabic body` });
      }
    }
    for (const name of arUsed) {
      if (!enUsed.has(name)) {
        problems.push({ template: key, problem: `placeholder {{${name}}} is missing from the English body` });
      }
    }
    for (const name of definition.required) {
      if (!enUsed.has(name)) {
        problems.push({ template: key, problem: `required variable "${name}" is never used in the body` });
      }
    }
    for (const name of definition.optional) {
      if (!enUsed.has(name)) {
        problems.push({ template: key, problem: `optional variable "${name}" is never used in the body` });
      }
    }
    for (const name of enUsed) {
      if (!definition.required.includes(name) && !definition.optional.includes(name)) {
        problems.push({ template: key, problem: `placeholder {{${name}}} is used but not declared` });
      }
    }
    if (!definition.en.trim() || !definition.ar.trim()) {
      problems.push({ template: key, problem: 'template body is empty' });
    }
    // Every generated, non-safety-critical patient-facing message must carry
    // the opt-out instruction. Two categories are deliberately exempt:
    // `safetyCritical` (a patient must not be able to opt out of a critical
    // reading alert) and `staffAuthored` (clinic staff own that wording).
    if (!definition.safetyCritical && !definition.staffAuthored && !/\bSTOP\b/.test(definition.en)) {
      problems.push({ template: key, problem: 'English body is missing the STOP opt-out instruction' });
    }
  }

  for (const [name, definition] of [
    ['opt_out', OPT_OUT_TEMPLATE],
    ['opt_in', OPT_IN_TEMPLATE],
  ] as [string, TemplateDefinition][]) {
    for (const required of definition.required) {
      if (!placeholdersIn(definition.en).has(required) || !placeholdersIn(definition.ar).has(required)) {
        problems.push({ template: name, problem: `required variable "${required}" is not used in both bodies` });
      }
    }
  }

  return problems;
}

/**
 * Opt-out keywords, matched case-insensitively on the raw inbound text.
 *
 * Arabic keywords are written as `\u` escapes on purpose. A single wrong
 * codepoint in a raw Arabic literal is invisible in review and silently
 * disables opt-out for that word, which is a compliance failure - this table
 * must fail loudly (in tests) rather than quietly miss.
 */
export const OPT_OUT_KEYWORDS: readonly string[] = [
  'stop',
  'unsubscribe',
  'cancel subscription',
  'end',
  'quit',
  'leave',
  '\u0625\u0642\u064A\u0627\u0639', // إيقاف
  '\u0627\u064A\u0642\u0627\u0639', // ايقاف (transposed typo, same letters)
  '\u062A\u0648\u0642\u0641', // توقف
  '\u0627\u0644\u063A\u0627\u0621 \u0627\u0644\u0627\u0634\u062A\u0631\u0627\u0643', // الغاء الاشتراك
  '\u0625\u0646\u0647\u0627\u0621', // إنهاء
  '\u0627\u0644\u062A\u0648\u0642\u0641', // التوقف
];

/** Opt-in keywords, used to reverse a previous opt-out. */
export const OPT_IN_KEYWORDS: readonly string[] = [
  'start',
  'subscribe',
  'resume',
  'yes please',
  '\u062A\u0641\u0639\u064A\u0644', // تفعيل
  '\u0627\u0634\u062A\u0631\u0627\u0643', // اشتراك
  '\u0645\u062A\u0627\u0628\u0639\u0629', // متابعة
];

/** Settings-screen summary of the template library. */
export function templateLibraryStats(): { total: number; problems: number } {
  return { total: Object.keys(WHATSAPP_TEMPLATES).length, problems: validateTemplateLibrary().length };
}
