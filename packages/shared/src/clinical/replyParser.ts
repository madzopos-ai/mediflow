/**
 * Parses free-text patient replies into structured vital readings.
 *
 * Real patients reply in wildly inconsistent ways:
 *   "110"  "110 mg/dl"  "١١٠"  "8.5"  "120/80"  "120 over 80"
 *   "قراءة السكر 165"  "الضغط 130/85"  "37.2 C"  "I feel 9.2"
 *
 * The parser is deliberately forgiving, returns *every* candidate it finds, and
 * lets the caller decide. When the conversation context tells us which vital was
 * asked for, unlabelled numbers are attributed to that kind.
 */

import type { VitalKind } from '../domain/enums.js';
import type { Source } from '../domain/enums.js';
import type { VitalBundle } from '../domain/types.js';
import { VITAL_DEFINITIONS, evaluateVital, getVitalDefinition, type VitalEvaluation } from './vitals.js';

/** Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digit maps. */
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC = '۰۱۲۳۴۵۶۷۸۹';

export interface ParsedReading {
  kind: VitalKind;
  value: number;
  secondaryValue: number | null;
  unit: string;
  context: string | null;
  /** How the value was identified. */
  confidence: 'high' | 'medium' | 'low';
  /** The exact substring that produced this reading. */
  matchedText: string;
}

export interface ParsedReply {
  /** At least one reading was found. */
  hasReading: boolean;
  readings: ParsedReading[];
  /** Units the patient used, e.g. mmol/L. */
  unitSystem: 'mg/dl' | 'mmol/l' | 'unknown';
  /** Non-reading content worth surfacing to staff. */
  freeText: string;
  /** Detected symptom/urgency keywords. */
  symptoms: string[];
  /** True when the patient expressed an urgent problem. */
  urgent: boolean;
  unmatchedNumbers: { value: number; text: string }[];
}

export interface ParseContext {
  /**
   * The vital the previous message asked for. Unlabelled numbers are then
   * attributed to this kind instead of being discarded.
   */
  expectedKind?: VitalKind | null;
  /** Additional kinds that would be plausible for this patient right now. */
  allowKinds?: readonly VitalKind[];
  /** Patient age, used for pediatric reference ranges downstream. */
  ageYears?: number | null;
  sex?: 'female' | 'male' | 'intersex' | 'unknown' | null;
  measuredAt?: string;
  source?: Source;
}

/** Arabic translation table for units and vital names. */
const ARABIC_TERMS: { pattern: RegExp; kind: VitalKind | 'bp_pair' }[] = [
  { pattern: /(السكر|سكر|سكر الدم|قراءة السكر|جلوكوز|الجلوكوز|سكر الصيام|صيام)/, kind: 'fasting_glucose' },
  { pattern: /(الضغط|ضغط الدم|الضغط للشخص|قياس الضغط|بPressure)/, kind: 'bp_pair' },
  { pattern: /(الحرارة|درجة الحرارة|حرارتي|حرارتك|سخونية|فايروس)/, kind: 'temperature' },
  { pattern: /(النبض|نبض|معدل النبض|ضربة القلب)/, kind: 'pulse' },
  { pattern: /(الوزن|وزني|وزنك|كيلو)/, kind: 'weight' },
  { pattern: /(الطول|طولي|سم)/, kind: 'height' },
  { pattern: /(الأكسجين|اكسجين|تشبع الأكسجين|SpO2)/, kind: 'spo2' },
  { pattern: /(الهيموجلوبين|الهيمو|hemoglobin|anemia|أنيميا)/, kind: 'hemoglobin' },
  { pattern: /(الكرياتينين|كرياتينين|creatinine)/, kind: 'creatinine' },
  { pattern: /(البوتاسيوم|بوتاسيوم|potassium)/, kind: 'serum_potassium' },
  { pattern: /(A1c|HbA1c|السكر التراكمي|الهيموجلوبين Sugar)/i, kind: 'hba1c' },
];

