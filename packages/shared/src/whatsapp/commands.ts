/**
 * Inbound WhatsApp intent router.
 *
 * A patient reply is ambiguous by nature - "yes", "2", "cancel", "150 90" are
 * all things a patient might send, and the correct meaning depends on what the
 * clinic asked last. The router therefore takes conversation context and
 * applies a fixed precedence, documented in `routeInbound`.
 *
 * Precedence is a safety decision, not a style choice:
 *   1. Opt-out always wins, even when the message also carries readings, so a
 *      compliance keyword is never lost in a long text. Readings are still
 *      returned so the data is not thrown away.
 *   2. Explicit symptom urgency outranks number parsing, because a patient
 *      reporting chest pain must reach a human even if they also sent a BP.
 *   3. A bare number is only read as a slot choice when the clinic actually
 *      offered numbered slots. Otherwise "2" would be swallowed as a vital
 *      reading.
 *   4. Only then does the reply fall through to vitals parsing.
 */

import type { ParsedReply } from '../clinical/replyParser.js';
import { normalizeText, parseVitalsReply, type ParseContext } from '../clinical/replyParser.js';
import { OPT_IN_KEYWORDS, OPT_OUT_KEYWORDS } from './templates.js';

export interface InboundContext extends ParseContext {
  /** The clinic just offered numbered slots, so a bare number selects one. */
  pendingSlotOffer?: boolean;
  /** The clinic asked YES/CANCEL about a specific appointment. */
  awaitingAppointmentResponse?: boolean;
  /** Default true. A transactional-only bot may disable marketing opt-out. */
  acceptOptOut?: boolean;
}

export type InboundIntent =
  | { kind: 'opt_out'; text: string }
  | { kind: 'opt_in'; text: string }
  | { kind: 'confirm'; text: string }
  | { kind: 'cancel'; text: string }
  | { kind: 'reschedule'; text: string }
  | { kind: 'slot_choice'; option: number; text: string }
  | { kind: 'help'; text: string }
  | { kind: 'human_handover'; text: string }
  | { kind: 'vitals'; parse: ParsedReply; urgent: boolean }
  | { kind: 'opt_out_with_readings'; text: string; parse: ParsedReply }
  | { kind: 'unrecognised'; text: string; parse: ParsedReply };

/**
 * Fold Arabic orthographic variants so keyword tables only need one spelling.
 *
 * A patient typing "ايقاع" must match a template saying "إيقاف". Without this,
 * opt-out detection silently fails on common misspellings, which is the worst
 * possible place for a typo to matter.
 */
export function foldArabic(input: string): string {
  return normalizeText(input)
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // آ أ إ ٱ -> ا
    .replace(/\u0629/g, '\u0647') // ة -> ه
    .replace(/\u0649/g, '\u064A') // ى -> ي
    .replace(/[\u0624]/g, '\u0648') // ؤ -> و
    .replace(/[\u0626]/g, '\u064A') // ئ -> ي
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsKeyword(folded: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => folded.includes(foldArabic(keyword)));
}

const CONFIRM_WORDS = ['yes', 'y', 'yep', 'yeah', 'yup', 'sure', 'ok', 'okay', 'confirm', 'confirmed', 'accepted', 'perfect', 'thanks', 'نعم', 'ايوه', 'تمام', 'موافق', 'اكيد', 'مؤكد', 'شكرا'];
const CANCEL_WORDS = ['cancel', 'cannot', 'cant', "can't", 'no', 'nope', 'sorry', 'unwell', 'sick', 'surgery', 'dead', 'deadline', 'الغاء', 'الغي', 'ما اقدر', 'مش هقدر', 'موافق', 'اعتذار', 'عندي سبب'];
const RESCHEDULE_WORDS = ['reschedule', 'change', 'change time', 'other time', 'different time', 'move', 'another day', 'postpone', 'تغيير', 'تغير', 'موعد اخر', 'وقت اخر', 'اخر', 'تاجيل', 'تأجيل'];
const HELP_WORDS = ['help', 'menu', 'info', '?', '؟', 'مساعدة', 'مساعده', 'كيف', 'معلومات', 'القائمة'];
const HANDOVER_WORDS = ['doctor', 'doctor please', 'clinic', 'nurse', 'speak to someone', 'call me', 'someone please', 'طبيب', 'دكتور', 'موظف', 'كلمني', 'اتصل', 'حد يكلمني', 'كلمني مع'];

