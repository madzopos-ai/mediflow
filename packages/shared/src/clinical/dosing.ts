/**
 * Patient-context dosing rules.
 *
 * Given a patient's age, sex, weight, renal/hepatic function, pregnancy status
 * and current medication list, this module produces dose adjustments and hard
 * contraindication flags for a proposed drug.
 *
 * These are *guidance*, not prescriptions. Every adjustment carries an explicit
 * severity so the UI can colour it appropriately.
 */

import type { AlertSeverity, Sex, VitalKind } from '../domain/enums.js';
import type { Drug } from './drugs.js';
import { getVitalDefinition } from './vitals.js';

export interface PatientClinicalContext {
  ageYears: number | null;
  sex: Sex;
  weightKg: number | null;
  heightCm: number | null;
  isPregnant: boolean;
  isBreastfeeding: boolean;
  /** Serum creatinine in mg/dL, when known. */
  creatinine: number | null;
  /** eGFR in mL/min/1.73m², when known. */
  egfr: number | null;
  /** AST/ALT in U/L, when known. */
  alt: number | null;
  ast: number | null;
  chronicConditions: string[];
  currentMedications: string[];
  allergies: string[];
  /** Highest systolic BP reading in the last 30 days. */
  maxSystolic: number | null;
  /** Highest fasting glucose in the last 30 days. */
  maxFastingGlucose: number | null;
  hba1c: number | null;
}

export interface DosingAdjustment {
  drugId: string;
  drugName: string;
  note: string;
  severity: AlertSeverity;
  kind: 'renal' | 'hepatic' | 'pediatric' | 'geriatric' | 'pregnancy' | 'lactation' | 'interaction_induced' | 'organ_reserve';
  recommendation: string | null;
}

export interface ContraindicationFlag {
  drugId: string;
  drugName: string;
  reason: string;
  severity: AlertSeverity;
  source: 'label' | 'guideline' | 'derived';
}

export function emptyClinicalContext(): PatientClinicalContext {
  return {
    ageYears: null,
    sex: 'unknown',
    weightKg: null,
    heightCm: null,
    isPregnant: false,
    isBreastfeeding: false,
    creatinine: null,
    egfr: null,
    alt: null,
    ast: null,
    chronicConditions: [],
    currentMedications: [],
    allergies: [],
    maxSystolic: null,
    maxFastingGlucose: null,
    hba1c: null,
  };
}

/** Cockcroft–Gault eGFR in mL/min (uses mg/dL creatinine). */
export function estimateEgfr(ctx: Pick<PatientClinicalContext, 'ageYears' | 'sex' | 'weightKg' | 'creatinine'>): number | null {
  const { ageYears, sex, weightKg, creatinine } = ctx;
  if (ageYears == null || weightKg == null || creatinine == null) return null;
  if (creatinine <= 0) return null;
  const sexFactor = sex === 'female' ? 0.85 : 1;
  return Math.round(((140 - ageYears) * weightKg * sexFactor) / (72 * creatinine));
}

function renalStage(egfr: number): {
  label: string;
  stage: 1 | 2 | 3 | 4 | 5;
  description: string;
} {
  if (egfr >= 90) return { label: 'Normal', stage: 1, description: 'eGFR ≥90 mL/min/1.73m²' };
  if (egfr >= 60) return { label: 'Mildly reduced', stage: 2, description: 'eGFR 60–89' };
  if (egfr >= 30) return { label: 'Moderately reduced', stage: 3, description: 'eGFR 30–59' };
  if (egfr >= 15) return { label: 'Severely reduced', stage: 4, description: 'eGFR 15–29' };
  return { label: 'Kidney failure', stage: 5, description: 'eGFR <15 or on dialysis' };
}

export function describeRenalFunction(egfr: number | null): string {
  if (egfr == null) return 'Renal function not available';
  return `${renalStage(egfr).description} — ${renalStage(egfr).label.toLowerCase()}`;
}

/** Drugs requiring renal dose adjustment, keyed by drug id. */
const RENAL_ADJUSTMENTS: Record<
  string,
  { below60: string; below30: string; below15: string; avoid: boolean; interval?: string }