const ENGLISH_TERMS: { pattern: RegExp; kind: VitalKind | 'bp_pair' }[] = [
  { pattern: /(blood\s*sugar|glucose|sugar|fasting\s*glucose|postprandial|fbs|rbs|ppbs)/i, kind: 'fasting_glucose' },
  { pattern: /(a1c|hba1c|glycated|hba1c\s*result)/i, kind: 'hba1c' },
  { pattern: /(blood\s*pressure|\bbp\b|\bpr\b|pressure\s*is|systolic|diastolic)/i, kind: 'bp_pair' },
  { pattern: /(temperature|\btemp\b|fever|pyrexia|celsius)/i, kind: 'temperature' },
  { pattern: /(pulse|heart\s*rate|\bhr\b|bpm|beats)/i, kind: 'pulse' },
  { pattern: /(weight|weigh)/i, kind: 'weight' },
  { pattern: /(height|tall)/i, kind: 'height' },
  { pattern: /(spo2|oxygen|o2|saturation|sat)/i, kind: 'spo2' },
  { pattern: /(respirat|breathing|breath)/i, kind: 'respiratory_rate' },
  { pattern: /(creatinine|creat\b)/i, kind: 'creatinine' },
  { pattern: /(potassium|\bk\b\s*result)/i, kind: 'serum_potassium' },
  { pattern: /(ldl|bad\s*cholesterol)/i, kind: 'ldl' },
  { pattern: /(hdl|good\s*cholesterol)/i, kind: 'hdl' },
  { pattern: /(triglyceride|trigs)/i, kind: 'triglycerides' },
  { pattern: /(hemoglobin|haemoglobin|hb\b|hemoglobin)/i, kind: 'hemoglobin' },
];

const SYMPTOM_TERMS: { pattern: RegExp; label: string; urgent: boolean }[] = [
  { pattern: /(chest\s*pain|pain\s*in\s*chest|ألم\s*في\s*الصدر|الم\u200cصدر)/i, label: 'chest_pain', urgent: true },
  { pattern: /(difficulty\s*breathing|shortness\s*of\s*breath|ضيق\s*تنفس|مشقة\s*تنفس|نفَس)/i, label: 'dyspnea', urgent: true },
  { pattern: /(faint|fainting| syncope|غشيان|إغماء|اغماء|.sync)/i, label: 'syncope', urgent: true },
  { pattern: /(confusion|confused|تشوش|غموض|ذهان|هلوس)/i, label: 'confusion', urgent: true },
  { pattern: /(seizure|fit\b|نوبة|تشنج|تشنجات)/i, label: 'seizure', urgent: true },
  { pattern: /(weakness|weak\b|ضعف|انهاك)/i, label: 'weakness', urgent: false },
  { pattern: /(dizz|vertigo|دوخة|دوخه)/i, label: 'dizziness', urgent: false },
  { pattern: /(nausea|vomit|غثيان|قيء|تقيؤ)/i, label: 'nausea', urgent: false },
  { pattern: /(thirst|polydipsia|عطش|عطش شديد)/i, label: 'polydipsia', urgent: false },
  { pattern: /(polyuria|frequent\s*urine|تبول|كثرة\s*التبول)/i, label: 'polyuria', urgent: false },
  { pattern: /(blurred?\s*vision|vision|زغللة|عدم\s*وضوح\s*الرؤية|رؤية)/i, label: 'visual_change', urgent: false },
  { pattern: /(foot\s*ulcer|ulcer\s*(?:on\s*)?foot|قرحة|تقرح\s*القدم|جرح)/i, label: 'foot_ulcer', urgent: true },
  { pattern: /(ketone|ketones|أ TON ketone|كيتون)/i, label: 'ketones', urgent: true },
  { pattern: /(headache|صداع|وجع\s*راس)/i, label: 'headache', urgent: false },
  { pattern: /(cough|كحة|سعال)/i, label: 'cough', urgent: false },
  { pattern: /(fever|حرارة\s*عالية|سخونة|حمى|سخونه)/i, label: 'fever', urgent: false },
  { pattern: /(swelling|oedema|edema|تورم|ورم|انتفاخ)/i, label: 'swelling', urgent: false },
  { pattern: /(numbness|tingling|تنميل|خز邻|وخز)/i, label: 'neuropathy', urgent: false },
  { pattern: /(bleeding|نزيف)/i, label: 'bleeding', urgent: true },
  { pattern: /(pregnan|حوامل|حامل)/i, label: 'pregnancy', urgent: false },
];

/** Convert Arabic-Indic digits to ASCII. */
export function normalizeDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a >= 0) {
      out += String(a);
      continue;
    }
    const e = EASTERN_ARABIC.indexOf(ch);
    if (e >= 0) {
      out += String(e);
      continue;
    }
    out += ch;
  }
  return out;
}

