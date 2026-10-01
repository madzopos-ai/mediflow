/**
 * Lab-panel parser: structured readings out of printed blood-test reports.
 *
 * Lab reports are line-oriented ("HbA1c  6.2 %", "LDL  130 mg/dL"), unlike
 * chat replies, so they get their own parser rather than stretching the
 * reply parser. Each line yields at most one reading per kind, the number
 * must sit next to its label (never inside a reference range in parentheses),
 * and values outside the physical range of the vital are rejected - OCR
 * misreads a "6.2" into "62" often enough that this check earns its keep.
 *
 * Only kinds the system can store (VitalKind) are produced; anything else on
 * the panel is ignored rather than forced into the wrong slot.
 */

import { getVitalDefinition } from './vitals.js';
import type { VitalKind } from '../domain/enums.js';

export interface LabValue {
  kind: VitalKind;
  value: number;
  unit: string;
  /** The exact line fragment the value came from, for the confirmation UI. */
  matchedText: string;
}

interface PanelEntry {
  kind: VitalKind;
  unit: string;
  label: RegExp;
}

const PANEL: readonly PanelEntry[] = [
  // "HbalC" is tesseract's favourite misreading of "HbA1c" - match it.
  { kind: 'hba1c', unit: '%', label: /hba1c|hbalc|\ba1c\b|glycated|التراكمي/i },
  { kind: 'hemoglobin', unit: 'g/dL', label: /hemoglobin|\bhgb?\b|الهيموجلوبين|الهيمو/i },
  { kind: 'fasting_glucose', unit: 'mg/dL', label: /glucose|fbs|rbs|السكر|سكر الدم|جلوكوز/i },
  { kind: 'creatinine', unit: 'mg/dL', label: /creatinine|creat\b|الكرياتينين|كرياتينين/i },
  { kind: 'serum_potassium', unit: 'mmol/L', label: /potassium|\bk\b|البوتاسيوم|بوتاسيوم/i },
  { kind: 'ldl', unit: 'mg/dL', label: /\bldl\b/i },
  { kind: 'hdl', unit: 'mg/dL', label: /\bhdl\b/i },
  { kind: 'triglycerides', unit: 'mg/dL', label: /triglycerides?|\btrig\b|الدهون الثلاثية/i },
  { kind: 'spo2', unit: '%', label: /spo2|تشبع الأكسجين/i },
  { kind: 'wbc', unit: 'K/µL', label: /\bwbc\b|white\s*blood\s*cells?|leucocytes?|leukocytes?|الكريات البيضاء|كريات بيض/i },
  { kind: 'rbc', unit: 'M/µL', label: /\brbc\b|red\s*blood\s*cells?|erythrocytes?|الكريات الحمراء|كريات حمر/i },
  { kind: 'hematocrit', unit: '%', label: /hematocrit|\bhct\b|الهيماتوكريت/i },
  { kind: 'platelets', unit: 'K/µL', label: /platelets?|\bplt\b|thrombocytes?|الصفائح|صفائح/i },
  { kind: 'mcv', unit: 'fL', label: /\bmcv\b/i },
  { kind: 'mch', unit: 'pg', label: /\bmch\b/i },
  { kind: 'esr', unit: 'mm/h', label: /\besr\b|sed(\.|imentation)?\s*rate|سرعة التثفل|التثفل/i },
  { kind: 'crp', unit: 'mg/L', label: /\bcrp\b|c-reactive|البروتين التفاعلي/i },
  { kind: 'urea', unit: 'mg/dL', label: /urea|\bbun\b|يوريا|البولة/i },
  { kind: 'microalbumin', unit: 'mg/L', label: /microalbuminuria?|microalbumin|الزلال/i },
  { kind: 'urine_acr', unit: 'mg/g', label: /\bacr\b|alb\/creat|albumin.?creatinine.?ratio/i },
];

/**
 * A decimal number that is not glued to a word: the "1" in "HbA1c" or the
 * "12" in "B12" is part of a name, never a result. A trailing unit without a
 * space ("130mg/dL") still counts - only the left side is anchored.
 */
const NUMBER = /(?<![A-Za-z0-9])-?\d+(?:[.,]\d+)?/g;

/** Ranges in parentheses are reference intervals, never results. */
function stripParenthesised(line: string): string {
  return line.replace(/\([^)]*\)/g, ' ');
}

function firstNumberNear(text: string, at: number): { value: number; text: string } | null {
  const candidates: { value: number; text: string; distance: number }[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const raw = match[0].replace(',', '.');
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const index = match.index ?? 0;
    candidates.push({ value, text: match[0], distance: Math.abs(index - at) });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0] ?? null;
}

export function parseLabPanel(text: string): LabValue[] {
  const found = new Map<VitalKind, LabValue>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const clean = stripParenthesised(line);
    for (const entry of PANEL) {
      if (found.has(entry.kind)) continue;
      const label = clean.match(entry.label);
      if (!label || label.index === undefined) continue;
      const candidate = firstNumberNear(clean, label.index);
      if (!candidate) continue;
      // Physical plausibility from the vital definition rejects OCR garbage
      // (a "6.2" misread as "62") without any per-kind magic numbers here.
      const def = getVitalDefinition(entry.kind);
      if (candidate.value < def.min || candidate.value > def.max) continue;
      found.set(entry.kind, {
        kind: entry.kind,
        value: candidate.value,
        unit: entry.unit,
        matchedText: line.slice(0, 120),
      });
    }
  }
  return [...found.values()];
}