> = {
  metformin: {
    below60: 'No change, but check eGFR every 3–6 months.',
    below30: 'Contraindicated — discontinue metformin.',
    below15: 'Contraindicated — discontinue metformin.',
    avoid: true,
  },
  gabapentin: {
    below60: 'Reduce the total daily dose by 25–50%.',
    below30: 'Use 200–700 mg once daily or 100–300 mg three times daily.',
    below15: 'Use 100–300 mg once daily after dialysis.',
    avoid: false,
    interval: 'Extend the dosing interval substantially',
  },
  'insulin-glargine': {
    below60: 'Reduce dose by 10–25%; hypoglycaemia risk rises.',
    below30: 'Reduce dose by 25–50% and monitor glucose closely.',
    below15: 'Reduce dose by 50% or more; consider lower-concentration formulation.',
    avoid: false,
  },
  'insulin-aspart': {
    below60: 'Reduce dose by 10–25%.',
    below30: 'Reduce dose by 25–50%.',
    below15: 'Reduce dose by 50%; coordinate with dialysis.',
    avoid: false,
  },
  'amoxicillin-clavulanate': {
    below60: 'No change for mild impairment; give every 8 hours if eGFR <30.',
    below30: '375 mg every 8 hours (do not use the 625 mg tablet).',
    below15: 'Administer only after dialysis.',
    avoid: false,
    interval: 'Extend interval to every 12 hours',
  },
  amoxicillin: {
    below60: 'No change.',
    below30: 'Give every 12 hours instead of every 8 hours.',
    below15: 'Administer after dialysis only.',
    avoid: false,
    interval: 'Extend interval',
  },
  ibuprofen: {
    below60: 'Avoid if possible; if used, limit to the lowest dose for the shortest time.',
    below30: 'Avoid — high risk of acute kidney injury and further decline in function.',
    below15: 'Avoid — contraindicated.',
    avoid: true,
  },
  naproxen: {
    below60: 'Avoid or limit duration.',
    below30: 'Avoid.',
    below15: 'Avoid — contraindicated.',
    avoid: true,
  },
  tramadol: {
    below60: 'Reduce the dose by 25%.',
    below30: 'Reduce the dose by 50% and extend the interval to every 12 hours.',
    below15: 'Avoid — active metabolite accumulates.',
    avoid: true,
  },
  levetiracetam: {
    below60: 'Reduce the total daily dose by 25–50%.',
    below30: 'Reduce by 50% and extend the interval.',
    below15: 'Reduce by 50% and give after dialysis.',
    avoid: false,
  },
  allopurinol_placeholder: {
    below60: 'No change.',
    below30: 'Reduce the starting dose.',
    below15: 'Reduce the dose substantially; risk of severe hypersensitivity rises.',
    avoid: false,
  },
  spironolactone: {
    below60: 'Reduce the dose by 25% if potassium rises.',
    below30: 'Avoid — high hyperkalaemia risk.',
    below15: 'Contraindicated unless on dialysis with potassium monitoring.',
    avoid: true,
  },
  'isosorbide-mononitrate': {
    below60: 'No change required.',
    below30: 'No change required; the drug is not renally cleared.',
    below15: 'No change required.',
    avoid: false,
  },
  'rivaroxaban': {
    below60: 'No change if CrCl >50 mL/min.',
    below30: 'Reduce to 15 mg once daily with food.',
    below15: 'Contraindicated — not recommended in dialysis-dependent patients.',
    avoid: true,
  },
  paracetamol: {
    below60: 'Limit to 3 g/day.',
    below30: 'Limit to 2 g/day.',
    below15: 'Limit to 2 g/day and extend the interval to every 8 hours.',
    avoid: false,
  },
  aspirin: {
    below60: 'Caution — bleeding risk rises with CKD.',
    below30: 'Avoid for primary prevention; limit to 75–100 mg if clearly indicated.',
    below15: 'Avoid unless dialysis access or stent thrombosis risk demands it.',
    avoid: false,
  },
  fexofenadine: {
    below60: 'No change.',
    below30: 'Reduce the dose by half.',
    below15: 'Use 30 mg once daily.',
    avoid: false,
  },
};

/**
 * Upper limit of normal for AST/ALT, in U/L (2x the sex-specific ULN used by
 * most reference ranges). Enzyme advice is graded as a *multiple* of this
 * value, which is how hepatotoxicity risk thresholds are actually defined.
 */
export const TRANSAMINASE_ULN = 40;

