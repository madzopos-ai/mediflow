/**
 * AI-style voice-note structuring (P2, rule-based on-device assist).
 *
 * The doctor dictates free text (Arabic or English); this parser structures it
 * into { diagnosis, vitals, prescriptions, labOrders } for one-click review. It
 * is explicitly an assist, not a model: every suggestion is shown to the
 * doctor, who picks what enters the chart. Nothing is saved automatically.
 *
 * Design notes:
 *   - Vital extraction is delegated to `parseVitalsReply`, the same parser the
 *     WhatsApp inbound path uses, so a dictated "الضغط ١٤٠/٩٠" and a texted one
 *     land identically. Only label-attributed readings are kept: an unlabelled
 *     number is never guessed into a chart field.
 *   - Drug names are resolved against the shared catalogue
 *     (`resolveMedicationString`), so a brand name becomes its generic and the
 *     allergy and interaction engines can screen the suggestion.
 *   - Free-text fields (frequency) stay verbatim in the doctor's own words.
 *     Normalising clinical wording from speech risks quietly changing meaning.
 *
 * Heuristics (bilingual ar/en):
 *   - diagnosis: after `تشخيص/التشخيص/diagnosis/dx:`.
 *   - vitals: a labelled vital plus a number, including BP pairs (140/90,
 *     140 over 90, 140 على 90) and spoken numbers (مئة وأربعين).
 *   - medications: lines with dose units (mg/ملغ/غ/g, حبة/tablet, مرات/daily)
 *     or a known drug-name hit, split into drug/dose/frequency/duration.
 *   - lab orders: lines naming a test (hba1c/سكر تراكمي, cbc/تعداد, ldl/دهون,
 *     creatinine/كرياتينين, تحليل/فحص/test/تحاليل ...).
 */

import type { VitalKind } from '../domain/enums.js';
import { parseVitalsReply } from './replyParser.js';
import { resolveMedicationString } from './drugs.js';
import { arabicNumbersToDigits } from './arabicNumbers.js';

export interface DictatedPrescription {
  /** Catalogue generic name when recognised, else the dictated text. */
  drug: string;
  /** Verbatim dose phrase, e.g. "5 ملغ". Null when not dictated. */
  dose: string | null;
  /** Verbatim frequency phrase, e.g. "يومياً". Null when not dictated. */
  frequency: string | null;
  durationDays: number | null;
  /** The clause this was read from. */
  raw: string;
}

export interface DictatedVital {
  kind: VitalKind;
  value: number;
  /** The clause this was read from. */
  raw: string;
}

export interface VoiceSummary {
  diagnosis: string | null;
  /** Raw medication clauses, kept for the existing apply-to-draft flow. */
  medications: string[];
  /** The same medication clauses parsed into draftable fields. */
  prescriptions: DictatedPrescription[];
  /** Label-attributed vital readings the doctor can commit in one tap. */
  vitals: DictatedVital[];
  labOrders: string[];
}

/**
 * A number followed by a dose unit.
 *
 * The trailing lookahead is `(?!\p{L})`, not `\b`: JS defines `\b` over the
 * ASCII `\w` class, so `\b` after "ملغ" is always false and a plain `\b` here
 * silently rejected every Arabic dose. Units are ordered longest-first so
 * "ملجم" is not consumed as "ملغ" plus a stray "جم".
 */
const DOSE_RE =
  /(\d+(?:[.,]\d+)?)\s*(بالمئة|بالمائة|نقطة|وحدات|وحدة|ملجم|مكجم|مجم|ملغ|غرام|جرام|مغ|جم|بود|mcg|µg|μg|ug|mg|ml|iu|%)(?!\p{L})/iu;

const LAB_WORDS = [
  'hba1c', 'تحليل', 'تحاليل', 'فحص', 'مخبر', 'cbc', 'تعداد',
  'ldl', 'hdl', 'دهون', 'كولسترول',
  'creatinine', 'كرياتينين', 'سكر تراكمي', 'سكر صيام', 'urea', 'بولة',
  'tsh', 'vitamin', 'فيتامين', 'esr', 'crp', 'urine', 'بول',
  'xray', 'أشعة', 'echo', 'إيكو', 'صور', 'سونار', 'رنين',
  'test ', 'lab ',
];

const ORDER_VERB_EN = /^\s*(?:please\s+)?(?:order|request|add(?:\s+test)?|rule\s*out)\s+/iu;

/**
 * Request verbs stripped so the remaining phrase reads as the test or the drug.
 *
 * Both spellings of the alef are listed because a doctor dictates "أضف" and
 * types "اضف", and an optional leading "و" is allowed for "وطلب تحليل".
 */
const ORDER_VERB_AR =
  /^\s*(?:و\s*)?(?:من\s+)?(?:أطلب|اطلب|طلب|أضيف|اضيف|ضيف|أضف|اضف|أعمل|اعمل|حط|سجل|أكتب|اكتب|ورّر|ورّ)\s+/u;

const DIAG_RE = /(?:التشخيص|تشخيص|diagnosis|dx)\s*[:：-]?\s*(.+)/i;

