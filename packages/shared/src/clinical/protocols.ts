/**
 * Condition-first treatment protocols.
 *
 * Each protocol captures the standard first-line approach for a condition,
 * alternative options, required investigations, monitoring and red flags. The
 * decision-support engine uses these to build suggestions deterministically —
 * they are the *fallback* and the *safety net* when an LLM is not configured.
 */

import type { Specialty, VitalKind } from '../domain/enums.js';
import { getDrug } from './drugs.js';
import { VITAL_DEFINITIONS } from './vitals.js';

export interface ProtocolRegimenOption {
  drugId: string;
  /** Why this drug is chosen for this condition. */
  rationale: string;
  /** Line in the treatment pathway: first-line, second-line, third-line, adjunct or rescue. */
  role: 'first_line' | 'second_line' | 'third_line' | 'adjunct' | 'rescue';
  /** Notes specific to using this drug in this condition. */
  conditionNotes: string | null;
}

export interface ProtocolStep {
  step: number;
  title: string;
  detail: string;
}

export interface ClinicalProtocol {
  id: string;
  condition: string;
  /** Alternative/related spellings used for matching. */
  synonyms: string[];
  icdCode: string;
  specialties: Specialty[];
  summary: string;
  /** One-line patient counselling point. */
  counselling: string;
  investigations: string[];
  regimen: ProtocolRegimenOption[];
  monitoring: { label: string; kind: VitalKind | null; frequency: string; reason: string }[];
  steps: ProtocolStep[];
  redFlags: string[];
  referrals: string[];
  guidelineRefs: { title: string; source: string; url: string | null }[];
  /** Follow-up interval in days for the chronic follow-up engine. */
  followUpDays: number | null;
  /** Vitals the follow-up engine should request. */
  followUpVitals: VitalKind[];
  lifestyle: string[];
}

const ADA = { title: 'Standards of Care in Diabetes', source: 'American Diabetes Association', url: 'https://diabetesjournals.org/care/issue' };
const AHA = { title: 'Guideline for the Prevention, Detection, Evaluation and Management of High Blood Pressure in Adults', source: 'American Heart Association', url: 'https://www.ahajournals.org' };
const ESC = { title: 'ESC Guidelines on Cardiovascular Disease Prevention', source: 'European Society of Cardiology', url: 'https://www.escardio.org' };
const NICE = { title: 'NICE guidelines', source: 'National Institute for Health and Care Excellence', url: 'https://www.nice.org.uk/guidance' };
const WHO = { title: 'WHO Guidelines on Diabetes', source: 'World Health Organization', url: 'https://www.who.int' };
const ADAE = { title: 'Standards of Care in Diabetes — Education and psychosocial care', source: 'American Diabetes Association', url: null };
const GOLD = { title: 'GOLD strategy for prevention, diagnosis and management of COPD', source: 'Global Initiative for Chronic Obstructive Lung Disease', url: 'https://goldcopd.org' };
const ACG = { title: 'ACG Clinical Guideline for the diagnosis and management of GERD', source: 'American College of Gastroenterology', url: 'https://gi.org' };
const EAU = { title: 'EAU Guidelines on Urological Infections', source: 'European Association of Urology', url: 'https://uroweb.org' };
const APA = { title: 'Practice Guidelines for the Treatment of Patients with Major Depressive Disorder and Anxiety Disorders', source: 'American Psychiatric Association', url: 'https://www.psychiatry.org' };
const ILAE = { title: 'Epilepsy management guidelines', source: 'International League Against Epilepsy', url: 'https://www.ilae.org' };
const ICHD = { title: 'International Classification of Headache Disorders, 3rd edition', source: 'International Headache Society', url: 'https://ichd-3.org' };
const AAAAI = { title: 'Allergic disease practice parameters', source: 'American Academy of Allergy, Asthma and Immunology', url: 'https://www.aaaai.org' };
const BAD = { title: 'BAD Guidelines for the management of acne vulgaris', source: 'British Association of Dermatologists', url: 'https://www.bad.org.uk' };
const SIGN = { title: 'SIGN guideline on the management of dental pain and oral disease', source: 'Scottish Intercollegiate Guidelines Network', url: 'https://www.sign.ac.uk' };
const EFP = { title: 'EFP S3 level clinical practice guideline on the treatment of stage I-III periodontitis', source: 'European Federation of Periodontology', url: 'https://efp.org' };
const RCPCH = { title: 'RCPCH Paediatric Fever Guidelines', source: 'Royal College of Paediatrics and Child Health', url: 'https://www.rcpch.ac.uk' };
const AAP = { title: 'AAP Pediatric Emergency Medicine and Clinical Practice Guidelines', source: 'American Academy of Pediatrics', url: 'https://publications.aap.org' };