export type TransaminaseGrade = 'normal' | 'mild' | 'moderate' | 'severe';

export function gradeTransaminases(value: number | null | undefined): TransaminaseGrade {
  if (value == null || !Number.isFinite(value) || value <= 0) return 'normal';
  const multiple = value / TRANSAMINASE_ULN;
  if (multiple > 3) return 'severe';
  if (multiple > 2) return 'moderate';
  if (multiple > 1) return 'mild';
  return 'normal';
}

export function describeTransaminaseGrade(grade: TransaminaseGrade): string {
  switch (grade) {
    case 'severe':
      return `more than 3x the upper limit of normal (${TRANSAMINASE_ULN} U/L)`;
    case 'moderate':
      return `2-3x the upper limit of normal (${TRANSAMINASE_ULN} U/L)`;
    case 'mild':
      return `1-2x the upper limit of normal (${TRANSAMINASE_ULN} U/L)`;
    case 'normal':
      return 'within the normal range';
  }
}

const HEPATIC_ADJUSTMENTS: Record<string, { mild: string; moderate: string; severe: string; avoid: boolean }> = {
  metformin: { mild: 'No change.', moderate: 'Do not initiate.', severe: 'Contraindicated — risk of lactic acidosis.', avoid: true },
  atorvastatin: { mild: 'No change, monitor LFTs.', moderate: 'Halve the dose and monitor LFTs.', severe: 'Contraindicated in active liver disease.', avoid: true },
  rosuvastatin: { mild: 'No change, monitor LFTs.', moderate: 'Limit to 10 mg/day.', severe: 'Contraindicated.', avoid: true },
  paracetamol: { mild: 'Limit to 3 g/day.', moderate: 'Limit to 2 g/day.', severe: 'Avoid — hepatotoxic at therapeutic doses.', avoid: true },
  ibuprofen: { mild: 'Use the lowest effective dose.', moderate: 'Avoid or limit to a few days.', severe: 'Avoid — decompensated liver disease and variceal bleeding risk.', avoid: true },
  naproxen: { mild: 'Use caution.', moderate: 'Avoid.', severe: 'Contraindicated.', avoid: true },
  tramadol: { mild: 'No change.', moderate: 'Extend the interval to every 12 hours.', severe: 'Avoid — hepatic metabolism reduced.', avoid: true },
  'ondansetron-pump': { mild: 'No change.', moderate: 'Reduce the dose.', severe: 'Contraindicated.', avoid: true },
  'ondansetron': { mild: 'No change.', moderate: 'Reduce the dose to 4 mg.', severe: 'Use 4 mg once daily with monitoring.', avoid: false },
  'amoxicillin-clavulanate': { mild: 'No change.', moderate: 'Monitor LFTs; risk of cholestatic hepatitis.', severe: 'Avoid — risk of severe hepatotoxicity.', avoid: true },
  'clindamycin': { mild: 'No change.', moderate: 'No change, monitor LFTs.', severe: 'Avoid.', avoid: true },
};

const PEDIATRIC_RULES: Record<string, { minAge: number; note: string; severity: AlertSeverity }> = {
  aspirin: { minAge: 16, note: 'Aspirin is avoided in children and teenagers with viral illness because of the risk of Reye syndrome. Use paracetamol or ibuprofen instead.', severity: 'critical' },
  ibuprofen: { minAge: 0.5, note: 'Ibuprofen must not be given to infants under 6 months, or to children who are dehydrated, vomiting, or have chickenpox.', severity: 'critical' },
  'ibuprofen-pediatric': { minAge: 0.5, note: 'Not licensed under 6 months of age.', severity: 'critical' },
  'amoxicillin-clavulanate': { minAge: 0, note: 'Dose by weight; avoid the 875 mg tablet in children under 40 kg.', severity: 'info' },
  metformin: { minAge: 10, note: 'Not licensed below 10 years of age in most formularies.', severity: 'warning' },
  tramadol: { minAge: 12, note: 'Contraindicated in children under 12 years.', severity: 'critical' },
  alprazolam: { minAge: 12, note: 'Benzodiazepines are generally avoided in children.', severity: 'warning' },
  amitriptyline: { minAge: 12, note: 'Not recommended in children under 12 years.', severity: 'warning' },
  'clobetasol-topical': { minAge: 1, note: 'Very potent steroid: avoid on the face, flexures and genital area, and limit to short courses.', severity: 'warning' },
  'hydrochlorothiazide': { minAge: 0, note: 'May cause volume depletion and hypokalaemia in children; monitor electrolytes.', severity: 'info' },
  atorvastatin: { minAge: 10, note: 'Statins are rarely indicated below 10 years; specialist guidance only.', severity: 'warning' },
};