/**
 * Danger phrases that must reach a human regardless of any numbers present.
 *
 * These are regexes against the *folded* text, and the Arabic patterns are
 * written in folded form (ا for أ/إ/آ, ه for ة, و for ؤ, ي for ى/ئ) because
 * `foldArabic` runs before the match.
 *
 * Arabic word order breaks naive substring matching: "ألم شديد في الصدر" (severe
 * pain in the chest) never contains the literal substring "ألم في الصدر", so
 * severity and location are matched as separate terms with a bounded gap
 * between them. The gap is bounded on purpose - an unbounded `.*` would let
 * "pain" anywhere in a long message escalate a routine one.
 */
const URGENT_PATTERNS: readonly RegExp[] = [
  // English
  /\bchest\s*pain\b/,
  /\b(can\s*not|cant|unable\s*to)\s*breath(e|ing)\b/,
  /\bbreathless\b/,
  /\bheart\s*attack\b/,
  /\bstroke\b/,
  /\b(unconscious|passed\s*out|fainted)\b/,
  /\bseizure\b/,
  /\bconvulsion/,
  /\b(heavy|severe)\s*bleeding\b/,
  /\bvomiting\s*blood\b/,
  /\bblood\s*in\s*(vomit|stool)\b/,
  /\bblack\s*stool\b/,
  /\bsuicid/,
  /\boverdose\b/,
  /\bswallowed\s+(the\s+)?(tablets|pills)\b/,
  /\banaphyla/,
  /\bthroat\s*(is\s*)?closing\b/,
  /\b(confused|confusion)\b/,
  /\bdifficulty\s*waking\b/,
  /\bnumbness\s+(in|on)\s+one\s+side\b/,
  /\bslurred\s*speech\b/,
  /\b(severe|sudden)\s+headache\b/,
  /\b(sudden\s+)?blurred\s*vision\b/,
  /\bcan'?t\s+speak\b/,
  // Arabic (folded form)
  // Note `(?:ال)?` and not `ال?`: the latter means "ا" followed by an optional
  // "ل", so it silently never matched the definite article at all.
  /(?:ال)?الم\s+شديد\s+في\s+(?:ال)?صدر/,
  /(?:ال)?الم\s+في\s+(?:ال)?صدر/,
  /وجع\s+(شديد|كبير)\s+في\s*(?:ال)?صدر/,
  /ما\s*اقدر\s+ات?نفس/,
  /صعوبه\s+في\s+التنفس/,
  /ضيق\s+تنفس/,
  /نوبه?\s+قلبيه/,
  /جلط[هة]/,
  /فقدان\s+وعي/,
  /اغماء/,
  /تشنج/,
  /نزيف\s+شديد/,
  /دم\s+في\s+(?:ال)?قي[ءه]/,
  /دم\s+في\s+(?:ال)?براز/,
  /انتحار/,
  /جرعه\s+زائده/,
  /ابتلع\s+(?:ال)?حبوب/,
  /تسمم/,
  /تورم\s+(?:ال)?وجه/,
  /تضيق\s+(?:ال)?حلق/,
  /تشوش\s+(?:ال)?رؤيه/,
  /صعوبه\s+في\s+التركيز/,
  /لا\s+يوجد\s+وعي/,
  /وجع\s+راس\s+شديد/,
  /صداع\s+شديد/,
  /صداع\s+مفاجئ/,
  /تنميل\s+نص/,
];