export const CLINICAL_PROTOCOLS: ClinicalProtocol[] = [
  // ------------------------------------------------------------- Diabetes
  {
    id: 't2dm',
    condition: 'Type 2 Diabetes Mellitus',
    synonyms: ['type 2 diabetes', 't2dm', 'diabetes', 'diabetes mellitus', 'dm', 'niddm', 'adult onset diabetes'],
    icdCode: 'E11',
    specialties: ['endocrinology', 'general_medicine', 'nutrition'],
    summary:
      'Lifestyle therapy plus metformin is first-line for most patients. Add a second agent when HbA1c is more than 1.5% above target or cardiovascular/renal indications exist. SGLT2 inhibitors or GLP-1 receptor agonists are preferred when there is established cardiovascular or kidney disease.',
    counselling:
      'Reduce sugary drinks, aim for 150 minutes of activity per week, lose 5–7% of body weight, and check your feet daily if you have diabetes.',
    investigations: ['HbA1c', 'Fasting lipid profile', 'Serum creatinine with eGFR', 'Urine albumin-to-creatinine ratio', 'Dilated retinal examination at diagnosis and annually', 'Urine for glucose and ketones if unwell'],
    regimen: [
      { drugId: 'metformin', rationale: 'First-line therapy with proven cardiovascular benefit, weight neutrality and negligible hypoglycaemia risk. Start low and titrate to reduce GI intolerance.', role: 'first_line', conditionNotes: 'Start 500 mg once or twice daily with the evening meal; titrate by 500 mg every 1–2 weeks to 1.5–2 g/day.' },
      { drugId: 'empagliflozin', rationale: 'Preferred second agent when there is heart failure or chronic kidney disease: reduces hospitalisation and slows eGFR decline.', role: 'second_line', conditionNotes: 'Ensure eGFR ≥30 before starting; counsel on genital hygiene and sick-day rules (hold during vomiting, fasting or acute illness).' },
      { drugId: 'sitagliptin', rationale: 'Weight-neutral add-on with very low intrinsic hypoglycaemia risk; useful when SGLT2 inhibitors are unsuitable.', role: 'second_line', conditionNotes: 'Reduce to 50 mg daily if eGFR 30–45.' },
      { drugId: 'glimepiride', rationale: 'Low-cost option with proven HbA1c reduction, but carries a higher risk of hypoglycaemia than newer agents.', role: 'second_line', conditionNotes: 'Dose carefully: a 1 mg tablet with breakfast may be sufficient for many patients.' },
      { drugId: 'insulin-glargine', rationale: 'Basal insulin when HbA1c remains above target despite maximal oral therapy, or when catabolic symptoms are present.', role: 'second_line', conditionNotes: 'Start 0.1–0.2 IU/kg once daily; titrate 2 IU every 3 days to a fasting target of 80–130 mg/dL.' },
      { drugId: 'insulin-aspart', rationale: 'Rapid-acting insulin for mealtime control, usually added to basal insulin when postprandial glucose remains high.', role: 'adjunct', conditionNotes: 'Start 0.03–0.05 IU/kg before each meal; titrate against postprandial readings.' },
      { drugId: 'vitamin-d3', rationale: 'Correction of deficiency, which is very common in type 2 diabetes and contributes to bone disease and poorer outcomes.', role: 'adjunct', conditionNotes: 'Correct deficiency before high-dose maintenance.' },
    ],
    monitoring: [
      { label: 'HbA1c', kind: 'hba1c', frequency: 'Every 3 months until stable, then 6 monthly', reason: 'Tracks glycaemic control' },
      { label: 'Fasting blood glucose', kind: 'fasting_glucose', frequency: 'Daily by the patient', reason: 'Detects excursions and hypoglycaemia between visits' },
      { label: 'Blood pressure', kind: 'systolic_bp', frequency: 'Each visit', reason: 'Cardiovascular risk reduction is as important as glycaemic control' },
      { label: 'Renal function (eGFR)', kind: 'creatinine', frequency: 'Every 6–12 months', reason: 'Metformin safety and CKD staging' },
      { label: 'Urine albumin-to-creatinine ratio', kind: null, frequency: 'Annually', reason: 'Early nephropathy detection' },
      { label: 'Dilated fundus examination', kind: null, frequency: 'At diagnosis then annually', reason: 'Screening for diabetic retinopathy' },
      { label: 'Foot examination', kind: null, frequency: 'Every visit', reason: 'Ulcer prevention — the leading cause of amputation' },
    ],
    steps: [
      { step: 1, title: 'Confirm the diagnosis and baseline', detail: 'Repeat HbA1c to confirm, exclude type 1 and pancreatogenic diabetes, and obtain baseline renal, lipid, retinal and foot assessments.' },
      { step: 2, title: 'Lifestyle and education', detail: 'Refer to a dietitian, set a 5–7% weight target, and give structured self-management education.' },
      { step: 3, title: 'Start metformin and titrate', detail: 'Begin at 500 mg once or twice daily with food, titrating to 1.5–2 g/day over 4–6 weeks as tolerated.' },
      { step: 4, title: 'Add a second agent by comorbidity', detail: 'SGLT2 inhibitor for heart failure or CKD; GLP-1 receptor agonist where obesity is dominant; a DPP-4 inhibitor when cost or tolerability limits other options.' },
      { step: 5, title: 'Consider insulin', detail: 'Basal insulin if HbA1c remains above target, or urgently for hyperglycaemic crisis, HbA1c above 10%, or catabolic symptoms.' },
      { step: 6, title: 'Treat all risk factors', detail: 'Statin for anyone over 40 or with additional risk factors, ACE inhibitor or ARB for albuminuria or hypertension, and antiplatelet therapy where indicated.' },
    ],
    redFlags: [
      'New or worsening polyuria, polydipsia and weight loss',
      'Vomiting, abdominal pain and deep rapid breathing (possible DKA)',
      'Glucose persistently above 300 mg/dL',
      'Any foot ulcer, even a painless one',
      'Visual loss or new distortion',
      'Hypoglycaemia unawareness or repeated readings below 70 mg/dL',
    ],
    referrals: ['Endocrinology if HbA1c is not at target after 3 months', 'Ophthalmology for retinopathy screening', 'Dietitian for structured lifestyle counselling', 'Podiatry for foot care'],
    guidelineRefs: [ADA, WHO, ADAE],
    followUpDays: 30,
    followUpVitals: ['fasting_glucose', 'systolic_bp', 'weight'],
    lifestyle: ['Reduce refined carbohydrate and sugary drinks', '150 minutes of moderate activity per week', '5–7% body weight reduction', 'Stop smoking', 'Annual foot and eye checks', 'Keep vaccinations up to date'],
  },
  {
    id: 't1dm',
    condition: 'Type 1 Diabetes Mellitus',
    synonyms: ['type 1 diabetes', 't1dm', 'juvenile diabetes', 'insulin dependent diabetes'],
    icdCode: 'E10',
    specialties: ['endocrinology', 'pediatrics', 'general_medicine'],
    summary: 'Lifelong basal-bolus insulin with structured education, carbohydrate counting, hypoglycaemia safety planning and regular complication screening.',
    counselling: 'Never stop insulin. Carry fast-acting glucose, wear medical identification, and check glucose before driving.',
    investigations: ['HbA1c every 3 months', 'Thyroid antibodies at diagnosis', 'Coeliac screening at diagnosis', 'Urine albumin-to-creatinine ratio annually', 'Retinal screening after 5 years then annually'],
    regimen: [
      { drugId: 'insulin-glargine', rationale: 'Long-acting basal insulin provides the 24-hour replacement that all patients with type 1 diabetes require.', role: 'first_line', conditionNotes: 'Typical total daily dose 0.3–0.5 IU/kg, split roughly 50% basal and 50% prandial.' },
      { drugId: 'insulin-aspart', rationale: 'Rapid-acting analogue covers meals and corrects hyperglycaemia.', role: 'first_line', conditionNotes: 'Usually 3 doses daily; dose by carbohydrate counting with a correction factor.' },
    ],
    monitoring: [
      { label: 'HbA1c', kind: 'hba1c', frequency: 'Every 3 months', reason: 'Targets are stricter in type 1 diabetes' },
      { label: 'Time in range', kind: null, frequency: 'Continuous if a sensor is available', reason: 'Correlates better with complications than HbA1c alone' },
      { label: 'Fasting glucose', kind: 'fasting_glucose', frequency: 'Daily', reason: 'Adjusts the basal dose' },
    ],
    steps: [
      { step: 1, title: 'Structured education', detail: 'Carbbohydrate counting, hypoglycaemia treatment, sick-day rules and insulin adjustment at a specialist diabetes clinic.' },
      { step: 2, title: 'Basal-bolus regimen', detail: 'Long-acting basal insulin once daily plus rapid-acting insulin with each meal and correction.' },
      { step: 3, title: 'Continuous glucose monitoring', detail: 'Consider CGM or flash monitoring to reduce severe hypoglycaemia and improve time in range.' },
      { step: 4, title: 'Screen for complications', detail: 'Annual retinal, renal, foot and lipid screening from the appropriate time point.' },
    ],
    redFlags: ['Recurrent severe hypoglycaemia', 'Hypoglycaemia unawareness', 'Persistent ketones during illness', 'DKA symptoms', 'Recurrent foot ulcers'],
    referrals: ['Specialist diabetes clinic', 'Dietitian', 'Ophthalmology'],
    guidelineRefs: [ADA, NICE],
    followUpDays: 14,
    followUpVitals: ['fasting_glucose'],
    lifestyle: ['Carbohydrate counting', 'Consistent insulin-to-meal timing', 'Always carry fast-acting carbohydrate', 'Medical identification', 'Sick-day rules'],
  },
  {
    id: 'hypertension',
    condition: 'Hypertension',
    synonyms: ['hypertension', 'high blood pressure', 'htn', 'hbp', 'raised blood pressure', 'essential hypertension'],
    icdCode: 'I10',
    specialties: ['cardiology', 'general_medicine', 'nephrology'],
    summary:
      'Confirm the diagnosis with home or ambulatory readings, address lifestyle, then start antihypertensive therapy. Stage 2 hypertension or a 10-year cardiovascular risk above 10% warrants combination therapy. Target blood pressure is below 130/80 for most adults, and below 140/90 in those over 80.',
    counselling: 'Reduce salt to under 5 g per day, take tablets every day even when you feel well, and keep a home blood pressure diary.',
    investigations: ['Home blood pressure readings or 24-hour ambulatory monitoring', 'Serum electrolytes, creatinine and eGFR', 'Fasting lipid profile', 'Fasting glucose or HbA1c', 'Urinalysis for protein', '12-lead ECG', 'Fundoscopy for grade 3–4 retinopathy'],
    regimen: [
      { drugId: 'amlodipine', rationale: 'Well tolerated, effective at any age and in isolated systolic hypertension, which is common in older adults.', role: 'first_line', conditionNotes: '5 mg daily, titrate to 10 mg after 4 weeks; combination with an ACE inhibitor or ARB provides additive BP reduction with less oedema.' },
      { drugId: 'losartan', rationale: 'Preferred where there is albuminuria, chronic kidney disease or heart failure, and better tolerated than ACE inhibitors regarding cough.', role: 'first_line', conditionNotes: 'Check potassium and creatinine 1–2 weeks after starting and after each dose change.' },
      { drugId: 'ramipril', rationale: 'ACE inhibitor with proven benefit in heart failure, post-MI and diabetic nephropathy.', role: 'first_line', conditionNotes: 'Counsel that a persistent dry cough in the first weeks is common and treatable, and to report facial swelling urgently.' },
      { drugId: 'hydrochlorothiazide', rationale: 'Useful third agent in resistant hypertension and synergistic with ACE inhibitors or ARBs.', role: 'adjunct', conditionNotes: 'Start at 12.5 mg in the morning; check electrolytes and creatinine within 2–3 weeks.' },
      { drugId: 'indapamide', rationale: 'Thiazide-like diuretic with a longer duration of action and better metabolic profile than hydrochlorothiazide.', role: 'adjunct', conditionNotes: '1.5 mg modified-release tablet each morning.' },
      { drugId: 'bisoprolol', rationale: 'Add in resistant hypertension and where there is ischaemic heart disease, heart failure or a rate indication.', role: 'adjunct', conditionNotes: 'Start 2.5 mg daily and titrate; do not stop abruptly.' },
      { drugId: 'spironolactone', rationale: 'The preferred fourth-line agent for resistant hypertension (PATHWAY-2 trial).', role: 'rescue', conditionNotes: 'Check potassium at 1 week and 1 month; avoid potassium supplements and salt substitutes.' },
    ],
    monitoring: [
      { label: 'Blood pressure', kind: 'systolic_bp', frequency: 'Each visit and at home daily if unstable', reason: 'Titration target' },
      { label: 'Serum potassium and creatinine', kind: 'serum_potassium', frequency: '1–2 weeks after starting an ACE inhibitor, ARB or potassium-sparing diuretic', reason: 'Detect hyperkalaemia and acute kidney injury' },
      { label: 'Weight', kind: 'weight', frequency: 'Each visit', reason: 'Weight loss lowers blood pressure and improves all risk factors' },
      { label: 'Urinalysis / ACR', kind: null, frequency: 'Annually', reason: 'Detect albuminuria, which changes drug choice' },
    ],
    steps: [
      { step: 1, title: 'Confirm the diagnosis', detail: 'Require elevated readings on at least two occasions, and use home or ambulatory monitoring to exclude white-coat hypertension.' },
      { step: 2, title: 'Address lifestyle', detail: 'Salt restriction, DASH-style diet, weight reduction, 150 minutes of activity per week, alcohol moderation and smoking cessation.' },
      { step: 3, title: 'Choose first-line therapy', detail: 'A calcium channel blocker, ACE inhibitor or ARB. Use a single-pill combination where available to improve adherence.' },
      { step: 4, title: 'Escalate to two drugs', detail: 'Stage 2 hypertension or high cardiovascular risk: start an ACE inhibitor or ARB plus a calcium channel blocker or thiazide-like diuretic.' },
      { step: 5, title: 'Manage resistant hypertension', detail: 'If uncontrolled on three agents including a diuretic, add spironolactone and confirm adherence and measurement technique first.' },
      { step: 6, title: 'Review the whole patient', detail: 'Assess for orthostatic hypotension, and review BP targets against age, comorbidity and frailty.' },
    ],
    redFlags: [
      'Blood pressure ≥180/120 mmHg with chest pain, breathlessness, neurological deficit or severe headache — hypertensive emergency',
      'Severe headache, visual disturbance or confusion',
      'Blood pressure ≥180/120 mmHg without symptoms — urgent same-week review',
      'Suspected secondary hypertension: onset under 30 years, resistant to three agents, or hypokalaemia',
    ],
    referrals: ['Nephrology for secondary hypertension or resistant disease', 'Cardiology for ischaemic heart disease or heart failure', 'Endocrinology for phaeochromocytoma workup'],
    guidelineRefs: [AHA, ESC, NICE],
    followUpDays: 30,
    followUpVitals: ['systolic_bp', 'weight'],
    lifestyle: ['Salt under 5 g per day', 'DASH-style eating pattern', '150 minutes of activity weekly', 'Limit alcohol to 14 units per week', 'Weight reduction of 5–10%', 'Smoking cessation'],
  },
  {
    id: 'diabetes-hyperglycaemia-acute',
    condition: 'Hyperglycaemia / Poor Glycaemic Control',
    synonyms: ['poor glycemic control', 'poor control', 'hyperglycemia', 'hyperglycaemia', 'uncontrolled diabetes', 'high blood sugar'],
    icdCode: 'R73.9',
    specialties: ['endocrinology', 'general_medicine'],
    summary: 'Identify the reason control has deteriorated — missed doses, intercurrent illness, weight gain, new medications or a change in renal function — before escalating therapy.',
    counselling: 'Report glucose readings below 70 mg/dL or above 300 mg/dL straight away, and never stop insulin during illness.',
    investigations: ['HbA1c and trend', 'Review of adherence and injection technique', 'Renal and hepatic function', 'Urinalysis for glucose and ketones', 'Review of diet and activity changes', 'Screen for infection, particularly urinary and dental'],
    regimen: [
      { drugId: 'metformin', rationale: 'Ensure the dose is optimised and tolerated before adding a second agent; up-titration often resolves apparent "failure".', role: 'first_line', conditionNotes: 'If the patient reports GI intolerance, try a slower titration or an extended-release preparation.' },
      { drugId: 'empagliflozin', rationale: 'Addresses postprandial excursions and weight, with cardiovascular and renal benefit.', role: 'second_line', conditionNotes: 'Remind the patient to hold the drug during fasting, vomiting or acute illness.' },
      { drugId: 'insulin-glargine', rationale: 'Basal insulin is required for HbA1c above 10%, symptomatic hyperglycaemia or catabolic features.', role: 'second_line', conditionNotes: 'Starting basal insulin while continuing metformin often allows 30–40% lower insulin doses.' },
    ],
    monitoring: [
      { label: 'Fasting glucose', kind: 'fasting_glucose', frequency: 'Daily for 2 weeks, then 3–4 times weekly', reason: 'Guides titration' },
      { label: 'HbA1c', kind: 'hba1c', frequency: 'Every 3 months', reason: 'Confirms the effect of the change' },
      { label: 'Blood pressure', kind: 'systolic_bp', frequency: 'Each visit', reason: 'Part of global risk reduction' },
    ],
    steps: [
      { step: 1, title: 'Identify the barrier', detail: 'Adherence, cost, injection technique, missed doses, dietary change, weight gain, intercurrent illness or a new medication that raises glucose.' },
      { step: 2, title: 'Check for complications', detail: 'Infection is the commonest cause of acute decompensation; also check ketones if the patient is unwell.' },
      { step: 3, title: 'Optimise existing therapy', detail: 'Titrate metformin, or simplify the regimen to reduce the daily burden.' },
      { step: 4, title: 'Add or switch agent', detail: 'Choose by comorbidity profile, cost and patient preference.' },
    ],
    redFlags: ['Glucose above 300 mg/dL persistently', 'Vomiting with abdominal pain (DKA)', 'Dehydration or reduced consciousness', 'Any reading of 300 mg/dL or above needs same-day contact'],
    referrals: ['Endocrinology for repeated failure of escalation', 'Diabetes nurse specialist for education'],
    guidelineRefs: [ADA],
    followUpDays: 14,
    followUpVitals: ['fasting_glucose'],
    lifestyle: ['Consistent meal timing', 'Reduce sugary drinks', 'Review injection sites for lipohypertrophy'],
  },

  // --------------------------------------------------------------- Lipids
  {
    id: 'dyslipidemia',
    condition: 'Dyslipidaemia',
    synonyms: ['hyperlipidemia', 'hyperlipidemia', 'dyslipidemia', 'dyslipidaemia', 'high cholesterol', 'high triglycerides', 'hypercholesterolemia'],
    icdCode: 'E78',
    specialties: ['cardiology', 'general_medicine', 'endocrinology'],
    summary:
      'Intensity of statin therapy is driven by the 10-year ASCVD risk. Lifestyle change is always required. LDL ≥190 mg/dL, diabetes over 40, or established ASCVD warrant high-intensity statin therapy; triglycerides above 500 mg/dL require urgent treatment because of pancreatitis risk.',
    counselling: 'Take the statin at the same time every day and report muscle pain, weakness or dark urine immediately.',
    investigations: ['Fasting lipid profile', 'HbA1c or fasting glucose', 'Liver function tests', 'Thyroid function if TSH is not available on the record', '10-year ASCVD risk calculation'],
    regimen: [
      { drugId: 'atorvastatin', rationale: 'High-intensity statin for ASCVD, diabetes over 40, or LDL above 130 mg/dL. Atorvastatin 40–80 mg reduces events by around 50%.', role: 'first_line', conditionNotes: 'Check lipids at 4–6 weeks; consider a temporary hold if myalgia develops.' },
      { drugId: 'rosuvastatin', rationale: 'Most potent statin available and the least affected by drug interactions, making it useful in poly-pharmacy.', role: 'first_line', conditionNotes: '20 mg daily for high-intensity therapy.' },
      { drugId: 'ezetimibe', rationale: 'Add-on that lowers LDL by a further 15–25% when the LDL target is not met on a statin, and is useful in statin intolerance.', role: 'second_line', conditionNotes: 'Well tolerated with no significant interactions.' },
    ],
    monitoring: [
      { label: 'Lipid profile', kind: 'ldl', frequency: '4–6 weeks after a change, then 6–12 monthly once at target', reason: 'Confirms target attainment' },
      { label: 'Liver enzymes', kind: null, frequency: 'If symptoms suggest myopathy or hepatotoxicity', reason: 'Statin safety' },
      { label: 'Creatine kinase', kind: null, frequency: 'Only if muscle symptoms occur', reason: 'Detects myopathy' },
    ],
    steps: [
      { step: 1, title: 'Calculate ASCVD risk', detail: 'Use the pooled cohort equation. Risk determines statin intensity, not the LDL value alone.' },
      { step: 2, title: 'Treat lifestyle factors', detail: 'Dietary saturated fat reduction, weight management, exercise, smoking cessation and treatment of secondary causes such as hypothyroidism or nephrotic syndrome.' },
      { step: 3, title: 'Start the appropriate statin', detail: 'Moderate intensity for intermediate risk, high intensity for high risk, and at least 40–50% LDL reduction for established ASCVD.' },
      { step: 4, title: 'Escalate to combination therapy', detail: 'If LDL remains above target, add ezetimibe, then consider a PCSK9 inhibitor for very high risk.' },
    ],
    redFlags: ['Triglycerides above 500 mg/dL — pancreatitis risk, same-week review', 'Triglycerides above 1000 mg/dL — urgent referral', 'Dark urine with muscle pain — possible rhabdomyolysis', 'Chest pain or stroke symptoms'],
    referrals: ['Cardiology for very high risk or established ASCVD', 'Endocrinology for familial hypercholesterolaemia', 'Dietitian'],
    guidelineRefs: [ESC, AHA],
    followUpDays: 90,
    followUpVitals: ['ldl', 'triglycerides'],
    lifestyle: ['Reduce saturated fat to under 7% of energy intake', 'Increase soluble fibre to 10–25 g per day', 'Physical activity 150 minutes weekly', 'Weight management', 'Smoking cessation'],
  },

  // ------------------------------------------------------------- Cardiology
  {
    id: 'coronary-artery-disease',
    condition: 'Coronary Artery Disease / Stable Angina',
    synonyms: ['cad', 'coronary artery disease', 'ischemic heart disease', 'ischaemic heart disease', 'stable angina', 'angina', 'chest pain', 'acs'],
    icdCode: 'I20',
    specialties: ['cardiology', 'general_medicine'],
    summary:
      'Relieve symptoms with nitrates and a beta blocker or calcium channel blocker, and reduce cardiovascular events with a statin, antiplatelet therapy and control of blood pressure. New-onset angina, rest pain or a change in pattern requires urgent assessment.',
    counselling: 'Stop activity and take a sublingual nitrate when chest pain starts; call emergency services if it is not relieved after 10 minutes.',
    investigations: ['12-lead ECG at rest and after symptoms', 'Troponin if the presentation is acute', 'Lipid profile, HbA1c, renal function', 'Echocardiogram', 'Exercise ECG or stress imaging if symptoms are stable', 'Coronary CT angiography or invasive angiography as indicated'],
    regimen: [
      { drugId: 'aspirin', rationale: 'Antiplatelet therapy for secondary prevention in stable coronary disease.', role: 'first_line', conditionNotes: '75–100 mg daily; add a PPI if gastrointestinal risk is elevated.' },
      { drugId: 'atorvastatin', rationale: 'High-intensity statin regardless of baseline LDL — the biggest single benefit in atherosclerotic disease.', role: 'first_line', conditionNotes: 'Aim for a 50% or greater LDL reduction.' },
      { drugId: 'bisoprolol', rationale: 'Beta blocker reduces angina frequency and mortality in ischaemic heart disease.', role: 'first_line', conditionNotes: 'Titrate to resting heart rate 55–60 bpm; do not stop abruptly.' },
      { drugId: 'isosorbide-mononitrate', rationale: 'Long-acting nitrate for angina prophylaxis in patients who remain symptomatic on a beta blocker.', role: 'adjunct', conditionNotes: 'Must be dosed consistently to avoid tolerance; contraindicated with PDE-5 inhibitors.' },
      { drugId: 'clopidogrel', rationale: 'Second antiplatelet where aspirin is not tolerated, or within 12 months of a coronary stent.', role: 'adjunct', conditionNotes: 'If combined with a PPI, prefer pantoprazole.' },
      { drugId: 'amlodipine', rationale: 'Add-on anti-anginal and antihypertensive agent with favourable tolerability.', role: 'adjunct', conditionNotes: 'Watch for ankle oedema.' },
    ],
    monitoring: [
      { label: 'Blood pressure', kind: 'systolic_bp', frequency: 'Each visit', reason: 'Target below 130/80 mmHg' },
      { label: 'Lipid profile', kind: 'ldl', frequency: '6–12 weekly', reason: 'LDL target below 55 mg/dL for very high risk' },
      { label: 'Heart rate', kind: 'pulse', frequency: 'Each visit', reason: 'Beta blocker titration' },
      { label: 'Angina frequency and exercise tolerance', kind: null, frequency: 'Each visit', reason: 'Symptom control' },
    ],
    steps: [
      { step: 1, title: 'Risk stratify', detail: 'Exercise testing or imaging to determine whether symptoms are stable angina or require urgent invasive assessment.' },
      { step: 2, title: 'Start secondary prevention', detail: 'Aspirin, high-intensity statin, blood pressure control and smoking cessation together reduce events more than any single drug.' },
      { step: 3, title: 'Control angina', detail: 'Beta blocker first, adding a calcium channel blocker then a long-acting nitrate if symptoms persist. Provide sublingual GTN for acute attacks.' },
      { step: 4, title: 'Reassess for revascularisation', detail: 'Persistent symptoms despite optimal medical therapy, or high-risk anatomy, warrant specialist referral.' },
    ],
    redFlags: [
      'Chest pain at rest lasting more than 20 minutes — acute coronary syndrome',
      'New or worsening angina, or a change in the usual pattern',
      'Chest pain with sweating, nausea or breathlessness',
      'Any suspected myocardial infarction — call emergency services',
    ],
    referrals: ['Cardiology for angiography or revascularisation', 'Cardiac rehabilitation', 'Smoking cessation service'],
    guidelineRefs: [ESC, AHA],
    followUpDays: 90,
    followUpVitals: ['systolic_bp', 'pulse', 'ldl'],
    lifestyle: ['Complete smoking cessation', 'Mediterranean-style diet', 'Cardiac rehabilitation', '150 minutes of activity weekly', 'Weight management', 'Medication adherence'],
  },
  {
    id: 'heart-failure',
    condition: 'Heart Failure',
    synonyms: ['heart failure', 'hf', 'hfref', 'hfpef', 'congestive heart failure', 'chf', 'cardiac failure'],
    icdCode: 'I50',
    specialties: ['cardiology', 'general_medicine', 'nephrology'],
    summary:
      'Guideline-directed medical therapy with an ARNI or ACE inhibitor, a beta blocker, a mineralocorticoid receptor antagonist and an SGLT2 inhibitor dramatically reduces mortality and hospitalisation. Loop diuretics relieve congestion but do not improve survival.',
    counselling: 'Weigh yourself every morning and report a 2 kg gain in three days; reduce salt and avoid NSAIDs.',
    investigations: ['Echocardiogram to confirm ejection fraction', 'BNP or NT-proBNP', '12-lead ECG', 'Renal and hepatic function, electrolytes', 'Chest radiograph if acutely unwell', 'Iron studies — iron deficiency is common and treatable'],
    regimen: [
      { drugId: 'spironolactone', rationale: 'Mineralocorticoid receptor antagonism reduces mortality and hospitalisation, and reduces admissions for worsening heart failure.', role: 'first_line', conditionNotes: 'Check potassium and creatinine at 1 week and 1 month, then every 3–6 months.' },
      { drugId: 'bisoprolol', rationale: 'Evidence-based beta blockade started low and titrated slowly improves survival substantially.', role: 'first_line', conditionNotes: 'Start 1.25 mg twice daily; titrate to 10 mg once daily. Do not start during decompensation.' },
      { drugId: 'losartan', rationale: 'Renin–angiotensin system blockade reduces mortality and hospitalisation; an ARNI is better where tolerated.', role: 'first_line', conditionNotes: 'Target a blood pressure below 130/80; consider a single-pill combination to aid adherence.' },
      { drugId: 'empagliflozin', rationale: 'SGLT2 inhibition reduces heart failure hospitalisation and cardiovascular death, independent of glucose-lowering.', role: 'first_line', conditionNotes: 'Also effective in patients without diabetes; hold during acute illness or fasting.' },
      { drugId: 'hydrochlorothiazide', rationale: 'Symptomatic relief of congestion in addition to loop diuretics.', role: 'adjunct', conditionNotes: 'Usually combined with a loop diuretic when volume overload persists.' },
    ],
    monitoring: [
      { label: 'Weight', kind: 'weight', frequency: 'Daily at home', reason: 'The most sensitive marker of fluid retention' },
      { label: 'Blood pressure', kind: 'systolic_bp', frequency: 'Each visit', reason: 'Guides titration; a low SBP may limit beta blocker dose' },
      { label: 'Serum potassium', kind: 'serum_potassium', frequency: 'At 1 week, 1 month, then 3–6 monthly', reason: 'Hyperkalaemia risk with spironolactone' },
      { label: 'Renal function', kind: 'creatinine', frequency: 'With each potassium check', reason: 'Detects the cardiorenal syndrome' },
      { label: 'Breathlessness and functional class', kind: null, frequency: 'Each visit', reason: 'Tracks response to therapy' },
    ],
    steps: [
      { step: 1, title: 'Confirm and phenotype', detail: 'Echocardiogram for ejection fraction, natriuretic peptide level, ECG, and screen for precipitating causes such as ischaemia or uncontrolled hypertension.' },
      { step: 2, title: 'Start the four pillars', detail: 'ARNI or ACE inhibitor, evidence-based beta blocker, mineralocorticoid receptor antagonist and SGLT2 inhibitor, all at low starting doses.' },
      { step: 3, title: 'Titrate to target', detail: 'Increase doses every 2–4 weeks as tolerated, aiming for target doses rather than stopping early.' },
      { step: 4, title: 'Control congestion', detail: 'Loop diuretic to euvolaemia with daily weights, plus fluid and salt advice.' },
      { step: 5, title: 'Look for reversible causes', detail: 'Correct iron deficiency, review rate and rhythm control, and optimise ischaemic and valvular disease.' },
    ],
    redFlags: [
      'Rapid weight gain of 2 kg or more in 3 days',
      'Breathlessness at rest, orthopnoea or paroxysmal nocturnal dyspnoea',
      'Chest pain suggesting myocardial infarction',
      'Syncope, or a heart rate below 50 or above 120 bpm at rest',
    ],
    referrals: ['Heart failure specialist or advanced HF clinic', 'Cardiac rehabilitation', 'Device therapy assessment (ICD/CRT) where ejection fraction remains low'],
    guidelineRefs: [ESC, AHA],
    followUpDays: 30,
    followUpVitals: ['weight', 'systolic_bp', 'pulse'],
    lifestyle: ['Salt restriction under 5–6 g per day', 'Daily weight monitoring with a written action plan', 'Fluid restriction if advised', 'Smoking cessation', 'Cardiac rehabilitation', 'Review all medicines with a pharmacist for interactions and NSAID use'],
  },
  {
    id: 'atrial-fibrillation',
    condition: 'Atrial Fibrillation',
    synonyms: ['afib', 'af', 'atrial fibrillation', 'a fib', 'afib'],
    icdCode: 'I48',
    specialties: ['cardiology', 'general_medicine'],
    summary:
      'Rate control plus stroke risk assessment with CHA2DS2-VASc. Anticoagulation is indicated above a score of 1 in men and 2 in women, and a DOAC is now preferred over warfarin for most patients. Rhythm control is appropriate for recent-onset AF, symptoms or heart failure.',
    counselling: 'Report any palpitations, dizziness or stroke symptoms immediately; take anticoagulants consistently and never stop them abruptly.',
    investigations: ['12-lead ECG confirming AF', 'Echocardiogram for ejection fraction and valve assessment', 'Thyroid function', 'Renal and hepatic function', 'Blood pressure and full blood count', 'Chest radiograph'],
    regimen: [
      { drugId: 'bisoprolol', rationale: 'Rate control reduces ventricular rate and improves diastolic filling; it also provides rate control during cardioversion.', role: 'first_line', conditionNotes: 'Titrate to resting rate below 110 bpm; symptoms may need tighter control.' },
      { drugId: 'amlodipine', rationale: 'Rate control where beta blockers are contraindicated or not tolerated, usually combined with digoxin.', role: 'first_line', conditionNotes: 'Watch for ankle oedema; rate control is less effective in high-output states.' },
      { drugId: 'rivaroxaban', rationale: 'Direct oral anticoagulant preferred for stroke prevention in non-valvular AF, with lower intracranial bleeding than warfarin and no routine monitoring.', role: 'first_line', conditionNotes: 'Check renal function yearly; confirm the correct dose for weight, age and creatinine.' },
      { drugId: 'warfarin', rationale: 'Required for mechanical heart valves and moderate-to-severe mitral stenosis, and where a DOAC is unsuitable or cost-limited.', role: 'second_line', conditionNotes: 'Target INR 2.0–3.0; interacts with many antibiotics and requires frequent monitoring.' },
      { drugId: 'digoxin', rationale: 'Additional rate control particularly useful in heart failure, usually added to a beta blocker.', role: 'adjunct', conditionNotes: 'Watch for toxicity in renal impairment; check levels in the elderly and with interacting medicines.' },
    ],
    monitoring: [
      { label: 'Heart rate', kind: 'pulse', frequency: 'Each visit and by the patient when symptomatic', reason: 'Rate control target' },
      { label: 'Blood pressure', kind: 'systolic_bp', frequency: 'Each visit', reason: 'Modifiable stroke risk factor' },
      { label: 'Renal function', kind: 'creatinine', frequency: 'At least annually for DOACs', reason: 'Dose and safety depend on renal clearance' },
      { label: 'Haemoglobin and platelets', kind: 'hemoglobin', frequency: 'Every 6–12 months', reason: 'Detects occult bleeding on anticoagulation' },
    ],
    steps: [
      { step: 1, title: 'Confirm AF and rate the stroke risk', detail: 'Document AF on ECG, check for reversible causes, and calculate CHA2DS2-VASc.' },
      { step: 2, title: 'Rate control', detail: 'Beta blocker, or a calcium channel blocker or digoxin where beta blockers are unsuitable.' },
      { step: 3, title: 'Anticoagulate', detail: 'Start a DOAC when the stroke risk justifies it, after checking renal function, weight and interacting medicines.' },
      { step: 4, title: 'Rate or rhythm control', detail: 'Consider cardioversion for recent-onset AF, symptom-driven rhythm control, or a catheter ablation for recurrent symptomatic AF.' },
      { step: 5, title: 'Prevent complications', detail: 'Assess sleep apnoea, optimise blood pressure and weight, and counsel on anticoagulant adherence and bleeding precautions.' },
    ],
    redFlags: ['Stroke symptoms — FAST criteria, call emergency services', 'Syncope or near syncope', 'Uncontrolled ventricular rate with ischaemia or heart failure', 'Bleeding while anticoagulated', 'Palpitations with chest pain or breathlessness'],
    referrals: ['Cardiology or electrophysiology for rhythm control and ablation', 'Stroke prevention clinic', 'Sleep apnoea screening'],
    guidelineRefs: [ESC, AHA, NICE],
    followUpDays: 90,
    followUpVitals: ['pulse', 'systolic_bp'],
    lifestyle: ['Medication adherence for anticoagulation', 'Alcohol reduction — a modifiable AF trigger', 'Weight management', 'Blood pressure control', 'Sleep apnoea assessment', 'Recognise and report stroke symptoms'],
  },

  // ------------------------------------------------------------- Respiratory
  {
    id: 'asthma',
    condition: 'Asthma',
    synonyms: ['asthma', 'bronchial asthma', 'reactive airway disease', 'wheeze', 'wheezing'],
    icdCode: 'J45',
    specialties: ['pulmonology', 'pediatrics', 'general_medicine'],
    summary:
      'Diagnose with variable symptoms plus variable expiratory airflow limitation. Treatment is a stepwise approach: low-dose inhaled corticosteroid as needed for mild asthma, or as a preventer with a reliever for moderate disease. Review technique and adherence before stepping up.',
    counselling: 'Use a spacer with a metered-dose inhaler, rinse your mouth after steroid inhalers, and never use the reliever alone more than twice a week.',
    investigations: ['Spirometry with bronchodilator reversibility', 'Peak flow diary', 'FeNO and allergy testing if available', 'Chest radiograph if diagnosis is unclear', 'Assess for allergic triggers and occupational exposure'],
    regimen: [
      { drugId: 'budesonide-inhaler', rationale: 'Inhaled corticosteroid is the mainstay preventer therapy and reduces exacerbations.', role: 'first_line', conditionNotes: 'Start low and titrate according to symptoms, reliever use and exacerbation history; use a spacer.' },
      { drugId: 'salbutamol-inhaler', rationale: 'Short-acting beta-2 agonist for immediate symptom relief. It is a reliever, not a preventer.', role: 'rescue', conditionNotes: 'Reliever use more than twice weekly, or at night, indicates poor control.' },
      { drugId: 'montelukast', rationale: 'Leukotriene receptor antagonist for seasonal allergic asthma, or when a beta blocker is needed, or where inhaler technique is a problem.', role: 'second_line', conditionNotes: 'Trial for 4 weeks before judging benefit; counsel about mood and sleep changes.' },
      { drugId: 'amoxicillin-clavulanate', rationale: 'Treat bacterial exacerbations triggered by infection; most exacerbations are viral and do not need antibiotics.', role: 'adjunct', conditionNotes: 'Only where there is clear evidence of bacterial infection.' },
    ],
    monitoring: [
      { label: 'Reliever use frequency', kind: null, frequency: 'Reviewed at every visit', reason: 'The best single marker of control' },
      { label: 'Exacerbation frequency', kind: null, frequency: 'Reviewed at every visit', reason: 'Drives the treatment step' },
      { label: 'Lung function (FEV1, peak flow)', kind: null, frequency: 'At diagnosis, after step changes and at least annually', reason: 'Confirms control objectively' },
      { label: 'Oxygen saturation', kind: 'spo2', frequency: 'Each severe exacerbation', reason: 'Assesses severity' },
    ],
    steps: [
      { step: 1, title: 'Confirm the diagnosis', detail: 'Compatible symptoms plus variable airflow limitation on spirometry or peak flow. Treat COPD and vocal cord dysfunction as differentials.' },
      { step: 2, title: 'Check technique and adherence', detail: 'The most common reason for apparent treatment failure is poor inhaler technique or a spacer that is not used.' },
      { step: 3, title: 'Step up therapy', detail: 'Low-dose inhaled corticosteroid, then increase the dose or add a long-acting beta agonist, then consider higher doses and specialist referral.' },
      { step: 4, title: 'Written action plan', detail: 'Every patient should have a written plan describing when to use the reliever, when to step up steroids, and when to seek urgent care.' },
      { step: 5, title: 'Address risk factors', detail: 'Smoking, occupational exposure, obesity, rhinitis and reflux all worsen control; ensure influenza and COVID-19 vaccination.' },
    ],
    redFlags: ['Severe breathlessness, inability to speak in full sentences, or silent chest', 'Peak flow below 50% of personal best', 'Blue lips, confusion or exhaustion — call emergency services', 'No improvement after 48 hours of increased steroids', 'Any exacerbation requiring hospital admission'],
    referrals: ['Respiratory specialist for frequent exacerbations, poor control or steroid-dependent disease', 'Allergy clinic if trigger avoidance is unclear', 'Asthma nurse for technique checks'],
    guidelineRefs: [NICE, WHO],
    followUpDays: 90,
    followUpVitals: ['spo2'],
    lifestyle: ['Smoking cessation', 'Avoid known triggers and occupational exposures', 'Use a spacer with every metered-dose inhaler', 'Check inhaler technique at every visit', 'Annual influenza vaccination', 'Written action plan'],
  },
  {
    id: 'copd',
    condition: 'COPD',
    synonyms: ['copd', 'chronic obstructive pulmonary disease', 'emphysema', 'chronic bronchitis', 'smokers cough'],
    icdCode: 'J44',
    specialties: ['pulmonology', 'general_medicine'],
    summary:
      'Confirm with post-bronchodilator spirometry (FEV1/FVC below 0.7). Stop smoking, give vaccines, and use inhaled bronchodilators: a long-acting muscarinic antagonist and/or long-acting beta agonist for symptom relief, with inhaled corticosteroids for frequent exacerbations or high eosinophils. Long-term oxygen improves survival in severe chronic resting hypoxaemia.',
    counselling: 'Stopping smoking is the single most effective intervention; use pursed-lip breathing and stay active despite breathlessness.',
    investigations: ['Post-bronchodilator spirometry', 'Pulse oximetry and arterial blood gas if saturations below 92%', 'Chest radiograph', 'Full blood count and alpha-1 antitrypsin level in younger patients', 'CAT score for symptom burden', 'Echocardiogram if cor pulmonale is suspected'],
    regimen: [
      { drugId: 'budesonide-inhaler', rationale: 'Inhaled corticosteroid for patients with frequent exacerbations or raised blood eosinophils, usually in combination with a bronchodilator.', role: 'first_line', conditionNotes: 'Trial withdrawal after 3 months if exacerbations stop — ICS adds pneumonia risk.' },
      { drugId: 'salbutamol-inhaler', rationale: 'Short-acting reliever for immediate symptom relief in all severities.', role: 'rescue', conditionNotes: 'Over-reliance on the reliever indicates the long-acting therapy needs optimisation.' },
      { drugId: 'montelukast', rationale: 'Reduces exacerbations in COPD and is a useful add-on where inhaled therapy is difficult.', role: 'adjunct', conditionNotes: 'Trial for 3 months before assessing benefit.' },
    ],
    monitoring: [
      { label: 'Oxygen saturation', kind: 'spo2', frequency: 'Each visit', reason: 'Detects chronic hypoxaemia needing assessment' },
      { label: 'Exacerbation frequency', kind: null, frequency: 'Reviewed at every visit', reason: 'Determines need for ICS and admission risk' },
      { label: 'CAT score', kind: null, frequency: 'Every 6–12 months', reason: 'Tracks symptom burden and treatment response' },
      { label: 'Lung function', kind: null, frequency: 'At least annually', reason: 'Progression and inhaler technique' },
    ],
    steps: [
      { step: 1, title: 'Confirm with spirometry', detail: 'Post-bronchodilator FEV1/FVC below 0.70 is required; spirometry is often performed once the patient is clinically stable.' },
      { step: 2, title: 'Smoking cessation', detail: 'Offer pharmacotherapy (varenicline, NRT, bupropion) plus behavioural support; this is the highest-yield intervention.' },
      { step: 3, title: 'Bronchodilator therapy', detail: 'A long-acting muscarinic antagonist, long-acting beta agonist, or dual therapy according to symptom burden and exacerbation risk.' },
      { step: 4, title: 'Add inhaled corticosteroid', detail: 'Only for exacerbations despite optimal bronchodilators, or eosinophils above 300 cells/µL.' },
      { step: 5, title: 'Pulmonary rehabilitation', detail: 'Refer every patient — it improves exercise capacity, quality of life and admission rates.' },
      { step: 6, title: 'Long-term oxygen', detail: 'Assess for home oxygen if resting PaO2 is below 55 mmHg, or 55–60 mmHg with pulmonary hypertension or polycythaemia.' },
    ],
    redFlags: ['Acute severe breathlessness with exhaustion or confusion', 'Blue lips or saturations below 88%', 'New confusion, somnolence or asterixis — possible CO2 retention', 'Failure of an exacerbation to improve in 48 hours', 'Inability to eat, speak or sleep due to breathlessness'],
    referrals: ['Respiratory specialist for severe disease, frequent exacerbations or oxygen assessment', 'Pulmonary rehabilitation', 'Smoking cessation service'],
    guidelineRefs: [GOLD, NICE],
    followUpDays: 90,
    followUpVitals: ['spo2'],
    lifestyle: ['Smoking cessation — the definitive intervention', 'Pulmonary rehabilitation', 'Annual influenza and pneumococcal vaccination', 'Stay physically active', 'Pursed-lip breathing techniques', 'Avoid air pollution and occupational dusts'],
  },

  // -------------------------------------------------------------------- GI
  {
    id: 'gerd',
    condition: 'Gastro-oesophageal Reflux Disease (GERD)',
    synonyms: ['gerd', 'reflux', 'heartburn', 'acid reflux', 'gord', 'acid reflux'],
    icdCode: 'K21',
    specialties: ['gastroenterology', 'general_medicine'],
    summary:
      'Distinguish uncomplicated reflux from oesophagitis, Barrett oesophagus and alarm-feature malignancy. A proton pump inhibitor for 8 weeks is first line; review need after 4–8 weeks, step down to the lowest effective dose or on-demand therapy, and always address lifestyle and alarm features.',
    counselling: 'Avoid late meals, raise the head of the bed, avoid lying down for 3 hours after eating, and reduce weight if overweight.',
    investigations: ['Upper GI endoscopy for alarm features or persistent symptoms despite 8 weeks of PPI', 'Non-invasive reflux monitoring where PPI-refractory symptoms are unexplained', 'H. pylori testing before long-term PPI', 'CBC and iron studies for occult blood loss'],
    regimen: [
      { drugId: 'omeprazole', rationale: 'Proton pump inhibitor suppresses acid and heals oesophagitis more effectively than H2 antagonists.', role: 'first_line', conditionNotes: '20 mg daily before breakfast for 8 weeks; escalate to 40 mg for severe oesophagitis.' },
      { drugId: 'pantoprazole', rationale: 'Preferred PPI when clopidogrel is also prescribed, because CYP2C19 inhibition is minimal.', role: 'first_line', conditionNotes: '40 mg daily before breakfast; best choice for stent patients on clopidogrel.' },
      { drugId: 'cetirizine', rationale: 'Antihistamine adds a weak nocturnal acid-blocking effect for symptomatic relief.', role: 'adjunct', conditionNotes: 'Limited efficacy; useful only for occasional breakthrough symptoms.' },
      { drugId: 'ondansetron', rationale: 'For nausea associated with reflux, or for vomiting in reflux oesophagitis.', role: 'adjunct', conditionNotes: 'Avoid if there is a QT risk.' },
      { drugId: 'metronidazole', rationale: 'One component of H. pylori eradication alongside a PPI and a second antibiotic.', role: 'adjunct', conditionNotes: 'Always prescribe as part of a guideline eradication regimen with adherence support.' },
    ],
    monitoring: [
      { label: 'Symptom response', kind: null, frequency: 'At 4–8 weeks', reason: 'Determines whether to step down or investigate' },
      { label: 'Long-term PPI safety', kind: null, frequency: 'Every 6–12 months', reason: 'Review need, check magnesium, vitamin B12 and consider H. pylori status' },
    ],
    steps: [
      { step: 1, title: 'Look for alarm features', detail: 'Dysphagia, odynophagia, weight loss, gastrointestinal bleeding, anaemia, vomiting, or symptoms over 55 years new or progressive — refer for endoscopy.' },
      { step: 2, title: 'Lifestyle measures', detail: 'Weight reduction, smaller meals, no food 3 hours before bed, head-of-bed elevation, smoking cessation, and reducing alcohol, caffeine, chocolate, mint and fatty or spicy food.' },
      { step: 3, title: 'Eight weeks of PPI', detail: 'Standard-dose PPI once daily before breakfast.' },
      { step: 4, title: 'Review and step down', detail: 'At 8 weeks, reduce to the lowest effective dose, use on-demand therapy, or stop and reassess symptoms.' },
      { step: 5, title: 'Investigate refractory symptoms', detail: 'Confirm compliance and technique first, then endoscopy or pH-impedance monitoring, and test for H. pylori.' },
    ],
    redFlags: ['Difficulty or pain on swallowing', 'Gastrointestinal bleeding or black stools', 'Unintentional weight loss', 'Persistent vomiting', 'Iron deficiency anaemia', 'New symptoms in a patient over 55'],
    referrals: ['Gastroenterology for alarm features, Barrett oesophagus or refractory symptoms', 'Dietitian', 'Weight management service'],
    guidelineRefs: [NICE, ACG],
    followUpDays: 60,
    followUpVitals: [],
    lifestyle: ['Weight reduction', 'No food 3 hours before bed', 'Head of bed elevated 10–15 cm', 'Smoking cessation', 'Reduce alcohol, caffeine, chocolate, mint and fatty food', 'Avoid tight clothing'],
  },
  {
    id: 'acute-diarrhea',
    condition: 'Acute Diarrhoea / Gastroenteritis',
    synonyms: ['diarrhea', 'diarrhoea', 'gastroenteritis', 'food poisoning', 'ac gastroenteritis', 'loose motions', 'enteritis'],
    icdCode: 'A09',
    specialties: ['gastroenterology', 'general_medicine', 'pediatrics'],
    summary:
      'Rehydration is the cornerstone of therapy. Antibiotics are rarely needed except for cholera, dysentery, giardiasis, suspected Campylobacter, or in high-risk or immunocompromised patients. Bismuth subsalicylate reduces duration in non-bloody diarrhoea.',
    counselling: 'Continue fluids and continue feeding, including breastfeeding. Wash hands carefully — this prevents spread to family.',
    investigations: ['Usually none — clinical diagnosis', 'Stool culture and sensitivity if bloody diarrhoea, severe illness, or an outbreak', 'Stool microscopy for ova, cysts and parasites if giardiasis is suspected', 'Electrolytes if severe dehydration', 'Intensive support if the patient is septic or shocked'],
    regimen: [
      { drugId: 'oral-rehydration-solution', rationale: 'WHO-formula ORS corrects both fluid and electrolyte loss and is the definitive treatment for dehydration.', role: 'first_line', conditionNotes: '200–400 mL after each loose stool for adults; 50–100 mL per loose stool in young children.' },
      { drugId: 'paracetamol', rationale: 'Fever and abdominal pain relief, avoiding NSAIDs which are riskier in dehydration.', role: 'adjunct', conditionNotes: 'Safe in dehydration provided the dose interval is respected.' },
      { drugId: 'azithromycin', rationale: 'First-line antibiotic for suspected Campylobacter, cholera, and severe or febrile travellers diarrhoea.', role: 'second_line', conditionNotes: '5-day course; resistance is common so culture is useful where available.' },
      { drugId: 'metronidazole', rationale: 'Treats Giardia and Entamoeba histolytica, which cause prolonged diarrhoea and malabsorption.', role: 'second_line', conditionNotes: 'Requires a full 5–7 day course; strict alcohol avoidance.' },
      { drugId: 'ondansetron', rationale: 'Controls vomiting to allow oral rehydration to be tolerated.', role: 'adjunct', conditionNotes: 'Use only when vomiting prevents oral intake.' },
    ],
    monitoring: [
      { label: 'Hydration status', kind: 'spo2', frequency: 'At presentation and each review', reason: 'Guides fluid management' },
      { label: 'Weight', kind: 'weight', frequency: 'Each review in children and severe cases', reason: 'The most sensitive measure of fluid loss in children' },
      { label: 'Urine output', kind: null, frequency: 'At each review', reason: 'End-point of rehydration' },
    ],
    steps: [
      { step: 1, title: 'Assess severity', detail: 'Classify as mild, moderate or severe dehydration; check for blood, fever, and immunocompromise or elderly status.' },
      { step: 2, title: 'Rehydrate', detail: 'ORS for all severities; intravenous isotonic fluids only for shock or inability to tolerate oral fluids.' },
      { step: 3, title: 'Continue feeding', detail: 'Early return to normal feeding shortens the illness, including continued breastfeeding in infants.' },
      { step: 4, title: 'Decide on antibiotics', detail: 'Reserve for dysentery, cholera, giardiasis, immunocompromise, or severe febrile illness.' },
      { step: 5, title: 'Prevent spread', detail: 'Strict hand hygiene, safe food and water, and exclude contacts from work or school if required.' },
    ],
    redFlags: ['Blood in the stool', 'Severe dehydration, sunken eyes, no urine for 8 hours, or lethargy', 'Persistent high fever or severe abdominal pain', 'Diarrhoea lasting more than 14 days', 'Infants, elderly or immunocompromised patients with any moderate illness'],
    referrals: ['Admission if severe dehydration, shock or inability to rehydrate orally', 'Public health notification for cholera or suspected outbreak', 'Investigate diarrhoea lasting more than 6 weeks'],
    guidelineRefs: [WHO, NICE],
    followUpDays: 14,
    followUpVitals: ['temperature', 'weight'],
    lifestyle: ['Strict handwashing with soap for 20 seconds', 'Safe drinking water', 'Avoid street food and unpasteurised dairy while travelling', 'Continue feeding and breastfeeding', 'Clean and disinfect bathroom surfaces and nappies'],
  },
  {
    id: 'uti',
    condition: 'Urinary Tract Infection',
    synonyms: ['uti', 'urinary tract infection', 'cystitis', 'bladder infection', 'urethritis', 'pyelonephritis', 'kidney infection'],
    icdCode: 'N39',
    specialties: ['general_medicine', 'urology', 'pediatrics'],
    summary:
      'Uncomplicated lower UTI in a non-pregnant adult is usually treated with nitrofurantoin or trimethoprim. All pyelonephritis, pregnancy, male patients, children, and any systemic illness require urine culture, and most need systemic antibiotics. Urinary symptoms in men always need investigation.',
    counselling: 'Drink plenty of water, complete the antibiotic course, and seek help for fever, flank pain or vomiting.',
    investigations: ['Urine dipstick (nitrites, leukocytes)', 'Urine microscopy for pyuria', 'Urine culture and sensitivity for all pyelonephritis, pregnancy, men, children, relapse and treatment failure', 'Ultrasound or CT if recurrent or complicated', 'Renal function before nitrofurantoin in renal impairment'],
    regimen: [
      { drugId: 'nitrofurantoin', rationale: 'First-line for uncomplicated lower UTI because it concentrates in urine and does not select resistance elsewhere.', role: 'first_line', conditionNotes: '100 mg modified-release twice daily for 3 days; avoid if eGFR below 45.' },
      { drugId: 'amoxicillin-clavulanate', rationale: 'Broader option for complicated lower UTI or when oral cephalosporins are unsuitable.', role: 'second_line', conditionNotes: '5–7 day course.' },
      { drugId: 'cefuroxime', rationale: 'Alternative for uncomplicated lower UTI in patients with a penicillin allergy without anaphylaxis history.', role: 'first_line', conditionNotes: '250 mg twice daily for 5–7 days.' },
      { drugId: 'azithromycin', rationale: 'Option for patients with immediate-type penicillin allergy.', role: 'second_line', conditionNotes: 'Check for QT risk and local resistance patterns.' },
      { drugId: 'paracetamol', rationale: 'Antipyretic and analgesic for systemic illness or pyelonephritis.', role: 'adjunct', conditionNotes: 'Prefer paracetamol during dehydration.' },
    ],
    monitoring: [
      { label: 'Temperature', kind: 'temperature', frequency: 'Daily during acute illness', reason: 'Tracks response in pyelonephritis' },
      { label: 'Urine culture', kind: null, frequency: 'Before antibiotics in complicated cases; 48–72 hours if not improving', reason: 'Confirms susceptibility' },
      { label: 'Renal function', kind: 'creatinine', frequency: 'In pregnancy, elderly or recurrent UTI', reason: 'Nitrofurantoin and aminoglycoside safety' },
    ],
    steps: [
      { step: 1, title: 'Classify the patient', detail: 'Distinguish uncomplicated lower UTI in a non-pregnant adult from pyelonephritis, recurrent infection, or infection in pregnancy, men, children, or the immunocompromised.' },
      { step: 2, title: 'Obtain a urine sample', detail: 'Midstream clean-catch sample; send for culture in every complicated case.' },
      { step: 3, title: 'Treat uncomplicated cystitis', detail: 'Nitrofurantoin, trimethoprim or cefuroxime for 3–7 days depending on the agent.' },
      { step: 4, title: 'Treat pyelonephritis', detail: 'Fluoroquinolone, cephalosporin or aminoglycoside for 7–14 days, with oral versus intravenous choice guided by severity.' },
      { step: 5, title: 'Recurrent UTI', detail: 'Behavioural measures, vaginal oestrogen in postmenopausal women, methenamine hippurate, or prophylactic antibiotics after identifying triggers.' },
    ],
    redFlags: ['Fever with flank pain and vomiting — pyelonephritis', 'Pregnancy with UTI', 'Urinary retention', 'Confusion or sepsis in an older patient', 'Haematuria with clot retention', 'Recurrent infection in the same patient'],
    referrals: ['Urology for recurrent infection in men, structural abnormality, or obstruction', 'Obstetrics for UTI in pregnancy', 'Admission for sepsis or unable to take oral therapy'],
    guidelineRefs: [NICE, EAU],
    followUpDays: 30,
    followUpVitals: ['temperature'],
    lifestyle: ['Adequate hydration of 2–3 litres daily', 'Wipe front to back', 'Empty the bladder after intercourse', 'Avoid spermicide use in women with recurrent infection', 'Do not hold urine', 'Postmenopausal vaginal oestrogen reduces recurrence'],
  },

  // ------------------------------------------------------------------- CNS
  {
    id: 'depression',
    condition: 'Depressive Disorder',
    synonyms: ['depression', 'major depressive disorder', 'mdd', 'low mood', 'depressive episode', 'major depression'],
    icdCode: 'F32',
    specialties: ['psychiatry', 'general_medicine'],
    summary:
      'Assess severity, exclude bipolar disorder and physical causes, and offer psychological therapy first for mild-to-moderate depression. Antidepressants should be started when symptoms are moderate-to-severe, when psychotherapy is declined or unavailable, or in combination with therapy for severe depression. Review at 2–4 weeks and again at 6–8 weeks.',
    counselling: 'Antidepressants take 2–4 weeks to work and must be continued for at least 6 months after improvement. Do not stop abruptly.',
    investigations: ['Structured depression screening (PHQ-9)', 'Bipolar screening (MDQ) before starting an antidepressant', 'Thyroid function, full blood count, glucose, renal and hepatic function', 'Alcohol and substance use assessment', 'Suicide risk assessment at every contact'],
    regimen: [
      { drugId: 'sertraline', rationale: 'SSRI with a broad evidence base, low interaction burden and paediatric data, making it a common first choice.', role: 'first_line', conditionNotes: 'Start 25 mg daily, increasing to 50 mg after a week; full effect takes 4–6 weeks.' },
      { drugId: 'escitalopram', rationale: 'Highly selective SSRI with good tolerability and strong anxiety efficacy.', role: 'first_line', conditionNotes: 'Start 5 mg daily and titrate to 10–20 mg; check the QT interval in older adults.' },
      { drugId: 'amitriptyline', rationale: 'Tricyclic antidepressant, also useful for neuropathic pain and migraine prophylaxis.', role: 'second_line', conditionNotes: 'Start 10 mg at night and titrate slowly; anticholinergic effects limit use in older adults.' },
      { drugId: 'gabapentin', rationale: 'Adjunct for anxiety symptoms and sleep disturbance, and for neuropathic pain that co-exists with depression.', role: 'adjunct', conditionNotes: 'Causes sedation; start at 100 mg at night.' },
    ],
    monitoring: [
      { label: 'PHQ-9 score', kind: null, frequency: 'At baseline, 2–4 weeks, then 6–8 weekly', reason: 'Measures treatment response objectively' },
      { label: 'Suicide risk', kind: null, frequency: 'At every contact, especially in the first month and after dose changes', reason: 'Antidepressants can transiently increase suicidal thoughts' },
      { label: 'Adherence and side effects', kind: null, frequency: 'Every visit', reason: 'Drives the choice of continuing or switching' },
      { label: 'Weight', kind: 'weight', frequency: 'Every visit', reason: 'SSRIs can cause weight gain' },
    ],
    steps: [
      { step: 1, title: 'Assess and exclude', detail: 'Confirm the episode, screen for bipolar disorder, assess suicide risk, and exclude thyroid disease, anaemia, substance use and bereavement.' },
      { step: 2, title: 'Offer psychological therapy', detail: 'CBT, behavioural activation or interpersonal therapy for mild-to-moderate depression, guided by patient preference.' },
      { step: 3, title: 'Start an SSRI if indicated', detail: 'Start low, titrate after a week, and explain the delayed onset of effect and the need to continue beyond symptom resolution.' },
      { step: 4, title: 'Review at 4 weeks', detail: 'If there is no improvement, check adherence and dose, consider switching, and reconsider the diagnosis.' },
      { step: 5, title: 'Continue for at least 6 months', detail: 'After remission, continue the same dose for 6–12 months, then taper slowly to reduce relapse risk.' },
    ],
    redFlags: ['Any suicidal ideation or plan — same-day assessment and do not leave alone', 'New agitation or akathisia after starting an antidepressant', 'Activation or hypomania suggesting bipolar disorder', 'Not eating or drinking for several days', 'Severe self-neglect'],
    referrals: ['Crisis services for imminent suicide risk', 'Psychiatry for treatment resistance, bipolar disorder or severe depression', 'Psychological therapy services', 'Social work for severe functional impairment'],
    guidelineRefs: [NICE, APA],
    followUpDays: 30,
    followUpVitals: ['weight'],
    lifestyle: ['Regular sleep and wake times', 'Daily physical activity', 'Structured routine and behavioural activation', 'Reduce alcohol and avoid recreational drugs', 'Social contact and reduced isolation', 'Recognise early warning signs of relapse'],
  },
  {
    id: 'anxiety-disorder',
    condition: 'Anxiety Disorder',
    synonyms: ['anxiety', 'gad', 'generalized anxiety disorder', 'generalised anxiety disorder', 'panic disorder', 'phobic disorder', 'social anxiety'],
    icdCode: 'F41',
    specialties: ['psychiatry', 'general_medicine'],
    summary:
      'Psychoeducation and CBT are first line for all anxiety disorders. SSRIs are first-line medication, taken in the morning for generalised anxiety and at onset for panic disorder. Benzodiazepines should be restricted to short-term crisis use only, never as a first line.',
    counselling: 'Avoiding feared situations maintains anxiety — gradual exposure is the most effective long-term treatment.',
    investigations: ['GAD-7 or panic screening', 'Rule out thyroid disease, arrhythmia and substance use', 'Screen for depression and alcohol use as comorbidity', 'Blood pressure and pulse at baseline on any benzodiazepine'],
    regimen: [
      { drugId: 'sertraline', rationale: 'SSRI with strong evidence in generalised anxiety, panic disorder, social anxiety and PTSD.', role: 'first_line', conditionNotes: 'Start 25 mg daily; some patients respond better to a divided morning and evening dose.' },
      { drugId: 'escitalopram', rationale: 'Effective for generalised anxiety disorder and panic disorder with a favourable tolerability profile.', role: 'first_line', conditionNotes: 'Start 5–10 mg daily.' },
      { drugId: 'propranolol', rationale: 'Propranolol reduces the physical symptoms of performance anxiety and tremor.', role: 'adjunct', conditionNotes: '10–20 mg as needed 30 minutes before the event; avoid in asthma.' },
      { drugId: 'alprazolam', rationale: 'Rapid relief for acute crisis and as a bridge while an SSRI takes effect.', role: 'rescue', conditionNotes: 'Strictly short-term (2–4 weeks) and lowest effective dose; never a first-line treatment.' },
      { drugId: 'gabapentin', rationale: 'Reduces somatic anxiety symptoms and is useful when benzodiazepines must be avoided.', role: 'second_line', conditionNotes: '300 mg three times daily, titrated; causes sedation and dizziness.' },
    ],
    monitoring: [
      { label: 'GAD-7 score', kind: null, frequency: 'At baseline and every 4–6 weeks', reason: 'Objective response tracking' },
      { label: 'Functional impairment', kind: null, frequency: 'Every visit', reason: 'The outcome patients care about' },
      { label: 'Sedation and falls', kind: null, frequency: 'Every visit if on a benzodiazepine', reason: 'Safety, particularly in older adults' },
    ],
    steps: [
      { step: 1, title: 'Diagnose and specify', detail: 'Identify the specific disorder, duration, functional impact and comorbidity, and exclude medical mimics.' },
      { step: 2, title: 'Psychoeducation', detail: 'Explain the physiology of the anxiety response, which reduces catastrophising and reduces the perceived need for medication.' },
      { step: 3, title: 'CBT with exposure', detail: 'Graded exposure and cognitive restructuring are the interventions with the strongest long-term evidence.' },
      { step: 4, title: 'SSRIs for moderate-to-severe symptoms', detail: 'Titrate slowly; the first 2–4 weeks can be harder before benefit appears.' },
      { step: 5, title: 'Benzodiazepines only for crisis', detail: 'Short term only, with an explicit taper plan and review of falls, cognition and dependence.' },
    ],
    redFlags: ['Suicidal ideation', 'Panic attacks with chest pain mistaken for cardiac disease', 'Agoraphobia limiting independent living', 'Alcohol or benzodiazepine dependence', 'Severe functional impairment or job loss'],
    referrals: ['Psychology for CBT and exposure therapy', 'Psychiatry for severe or complex cases', 'Addiction services where relevant'],
    guidelineRefs: [NICE, APA],
    followUpDays: 30,
    followUpVitals: ['pulse'],
    lifestyle: ['Regular sleep and wake times', 'Regular aerobic exercise — strong evidence for anxiety', 'Gradual exposure to feared situations', 'Reduce caffeine, alcohol and nicotine', 'Structured worry time', 'Maintain social contact'],
  },
  {
    id: 'epilepsy',
    condition: 'Epilepsy',
    synonyms: ['epilepsy', 'seizure disorder', 'seizures', 'fits', 'epileptic seizure'],
    icdCode: 'R56.9',
    specialties: ['neurology', 'general_medicine'],
    summary:
      'Diagnosis requires at least two unprovoked seizures, or one seizure with a high recurrence risk, plus evidence of an enduring epileptic tendency. First-line therapy depends on seizure type; levetiracetam and lamotrigine are broadly suitable. Never withdraw antiseizure medication abruptly.',
    counselling: 'Never stop antiseizure medication suddenly. Keep a seizure diary, avoid sleep deprivation, and tell employers where legally required.',
    investigations: ['12-lead ECG to exclude cardiac syncope', 'Blood glucose, electrolytes, calcium and renal function', 'MRI brain with epilepsy protocol', 'EEG, including sleep-deprived EEG', 'Sleep history to exclude nocturnal hypoglycaemia'],
    regimen: [
      { drugId: 'levetiracetam', rationale: 'Broad-spectrum antiseizure medication with a favourable interaction profile and low teratogenicity concerns in women.', role: 'first_line', conditionNotes: 'Start 250 mg twice daily; increase every 2 weeks by up to 500 mg twice daily.' },
      { drugId: 'carbamazepine', rationale: 'First-line for focal (partial) seizures and trigeminal neuralgia.', role: 'first_line', conditionNotes: 'Dose by blood level; watch for hyponatraemia and drug interactions. Teratogenic — avoid in women of childbearing potential without effective contraception.' },
      { drugId: 'gabapentin', rationale: 'Useful for focal seizures and for neuropathic pain, which is frequently comorbid.', role: 'first_line', conditionNotes: 'Sedation is dose-limiting; requires renal dose adjustment.' },
    ],
    monitoring: [
      { label: 'Seizure frequency', kind: null, frequency: 'Every visit via a seizure diary', reason: 'The primary treatment outcome' },
      { label: 'Drug level or adverse effects', kind: null, frequency: 'After every dose change and at each visit', reason: 'Balance efficacy against toxicity' },
      { label: 'Mood and cognition', kind: null, frequency: 'Every visit', reason: 'Drowsiness and depression are common and under-reported' },
      { label: 'Sodium and liver function', kind: null, frequency: 'With carbamazepine', reason: 'Detects hyponatraemia and hepatotoxicity' },
    ],
    steps: [
      { step: 1, title: 'Confirm the diagnosis', detail: 'Distinguish epilepsy from syncope, psychogenic non-epileptic seizures and nocturnal hypoglycaea; a witnessed video is invaluable.' },
      { step: 2, title: 'Investigate the cause', detail: 'MRI to identify structural lesions, and EEG for supportive evidence.' },
      { step: 3, title: 'Choose a first-line agent', detail: 'Levetiracetam, lamotrigine or valproate, chosen by seizure type, comorbidity, age and pregnancy plans.' },
      { step: 4, title: 'Titrate slowly', detail: 'Increase gradually to minimise sedation and behavioural effects; aim for the lowest effective dose.' },
      { step: 5, title: 'Review and plan for pregnancy', detail: 'Discuss contraception, folic acid and the need for specialist pre-pregnancy planning, as several agents are teratogenic.' },
    ],
    redFlags: ['A seizure lasting over 5 minutes — status epilepticus, call emergency services', 'Repeated seizures without recovery between them', 'First seizure, or new neurological deficit', 'Seizure during pregnancy or in water', 'Severe rash or mouth ulcers suggesting Stevens-Johnson syndrome'],
    referrals: ['Neurology for all new diagnoses and drug changes', 'Epilepsy specialist nurse', 'Pregnancy counselling for women of childbearing potential'],
    guidelineRefs: [NICE, ILAE],
    followUpDays: 180,
    followUpVitals: [],
    lifestyle: ['Take medication consistently at the same times', 'Adequate sleep — sleep deprivation is a common seizure trigger', 'Avoid flashing lights if photosensitive', 'Limit alcohol', 'Safety assessment for bathing, heights and driving', 'Medical identification and emergency plan for caregivers'],
  },
  {
    id: 'migraine',
    condition: 'Migraine',
    synonyms: ['migraine', 'migrain', 'headache disorder', 'chronic migraine', 'tension headache', 'cluster headache'],
    icdCode: 'G43',
    specialties: ['neurology', 'general_medicine'],
    summary:
      'Identify the headache type and frequency. Acute treatment should begin early and is limited to 2 days per week for triptans and 10 days per month for simple analgesics. Exceeding these limits causes medication-overuse headache, the most common cause of chronic migraine.',
    counselling: 'Take acute treatment at the first sign of headache, not later. Rest in a dark quiet room, keep a diary of triggers, and keep hydrated.',
    investigations: ['Structured headache diary for at least 4 weeks', 'Neurological examination', 'Blood pressure in every patient with headache', 'MRI brain if red flags are present or the headache is new and progressive', 'Consider ESR and CRP in the over-50s with temporal arteritis features'],
    regimen: [
      { drugId: 'sumatriptan', rationale: 'Triptans are the most effective acute treatment and are more effective when taken at headache onset.', role: 'first_line', conditionNotes: 'Contraindicated in ischaemic heart disease, uncontrolled hypertension and with other triptans or ergot derivatives within 24 hours.' },
      { drugId: 'paracetamol', rationale: 'First-line for infrequent migraine and tension headache.', role: 'first_line', conditionNotes: '2 g at onset, up to 4 g per day, no more than 2 days per week.' },
      { drugId: 'ibuprofen', rationale: 'Effective for acute migraine, particularly with nausea.', role: 'first_line', conditionNotes: '400–800 mg at onset; combine with an antiemetic if nausea predominates.' },
      { drugId: 'ondansetron', rationale: 'Antiemetic for the nausea and vomiting that frequently accompanies migraine.', role: 'adjunct', conditionNotes: 'Combine with an NSAID for greater acute efficacy.' },
      { drugId: 'amitriptyline', rationale: 'First-line prophylaxis for frequent or chronic migraine, and also useful for insomnia and neuropathic pain.', role: 'first_line', conditionNotes: 'Start 10 mg at night, titrating by 10 mg every 2 weeks to 25–75 mg; takes 8–12 weeks to work.' },
      { drugId: 'propranolol', rationale: 'First-line preventive agent in patients with no contraindications.', role: 'first_line', conditionNotes: 'Start 40–80 mg daily, titrate to 160 mg; avoid in asthma and bradycardia.' },
      { drugId: 'gabapentin', rationale: 'Second-line prophylaxis, commonly combined with an antidepressant.', role: 'second_line', conditionNotes: 'Up to 2400 mg daily in divided doses.' },
    ],
    monitoring: [
      { label: 'Headache days per month', kind: null, frequency: 'Reviewed at each visit using the diary', reason: 'Ten or more headache days defines chronic migraine' },
      { label: 'Acute analgesic days used', kind: null, frequency: 'Each visit', reason: 'Prevents medication-overuse headache' },
      { label: 'Blood pressure', kind: null, frequency: 'Each visit', reason: 'Serial use of analgesics and triptans can affect blood pressure' },
    ],
    steps: [
      { step: 1, title: 'Diagnose the headache type', detail: 'ICHD-3 criteria for migraine with and without aura, tension headache and cluster headache; check for red flags.' },
      { step: 2, title: 'Exclude medication overuse', detail: 'Analgesics on 10 or more days per month, triptans on 10 or more days, or opioids on 15 or more days.' },
      { step: 3, title: 'Treat the acute attack', detail: 'Triptan or NSAID with an antiemetic, taken early, limited to 2 days per week.' },
      { step: 4, title: 'Start prophylaxis', detail: 'Offer when attacks occur more than 4 times a month, are disabling, or cause medication overuse.' },
      { step: 5, title: 'Address lifestyle and triggers', detail: 'Regular sleep, meals and hydration, exercise, and trigger management identified from the diary.' },
      { step: 6, title: 'Withdraw overused medication', detail: 'Withdraw corticosteroids acutely; bridge withdrawal of simple analgesics and opioids with a preventive agent.' },
    ],
    redFlags: ['Sudden "thunderclap" headache reaching maximum intensity in under a minute', 'New or changed headache in someone over 50', 'Fever with neck stiffness or rash', 'Headache with neurological deficit, confusion or seizure', 'Headache during pregnancy or postpartum', 'Progressive worsening over weeks'],
    referrals: ['Neurology for new, changing or refractory headache', 'Emergency assessment for any red flag', 'Headache clinic for medication-overuse withdrawal'],
    guidelineRefs: [NICE, ICHD],
    followUpDays: 90,
    followUpVitals: [],
    lifestyle: ['Regular sleep, meals and hydration', 'Aerobic exercise', 'Trigger management from a diary', 'Limit acute analgesics to 2 days per week', 'Stress management', 'Avoid alcohol excess and screen use during pregnancy'],
  },

  // ---------------------------------------------------------------- Skin
  {
    id: 'atopic-dermatitis',
    condition: 'Atopic Dermatitis / Eczema',
    synonyms: ['eczema', 'atopic dermatitis', 'atopic eczema', 'dermatitis', 'itchy skin'],
    icdCode: 'L20',
    specialties: ['dermatology', 'general_medicine', 'pediatrics'],
    summary:
      'Emollients are the foundation of therapy and should be used liberally and frequently, including in flares. Topical corticosteroids treat flares at the lowest effective potency for the shortest time. Severe disease needs specialist assessment and systemic therapy.',
    counselling: 'Apply emollient at least four times daily and within 5 minutes after bathing. Use the steroid until the flare settles, then stop — do not fear the steroid.',
    investigations: ['Clinical diagnosis by pattern, age and distribution', 'Skin prick or specific IgE testing if the atopic history is unclear', 'Skin scraping and microscopy to exclude scabies and fungal infection', 'Patch testing for suspected contact allergy', 'Bacterial swab if secondary infection is suspected'],
    regimen: [
      { drugId: 'hydrocortisone-topical', rationale: 'Low-potency topical corticosteroid for the face, flexures and children, appropriate for mild flares.', role: 'first_line', conditionNotes: 'Apply thinly once or twice daily for up to 7 days, then stop.' },
      { drugId: 'clobetasol-topical', rationale: 'Very potent corticosteroid for thick skin on the hands, feet and body in severe flares, used for short courses only.', role: 'first_line', conditionNotes: 'Limit to 7–14 days; never use on the face or flexures without specialist advice.' },
      { drugId: 'cetirizine', rationale: 'Antihistamine reduces itching, which is the main driver of scratching and skin damage.', role: 'adjunct', conditionNotes: 'Sedating at higher doses; note that antihistamines rarely improve eczema itself.' },
      { drugId: 'permethrin-cream', rationale: 'Treats scabies, which mimics or exacerbates eczema and is easily missed.', role: 'second_line', conditionNotes: 'Treat the whole household simultaneously; apply to cool dry skin and leave for 8–14 hours.' },
    ],
    monitoring: [
      { label: 'Eczema area and severity index', kind: null, frequency: 'Each visit', reason: 'Objective assessment of extent and severity' },
      { label: 'Itch and sleep disturbance', kind: null, frequency: 'Each visit', reason: 'Itch drives the disease cycle' },
      { label: 'Steroid quantity used', kind: null, frequency: 'Each visit', reason: 'Detects overuse and under-treatment' },
    ],
    steps: [
      { step: 1, title: 'Confirm the diagnosis', detail: 'Recognise the pattern and distribution, and exclude scabies, tinea, contact dermatitis and cutaneous T-cell lymphoma in atypical cases.' },
      { step: 2, title: 'Start emollients', detail: 'Apply at least 500 g per week in adults; apply immediately after bathing within the "soak and seal" approach.' },
      { step: 3, title: 'Treat flares', detail: 'Topical corticosteroid at potency matched to site and severity, for the shortest effective course.' },
      { step: 4, title: 'Control itch', detail: 'Antihistamines, cool compresses, and avoid triggers such as fragrance, wool and heat.' },
      { step: 5, title: 'Step up severe disease', detail: 'Phototherapy, systemic corticosteroids for severe flares, or specialist biologic and oral agents for refractory disease.' },
    ],
    redFlags: ['Widespread weeping or crusting suggesting bacterial infection needing antibiotics', 'Fever with worsening eczema', 'Painful grouped blisters suggesting eczema herpeticum', 'Facial or flexural disease in an infant', 'Eczema that does not respond to adequate topical therapy'],
    referrals: ['Dermatology for severe, facial or genital disease, or steroid dependence', 'Allergy clinic for trigger identification', 'Specialist nursing for severe or recurrent disease'],
    guidelineRefs: [NICE, AAAAI],
    followUpDays: 60,
    followUpVitals: [],
    lifestyle: ['Emollients at least four times daily', 'Short lukewarm baths with a soap substitute', 'Avoid triggers including fragrance, wool and dust', 'Keep nails short to reduce excoriation', 'Cotton clothing', 'Regular emollient application after hand washing'],
  },
  {
    id: 'acne',
    condition: 'Acne Vulgaris',
    synonyms: ['acne', 'pimples', 'spots', 'cystic acne', 'acne vulgaris'],
    icdCode: 'L70',
    specialties: ['dermatology', 'general_medicine'],
    summary:
      'Comedonal acne responds to topical retinoids, benzoyl peroxide or antibiotics. Moderate inflammatory acne needs a systemic tetracycline with topical retinoid and benzoyl peroxide. Isotretinoin is reserved for severe nodular, scarring or refractory acne.',
    counselling: 'Treatment takes 8–12 weeks to work. Do not squeeze or pick lesions, as this causes scarring and post-inflammatory pigmentation.',
    investigations: ['Clinical assessment and severity grading', 'Photographs to track progress and scarring', 'Consider culture for recurrent or resistant nodular disease', 'Assess mood and self-esteem — acne carries real psychological burden', 'Screen for PCOS if there is menstrual irregularity with hirsutism'],
    regimen: [
      { drugId: 'tretinoin-topical', rationale: 'Topical retinoid is first-line for comedonal acne and prevents new lesions by normalising keratinisation.', role: 'first_line', conditionNotes: 'Start every other night for 2 weeks then nightly; expect dryness and purging for 4–6 weeks. Absolutely contraindicated in pregnancy.' },
      { drugId: 'metronidazole', rationale: 'Topical metronidazole for inflammatory papulopustular acne, with an excellent tolerability profile.', role: 'first_line', conditionNotes: 'Apply twice daily for at least 8 weeks.' },
      { drugId: 'azithromycin', rationale: 'Systemic macrolide for moderate to severe inflammatory acne, always combined with topical benzoyl peroxide to limit resistance.', role: 'second_line', conditionNotes: 'Typically 3 months; combine with topical therapy.' },
      { drugId: 'erythromycin', rationale: 'Topical or oral antibiotic alternative for patients unable to take tetracyclines.', role: 'second_line', conditionNotes: 'Limit duration; always combine with benzoyl peroxide.' },
      { drugId: 'isotretinoin', rationale: 'The most effective treatment for severe nodular, scarring or treatment-resistant acne.', role: 'third_line', conditionNotes: 'Baseline LFTs and lipids, pregnancy prevention programme, and monthly monitoring.' },
    ],
    monitoring: [
      { label: 'Lesion count', kind: null, frequency: 'At 8–12 weeks', reason: 'Objective treatment response' },
      { label: 'LFTs and lipids', kind: null, frequency: 'Before and during isotretinoin', reason: 'Isotretinoin safety' },
      { label: 'Mood and adherence', kind: null, frequency: 'Each visit', reason: 'Detects early stopping and psychological impact' },
    ],
    steps: [
      { step: 1, title: 'Grade severity', detail: 'Classify as mild comedonal, moderate inflammatory, or severe nodular and scarring, and document with photographs.' },
      { step: 2, title: 'Start topical therapy', detail: 'Topical retinoid plus benzoyl peroxide or topical metronidazole for 8–12 weeks.' },
      { step: 3, title: 'Add systemic antibiotics', detail: 'For moderate to severe inflammatory disease, always with a topical retinoid and benzoyl peroxide.' },
      { step: 4, title: 'Consider isotretinoin', detail: 'For severe nodular, scarring or refractory acne after at least two adequate treatment trials.' },
      { step: 5, title: 'Address lifestyle and hormones', detail: 'Manage sebum with gentle skin care; investigate PCOS where there is menstrual irregularity with hirsutism.' },
    ],
    redFlags: ['Rapidly progressive scarring or ulceration', 'Nodular cystic disease with risk of scarring', 'Significant psychological distress or low self-esteem', 'Acne in a patient with signs of Cushing syndrome', 'Drug-induced acne after starting a steroid'],
    referrals: ['Dermatology for severe disease, scarring or isotretinoin', 'Psychology support where there is significant distress', 'Endocrinology for PCOS workup'],
    guidelineRefs: [NICE, BAD],
    followUpDays: 90,
    followUpVitals: [],
    lifestyle: ['Gentle non-comedogenic skin care twice daily', 'Do not squeeze or pick lesions', 'Non-comedogenic moisturiser', 'Avoid oily or occlusive products', 'Manage stress and sleep', 'Expect visible improvement only after 8–12 weeks'],
  },

  // ------------------------------------------------------------- Dentistry
  {
    id: 'dental-pain',
    condition: 'Acute Dental Pain',
    synonyms: ['toothache', 'tooth ache', 'dental pain', 'odontalgia', 'tooth pain', 'dental emergency'],
    icdCode: 'K08',
    specialties: ['dentistry'],
    summary:
      'The priority is definitive treatment — drainage, endodontic treatment or extraction. Analgesia bridges the patient to that treatment: ibuprofen with paracetamol alternating gives better analgesia than either alone or opioid alternatives. Antibiotics are indicated only when there is systemic involvement, spread or immunocompromise.',
    counselling: 'Ibuprofen and paracetamol taken together work better than either alone. Do not place aspirin directly on the gum — it causes a chemical burn.',
    investigations: ['Clinical examination with pulp sensibility testing (cold, electric)', 'Percussion and palpation for apical involvement', 'Periodontal probing', 'Radiographs: bitewing for caries, periapical for apical pathology, panoramic for impacted teeth and fractures', 'Assess for swelling, fever, trismus and lymphadenopathy'],
    regimen: [
      { drugId: 'ibuprofen-oral-dental', rationale: 'NSAID with the strongest evidence for acute dental pain, and superior to paracetamol alone.', role: 'first_line', conditionNotes: '400 mg every 6–8 hours with food, maximum 1200 mg/day, for 3 days.' },
      { drugId: 'paracetamol', rationale: 'Combine with ibuprofen for synergistic analgesia that matches opioid efficacy without sedation or nausea.', role: 'first_line', conditionNotes: '1 g every 6 hours, maximum 4 g/day. Alternating with ibuprofen gives longer analgesia.' },
      { drugId: 'amoxicillin-clavulanate', rationale: 'First-choice antibiotic for spreading odontogenic infection, with anaerobic coverage appropriate to dental flora.', role: 'second_line', conditionNotes: '1 g every 12 hours for 5–7 days, starting the same day as drainage.' },
      { drugId: 'amoxicillin', rationale: 'Alternative when clavulanate is unavailable, with narrower spectrum.', role: 'second_line', conditionNotes: '500 mg every 8 hours for 5–7 days.' },
      { drugId: 'azithromycin', rationale: 'For immediate-type penicillin allergy, or for locally resistant organisms.', role: 'second_line', conditionNotes: '500 mg on day 1 then 250 mg daily for 4 days.' },
      { drugId: 'clindamycin', rationale: 'Reserved for penicillin-allergic patients with severe spreading infection; highest risk of C. difficile diarrhoea.', role: 'second_line', conditionNotes: '300 mg every 6 hours for 5 days; stop immediately if diarrhoea develops.' },
      { drugId: 'chlorhexidine-mouthwash', rationale: 'Reduces plaque and secondary infection after extraction or surgery.', role: 'adjunct', conditionNotes: '10–15 mL for 30 seconds twice daily; do not rinse with water afterwards.' },
      { drugId: 'gabapentin', rationale: 'Useful for trigeminal neuralgia and neuropathic dental pain, and as an opioid-sparing adjunct.', role: 'second_line', conditionNotes: 'Start 100 mg at night, titrating up to 3600 mg/day.' },
    ],
    monitoring: [
      { label: 'Pain score', kind: null, frequency: 'At every visit', reason: 'Guides analgesia and confirms treatment response' },
      { label: 'Swelling and systemic features', kind: 'temperature', frequency: 'At 48–72 hours if antibiotics were started', reason: 'Confirms infection is resolving' },
      { label: 'Jaw opening and swallowing', kind: null, frequency: 'At every visit', reason: 'Detects spreading infection' },
    ],
    steps: [
      { step: 1, title: 'Diagnose precisely', detail: 'Differentiate pulpal, periapical and periodontal pain, and identify the causative tooth before treating.' },
      { step: 2, title: 'Provide analgesia immediately', detail: 'Ibuprofen 400 mg with paracetamol 1 g, alternating every 2–3 hours, is the recommended combination.' },
      { step: 3, title: 'Eliminate the source', detail: 'Definitive treatment on the same visit where possible: drainage, pulpotomy, endodontic treatment or extraction.' },
      { step: 4, title: 'Reserve antibiotics', detail: 'Systemic spread, swelling, fever, trismus, dysphagia, or immunocompromise. Start the same day as drainage.' },
      { step: 5, title: 'Review', detail: 'Reassess at 48–72 hours if antibiotics were prescribed, and until asymptomatic.' },
    ],
    redFlags: ['Trismus or difficulty swallowing — deep space infection, admit the same day', 'Swelling of the face or neck with fever — urgent hospital referral', 'Difficulty breathing or a spreading floor-of-mouth swelling — emergency airway risk', 'Rapidly increasing pain at night with a non-responsive tooth', 'Immunocompromise or poorly controlled diabetes with any dental infection', 'Tingling or numbness of the lower lip after dental trauma — urgent radiographic assessment'],
    referrals: ['Oral and maxillofacial surgery for spreading infection, trismus or fascial space involvement', 'Endodontics for complex root canal anatomy', 'Hospital dentistry for patients who cannot safely be treated in the chair'],
    guidelineRefs: [NICE, ADA, SIGN],
    followUpDays: 3,
    followUpVitals: ['temperature'],
    lifestyle: ['Warm saline rinses every 2 hours', 'Soft diet and avoid chewing on the affected side', 'Good analgesia dosing — under-dosing is the commonest reason patients return', 'Chlorhexidine rinse twice daily for 7–14 days', 'Complete the antibiotic course', 'Definitive treatment is required — analgesia alone will not resolve the cause'],
  },
  {
    id: 'periodontal-disease',
    condition: 'Periodontal Disease',
    synonyms: ['gum disease', 'periodontitis', 'gingivitis', 'periodontal disease', 'pyorrhea', 'gum bleeding'],
    icdCode: 'K05',
    specialties: ['dentistry'],
    summary:
      'Gingivitis is reversible with mechanical plaque control. Once attachment loss occurs the disease is irreversible but can be stabilised. Treatment is professional debridement plus rigorous home care; the patient\'s plaque control determines the outcome more than the clinician\'s instrumentation.',
    counselling: 'Brushing twice daily with the modified Bass technique, plus interdental cleaning daily, is what determines whether the treatment works.',
    investigations: ['Full periodontal charting with probing depths, attachment level and bleeding on probing', 'Radiographs to assess interdental bone loss', 'Mobility and furcation assessment', 'Plaque score and oral hygiene assessment', 'Consider the cause of tooth mobility: periodontitis versus trauma or endodontic disease'],
    regimen: [
      { drugId: 'chlorhexidine-mouthwash', rationale: 'Short-term adjunct to reduce plaque and gingival inflammation after scaling and root planing.', role: 'adjunct', conditionNotes: '0.12% for 7–14 days; causes temporary staining and taste alteration.' },
      { drugId: 'metronidazole', rationale: 'Systemic metronidazole with amoxicillin is used for aggressive periodontitis and refractory cases.', role: 'adjunct', conditionNotes: 'Usually combined with local debridement; strict alcohol avoidance.' },
      { drugId: 'paracetamol', rationale: 'Post-treatment discomfort after extensive scaling and root planing.', role: 'adjunct', conditionNotes: '1 g up to four times daily for 2 days.' },
    ],
    monitoring: [
      { label: 'Probing depths and bleeding score', kind: null, frequency: 'Every 3 months during maintenance', reason: 'The outcome measure for periodontal therapy' },
      { label: 'Plaque score', kind: null, frequency: 'Every maintenance visit', reason: 'Predicts recurrence' },
      { label: 'Tooth mobility', kind: null, frequency: 'Every visit', reason: 'Tracks progression of attachment loss' },
    ],
    steps: [
      { step: 1, title: 'Chart the periodontium', detail: 'Full probing depths, attachment levels, bleeding on probing and radiographic bone levels.' },
      { step: 2, title: 'Stage and grade the disease', detail: 'Staging reflects severity and complexity; grading reflects progression rate and smoking and diabetes modifiers.' },
      { step: 3, title: 'Non-surgical therapy', detail: 'Full-mouth debridement over one or two visits, plus oral hygiene instruction.' },
      { step: 4, title: 'Re-evaluate at 6–8 weeks', detail: 'Re-chart. Sites with residual pockets of 5 mm or more with bleeding need periodontal surgery.' },
      { step: 5, title: 'Supportive periodontal maintenance', detail: 'Three-monthly recall indefinitely — periodontal patients relapse without it.' },
    ],
    redFlags: ['Rapidly progressive attachment loss', 'Tooth mobility with a normal probing depth — consider occlusal trauma or endodontic disease', 'Gingival recession with sensitivity', 'Swelling or sinus tract suggesting endodontic-periodontal disease', 'Bleeding with no plaque — consider a bleeding disorder such as leukaemia or von Willebrand disease'],
    referrals: ['Periodontist for surgery or advanced disease', 'Endodontist for endodontic-periodontal lesions', 'Medical evaluation for unexplained bleeding'],
    guidelineRefs: [EFP, NICE],
    followUpDays: 90,
    followUpVitals: [],
    lifestyle: ['Brush twice daily for 2 minutes with a soft brush and fluoridated toothpaste', 'Clean interdental spaces daily — the single most effective measure', 'Consider electric toothbrush', 'Limit smoking — it is the strongest modifiable risk factor', 'Sugar reduction and regular professional cleaning', 'Mouthwash is an adjunct, never a substitute for mechanical cleaning'],
  },

  // ---------------------------------------------------------------- Peds
  {
    id: 'pediatric-fever',
    condition: 'Acute Fever in Children',
    synonyms: ['fever', 'child fever', 'pyrexia', 'high temperature', 'fever in children'],
    icdCode: 'R50.9',
    specialties: ['pediatrics', 'general_medicine'],
    summary:
      'Most fever in children is viral and self-limiting. The decision to investigate or treat rests on the child\'s appearance, not the temperature reading. Antipyretics treat discomfort, not the fever itself, and should be given with adequate fluids and never alternate ibuprofen and paracetamol without advice.',
    counselling: 'Watch for how your child is looking, not just the number on the thermometer. Paracetamol or ibuprofen every 4–6 hours with fluids; do not exceed the stated daily maximum.',
    investigations: ['Clinical assessment including hydration status, appearance and parental concern', 'Temperature and pulse', 'Nose and throat examination', 'Otoscopy', 'Chest auscultation', 'Urine dipstick if the child is febrile with no focus and over 6 months', 'Blood tests or CRP only if the child appears unwell or has risk factors'],
    regimen: [
      { drugId: 'acetaminophen-pediatric', rationale: 'First-line antipyretic and analgesic in children, with the widest safety margin.', role: 'first_line', conditionNotes: '15 mg/kg per dose every 4–6 hours; maximum 60 mg/kg/day, never more than 4 doses in 24 hours.' },
      { drugId: 'ibuprofen-pediatric', rationale: 'Effective alternative with a longer duration of action, and better for the anti-inflammatory effect in musculoskeletal pain.', role: 'first_line', conditionNotes: '10 mg/kg per dose every 6–8 hours with food; maximum 40 mg/kg/day. Not under 6 months, and avoid in dehydration or chickenpox.' },
      { drugId: 'oral-rehydration-solution', rationale: 'Prevents and treats the dehydration that causes most febrile illness complications.', role: 'first_line', conditionNotes: '50–100 mL per loose stool or vomiting episode in children; offer small amounts frequently.' },
      { drugId: 'amoxicillin-pediatric', rationale: 'For otitis media, streptococcal pharyngitis and urinary tract infection when bacterial infection is diagnosed.', role: 'second_line', conditionNotes: '25–50 mg/kg/day in divided doses.' },
      { drugId: 'azithromycin', rationale: 'For atypical respiratory pathogens or penicillin allergy in children.', role: 'second_line', conditionNotes: '10 mg/kg on day 1 then 5 mg/kg daily for 4 days.' },
    ],
    monitoring: [
      { label: 'Temperature', kind: 'temperature', frequency: 'Every 4–6 hours while unwell', reason: 'Tracks the fever course' },
      { label: 'Hydration and urine output', kind: 'weight', frequency: 'Each review', reason: 'Dehydration is the main danger in febrile children' },
      { label: 'Weight', kind: 'weight', frequency: 'At each visit', reason: 'Dosing is weight-based, and weight loss indicates dehydration' },
    ],
    steps: [
      { step: 1, title: 'Assess appearance, not the number', detail: 'A child who is alert, feeding, alert and responsive to parents is far more reassuring than the temperature alone.' },
      { step: 2, title: 'Look for a focus', detail: 'Ear, throat, chest, urine, skin and gut — examine rather than reflexively investigating.' },
      { step: 3, title: 'Identify red flags', detail: 'Infants under 3 months with fever, non-blanching rash, neck stiffness, respiratory distress, seizures, reduced consciousness or a child who is toxic.' },
      { step: 4, title: 'Manage at home', detail: 'Fluids, rest, antipyretic for comfort, and clear safety-net advice with written instructions.' },
      { step: 5, title: 'Targeted treatment only', detail: 'Antibiotics only for a diagnosed bacterial infection, and never for viral fever.' },
    ],
    redFlags: ['Any infant under 3 months of age with a temperature of 38 °C or above — immediate assessment', 'Non-blanching (blanching does not disappear) purpuric rash', 'Neck stiffness, photophobia or a non-specific rash', 'Respiratory distress, grunting or apnoea', 'Seizure or reduced consciousness', 'Signs of sepsis: poor perfusion, mottling, abnormal grunting, rigors', 'A child who stops drinking or has no wet nappies for 8 hours', 'Fever lasting more than 5 days without improvement'],
    referrals: ['Emergency assessment for any red flag', 'Same-day review for infants under 3 months', 'Paediatrics for suspected serious bacterial infection', 'Social review where safeguarding concerns arise'],
    guidelineRefs: [NICE, WHO, RCPCH],
    followUpDays: 3,
    followUpVitals: ['temperature', 'weight'],
    lifestyle: ['Encourage fluids — the most important part of care', 'Do not alternate ibuprofen and paracetamol', 'Avoid aspirin entirely in children', 'Never exceed the stated daily maximum dose', 'Return if the child becomes less well, not just if the fever persists', 'Keep the child home and away from school if unwell'],
  },
  {
    id: 'pediatric-gt',
    condition: 'Colic / Infant Feeding Difficulties',
    synonyms: ['colic', 'infant colic', 'feeding difficulties', 'poor weight gain', 'failing to thrive'],
    icdCode: 'R10.83',
    specialties: ['pediatrics', 'general_medicine'],
    summary:
      'Colic is defined as paroxysms of inconsolable crying for at least 3 hours a day, more than 3 days a week, for more than 3 weeks, in a well-grown infant. It is benign and self-limiting. Exclude gastro-oesophageal reflux, cow\'s milk protein allergy and infection, and support the parents, who are often exhausted and anxious.',
    counselling: 'Colic peaks at 6 weeks and resolves by 3–4 months. Hold your baby close, use white noise, and try a pacifier. It is not caused by anything you did.',
    investigations: ['Growth chart: weight, length and head circumference', 'Full clinical examination including hips and neurological system', 'Feeding history and wet nappies', 'Gastro-oesophageal reflux assessment', 'Exclude cow\'s milk protein allergy', 'Consider urinalysis to exclude urinary tract infection'],
    regimen: [
      { drugId: 'simethicone', rationale: 'Antiflatulent widely used for colic; safe but evidence of benefit is limited.', role: 'adjunct', conditionNotes: '20–40 mg before feeds; parents should be told the evidence is weak.' },
      { drugId: 'paracetamol', rationale: 'Rarely appropriate for colic, but may be used for a short period if the baby is genuinely distressed, after a growth check.', role: 'adjunct', conditionNotes: '15 mg/kg per dose every 4–6 hours, maximum 60 mg/kg/day.' },
    ],
    monitoring: [
      { label: 'Weight and length', kind: 'weight', frequency: 'Every 1–2 weeks while unsettled', reason: 'Excludes faltering growth' },
      { label: 'Crying pattern and parental wellbeing', kind: null, frequency: 'Each contact', reason: 'Guides support and identifies parental exhaustion' },
    ],
    steps: [
      { step: 1, title: 'Reassure the parents', detail: 'Explain the natural history — improvement by 3–4 months — and that colic is not a sign of illness or poor parenting.' },
      { step: 2, title: 'Exclude pathology', detail: 'Growth trajectory, reflux, cow\'s milk protein allergy, infection and structural abnormalities.' },
      { step: 3, title: 'Provide practical strategies', detail: 'White noise, gentle rocking, swaddling, a pacifier, "5 S"s, and a later bedtime for the infant.' },
      { step: 4, title: 'Support the parents', detail: 'Identify a support person, arrange respite care, and screen for postnatal depression.' },
      { step: 5, title: 'Review and follow up', detail: 'Review in 1–2 weeks. If the pattern changes, reconsider the diagnosis.' },
    ],
    redFlags: ['Weight loss or failure to gain weight', 'Blood in the stool, or a rash suggesting cow\'s milk protein allergy', 'Projectile vomiting, or bile-stained vomit', 'Fever, lethargy or reduced responsiveness', 'An inconsolable high-pitched cry, or a cry that is different from usual', 'Parental exhaustion or expressed thoughts of harming the baby'],
    referrals: ['Paediatrics if growth is faltering or the diagnosis is uncertain', 'Health visitor or maternal mental health service for parental support', 'Allergy specialist for suspected cow\'s milk protein allergy', 'Emergency assessment for any danger sign'],
    guidelineRefs: [NICE, AAP],
    followUpDays: 14,
    followUpVitals: ['weight'],
    lifestyle: ['Respond promptly and consistently to crying', 'White noise or shushing at a moderate volume', 'Gentle rocking, swaddling and pacifier use', 'Later and more regular sleep times', 'Parent support groups', 'Do not shake the baby — seek help if you feel overwhelmed'],
  },

  // -------------------------------------------------------------- OBGYN
  {
    id: 'gestational-diabetes',
    condition: 'Gestational Diabetes Mellitus',
    synonyms: ['gdm', 'gestational diabetes', 'diabetes in pregnancy', 'gestational hyperglycaemia'],
    icdCode: 'O24.4',
    specialties: ['gynecology', 'endocrinology', 'general_medicine'],
    summary:
      'Diet and exercise manage the majority of cases. Insulin is started when capillary glucose exceeds target despite diet, or when fasting glucose is above 95 mg/dL or one-hour postprandial above 140 mg/dL at diagnosis. Metformin and glyburide are alternatives where insulin is not feasible, but insulin remains first line for fetal safety.',
    counselling: 'Monitor glucose four times daily, aim for a healthy pregnancy weight gain, and remember that gestational diabetes usually resolves after delivery but raises lifetime type 2 diabetes risk.',
    investigations: ['75 g oral glucose tolerance test at 24–28 weeks, or earlier with risk factors', 'Fasting and postprandial capillary glucose monitoring', 'Blood pressure and weight at each visit', 'Urine for protein and ketones', 'Fetal growth scans and anomaly screening as per the diabetes pregnancy pathway'],
    regimen: [
      { drugId: 'insulin-glargine', rationale: 'Long-acting insulin provides the basal control needed in pregnancy without placental transfer.', role: 'first_line', conditionNotes: 'Bedtime dosing; titrate against fasting glucose targets of 63–95 mg/dL.' },
      { drugId: 'insulin-aspart', rationale: 'Rapid-acting insulin for postprandial control; it does not cross the placenta.', role: 'first_line', conditionNotes: 'Pre-meal dosing; target 1-hour postprandial glucose below 140 mg/dL.' },
      { drugId: 'metformin', rationale: 'Used where insulin is unavailable, unaffordable or unacceptable, or for significant weight gain, with informed discussion of the evidence.', role: 'second_line', conditionNotes: 'Crosses the placenta; monitor for neonatal hypoglycaemia and lactic acidosis.' },
    ],
    monitoring: [
      { label: 'Fasting glucose', kind: 'fasting_glucose', frequency: 'Daily', reason: 'Primary titration target' },
      { label: 'Postprandial glucose', kind: 'postprandial_glucose', frequency: 'Daily or as advised', reason: 'Detects postprandial hyperglycaemia' },
      { label: 'Blood pressure', kind: 'systolic_bp', frequency: 'Each visit', reason: 'Preeclampsia risk is increased' },
      { label: 'Weight', kind: 'weight', frequency: 'Each visit', reason: 'Guides gestational weight gain' },
    ],
    steps: [
      { step: 1, title: 'Screen at the right time', detail: '24–28 weeks routinely; earlier with obesity, previous gestational diabetes, a family history or a previous large-for-gestational-age baby.' },
      { step: 2, title: 'Diet and exercise first', detail: 'Carbohydrate-aware diet with a morning meal and an evening snack, plus 30 minutes of post-meal walking, for 1–2 weeks.' },
      { step: 3, title: 'Start insulin if targets are exceeded', detail: 'Bedtime basal insulin for fasting hyperglycaemia; pre-meal rapid-acting insulin for postprandial hyperglycaemia.' },
      { step: 4, title: 'Antenatal surveillance', detail: 'Fetal growth scans, blood pressure surveillance, and a 6-week post-partum glucose tolerance test.' },
      { step: 5, title: 'Post-partum follow up', detail: 'Lifetime risk reduction counselling and annual HbA1c screening thereafter.' },
    ],
    redFlags: ['Vomiting, abdominal pain and deep breathing suggesting ketoacidosis', 'Reduced fetal movements', 'Severe hypertension, headache or visual disturbance suggesting preeclampsia', 'Glucose persistently above 200 mg/dL', 'Any infection during pregnancy in a woman with diabetes'],
    referrals: ['Joint obstetrics and diabetes clinic', 'Fetal medicine if macrosomia or poor control', 'Dietitian for structured diabetes-in-pregnancy counselling'],
    guidelineRefs: [NICE, ADA, WHO],
    followUpDays: 14,
    followUpVitals: ['fasting_glucose', 'postprandial_glucose', 'systolic_bp', 'weight'],
    lifestyle: ['Carbohydrate-aware diet with even distribution', '30 minutes of activity after meals', 'Target gestational weight gain appropriate for pre-pregnancy BMI', 'Four-times-daily glucose monitoring', 'Smoking cessation', 'Family planning and preconception counselling for future pregnancies'],
  },
];