const GERIATRIC_NOTES: Record<string, string> = {
  alprazolam: 'On the Beers list: benzodiazepines increase falls, fracture and cognitive impairment in older adults. Prefer non-pharmacological measures.',
  diazepam: 'On the Beers list: long half-life benzodiazepine in the elderly.',
  'diphenhydramine': 'On the Beers list: anticholinergic burden in older adults.',
  dimenhydrinate: 'On the Beers list: anticholinergic burden and sedation.',
  promethazine: 'On the Beers list: anticholinergic and sedating; avoid in older adults.',
  meperidine: 'On the Beers list: normeperidine accumulation causes seizures and serotonin syndrome.',
  'hydrochlorothiazide': 'Thiazides increase the risk of hypokalaemia, hyponatraemia and gout in older adults; check electrolytes within 2–3 weeks.',
  'ibuprofen': 'NSAIDs carry high GI bleed and renal risk in older adults, especially with ACE inhibitors, ARBs, diuretics or antiplatelets.',
  naproxen: 'NSAIDs carry high GI bleed and renal risk in older adults.',
  'diclofenac': 'Avoid NSAIDs in older adults when an alternative exists.',
  'amitriptyline': 'On the Beers list: TCAs have anticholinergic and orthostatic hypotension risks.',
  'chlorpheniramine': 'On the Beers list: sedating antihistamine.',
  glyburide: 'On the Beers list: glyburide has a high risk of prolonged hypoglycaemia in older adults; prefer glipizide.',
  'glimepiride': 'Higher hypoglycaemia risk than glipizide in older adults; use cautiously.',
  oxybutynin: 'On the Beers list: anticholinergic retention effect.',
};

