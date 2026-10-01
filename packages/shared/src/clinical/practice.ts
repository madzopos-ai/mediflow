/**
 * Practice learning: prescriptions written the way this doctor writes them.
 *
 * The engine suggests guideline regimens; this module answers a different
 * question - "what does this doctor usually prescribe for this diagnosis?" -
 * by counting the doctor's own history. Over time the "usual practice" box
 * converges on their habits: same drugs, same doses, same frequencies.
 *
 * Matching is deliberately forgiving (case-insensitive, either side may
 * contain the other) because "DM2", "diabetes type 2" and "Type 2 diabetes"
 * are the same diagnosis written three ways. Dose and frequency follow the
 * majority of that doctor's own orders, never a global default.
 */

export interface PracticeRecord {
  /** Diagnosis text from the visit, if the prescription was linked to one. */
  diagnosis: string | null;
  items: { drug: string; dose?: string | null; frequency?: string | null }[];
  createdAt: string;
  /** Lab values and biometrics on the chart when this was written. */
  labs?: Record<string, number>;
}

export interface PracticePattern {
  drug: string;
  times: number;
  dose: string | null;
  frequency: string | null;
  lastUsed: string;
  /** What "usual" meant here, e.g. "your usual at HbA1c ~9". */
  basis: string | null;
}

export interface CurrentLabs {
  hba1c?: number | null;
  creatinine?: number | null;
  egfr?: number | null;
  ldl?: number | null;
  systolic?: number | null;
}

function normaliseDiagnosis(diagnosis: string): string {
  return diagnosis
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DIAGNOSIS_SYNONYMS: Record<string, string> = {
  dm: 'diabetes',
  dm2: 'diabetes',
  t2dm: 'diabetes',
  t1dm: 'diabetes',
  htn: 'hypertension',
  ckd: 'chronic kidney disease',
  uti: 'urinary tract infection',
  gerd: 'reflux',
  copd: 'copd',
};

function diagnosisTokens(diagnosis: string): Set<string> {
  const words = normaliseDiagnosis(diagnosis).split(' ').filter(Boolean);
  const expanded = new Set<string>();
  for (const word of words) {
    expanded.add(DIAGNOSIS_SYNONYMS[word] ?? word);
    // A mapped phrase contributes its own words too ("chronic kidney disease").
    for (const part of (DIAGNOSIS_SYNONYMS[word] ?? '').split(' ')) {
      if (part) expanded.add(part);
    }
  }
  return expanded;
}

function sameDiagnosis(a: string, b: string): boolean {
  const x = normaliseDiagnosis(a);
  const y = normaliseDiagnosis(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  // Word-order-proof: every word of one side appears in the other.
  const tx = diagnosisTokens(a);
  const ty = diagnosisTokens(b);
  const covers = (needles: Set<string>, haystack: Set<string>): boolean => {
    if (needles.size === 0) return false;
    for (const word of needles) {
      if (!haystack.has(word)) return false;
    }
    return true;
  };
  return covers(tx, ty) || covers(ty, tx);
}

function normaliseDrug(drug: string): string {
  return drug.toLowerCase().trim().replace(/\s+/g, ' ');
}

function majority(values: (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    const key = value.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/** Labs that drive titration: the ones whose value changes the dose. */
const TITRATION_LABS: { key: keyof CurrentLabs; label: string; scale: number }[] = [
  { key: 'hba1c', label: 'HbA1c', scale: 2 },
  { key: 'egfr', label: 'eGFR', scale: 15 },
  { key: 'ldl', label: 'LDL', scale: 30 },
  { key: 'systolic', label: 'systolic BP', scale: 20 },
];

function labProximity(orderLabs: Record<string, number> | undefined, current: CurrentLabs): number {
  // 1 when the order was written at identical labs, decaying as they differ.
  // HbA1c dominates because it is what diabetes titration follows.
  let score = 1;
  for (const { key, scale } of TITRATION_LABS) {
    const now = current[key];
    const then = orderLabs?.[key];
    if (now == null || then == null) continue;
    score *= 1 / (1 + Math.abs(now - then) / scale);
  }
  return score;
}

function recency(createdAt: string, now: number): number {
  const ageDays = Math.max(0, (now - Date.parse(createdAt)) / 86_400_000);
  if (!Number.isFinite(ageDays)) return 0.5;
  return 1 / (1 + ageDays / 180);
}

export function learnPrescribingPatterns(
  records: readonly PracticeRecord[],
  diagnosis: string,
  currentLabs?: CurrentLabs,
  limit = 5,
): PracticePattern[] {
  const matching = records.filter((r) => r.diagnosis && sameDiagnosis(r.diagnosis, diagnosis));
  const now = Date.now();
  const byDrug = new Map<
    string,
    {
      display: string;
      times: number;
      score: number;
      doses: { dose: string; weight: number }[];
      frequencies: (string | null)[];
      lastUsed: string;
      basisLabs: Record<string, number> | null;
    }
  >();
  for (const record of matching) {
    // An order written at similar labs counts more: this is what turns
    // "your usual" into "your usual at HbA1c 9".
    const proximity = currentLabs ? labProximity(record.labs, currentLabs) : 1;
    const weight = proximity * (0.5 + recency(record.createdAt, now));
    for (const item of record.items) {
      const key = normaliseDrug(item.drug);
      if (!key) continue;
      const entry = byDrug.get(key) ?? {
        display: item.drug.trim(),
        times: 0,
        score: 0,
        doses: [],
        frequencies: [],
        lastUsed: '',
        basisLabs: null,
      };
      entry.times += 1;
      entry.score += weight;
      if (item.dose?.trim()) entry.doses.push({ dose: item.dose.trim(), weight });
      entry.frequencies.push(item.frequency ?? null);
      if (record.createdAt > entry.lastUsed) {
        entry.lastUsed = record.createdAt;
        entry.basisLabs = record.labs ?? null;
      }
      byDrug.set(key, entry);
    }
  }
  return [...byDrug.values()]
    .sort((a, b) => b.score - a.score || b.times - a.times)
    .slice(0, Math.max(1, limit))
    .map((entry) => {
      let bestDose: string | null = null;
      let bestWeight = 0;
      const doseTotals = new Map<string, number>();
      for (const d of entry.doses) {
        doseTotals.set(d.dose, (doseTotals.get(d.dose) ?? 0) + d.weight);
      }
      for (const [dose, total] of doseTotals) {
        if (total > bestWeight) {
          bestDose = dose;
          bestWeight = total;
        }
      }
      return {
        drug: entry.display,
        times: entry.times,
        dose: bestDose,
        frequency: majority(entry.frequencies),
        lastUsed: entry.lastUsed,
        basis: describeBasis(entry.basisLabs, currentLabs),
      };
    });
}

/** Human basis for the suggestion, or null when it is habit alone. */
function describeBasis(orderLabs: Record<string, number> | null, current: CurrentLabs | undefined): string | null {
  if (!current || !orderLabs) return null;
  for (const { key, label } of TITRATION_LABS) {
    const then = orderLabs[key];
    if (then != null && current[key] != null) {
      return `your usual at ${label} ~${Math.round(then * 10) / 10}`;
    }
  }
  return null;
}
