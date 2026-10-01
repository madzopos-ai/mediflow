/**
 * Lab-guided dosing: explicit drug + dose from this patient's numbers.
 *
 * The protocol engine says *what class* to consider; this module says *how
 * much*, with every number cited. HbA1c 9.1 in a 50-year-old weighing 82 kg
 * with an eGFR of 42 is not the same patient as the same HbA1c in a frail
 * 80-year-old with an eGFR of 25 - the recommendations below read those
 * differences and write them into the reasons, so the doctor sees the *why*
 * next to the *what*.
 *
 * Conservative by design: tiers follow widely used thresholds, renal caps
 * are hard stops rather than suggestions, and anything genuinely risky
 * (insulin initiation, for example) is deliberately absent - that decision
 * stays entirely with the doctor. Output is a draft like everything else.
 */

export interface DoseLabs {
  hba1c: number | null;
  creatinine: number | null;
  egfr: number | null;
  ldl: number | null;
  triglycerides: number | null;
  systolic: number | null;
  microalbumin: number | null;
  urineAcr: number | null;
  /** Blood urea (BUN-equivalent panel value, mg/dL) - kidney context. */
  urea: number | null;
}

export interface DoseBiometrics {
  ageYears: number | null;
  sex: string;
  weightKg: number | null;
}

export interface DoseRecommendation {
  drug: string;
  dose: string;
  frequency: string;
  durationDays: number | null;
  /** Each reason cites the value that produced it. */
  reasons: string[];
  /** True when the right answer is to withhold, not to dose. */
  contraindicated: boolean;
}

export interface DoseInput {
  diagnosis: string;
  conditions: string[];
  labs: DoseLabs;
  biometrics: DoseBiometrics;
  /** Generic names, any case. */
  currentMedications: string[];
}

const DIABETES = /diabet|dm2|t2dm|t1dm|hyperglyc/i;

function isDiabetic(diagnosis: string, conditions: string[], hba1c: number | null): boolean {
  if (hba1c !== null && hba1c >= 6.5) return true;
  if (DIABETES.test(diagnosis)) return true;
  return conditions.some((c) => DIABETES.test(c));
}

function onDrug(currentMedications: string[], ...names: string[]): boolean {
  const meds = currentMedications.map((m) => m.toLowerCase());
  return names.some((name) => meds.some((m) => m.includes(name.toLowerCase())));
}

function fmt(value: number): string {
  return String(Math.round(value * 10) / 10);
}