const PREGNANCY_BLOCKS: Record<string, { category: string; note: string; avoid: boolean; alternative?: string }> = {
  aspirin: { category: 'D', note: 'Aspirin is contraindicated in the third trimester: premature closure of the fetal ductus arteriosus and maternal haemorrhage. Low-dose aspirin is however standard for pre-eclampsia prophylaxis where prescribed by an obstetrician.', avoid: true },
  'rivaroxaban': { category: 'X', note: 'DOACs are contraindicated in pregnancy — they cross the placenta and there is no reversal agent.', avoid: true },
  warfarin: { category: 'X', note: 'Warfarin is teratogenic, especially in weeks 6–12. Switch to therapeutic LMWH in pregnancy, coordinated with haematology.', avoid: true },
  losartan: { category: 'D', note: 'ARBs are fetotoxic: renal dysgenesis, oligohydramnios and neonatal renal failure. Replace with labetalol, nifedipine or methyldopa.', avoid: true },
  ramipril: { category: 'D', note: 'ACE inhibitors are fetotoxic. Replace with labetalol, nifedipine or methyldopa.', avoid: true },
  lisinopril: { category: 'D', note: 'ACE inhibitors are fetotoxic. Replace with labetalol, nifedipine or methyldopa.', avoid: true },
  spironolactone: { category: 'C', note: 'Anti-androgenic activity is a concern in pregnancy; generally avoided.', avoid: true },
  'isosorbide-mononitrate': { category: 'C', note: 'Use only when clearly indicated; monitor for fetal hypotension.', avoid: false },
  'clindamycin': { category: 'B', note: 'One of the safer antibiotics in pregnancy for odontogenic infection.', avoid: false },
  'azithromycin': { category: 'C', note: 'Considered for use when beta-lactams are contraindicated; discuss with the obstetrician.', avoid: false },
  'amoxicillin-clavulanate': { category: 'B', note: 'Acceptable in pregnancy — one of the preferred antibiotics for dental and respiratory infection.', avoid: false },
  amoxicillin: { category: 'B', note: 'Acceptable in pregnancy.', avoid: false },
  cefuroxime: { category: 'B', note: 'Acceptable in pregnancy.', avoid: false },
  metronidazole: { category: 'B', note: 'Second trimester use is acceptable; avoid in the first trimester where possible.', avoid: false },
  metformin: { category: 'B', note: 'Continuing metformin in pregnancy is generally acceptable; insulin remains first line when glycaemic targets are not met.', avoid: false },
  insulin_glargine: { category: 'C', note: 'Insulin does not cross the placenta and is safe in pregnancy.', avoid: false },
  atorvastatin: { category: 'X', note: 'Statins are contraindicated in pregnancy. Statins should be stopped before conception in women planning pregnancy.', avoid: true },
  rosuvastatin: { category: 'X', note: 'Statins are contraindicated in pregnancy.', avoid: true },
  isotretinoin: { category: 'X', note: 'Absolutely contraindicated — severe teratogenic risk requiring a pregnancy prevention programme.', avoid: true },
  'tretinoin-topical': { category: 'X', note: 'Topical retinoids are contraindicated in pregnancy; discontinue before conception.', avoid: true },
  alprazolam: { category: 'D', note: 'Benzodiazepines near term can cause neonatal flaccidity and respiratory depression.', avoid: true },
  amitriptyline: { category: 'C', note: 'Use only if clearly required, at the lowest dose.', avoid: false },
  ibuprofen: { category: 'C', note: 'Avoid from 20 weeks onwards because of oligohydramnios risk and ductus arteriosus closure; paracetamol is preferred.', avoid: true },
  naproxen: { category: 'C', note: 'Avoid from 20 weeks onwards; paracetamol is preferred.', avoid: true },
  paracetamol: { category: 'B', note: 'First-line analgesic in pregnancy at standard doses.', avoid: false },
  tramadol: { category: 'C', note: 'Use only if paracetamol and NSAIDs are insufficient.', avoid: false },
  gabapentin: { category: 'C', note: 'Limited pregnancy data; use only for clear indications.', avoid: false },
  'vitamin-d3': { category: 'A', note: 'Safe and recommended in pregnancy.', avoid: false },
  'ferrous-sulfate': { category: 'A', note: 'Safe and recommended in pregnancy for anaemia.', avoid: false },
  'ondansetron': { category: 'B', note: 'Acceptable for significant nausea and vomiting in pregnancy.', avoid: false },
  omeprazole: { category: 'C', note: 'Use for clear indications such as reflux with alarm features.', avoid: false },
  sumatriptan: { category: 'C', note: 'Consider only if benefit outweighs risk; discuss with the obstetrician.', avoid: false },
};

const LACTATION_RULES: Record<string, { compatible: boolean; note: string }> = {
  metformin: { compatible: true, note: 'Passes into milk in small amounts; generally considered compatible.' },
  paracetamol: { compatible: true, note: 'Preferred analgesic while breastfeeding.' },
  ibuprofen: { compatible: true, note: 'One of the preferred NSAIDs while breastfeeding; short acting formulations are best.' },
  amoxicillin: { compatible: true, note: 'Compatible with breastfeeding; may cause infant diarrhoea or candidiasis.' },
  'amoxicillin-clavulanate': { compatible: true, note: 'Compatible with breastfeeding.' },
  cefuroxime: { compatible: true, note: 'Compatible with breastfeeding.' },
  'azithromycin': { compatible: true, note: 'Compatible with breastfeeding.' },
  clindamycin: { compatible: true, note: 'Compatible with breastfeeding.' },
  amlodipine: { compatible: true, note: 'Low milk levels; compatible with monitoring for infant sedation.' },
  losartan: { compatible: false, note: 'Not recommended while breastfeeding — discuss an alternative antihypertensive.' },
  ramipril: { compatible: false, note: 'Not recommended while breastfeeding.' },
  lisinopril: { compatible: false, note: 'Not recommended while breastfeeding.' },
  atorvastatin: { compatible: false, note: 'Statins are generally avoided during breastfeeding; the infant receives a relatively high lipid intake.' },
  'rosuvastatin': { compatible: false, note: 'Avoid during breastfeeding.' },
  warfarin: { compatible: true, note: 'Compatible with breastfeeding; monitor the infant for bruising.' },
  alprazolam: { compatible: false, note: 'Sedating; avoid while breastfeeding.' },
  sertraline: { compatible: true, note: 'Sertraline is one of the preferred antidepressants during breastfeeding; monitor the infant for sedation.' },
  escitalopram: { compatible: true, note: 'Compatible with breastfeeding; monitor for infant sedation.' },
  'metronidazole': { compatible: false, note: 'Avoid the high single dose; if essential, discontinue breastfeeding for 12–24 hours.' },
  gabapentin: { compatible: true, note: 'Compatible; monitor the infant for sedation.' },
  'vitamin-d3': { compatible: true, note: 'Safe while breastfeeding.' },
  'ferrous-sulfate': { compatible: true, note: 'Safe while breastfeeding; may darken infant stools.' },
  'isosorbide-mononitrate': { compatible: true, note: 'Compatible with monitoring.' },
  'levetiracetam': { compatible: true, note: 'Compatible with monitoring for infant sedation.' },
  sumatriptan: { compatible: true, note: 'Compatible; low milk transfer.' },
  omeprazole: { compatible: true, note: 'Compatible with monitoring.' },
};