/** Common Arabic decimal/decimal-separator forms: ٫ -> ., ٬ -> , */
function normalizeSeparators(input: string): string {
  return input.replace(/[\u066B\u066C]/g, (m) => (m === '\u066B' ? '.' : ','));
}

export function normalizeText(input: string): string {
  return normalizeSeparators(normalizeDigits(input))
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u064B-\u0652\u0670]/g, '')
    .replace(/[\u0660-\u0669\u06F0-\u06F9]/g, '')
    .replace(/\u00A0/g, ' ')
    .trim();
}

/** mmol/L -> mg/dL conversion factors for glucose-like analytes. */
const MMOL_TO_MGDL: Partial<Record<VitalKind, number>> = {
  fasting_glucose: 18.0182,
  random_glucose: 18.0182,
  postprandial_glucose: 18.0182,
  creatinine: 88.4,
  triglycerides: 88.57,
  ldl: 38.67,
  hdl: 38.67,
  serum_potassium: 3.91,
  hemoglobin: 0.6206,
};

export function convertToCanonicalUnit(kind: VitalKind, value: number, unit: string): number {
  const u = unit.toLowerCase().replace(/\s+/g, '').replace('°', '');
  const def = getVitalDefinition(kind);
  const canonical = def.unit.toLowerCase().replace(/\s+/g, '').replace('°', '');
  if (u === canonical || u === '') return value;
  if (u.startsWith('mmol') || u.startsWith('µmol') || u.startsWith('μmol')) {
    const factor = MMOL_TO_MGDL[kind];
    if (factor) return value * factor;
  }
  if (kind === 'temperature' && u === 'f' || kind === 'temperature' && u === 'fahrenheit') {
    return Number((((value - 32) * 5) / 9).toFixed(1));
  }
  if (kind === 'temperature' && (u === 'k' || u === 'kelvin')) {
    return Number((value - 273.15).toFixed(1));
  }
  return value;
}

/**
 * Put a raw number into the canonical unit for its kind.
 *
 * A unitless number is ambiguous, and guessing wrong is clinically dangerous: a
 * patient who replies "8.5" means 8.5 mmol/L, which is 153 mg/dL. Recording that
 * as "9 mg/dL" would read as severe hypoglycaemia, so a bare value that is
 * impossible in the canonical unit but plausible after conversion is treated as
 * mmol/L.
 */
export function normaliseValueToCanonical(
  kind: VitalKind,
  rawValue: number,
  unitSystem: 'mg/dl' | 'mmol/l' | 'unknown',
  text: string,
): number {
  const factor = MMOL_TO_MGDL[kind];
  const def = getVitalDefinition(kind);

  if (unitSystem === 'mmol/l' && factor) {
    return rawValue * factor;
  }

  if (unitSystem === 'unknown' && factor) {
    const converted = rawValue * factor;
    if (rawValue < def.min && converted >= def.min && converted <= def.max) {
      return converted;
    }
  }

  if (kind === 'temperature' && /(\u00b0\s*f\b|\d\s*\u00b0?\s*f\b|fahrenheit)/i.test(text)) {
    return Number((((rawValue - 32) * 5) / 9).toFixed(1));
  }

  return rawValue;
}

function detectUnitSystem(text: string): 'mg/dl' | 'mmol/l' | 'unknown' {
  if (/mmol|µmol|μmol/i.test(text)) return 'mmol/l';
  if (/mg\s*\/\s*dl|mg\/dl/i.test(text)) return 'mg/dl';
  if (/g\s*\/\s*l|gm\/l/i.test(text)) return 'mg/dl';
  return 'unknown';
}

function kindFromLabels(text: string): { kind: VitalKind | 'bp_pair'; index: number } | null {
  for (const t of ENGLISH_TERMS) {
    const m = t.pattern.exec(text);
    if (m) return { kind: t.kind, index: m.index };
  }
  for (const t of ARABIC_TERMS) {
    const m = t.pattern.exec(text);
    if (m) return { kind: t.kind, index: m.index };
  }
  return null;
}

interface NumberMatch {
  value: number;
  start: number;
  end: number;
  text: string;
}