export function recommendLabGuidedDoses(input: DoseInput): DoseRecommendation[] {
  const out: DoseRecommendation[] = [];
  const { labs, biometrics } = input;
  const diabetic = isDiabetic(input.diagnosis, input.conditions, labs.hba1c);
  const albuminuria =
    (labs.urineAcr !== null && labs.urineAcr > 30) || (labs.microalbumin !== null && labs.microalbumin > 30);

  // ---- Metformin: HbA1c tier sets the dose, kidneys set the ceiling ----
  if (diabetic && !onDrug(input.currentMedications, 'metformin', 'glucophage')) {
    if (labs.egfr !== null && labs.egfr < 30) {
      out.push({
        drug: 'Metformin',
        dose: 'withhold',
        frequency: '',
        durationDays: null,
        reasons: [`eGFR ${fmt(labs.egfr)} < 30 - metformin is contraindicated, use an alternative`],
        contraindicated: true,
      });
    } else if (labs.hba1c !== null && labs.hba1c >= 9) {
      const capped = labs.egfr !== null && labs.egfr < 45;
      out.push({
        drug: 'Metformin',
        dose: capped ? '1000mg' : '1000mg',
        frequency: capped ? 'once daily' : 'twice daily',
        durationDays: 30,
        reasons: [
          `HbA1c ${fmt(labs.hba1c)}% ≥ 9 - intensify to full dose`,
          ...(capped ? [`eGFR ${fmt(labs.egfr ?? 0)} < 45 - capped at 1000mg total daily`] : []),
        ],
        contraindicated: false,
      });
    } else if (labs.hba1c !== null && labs.hba1c >= 7) {
      out.push({
        drug: 'Metformin',
        dose: '500mg',
        frequency: 'twice daily',
        durationDays: 30,
        reasons: [`HbA1c ${fmt(labs.hba1c)}% above goal - start/continue 500mg twice daily`],
        contraindicated: false,
      });
    } else if (labs.hba1c === null) {
      out.push({
        drug: 'Metformin',
        dose: '500mg',
        frequency: 'twice daily',
        durationDays: 30,
        reasons: ['No HbA1c on file - standard start; recheck HbA1c in 3 months'],
        contraindicated: false,
      });
    }
  }

  // ---- SGLT2 inhibitor: dual-therapy backbone at HbA1c ≥ 9 ----
  // Glycemic control PLUS renal/cardiac protection on top of metformin.
  // Never initiation below eGFR 20 for glycemia - nephrology owns that call.
  const onSglt2 = onDrug(
    input.currentMedications,
    'sglt2',
    'empagliflozin',
    'dapagliflozin',
    'jardiance',
    'forxiga',
  );
  if (diabetic && labs.hba1c !== null && labs.hba1c >= 9 && !onSglt2) {
    if (labs.egfr !== null && labs.egfr < 20) {
      out.push({
        drug: 'Empagliflozin',
        dose: 'withhold',
        frequency: '',
        durationDays: null,
        reasons: [`eGFR ${fmt(labs.egfr)} < 20 - SGLT2i not initiated for glycemia at this level; nephrology input needed`],
        contraindicated: true,
      });
    } else {
      out.push({
        drug: 'Empagliflozin',
        dose: '10mg',
        frequency: 'once daily',
        durationDays: 30,
        reasons: [
          `HbA1c ${fmt(labs.hba1c)}% ≥ 9 - dual therapy with metformin for combined glycemic control`,
          ...(albuminuria ? ['albuminuria present - added renal protection alongside ACEi/ARB therapy'] : []),
          ...(labs.egfr !== null ? [`eGFR ${fmt(labs.egfr)} - eligible for SGLT2i initiation`] : []),
          'Recheck HbA1c in 3 months; renal panel in 2-4 weeks',
          'Safety: hold during acute illness, fasting or dehydration (ketoacidosis risk); counsel on foot care and genital hygiene',
        ],
        contraindicated: false,
      });
    }
  }

  // ---- Statin: LDL level, or diabetes + age as the risk equivalent ----
  const age = biometrics.ageYears;
  if (!onDrug(input.currentMedications, 'statin', 'atorvastatin', 'rosuvastatin', 'simvastatin', 'pravastatin')) {
    if (labs.ldl !== null && labs.ldl >= 190) {
      out.push({
        drug: 'Atorvastatin',
        dose: '20mg',
        frequency: 'once nightly',
        durationDays: 30,
        reasons: [`LDL ${fmt(labs.ldl)} mg/dL ≥ 190 - high-intensity statin indicated`],
        contraindicated: false,
      });
    } else if (diabetic && age !== null && age >= 40 && age <= 75) {
      out.push({
        drug: 'Atorvastatin',
        dose: '20mg',
        frequency: 'once nightly',
        durationDays: 30,
        reasons: [
          `Diabetes, age ${age}${labs.ldl !== null ? `, LDL ${fmt(labs.ldl)}` : ''} - primary prevention per guideline age band`,
        ],
        contraindicated: false,
      });
    } else if (labs.ldl !== null && labs.ldl >= 130) {
      out.push({
        drug: 'Atorvastatin',
        dose: '10mg',
        frequency: 'once nightly',
        durationDays: 30,
        reasons: [`LDL ${fmt(labs.ldl)} mg/dL in the 130-189 band - moderate-intensity statin`],
        contraindicated: false,
      });
    }
  }

  // ---- ACE inhibitor: albuminuria is the trigger, kidneys the guardrail ----
  if (albuminuria && !onDrug(input.currentMedications, 'lisinopril', 'enalapril', 'losartan', 'valsartan', 'irbesartan')) {
    const acrText =
      labs.urineAcr !== null && labs.urineAcr > 30
        ? `ACR ${fmt(labs.urineAcr)} mg/g > 30`
        : `microalbumin ${fmt(labs.microalbumin ?? 0)} mg/L > 30`;
    out.push({
      drug: 'Lisinopril',
      dose: '10mg',
      frequency: 'once daily',
      durationDays: 30,
      reasons: [
        `${acrText} - ACE inhibition for kidney protection; recheck creatinine in 2 weeks`,
        ...(labs.urea !== null && labs.urea >= 60
          ? [`urea ${fmt(labs.urea)} mg/dL - azotemia alongside albuminuria, monitor renal function closely`]
          : []),
      ],
      contraindicated: false,
    });
  }

  // ---- Triglycerides: severe levels threaten the pancreas, moderate levels
  // add to cardiovascular risk alongside LDL ----
  const onStatin = onDrug(input.currentMedications, 'statin', 'atorvastatin', 'rosuvastatin', 'simvastatin', 'pravastatin');
  const statinRecommended = out.some((r) => r.drug === 'Atorvastatin');
  if (labs.triglycerides !== null && labs.triglycerides >= 500) {
    out.push({
      drug: 'Fenofibrate',
      dose: '145mg',
      frequency: 'once daily',
      durationDays: 30,
      reasons: [`Triglycerides ${fmt(labs.triglycerides)} mg/dL ≥ 500 - pancreatitis risk, fibrate indicated`],
      contraindicated: false,
    });
  } else if (labs.triglycerides !== null && labs.triglycerides >= 150 && !onStatin && !statinRecommended) {
    out.push({
      drug: 'Atorvastatin',
      dose: '20mg',
      frequency: 'once nightly',
      durationDays: 30,
      reasons: [`Triglycerides ${fmt(labs.triglycerides)} mg/dL ≥ 150 - address cardiovascular risk with a statin`],
      contraindicated: false,
    });
  }

  return out;
}