/** Compute all applicable adjustments and contraindications for a drug. */
export function evaluateDosing(
  drug: Drug,
  ctx: PatientClinicalContext,
): { adjustments: DosingAdjustment[]; contraindications: ContraindicationFlag[] } {
  const adjustments: DosingAdjustment[] = [];
  const contraindications: ContraindicationFlag[] = [];

  const egfr = ctx.egfr ?? (ctx.creatinine != null ? estimateEgfr(ctx) : null);

  // ---- Renal
  if (egfr != null) {
    const rule = RENAL_ADJUSTMENTS[drug.id];
    if (rule) {
      if (egfr < 15) {
        if (rule.avoid) {
          contraindications.push({
            drugId: drug.id,
            drugName: drug.genericName,
            reason: `eGFR ${egfr} mL/min: ${rule.below15}`,
            severity: 'critical',
            source: 'label',
          });
        } else {
          adjustments.push({ drugId: drug.id, drugName: drug.genericName, note: `eGFR ${egfr} mL/min: ${rule.below15}`, severity: 'critical', kind: 'renal', recommendation: rule.below15 });
        }
      } else if (egfr < 30) {
        if (rule.avoid) {
          contraindications.push({
            drugId: drug.id,
            drugName: drug.genericName,
            reason: `eGFR ${egfr} mL/min: ${rule.below30}`,
            severity: 'critical',
            source: 'label',
          });
        } else {
          adjustments.push({ drugId: drug.id, drugName: drug.genericName, note: `eGFR ${egfr} mL/min: ${rule.below30}`, severity: 'warning', kind: 'renal', recommendation: rule.below30 });
        }
      } else if (egfr < 60) {
        adjustments.push({ drugId: drug.id, drugName: drug.genericName, note: `eGFR ${egfr} mL/min: ${rule.below60}`, severity: 'warning', kind: 'renal', recommendation: rule.below60 });
      }
    }
    if (drug.renalCaution && egfr < 45) {
      const alreadyCovered = adjustments.some((a) => a.kind === 'renal');
      if (!alreadyCovered) {
        adjustments.push({
          drugId: drug.id,
          drugName: drug.genericName,
          note: drug.renalCaution,
          severity: 'warning',
          kind: 'renal',
          recommendation: drug.renalCaution,
        });
      }
    }
  } else if (drug.renalCaution) {
    adjustments.push({
      drugId: drug.id,
      drugName: drug.genericName,
      note: `Renal function unknown — ${drug.renalCaution}`,
      severity: 'info',
      kind: 'renal',
      recommendation: 'Obtain a serum creatinine before prescribing.',
    });
  }

  // ---- Hepatic
  if (ctx.ast != null || ctx.alt != null) {
    const rule = HEPATIC_ADJUSTMENTS[drug.id];
    const grade = gradeTransaminases(Math.max(ctx.ast ?? 0, ctx.alt ?? 0));
    if (grade === 'severe') {
      if (rule?.avoid) {
        contraindications.push({
          drugId: drug.id,
          drugName: drug.genericName,
          reason: `Transaminases ${ctx.ast ?? ctx.alt} U/L (${describeTransaminaseGrade(grade)}): ${rule.severe}`,
          severity: 'critical',
          source: 'derived',
        });
      } else if (rule) {
        adjustments.push({ drugId: drug.id, drugName: drug.genericName, note: `Markedly elevated transaminases: ${rule.moderate}`, severity: 'warning', kind: 'hepatic', recommendation: rule.moderate });
      } else if (drug.hepaticCaution) {
        adjustments.push({ drugId: drug.id, drugName: drug.genericName, note: drug.hepaticCaution, severity: 'warning', kind: 'hepatic', recommendation: drug.hepaticCaution });
      }
    } else if (grade === 'moderate') {
      adjustments.push({
        drugId: drug.id,
        drugName: drug.genericName,
        note: `Elevated transaminases: ${rule?.moderate ?? drug.hepaticCaution ?? 'Review hepatic function before prescribing.'}`,
        severity: 'warning',
        kind: 'hepatic',
        recommendation: rule?.moderate ?? drug.hepaticCaution,
      });
    } else if (grade === 'mild' && rule) {
      adjustments.push({ drugId: drug.id, drugName: drug.genericName, note: `Mildly elevated transaminases: ${rule.mild}`, severity: 'info', kind: 'hepatic', recommendation: rule.mild });
    } else if (grade === 'normal' && drug.hepaticCaution) {
      adjustments.push({ drugId: drug.id, drugName: drug.genericName, note: drug.hepaticCaution, severity: 'info', kind: 'hepatic', recommendation: drug.hepaticCaution });
    }
  } else if (drug.hepaticCaution) {
    adjustments.push({ drugId: drug.id, drugName: drug.genericName, note: drug.hepaticCaution, severity: 'info', kind: 'hepatic', recommendation: drug.hepaticCaution });
  }

  // ---- Paediatric
  if (ctx.ageYears != null && ctx.ageYears < 18) {
    const rule = PEDIATRIC_RULES[drug.id];
    if (rule && ctx.ageYears < rule.minAge) {
      contraindications.push({
        drugId: drug.id,
        drugName: drug.genericName,
        reason: `Patient is ${ctx.ageYears} years old: ${rule.note}`,
        severity: rule.severity,
        source: 'label',
      });
    } else if (rule && ctx.ageYears < rule.minAge + 2) {
      adjustments.push({ drugId: drug.id, drugName: drug.genericName, note: rule.note, severity: 'info', kind: 'pediatric', recommendation: rule.note });
    }
    if (ctx.ageYears < 2 && ctx.weightKg == null) {
      adjustments.push({
        drugId: drug.id,
        drugName: drug.genericName,
        note: 'Infant under 2 years without a recorded weight — weight-based dosing cannot be calculated safely.',
        severity: 'warning',
        kind: 'pediatric',
        recommendation: 'Record the infant\'s current weight before prescribing.',
      });
    }
  }

  // ---- Geriatric
  if (ctx.ageYears != null && ctx.ageYears >= 65) {
    const note = GERIATRIC_NOTES[drug.id];
    if (note) {
      adjustments.push({ drugId: drug.id, drugName: drug.genericName, note, severity: 'warning', kind: 'geriatric', recommendation: note });
    }
  }

  // ---- Pregnancy
  if (ctx.isPregnant) {
    const block = PREGNANCY_BLOCKS[drug.id];
    if (block) {
      if (block.avoid) {
        contraindications.push({
          drugId: drug.id,
          drugName: drug.genericName,
          reason: `Pregnancy category ${block.category}: ${block.note}`,
          severity: 'critical',
          source: 'label',
        });
      } else {
        adjustments.push({
          drugId: drug.id,
          drugName: drug.genericName,
          note: `Pregnancy category ${block.category}: ${block.note}`,
          severity: 'warning',
          kind: 'pregnancy',
          recommendation: block.alternative ? `Consider ${block.alternative}.` : block.note,
        });
      }
    } else if (drug.pregnancy === 'd' || drug.pregnancy === 'x') {
      contraindications.push({
        drugId: drug.id,
        drugName: drug.genericName,
        reason: `${drug.genericName} is pregnancy category ${drug.pregnancy.toUpperCase()}: ${drug.contraindications.join('; ') || 'known fetal risk'}.`,
        severity: 'critical',
        source: 'label',
      });
    } else if (drug.pregnancy === 'c') {
      adjustments.push({
        drugId: drug.id,
        drugName: drug.genericName,
        note: `Pregnancy category C: use only where the benefit clearly outweighs the risk.`,
        severity: 'info',
        kind: 'pregnancy',
        recommendation: drug.indication,
      });
    }
  }

  // ---- Lactation
  if (ctx.isBreastfeeding) {
    const rule = LACTATION_RULES[drug.id];
    if (rule && !rule.compatible) {
      adjustments.push({
        drugId: drug.id,
        drugName: drug.genericName,
        note: `Breastfeeding: ${rule.note}`,
        severity: 'warning',
        kind: 'lactation',
        recommendation: rule.note,
      });
    } else if (drug.lactation === 'avoid') {
      adjustments.push({
        drugId: drug.id,
        drugName: drug.genericName,
        note: `${drug.genericName} is not recommended while breastfeeding.`,
        severity: 'warning',
        kind: 'lactation',
        recommendation: 'Select a breastfeeding-compatible alternative.',
      });
    }
  }

  // ---- Labelled contraindications that match the patient record
  for (const contra of drug.contraindications) {
    const c = contra.toLowerCase();
    let matched: string | null = null;
    if (c.includes('pregnan') && ctx.isPregnant) matched = contra;
    else if (c.includes('eGFR') || c.includes('renal')) {
      const m = c.match(/egfr\s*<\s*(\d+)/);
      if (m && egfr != null && egfr < Number(m[1])) matched = contra;
    } else if (c.includes('hepatic') || c.includes('liver') || c.includes('cirrhosis')) {
      if (gradeTransaminases(Math.max(ctx.ast ?? 0, ctx.alt ?? 0)) !== 'normal') matched = contra;
      else if (ctx.chronicConditions.some((cc) => /hepatic|liver|cirrhosis|alcoholic hepatitis/i.test(cc))) matched = contra;
    } else if (c.includes('child') && ctx.ageYears != null && ctx.ageYears < 12) matched = contra;
    if (matched) {
      const already = contraindications.some((x) => x.reason === matched);
      if (!already) {
        contraindications.push({
          drugId: drug.id,
          drugName: drug.genericName,
          reason: `Labelled contraindication relevant to this patient: ${matched}`,
          severity: 'critical',
          source: 'label',
        });
      }
    }
  }

  return { adjustments, contraindications };
}