export const PROTOCOLS_BY_ID: Record<string, ClinicalProtocol> = Object.fromEntries(
  CLINICAL_PROTOCOLS.map((p) => [p.id, p]),
);

const STOP_WORDS = new Set([
  'the', 'and', 'with', 'for', 'from', 'without', 'mellitus', 'disease', 'disorder', 'syndrome', 'acute', 'chronic',
  'type', 'of', 'in', 'on', 'a', 'an', 'to', 'stage', 'grade', 'iii', 'ii', 'iv', 'i',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/**
 * Match free-text diagnoses (as typed by a clinician or extracted from a voice
 * note) to protocols. Returns matches ranked by confidence.
 */
export function matchProtocols(
  input: string,
  options: { specialties?: readonly import('../domain/enums.js').Specialty[]; limit?: number } = {},
): { protocol: ClinicalProtocol; score: number; matchedTerms: string[] }[] {
  const text = input.toLowerCase().trim();
  if (!text) return [];
  const inputTokens = new Set(tokenize(input));
  const results: { protocol: ClinicalProtocol; score: number; matchedTerms: string[] }[] = [];

  for (const protocol of CLINICAL_PROTOCOLS) {
    if (options.specialties && options.specialties.length && !protocol.specialties.some((s) => options.specialties?.includes(s))) {
      continue;
    }
    let score = 0;
    const matched: string[] = [];

    if (text === protocol.condition.toLowerCase()) score += 100;
    if (text.includes(protocol.condition.toLowerCase())) {
      score += 60;
      matched.push(protocol.condition);
    }
    for (const syn of protocol.synonyms) {
      const s = syn.toLowerCase();
      if (text === s) {
        score += 90;
        matched.push(syn);
      } else if (text.includes(s)) {
        score += 45;
        matched.push(syn);
      }
    }
    if (text.includes(protocol.icdCode.toLowerCase())) {
      score += 40;
      matched.push(protocol.icdCode);
    }
    // Token overlap as a weaker signal.
    const protocolTokens = new Set(tokenize(protocol.condition));
    for (const t of inputTokens) {
      if (protocolTokens.has(t)) {
        score += 6;
        matched.push(t);
      }
    }

    if (score > 0) {
      results.push({ protocol, score, matchedTerms: Array.from(new Set(matched)) });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 3);
}

/** Protocols relevant to a clinic specialty, used to seed the AI prompt. */
export function protocolsForSpecialty(specialty: import('../domain/enums.js').Specialty): ClinicalProtocol[] {
  return CLINICAL_PROTOCOLS.filter((p) => p.specialties.includes(specialty));
}

/** The protocol library coverage summary, shown on the settings page. */
export function protocolCoverage(): { total: number; bySpecialty: Record<string, number>; conditions: string[] } {
  const bySpecialty: Record<string, number> = {};
  for (const p of CLINICAL_PROTOCOLS) {
    for (const s of p.specialties) {
      bySpecialty[s] = (bySpecialty[s] ?? 0) + 1;
    }
  }
  return {
    total: CLINICAL_PROTOCOLS.length,
    bySpecialty,
    conditions: CLINICAL_PROTOCOLS.map((p) => p.condition),
  };
}

/**
 * Drop regimen options whose drug is not in the catalog.
 * The protocol library is data, and data can drift out of sync with the drug
 * catalog; this keeps the engine from ever producing a dangling drug id.
 */
export function resolveRegimen(options: readonly ProtocolRegimenOption[]): { drugId: string; option: ProtocolRegimenOption }[] {
  return options
    .map((option) => ({ drugId: option.drugId, option }))
    .filter((entry) => getDrug(entry.drugId) !== undefined);
}

/** Dataset integrity check, surfaced on the settings/diagnostics page. */
export function validateProtocolLibrary(): { protocolId: string; missingDrugId: string }[] {
  const problems: { protocolId: string; missingDrugId: string }[] = [];
  for (const p of CLINICAL_PROTOCOLS) {
    for (const option of p.regimen) {
      if (getDrug(option.drugId) === undefined) {
        problems.push({ protocolId: p.id, missingDrugId: option.drugId });
      }
    }
    for (const vital of p.followUpVitals) {
      if (VITAL_DEFINITIONS[vital] === undefined) {
        problems.push({ protocolId: p.id, missingDrugId: `vital:${vital}` });
      }
    }
  }
  return problems;
}