const COMMON_DRUGS = [
  'metformin', 'ميتفورمين',
  'amoxicillin', 'أموكسيسيلين',
  'paracetamol', 'بانادول', 'سيتامول',
  'ibuprofen', 'بروفين',
  'atorvastatin', 'ليبيتور',
  'amlodipine', 'املوديبين', 'أملوديبين',
  'omeprazole', 'اوميبرازول', 'أوميبرازول',
  'insulin', 'أنسولين',
  'aspirin', 'أسبرين',
  'azithromycin',
];

/**
 * Frequency phrases. Compound phrases come before the bare ones so "مرتين
 * يومياً" is consumed whole: matching only "مرتين" would leave the trailing
 * "يومياً" attached to the drug name.
 */
const FREQUENCY_RE =
  /(ثلاث\s*مرات\s*(?:يومياً|يوميا|يوميًا)|ثلاث\s*مرات|ثلاثة\s*مرات|مرتين\s*(?:يومياً|يوميا|يوميًا)|مرة\s*واحدة|مرتان|كل\s*يوم|عند\s*اللزوم|عند\s*الحاجة|قبل\s*النوم|قبل\s*الأكل|قبل\s*الاكل|بعد\s*الأكل|بعد\s*الاكل|مع\s*الأكل|مع\s*الاكل|بعد\s*الطعام|مرتين|مرة|يومياً|يوميا|يوميًا|(?:three\s*times\s*(?:daily|per\s*day)|twice\s*(?:daily|per\s*day|a\s*day)|once\s*(?:daily|per\s*day|a\s*day)|daily|every\s*day|nightly|bedtime|as\s*needed|\bprn\b|\bod\b|\bqd\b|\bbid\b|\bbd\b|\btid\b|\btds\b|\bqid\b))/iu;

/**
 * Duration phrases. Dual forms matter: doctors say "أسبوعين", not "14 أسبوع".
 *
 * The unit is guarded by `(?!\p{L})` for the same reason as DOSE_RE: without it
 * "يومياً" matches the "يوم" branch and a daily-forever order is filed as a
 * one-day course.
 */
const DURATION_AR_RE =
  /(?:لمدة\s*)?(\d+)?\s*(يومين|يوماً|يومًا|أيام|ايام|يوم|أسبوعين|اسبوعين|أسابيع|اسابيع|أسبوع|اسبوع|شهرين|شهور|شهر)(?!\p{L})/u;
const DURATION_EN_RE = /(?:for\s*)?(\d+)\s*(days|day|weeks|week|months|month)\b/iu;

const DURATION_DAYS: Record<string, number> = {
  'يوم': 1, 'يوماً': 1, 'يومًا': 1, 'يومين': 2, 'أيام': 1, 'ايام': 1,
  'أسبوع': 7, 'اسبوع': 7, 'أسبوعين': 14, 'اسبوعين': 14, 'أسابيع': 7, 'اسابيع': 7,
  'شهر': 30, 'شهرين': 60, 'شهور': 30,
  day: 1, days: 1, week: 7, weeks: 7, month: 30, months: 30,
};

function clean(line: string): string {
  return line.replace(/^[-•*\d.)\s]+/, '').trim();
}

/**
 * A lone number under a blood-pressure label is ambiguous, and a systolic
 * under 100 is not a plausible systolic: both spoken and typed Arabic produce
 * "الضغط 90" meaning the diastolic. Attributes it there rather than filing a
 * critical hypotension alert off half a sentence.
 */
function remapLoneBp(vitals: DictatedVital[]): DictatedVital[] {
  return vitals.map((v) =>
    v.kind === 'systolic_bp' && v.value < 100 ? { ...v, kind: 'diastolic_bp' as VitalKind } : v,
  );
}

/**
 * Splits a dictation into clauses. Comma/newline/semicolon boundaries are the
 * obvious ones; Arabic "و" ("and") is also a boundary when it introduces
 * another labelled vital ("الحرارة 38 والنبض 90"), because one label per clause
 * is what lets a number be attributed to the right vital.
 */
const VITALS_BOUNDARY_RE =
  /\s+و(?=\s*(?:ال)?(?:ضغط|نبض|حراره|وزن|طول|اكسجين|سكر|هيموجلوبين|كرياتينين))/u;

function clauses(text: string): string[] {
  return text
    .split(/[\n\r،,؛;]+/u)
    .flatMap((part) => part.split(VITALS_BOUNDARY_RE))
    .map((part) => clean(part))
    .filter((part) => part.length > 1)
    .slice(0, 60);
}

/** Labelled readings only: `parseVitalsReply` marks its guesses as `low`. */
function vitalsFromClause(clause: string): DictatedVital[] {
  const parse = parseVitalsReply(arabicNumbersToDigits(clause));
  const out: DictatedVital[] = [];
  for (const reading of parse.readings) {
    if (reading.confidence === 'low') continue;
    if (reading.kind === 'systolic_bp' && reading.secondaryValue != null) {
      out.push({ kind: 'systolic_bp', value: reading.value, raw: clause });
      out.push({ kind: 'diastolic_bp', value: reading.secondaryValue, raw: clause });
      continue;
    }
    out.push({ kind: reading.kind, value: reading.value, raw: clause });
  }
  return remapLoneBp(out);
}