/** Monitorable vitals implied by a drug's monitoring requirements. */
export function monitoringVitalsFor(drug: Drug): { kind: VitalKind; label: string; frequency: string; reason: string }[] {
  const out: { kind: VitalKind; label: string; frequency: string; reason: string }[] = [];
  const text = drug.monitoring.join(' ').toLowerCase();
  const push = (kind: VitalKind, frequency: string, reason: string): void => {
    out.push({ kind, label: getVitalDefinition(kind).label, frequency, reason });
  };
  if (text.includes('fasting') || text.includes('glucose') || text.includes('a1c')) push('fasting_glucose', 'Weekly until stable, then monthly', 'Detect hypoglycaemia and loss of control');
  if (text.includes('blood pressure')) push('systolic_bp', 'Every review', 'Assess antihypertensive efficacy and hypotension');
  if (text.includes('potassium')) push('serum_potassium', 'Within 1 week, 1 month, then 3–6 monthly', 'Detect hyperkalaemia from RAAS blockade or diuretics');
  if (text.includes('creatinine') || text.includes('renal')) push('creatinine', 'Within 1–2 weeks of starting an NSAID or RAAS agent', 'Detect acute kidney injury');
  if (text.includes('lipid') || text.includes('ldl')) push('ldl', 'After 4–6 weeks, then 6–12 monthly', 'Confirm lipid target attainment');
  if (text.includes('haemoglobin') || text.includes('hemoglobin')) push('hemoglobin', 'After 4–6 weeks of haematinics', 'Confirm response to treatment');
  if (text.includes('heart rate')) push('pulse', 'Each review', 'Detect bradycardia or tachycardia');
  if (text.includes('liver') || text.includes('transaminase')) push('weight', 'Each review', 'Track weight; unexplained loss may indicate hepatic toxicity');
  return out;
}

/** Weight-based dose calculator (mg/kg/day) for paediatric-friendly drugs. */
export function weightBasedDose(dosePerKgDay: number, weightKg: number): number {
  return Math.round(dosePerKgDay * weightKg);
}