/** Extract numbers, keeping "120/80" as a single slash token for the caller to split. */
function extractNumbers(text: string): NumberMatch[] {
  const out: NumberMatch[] = [];
  // BP pairs: 120/80, 120 over 80, 120-80 handled separately
  const pairRe = /(\d{2,3})\s*(?:\/|over|فوق|on)\s*(\d{2,3})/gi;
  let m: RegExpExecArray | null;
  const consumed: [number, number][] = [];
  while ((m = pairRe.exec(text)) !== null) {
    const sys = Number(m[1]);
    const dia = Number(m[2]);
    if (sys >= 50 && sys <= 300 && dia >= 30 && dia <= 200) {
      out.push({ value: sys, start: m.index, end: m.index + m[0].length, text: m[1] ?? '' });
      out.push({ value: dia, start: m.index, end: m.index + m[0].length, text: m[2] ?? '' });
      consumed.push([m.index, m.index + m[0].length]);
    }
  }
  // Individual decimals/integers
  const numRe = /(\d+(?:[.,]\d+)?)/g;
  let n: RegExpExecArray | null;
  while ((n = numRe.exec(text)) !== null) {
    const index = n.index;
    if (consumed.some(([s, e]) => index >= s && index < e)) continue;
    const value = Number(n[1]!.replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    out.push({ value, start: index, end: index + n[0].length, text: n[1]! });
  }
  return out.sort((a, b) => a.start - b.start);
}

function roundForKind(kind: VitalKind, value: number): number {
  const def = getVitalDefinition(kind);
  return Number(value.toFixed(def.decimals));
}

function withinPhysicalRange(kind: VitalKind, value: number): boolean {
  const def = getVitalDefinition(kind);
  return value >= def.min && value <= def.max;
}

/** Determine which vital a bare number most likely refers to. */
function inferKindFromValue(
  value: number,
  expected: VitalKind | null | undefined,
  allow: readonly VitalKind[] | undefined,
  pair: boolean,
): VitalKind | null {
  if (pair) return 'systolic_bp';
  if (expected) return expected;

  const candidates: VitalKind[] = [];
  if (allow && allow.length) {
    candidates.push(...allow);
  } else {
    if (value >= 3 && value <= 20) candidates.push('hba1c', 'temperature');
    if (value >= 30 && value <= 200) candidates.push('fasting_glucose', 'postprandial_glucose', 'weight', 'spo2');
    if (value >= 40 && value <= 140) candidates.push('pulse', 'random_glucose');
    if (value >= 50 && value <= 300) candidates.push('systolic_bp', 'random_glucose', 'fasting_glucose');
  }
  // Prefer the most specific / most commonly monitored.
  const priority: VitalKind[] = [
    'fasting_glucose',
    'random_glucose',
    'postprandial_glucose',
    'systolic_bp',
    'pulse',
    'weight',
    'temperature',
    'spo2',
    'hba1c',
  ];
  for (const k of priority) {
    if (candidates.includes(k)) return k;
  }
  return null;
}

/**
 * Main entry point. Always returns a result; `hasReading` tells the caller
 * whether anything usable was found.
 */
export function parseVitalsReply(rawText: string, context: ParseContext = {}): ParsedReply {
  const text = normalizeText(rawText);
  const unitSystem = detectUnitSystem(text);
  const label = kindFromLabels(text);
  const allowKinds = context.allowKinds ?? [];
  const expected = context.expectedKind ?? null;

  const symptoms: string[] = [];
  let urgent = false;
  for (const s of SYMPTOM_TERMS) {
    if (s.pattern.test(text)) {
      symptoms.push(s.label);
      if (s.urgent) urgent = true;
    }
  }
  if (/\b(emergency|urgent|call\s*ambulance)\b|(طوارئ|اسعاف)/i.test(text)) {
    urgent = true;
    symptoms.push('patient_requested_urgent_help');
  }

  const numbers = extractNumbers(text);
  const readings: ParsedReading[] = [];
  const unmatched: { value: number; text: string }[] = [];
  const used = new Set<number>();

  // 1) Blood-pressure pair gets priority: it produces two readings.
  const isBpContext = label?.kind === 'bp_pair' || /\b\d{2,3}\s*(\/|over)\s*\d{2,3}\b/i.test(text);
  if (isBpContext) {
    const pairRe = /(\d{2,3})\s*(?:\/|over|فوق)\s*(\d{2,3})/gi;
    let pm: RegExpExecArray | null;
    while ((pm = pairRe.exec(text)) !== null) {
      const sys = Number(pm[1]);
      const dia = Number(pm[2]);
      if (sys >= 50 && sys <= 300 && dia >= 30 && dia <= 200) {
        readings.push({
          kind: 'systolic_bp',
          value: sys,
          secondaryValue: dia,
          unit: getVitalDefinition('systolic_bp').unit,
          context: null,
          confidence: 'high',
          matchedText: pm[0],
        });
        // The diastolic reading is attached as secondaryValue; the persistence
        // layer splits it into a separate row.
        for (let i = 0; i < numbers.length; i += 1) {
          const n = numbers[i]!;
          if (n.start >= pm.index && n.start < pm.index + pm[0].length) used.add(i);
        }
        break;
      }
    }
  }

  // 2) Remaining numbers attributed to labelled or expected vitals.
  for (let i = 0; i < numbers.length; i += 1) {
    if (used.has(i)) continue;
    const n = numbers[i]!;
    const nearLabel = label && Math.abs(n.start - label.index) < 60;
    const isPairValue = label?.kind === 'bp_pair';

    let kind: VitalKind | null = null;
    if (nearLabel && !isPairValue && label && label.kind !== 'bp_pair') {
      kind = label.kind;
    } else if (isPairValue) {
      // Unpaired number in a BP message: treat as systolic.
      kind = 'systolic_bp';
    } else {
      kind = inferKindFromValue(n.value, expected, allowKinds, false);
    }
    if (!kind) {
      unmatched.push({ value: n.value, text: n.text });
      continue;
    }

    // Unit-aware conversion for glucose/lab analytes.
    const value = roundForKind(kind, normaliseValueToCanonical(kind, n.value, unitSystem, text));

    if (!withinPhysicalRange(kind, value)) {
      // Could be a different metric (e.g. a phone number or a date).
      if (!nearLabel && !expected) {
        unmatched.push({ value: n.value, text: n.text });
        continue;
      }
    }

    readings.push({
      kind,
      value,
      secondaryValue: null,
      unit: getVitalDefinition(kind).unit,
      context: null,
      confidence: nearLabel ? 'high' : expected ? 'medium' : 'low',
      matchedText: n.text,
    });
  }

  // 3) BMI derivation from a weight reply when height is on file.
  const freeText = text
    .replace(/(\d+(?:[.,]\d+)?)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    hasReading: readings.length > 0,
    readings,
    unitSystem,
    freeText,
    symptoms: Array.from(new Set(symptoms)),
    urgent,
    unmatchedNumbers: unmatched,
  };
}

/** Build the persistable bundle from a parse result. */
export function toBundle(parse: ParsedReply, context: ParseContext = {}): VitalBundle | null {
  if (!parse.hasReading) return null;
  return {
    readings: parse.readings.map((r) => ({
      kind: r.kind,
      value: r.value,
      secondaryValue: r.secondaryValue,
      unit: r.unit,
      context: r.context,
    })),
    measuredAt: context.measuredAt ?? new Date().toISOString(),
    source: context.source ?? 'whatsapp_inbound',
  };
}

/** Evaluate a parse result directly (used for pre-save alerting). */
export function evaluateParsed(parse: ParsedReply, context: ParseContext = {}): VitalEvaluation[] {
  const out: VitalEvaluation[] = [];
  for (const r of parse.readings) {
    if (r.kind === 'systolic_bp' && r.secondaryValue != null) {
      out.push(
        evalWith(r.kind, r.value, r.secondaryValue, context),
        evalWith('diastolic_bp', r.secondaryValue, null, context),
      );
      continue;
    }
    out.push(evalWith(r.kind, r.value, null, context));
  }
  return out;
}

function evalWith(
  kind: VitalKind,
  value: number,
  secondary: number | null,
  context: ParseContext,
): VitalEvaluation {
  return evaluateVital({
    kind,
    value,
    secondaryValue: secondary,
    ageYears: context.ageYears ?? null,
    sex: context.sex ?? null,
  });
}

/** All vitals that have a sane physical range, for the recorder UI. */
export function monitorableVitals(): VitalKind[] {
  return (Object.keys(VITAL_DEFINITIONS) as VitalKind[]).filter((k) => VITAL_DEFINITIONS[k].monitorable);
}