/** Removes the matched spans so what is left of the clause is the drug name. */
function stripSpans(clause: string, spans: readonly string[]): string {
  let out = clause;
  for (const span of spans) {
    if (!span) continue;
    const at = out.indexOf(span);
    if (at >= 0) out = out.slice(0, at) + out.slice(at + span.length);
  }
  return out.replace(/[،,؛;]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function durationFrom(match: RegExpExecArray | null): number | null {
  if (!match) return null;
  const unit = (match[2] ?? '').toLowerCase();
  const multiplier = DURATION_DAYS[unit];
  const amount = match[1] ? Number(match[1]) : 1;
  if (!Number.isFinite(amount)) return null;
  return multiplier === undefined ? Math.round(amount) : Math.round(amount * multiplier);
}

function prescriptionFromClause(clause: string): DictatedPrescription | null {
  const doseMatch = DOSE_RE.exec(clause);
  const freqMatch = FREQUENCY_RE.exec(clause);
  const durMatch = DURATION_AR_RE.exec(clause) ?? DURATION_EN_RE.exec(clause);

  const dose = doseMatch ? clean(doseMatch[0]) : null;
  const frequency = freqMatch ? clean(freqMatch[0]) : null;
  const durationDays = durationFrom(durMatch);

  let candidate = stripSpans(clause, [
    doseMatch?.[0] ?? '',
    freqMatch?.[0] ?? '',
    durMatch?.[0] ?? '',
  ])
    .replace(ORDER_VERB_AR, '')
    .replace(ORDER_VERB_EN, '')
    .trim()
    // Drop a dangling conjunction or preposition left behind by the stripping.
    .replace(/^(?:و|في|على|مع|ب|لِ|ل)\s+/u, '')
    .trim();

  const drug = resolveMedicationString(candidate)?.genericName ?? candidate;
  if (!drug || drug.replace(/\s+/g, '').length < 3) return null;
  return { drug: drug.slice(0, 200), dose, frequency, durationDays, raw: clause };
}

/** "اطلب تحليل سكري تراكمي" becomes "تحليل سكري تراكمي". */
function labOrderName(clause: string): string {
  const stripped = clean(clause.replace(ORDER_VERB_AR, '').replace(ORDER_VERB_EN, '').trim());
  return (stripped || clean(clause)).slice(0, 200);
}

/** Last reading per kind wins: a later clause supersedes an earlier one. */
function dedupeVitals(vitals: DictatedVital[]): DictatedVital[] {
  const byKind = new Map<VitalKind, DictatedVital>();
  for (const vital of vitals) byKind.set(vital.kind, vital);
  return [...byKind.values()];
}

export function summarizeDictation(text: string): VoiceSummary {
  const lines = clauses(text);

  let diagnosis: string | null = null;
  const medications: string[] = [];
  const prescriptions: DictatedPrescription[] = [];
  const vitals: DictatedVital[] = [];
  const labOrders: string[] = [];

  for (const clause of lines) {
    const diagMatch = DIAG_RE.exec(clause);
    if (diagMatch && diagMatch[1] && !diagnosis) {
      diagnosis = diagMatch[1].trim().slice(0, 200);
      continue;
    }

    // One clause can carry several entities at once ("صداع، ضغط 140/90، أضف
    // أملوديبين 5 ملغ"), so every extractor runs and collects its own hits.
    vitals.push(...vitalsFromClause(clause));

    const lower = clause.toLowerCase();
    const isLab = LAB_WORDS.some((w) => lower.includes(w));
    // A known drug name is enough on its own, so one clause can yield a drug and
    // a test at once ("أضف أملوديبين 5 ملغ وطلب تحليل صور دم"). A bare dose is
    // only a drug signal off a lab line, or "hba1c 6.5%" would become a drug.
    const isDrug =
      COMMON_DRUGS.some((d) => lower.includes(d)) || (!isLab && DOSE_RE.test(clause));

    if (isLab) {
      const name = labOrderName(clause);
      if (name && !labOrders.includes(name)) labOrders.push(name);
    }
    if (isDrug) {
      if (!medications.includes(clause)) medications.push(clause.slice(0, 200));
      const parsed = prescriptionFromClause(clause);
      if (parsed && !prescriptions.some((p) => p.drug === parsed.drug && p.dose === parsed.dose)) {
        prescriptions.push(parsed);
      }
    }
  }

  // Fallback: a single-clause dictation with a dose but no structure is one med.
  if (!diagnosis && medications.length === 0 && labOrders.length === 0 && text.trim().length > 2) {
    if (DOSE_RE.test(text)) {
      medications.push(text.trim().slice(0, 200));
      const parsed = prescriptionFromClause(text.trim());
      if (parsed) prescriptions.push(parsed);
    }
  }

  return {
    diagnosis,
    medications: medications.slice(0, 10),
    prescriptions: prescriptions.slice(0, 10),
    vitals: dedupeVitals(vitals).slice(0, 12),
    labOrders: labOrders.slice(0, 10),
  };
}