function isBareNumber(folded: string): number | null {
  const trimmed = folded.trim();
  // Accept "2", "2.", "#2", "number 2", "الخيار 2".
  const direct = trimmed.match(/^(?:[#ن]?\s*)?(\d{1,2})\s*[.)-]?$/u);
  if (direct?.[1]) return Number(direct[1]);

  const prefixed = trimmed.match(/^(?:option|choice|number|no)\s*(\d{1,2})$/u);
  if (prefixed?.[1]) return Number(prefixed[1]);

  const arabic = folded.replace(/\s+/g, ' ').trim();
  const arabicPrefixed = arabic.match(/^(?:الخيار|خيار|رقم|رقم )\s*(\d{1,2})$/u);
  if (arabicPrefixed?.[1]) return Number(arabicPrefixed[1]);

  return null;
}

function hasUrgentPhrase(raw: string): boolean {
  const folded = foldArabic(raw);
  return URGENT_PATTERNS.some((pattern) => pattern.test(folded));
}

function matchesWordSet(folded: string, words: readonly string[]): boolean {
  const tokens = folded.split(' ').filter(Boolean);
  if (tokens.length === 0) return false;
  // Only treat the reply as a keyword when the whole message is the keyword.
  // This stops "I cannot come on Tuesday, will I get a refund?" from being
  // read as a cancellation.
  if (tokens.length > 4) return false;
  return words.some((word) => {
    const target = foldArabic(word);
    return tokens.some((token) => token === target) || folded === target;
  });
}

/**
 * Route one inbound patient message.
 *
 * Never throws and never returns null: an unrecognised message is a valid
 * outcome that the caller answers with help text or a handover prompt.
 */
export function routeInbound(rawText: string, context: InboundContext = {}): InboundIntent {
  const text = normalizeText(rawText);
  const folded = foldArabic(text);
  const acceptOptOut = context.acceptOptOut !== false;

  // A live expectation from the clinic makes an unambiguous reply available
  // before we do any number parsing.
  if (context.pendingSlotOffer) {
    const option = isBareNumber(folded);
    if (option !== null && option >= 1) {
      return { kind: 'slot_choice', option, text };
    }
  }

  if (acceptOptOut && containsKeyword(folded, OPT_OUT_KEYWORDS)) {
    // Honour the opt-out even inside a longer message, but keep the readings.
    const parse = parseVitalsReply(text, context);
    if (parse.hasReading || parse.urgent) {
      return { kind: 'opt_out_with_readings', text, parse };
    }
    return { kind: 'opt_out', text };
  }

  if (acceptOptOut && containsKeyword(folded, OPT_IN_KEYWORDS)) {
    return { kind: 'opt_in', text };
  }

  if (hasUrgentPhrase(text)) {
    return { kind: 'vitals', parse: parseVitalsReply(text, context), urgent: true };
  }

  if (context.awaitingAppointmentResponse) {
    if (matchesWordSet(folded, CONFIRM_WORDS)) return { kind: 'confirm', text };
    if (matchesWordSet(folded, CANCEL_WORDS)) return { kind: 'cancel', text };
  }

  if (matchesWordSet(folded, RESCHEDULE_WORDS)) return { kind: 'reschedule', text };
  if (matchesWordSet(folded, CANCEL_WORDS) && !matchesWordSet(folded, CONFIRM_WORDS)) {
    return { kind: 'cancel', text };
  }
  if (matchesWordSet(folded, CONFIRM_WORDS)) return { kind: 'confirm', text };
  if (matchesWordSet(folded, HANDOVER_WORDS)) return { kind: 'human_handover', text };
  if (matchesWordSet(folded, HELP_WORDS)) return { kind: 'help', text };

  const parse = parseVitalsReply(text, context);
  if (parse.hasReading) {
    return { kind: 'vitals', parse, urgent: parse.urgent };
  }
  return { kind: 'unrecognised', text, parse };
}

/** Intents that must page a human rather than trigger an automated template. */
export function requiresHumanReview(intent: InboundIntent): boolean {
  if (intent.kind === 'human_handover') return true;
  if (intent.kind === 'vitals') return intent.urgent;
  if (intent.kind === 'opt_out_with_readings') return intent.parse.urgent;
  if (intent.kind === 'unrecognised') return intent.parse.urgent;
  return false;
}

/** Intents that must not be answered automatically. */
export function isAutomationBlocked(intent: InboundIntent): boolean {
  return requiresHumanReview(intent);
}
