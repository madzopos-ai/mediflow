/**
 * Vital sign reference data: units, display labels, and safety thresholds.
 *
 * Thresholds follow widely-used clinical cut-offs (ADA, AHA/ACC, WHO, ATS).
 * They are intentionally conservative and configurable-free: the goal is to
 * reliably flag readings that require a clinician to look at the patient
 * *today*, not to make diagnoses.
 */

import type { AlertSeverity, Sex, VitalKind } from '../domain/enums.js';

export interface VitalDefinition {
  kind: VitalKind;
  label: string;
  shortLabel: string;
  unit: string;
  /** Plural/alternate units accepted when parsing patient replies. */
  acceptedUnits: string[];
  decimals: number;
  step: number;
  min: number;
  max: number;
  normalLow: number;
  normalHigh: number;
  /** Values >= criticalHigh or <= criticalLow trigger an immediate alert. */
  criticalLow: number | null;
  criticalHigh: number | null;
  /** Guidance shown to the doctor when a reading is out of range. */
  highAdvice: string;
  lowAdvice: string;
  /** Free-text meaning attached to the reading. */
  contextLabels: Record<string, string>;
  /** Prompts used by the automated follow-up engine. */
  requestPrompt: string;
  requestPromptAr: string;
  /** Whether a chronic patient should be asked for this on a schedule. */
  monitorable: boolean;
  /** Icon key used by the web UI. */
  icon: string;
  /** Sort weight for chart axes. */
  order: number;
}

export const VITAL_DEFINITIONS: Record<VitalKind, VitalDefinition> = {
  fasting_glucose: {
    kind: 'fasting_glucose',
    label: 'Fasting blood glucose',
    shortLabel: 'Fasting glucose',
    unit: 'mg/dL',
    acceptedUnits: ['mg/dl', 'mg/dL', 'mmol/l', 'mmol/L', 'g/l', 'g/L', ''],
    decimals: 0,
    step: 1,
    min: 20,
    max: 900,
    normalLow: 70,
    normalHigh: 99,
    criticalLow: 54,
    criticalHigh: 300,
    highAdvice:
      'Fasting glucose ≥300 mg/dL suggests severe hyperglycaemia. Same-day assessment is advised; check for ketones and symptoms of DKA/HHS if unwell.',
    lowAdvice:
      'Fasting glucose <70 mg/dL is hypoglycaemia. If the patient is symptomatic or the value is <54 mg/dL, treat immediately and review therapy.',
    contextLabels: { fasting: 'Fasting (no calories for 8h)', morning: 'Morning fasting', 'pre-meal': 'Pre-meal' },
    requestPrompt: 'Please reply with your morning fasting blood sugar (e.g. 110).',
    requestPromptAr: 'من فضلكم ردوا على صيام الدم الصباحي (مثال: ١١٠).',
    monitorable: true,
    icon: 'droplet',
    order: 10,
  },
  random_glucose: {
    kind: 'random_glucose',
    label: 'Random blood glucose',
    shortLabel: 'Random glucose',
    unit: 'mg/dL',
    acceptedUnits: ['mg/dl', 'mmol/l', 'g/l', ''],
    decimals: 0,
    step: 1,
    min: 20,
    max: 900,
    normalLow: 70,
    normalHigh: 140,
    criticalLow: 54,
    criticalHigh: 300,
    highAdvice:
      'Random glucose ≥300 mg/dL warrants same-day review regardless of fasting status, particularly with symptoms of polyuria, thirst or ketones.',
    lowAdvice: 'Random glucose <70 mg/dL is hypoglycaemia — assess symptoms and review antidiabetic therapy.',
    contextLabels: { random: 'Random / post-meal', evening: 'Evening reading' },
    requestPrompt: 'Please reply with a random blood sugar reading (e.g. 145).',
    requestPromptAr: 'من فضلكم ردوا على قراءة سكر عشوائية (مثال: ١٤٥).',
    monitorable: true,
    icon: 'droplet',
    order: 20,
  },
  postprandial_glucose: {
    kind: 'postprandial_glucose',
    label: 'Postprandial blood glucose',
    shortLabel: 'Post-meal glucose',
    unit: 'mg/dL',
    acceptedUnits: ['mg/dl', 'mmol/l', 'g/l', ''],
    decimals: 0,
    step: 1,
    min: 20,
    max: 900,
    normalLow: 70,
    normalHigh: 180,
    criticalLow: 54,
    criticalHigh: 300,
    highAdvice: '2-hour postprandial >180 mg/dL indicates inadequate post-meal control; review meal timing and therapy.',
    lowAdvice: 'Postprandial glucose <70 mg/dL suggests reactive hypoglycaemia — review mealtime therapy.',
    contextLabels: { pp: '2h after meal', '2h': '2h after meal', '1h': '1h after meal' },
    requestPrompt: 'Please reply with your blood sugar 2 hours after eating (e.g. 160).',
    requestPromptAr: 'من فضلكم ردوا على سكر بعد الأكل بساعتين (مثال: ١٦٠).',
    monitorable: true,
    icon: 'droplet',
    order: 30,
  },
  hba1c: {
    kind: 'hba1c',
    label: 'HbA1c',
    shortLabel: 'HbA1c',
    unit: '%',
    acceptedUnits: ['%', 'percent', ''],
    decimals: 1,
    step: 0.1,
    min: 3,
    max: 20,
    normalLow: 4,
    normalHigh: 5.7,
    criticalLow: null,
    criticalHigh: 14,
    highAdvice: 'HbA1c ≥14% indicates markedly poor control; consider a regimen review and check for acute metabolic decompensation.',
    lowAdvice: 'HbA1c <4% may suggest hypoglycaemia risk in insulin-treated patients; review therapy and driving/fitness advice.',
    contextLabels: { lab: 'Laboratory result' },
    requestPrompt: 'Please reply with your latest HbA1c from your lab report (e.g. 7.2).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة آخر تحليل HbA1c (مثال: ٧.٢).',
    monitorable: true,
    icon: 'chart',
    order: 40,
  },
  systolic_bp: {
    kind: 'systolic_bp',
    label: 'Systolic blood pressure',
    shortLabel: 'Systolic BP',
    unit: 'mmHg',
    acceptedUnits: ['mmhg', 'mmHg', 'mm hg', ''],
    decimals: 0,
    step: 1,
    min: 50,
    max: 300,
    normalLow: 90,
    normalHigh: 129,
    criticalLow: 80,
    criticalHigh: 180,
    highAdvice:
      'Systolic ≥180 mmHg suggests a hypertensive urgency; ≥180 with chest pain, breathlessness or neurological symptoms is a hypertensive emergency requiring immediate referral.',
    lowAdvice: 'Systolic <90 mmHg is hypotensive; check for dizziness, syncope, sepsis and volume depletion.',
    contextLabels: { seated: 'Seated', supine: 'Supine', standing: 'Standing', morning: 'Morning reading' },
    requestPrompt: 'Please reply with your blood pressure as 120/80.',
    requestPromptAr: 'من فضلكم ردوا على ضغط الدم بالصيغة ١٢٠/٨٠.',
    monitorable: true,
    icon: 'heart',
    order: 50,
  },
  diastolic_bp: {
    kind: 'diastolic_bp',
    label: 'Diastolic blood pressure',
    shortLabel: 'Diastolic BP',
    unit: 'mmHg',
    acceptedUnits: ['mmhg', 'mmHg', ''],
    decimals: 0,
    step: 1,
    min: 30,
    max: 200,
    normalLow: 60,
    normalHigh: 89,
    criticalLow: 50,
    criticalHigh: 120,
    highAdvice: 'Isolated diastolic hypertension ≥120 mmHg still requires assessment, particularly with target-organ damage.',
    lowAdvice: 'Diastolic <50 mmHg with symptoms suggests significant hypotension; review antihypertensives.',
    contextLabels: { seated: 'Seated', supine: 'Supine' },
    requestPrompt: 'Please reply with your blood pressure as 120/80.',
    requestPromptAr: 'من فضلكم ردوا على ضغط الدم بالصيغة ١٢٠/٨٠.',
    monitorable: true,
    icon: 'heart',
    order: 60,
  },
  pulse: {
    kind: 'pulse',
    label: 'Pulse rate',
    shortLabel: 'Pulse',
    unit: 'bpm',
    acceptedUnits: ['bpm', '/min', 'beats/min', ''],
    decimals: 0,
    step: 1,
    min: 20,
    max: 300,
    normalLow: 60,
    normalHigh: 100,
    criticalLow: 40,
    criticalHigh: 140,
    highAdvice: 'Tachycardia >140 bpm or persistent >100 bpm: assess for arrhythmia, sepsis, dehydration or pain.',
    lowAdvice: 'Bradycardia <40 bpm or persistent <60 bpm: check for conduction disease, medication effect and syncope.',
    contextLabels: { resting: 'Resting', after_exercise: 'After exercise' },
    requestPrompt: 'Please reply with your pulse rate (e.g. 78).',
    requestPromptAr: 'من فضلكم ردوا على معدل النبض (مثال: ٧٨).',
    monitorable: true,
    icon: 'activity',
    order: 70,
  },
  temperature: {
    kind: 'temperature',
    label: 'Body temperature',
    shortLabel: 'Temperature',
    unit: '°C',
    acceptedUnits: ['c', '°c', 'celsius', ''],
    decimals: 1,
    step: 0.1,
    min: 30,
    max: 45,
    normalLow: 36,
    normalHigh: 37.5,
    criticalLow: 35,
    criticalHigh: 39.5,
    highAdvice: 'Temperature ≥39.5 °C: consider infection source, sepsis screen and same-day clinical review.',
    lowAdvice: 'Temperature <35 °C is hypothermic — assess for sepsis, exposure or hypothermia in infants and elderly patients.',
    contextLabels: { oral: 'Oral', axillary: 'Axillary', rectal: 'Rectal', tympanic: 'Tympanic' },
    requestPrompt: 'Please reply with your temperature (e.g. 37.2).',
    requestPromptAr: 'من فضلكم ردوا على درجة حرارتكم (مثال: ٣٧.٢).',
    monitorable: true,
    icon: 'thermometer',
    order: 80,
  },
  spo2: {
    kind: 'spo2',
    label: 'Oxygen saturation',
    shortLabel: 'SpO2',
    unit: '%',
    acceptedUnits: ['%', 'percent', ''],
    decimals: 0,
    step: 1,
    min: 50,
    max: 100,
    normalLow: 95,
    normalHigh: 100,
    criticalLow: 90,
    criticalHigh: null,
    highAdvice: 'SpO2 above 100% usually reflects probe misplacement; repeat the measurement.',
    lowAdvice: 'SpO2 <90% indicates hypoxaemia requiring urgent assessment; 90–94% is borderline and needs context.',
    contextLabels: { room_air: 'Room air', oxygen: 'On oxygen' },
    requestPrompt: 'Please reply with your oxygen saturation (e.g. 97).',
    requestPromptAr: 'من فضلكم ردوا على نسبة الأكسجين (مثال: ٩٧).',
    monitorable: true,
    icon: 'wind',
    order: 90,
  },
  respiratory_rate: {
    kind: 'respiratory_rate',
    label: 'Respiratory rate',
    shortLabel: 'Resp. rate',
    unit: '/min',
    acceptedUnits: ['/min', 'rpm', ''],
    decimals: 0,
    step: 1,
    min: 5,
    max: 70,
    normalLow: 12,
    normalHigh: 20,
    criticalLow: 8,
    criticalHigh: 30,
    highAdvice: 'Respiratory rate >30/min with other abnormalities suggests respiratory distress or metabolic acidosis.',
    lowAdvice: 'Respiratory rate <8/min is dangerous — assess for CNS depression or neuromuscular weakness.',
    contextLabels: { resting: 'Resting', sleeping: 'Sleeping' },
    requestPrompt: 'Please reply with your breathing rate per minute (e.g. 16).',
    requestPromptAr: 'من فضلكم ردوا على معدل التنفس (مثال: ١٦).',
    monitorable: true,
    icon: 'wind',
    order: 100,
  },
  weight: {
    kind: 'weight',
    label: 'Weight',
    shortLabel: 'Weight',
    unit: 'kg',
    acceptedUnits: ['kg', 'kgs', 'kilogram', ''],
    decimals: 1,
    step: 0.1,
    min: 0.5,
    max: 400,
    normalLow: 0,
    normalHigh: 400,
    criticalLow: null,
    criticalHigh: null,
    highAdvice: '',
    lowAdvice: '',
    contextLabels: { morning: 'Morning, before food' },
    requestPrompt: 'Please reply with your weight in kg (e.g. 82.5).',
    requestPromptAr: 'من فضلكم ردوا على الوزن بالكيلوجرام (مثال: ٨٢.٥).',
    monitorable: true,
    icon: 'scale',
    order: 110,
  },
  height: {
    kind: 'height',
    label: 'Height',
    shortLabel: 'Height',
    unit: 'cm',
    acceptedUnits: ['cm', ''],
    decimals: 1,
    step: 0.1,
    min: 30,
    max: 250,
    normalLow: 0,
    normalHigh: 250,
    criticalLow: null,
    criticalHigh: null,
    highAdvice: '',
    lowAdvice: '',
    contextLabels: {},
    requestPrompt: 'Please reply with your height in cm (e.g. 172).',
    requestPromptAr: 'من فضلكم ردوا على الطول بالسنتيمتر (مثال: ١٧٢).',
    monitorable: false,
    icon: 'ruler',
    order: 120,
  },
  bmi: {
    kind: 'bmi',
    label: 'Body mass index',
    shortLabel: 'BMI',
    unit: 'kg/m²',
    acceptedUnits: ['kg/m2', 'kg/m²', 'bmi', ''],
    decimals: 1,
    step: 0.1,
    min: 5,
    max: 80,
    normalLow: 18.5,
    normalHigh: 24.9,
    criticalLow: null,
    criticalHigh: 40,
    highAdvice: 'BMI ≥40 indicates severe obesity (class III), associated with substantial cardiometabolic risk.',
    lowAdvice: 'BMI <18.5 indicates undernutrition; screen for malabsorption or eating disorders.',
    contextLabels: {},
    requestPrompt: 'Please reply with your weight so we can calculate your BMI (e.g. 82.5).',
    requestPromptAr: 'من فضلكم ردوا على الوزن لنحسب مؤشر كتلة الجسم (مثال: ٨٢.٥).',
    monitorable: true,
    icon: 'scale',
    order: 130,
  },
  creatinine: {
    kind: 'creatinine',
    label: 'Serum creatinine',
    shortLabel: 'Creatinine',
    unit: 'mg/dL',
    acceptedUnits: ['mg/dl', 'µmol/l', 'umol/l', 'μmol/l', ''],
    decimals: 2,
    step: 0.01,
    min: 0.1,
    max: 20,
    normalLow: 0.6,
    normalHigh: 1.3,
    criticalLow: null,
    criticalHigh: 3,
    highAdvice: 'Creatinine ≥3 mg/dL indicates significant renal impairment — review renally-cleared drugs and dosing.',
    lowAdvice: '',
    contextLabels: { serum: 'Serum' },
    requestPrompt: 'Please reply with your latest serum creatinine from your lab report (e.g. 1.1).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة الكرياتينين من التحليل (مثال: ١.١).',
    monitorable: true,
    icon: 'flask',
    order: 140,
  },
  serum_potassium: {
    kind: 'serum_potassium',
    label: 'Serum potassium',
    shortLabel: 'Potassium',
    unit: 'mEq/L',
    acceptedUnits: ['meq/l', 'mmol/l', 'mg/dl', ''],
    decimals: 1,
    step: 0.1,
    min: 1.5,
    max: 10,
    normalLow: 3.5,
    normalHigh: 5.1,
    criticalLow: 2.8,
    criticalHigh: 6,
    highAdvice: 'Potassium ≥6 mEq/L risks arrhythmia — urgent ECG and same-day review.',
    lowAdvice: 'Potassium <2.8 mEq/L risks arrhythmia and weakness — urgent review.',
    contextLabels: { serum: 'Serum' },
    requestPrompt: 'Please reply with your latest potassium result (e.g. 4.2).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة البوتاسيوم (مثال: ٤.٢).',
    monitorable: true,
    icon: 'flask',
    order: 150,
  },
  ldl: {
    kind: 'ldl',
    label: 'LDL cholesterol',
    shortLabel: 'LDL',
    unit: 'mg/dL',
    acceptedUnits: ['mg/dl', 'mmol/l', ''],
    decimals: 0,
    step: 1,
    min: 10,
    max: 400,
    normalLow: 0,
    normalHigh: 100,
    criticalLow: null,
    criticalHigh: 190,
    highAdvice: 'LDL ≥190 mg/dL (≥4.9 mmol/L) warrants consideration of familial hypercholesterolaemia screening.',
    lowAdvice: '',
    contextLabels: { fasting: 'Fasting' },
    requestPrompt: 'Please reply with your latest LDL cholesterol (e.g. 95).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة الكوليسترول الضار (مثال: ٩٥).',
    monitorable: true,
    icon: 'flask',
    order: 160,
  },
  hdl: {
    kind: 'hdl',
    label: 'HDL cholesterol',
    shortLabel: 'HDL',
    unit: 'mg/dL',
    acceptedUnits: ['mg/dl', 'mmol/l', ''],
    decimals: 0,
    step: 1,
    min: 5,
    max: 200,
    normalLow: 40,
    normalHigh: 200,
    criticalLow: null,
    criticalHigh: null,
    highAdvice: '',
    lowAdvice: 'HDL <40 mg/dL in men or <50 mg/dL in women is an independent cardiovascular risk factor.',
    contextLabels: { fasting: 'Fasting' },
    requestPrompt: 'Please reply with your latest HDL cholesterol (e.g. 52).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة الكوليسترول النافع (مثال: ٥٢).',
    monitorable: true,
    icon: 'flask',
    order: 170,
  },
  triglycerides: {
    kind: 'triglycerides',
    label: 'Triglycerides',
    shortLabel: 'Triglycerides',
    unit: 'mg/dL',
    acceptedUnits: ['mg/dl', 'mmol/l', ''],
    decimals: 0,
    step: 1,
    min: 10,
    max: 2000,
    normalLow: 0,
    normalHigh: 150,
    criticalLow: null,
    criticalHigh: 500,
    highAdvice: 'Triglycerides ≥500 mg/dL carry a risk of pancreatitis; ≥1000 mg/dL is very high risk.',
    lowAdvice: '',
    contextLabels: { fasting: 'Fasting' },
    requestPrompt: 'Please reply with your latest triglycerides (e.g. 160).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة الدهون الثلاثية (مثال: ١٦٠).',
    monitorable: true,
    icon: 'flask',
    order: 180,
  },
  hemoglobin: {
    kind: 'hemoglobin',
    label: 'Haemoglobin',
    shortLabel: 'Haemoglobin',
    unit: 'g/dL',
    acceptedUnits: ['g/dl', 'g/l', ''],
    decimals: 1,
    step: 0.1,
    min: 3,
    max: 22,
    normalLow: 12,
    normalHigh: 17.5,
    criticalLow: 7,
    criticalHigh: null,
    highAdvice: '',
    lowAdvice: 'Haemoglobin <7 g/dL is severe anaemia and needs urgent assessment and transfusion consideration.',
    contextLabels: { serum: 'Venous' },
    requestPrompt: 'Please reply with your latest haemoglobin (e.g. 13.2).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة الهيموجلوبين (مثال: ١٣.٢).',
    monitorable: true,
    icon: 'flask',
    order: 190,
  },
  wbc: {
    kind: 'wbc',
    label: 'White blood cells',
    shortLabel: 'WBC',
    unit: 'K/µL',
    acceptedUnits: ['k/ul', '10^3/ul', 'g/l', ''],
    decimals: 1,
    step: 0.1,
    min: 0,
    max: 200,
    normalLow: 4.5,
    normalHigh: 11,
    criticalLow: 2,
    criticalHigh: 30,
    highAdvice:
      'WBC ≥30 K/µL suggests severe leucocytosis. Same-day assessment is advised; consider haematology input.',
    lowAdvice:
      'WBC <2 K/µL is severe leucopenia with infection risk. Urgent assessment is advised; consider isolation precautions.',
    contextLabels: {},
    requestPrompt: 'Please reply with your latest white blood cell count (e.g. 6.5).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة الكريات البيضاء (مثال: ٦.٥).',
    monitorable: false,
    icon: 'flask',
    order: 200,
  },
  rbc: {
    kind: 'rbc',
    label: 'Red blood cells',
    shortLabel: 'RBC',
    unit: 'M/µL',
    acceptedUnits: ['m/ul', '10^6/ul', ''],
    decimals: 2,
    step: 0.01,
    min: 0,
    max: 10,
    normalLow: 4.5,
    normalHigh: 5.9,
    criticalLow: 2.5,
    criticalHigh: null,
    highAdvice: '',
    lowAdvice: 'RBC <2.5 M/µL is severe anaemia range and needs urgent assessment.',
    contextLabels: {},
    requestPrompt: 'Please reply with your latest red blood cell count (e.g. 4.8).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة الكريات الحمراء (مثال: ٤.٨).',
    monitorable: false,
    icon: 'flask',
    order: 210,
  },
  hematocrit: {
    kind: 'hematocrit',
    label: 'Haematocrit',
    shortLabel: 'HCT',
    unit: '%',
    acceptedUnits: ['%', ''],
    decimals: 1,
    step: 0.1,
    min: 0,
    max: 100,
    normalLow: 36,
    normalHigh: 54,
    criticalLow: 20,
    criticalHigh: null,
    highAdvice: '',
    lowAdvice: 'Haematocrit <20% is severe anaemia range and needs urgent assessment.',
    contextLabels: {},
    requestPrompt: 'Please reply with your latest haematocrit (e.g. 42).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة الهيماتوكريت (مثال: ٤٢).',
    monitorable: false,
    icon: 'flask',
    order: 220,
  },
  platelets: {
    kind: 'platelets',
    label: 'Platelets',
    shortLabel: 'PLT',
    unit: 'K/µL',
    acceptedUnits: ['k/ul', '10^3/ul', ''],
    decimals: 0,
    step: 1,
    min: 0,
    max: 3000,
    normalLow: 150,
    normalHigh: 400,
    criticalLow: 50,
    criticalHigh: 1000,
    highAdvice:
      'Platelets ≥1000 K/µL is severe thrombocytosis with clotting risk. Same-day assessment is advised.',
    lowAdvice:
      'Platelets <50 K/µL is severe thrombocytopenia with bleeding risk. Urgent assessment is advised; avoid invasive procedures.',
    contextLabels: {},
    requestPrompt: 'Please reply with your latest platelet count (e.g. 250).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة الصفائح (مثال: ٢٥٠).',
    monitorable: false,
    icon: 'flask',
    order: 230,
  },
  mcv: {
    kind: 'mcv',
    label: 'Mean corpuscular volume',
    shortLabel: 'MCV',
    unit: 'fL',
    acceptedUnits: ['fl', ''],
    decimals: 1,
    step: 0.1,
    min: 0,
    max: 200,
    normalLow: 80,
    normalHigh: 100,
    criticalLow: null,
    criticalHigh: null,
    highAdvice: '',
    lowAdvice: '',
    contextLabels: {},
    requestPrompt: 'Please reply with your latest MCV (e.g. 90).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة MCV (مثال: ٩٠).',
    monitorable: false,
    icon: 'flask',
    order: 240,
  },
  mch: {
    kind: 'mch',
    label: 'Mean corpuscular haemoglobin',
    shortLabel: 'MCH',
    unit: 'pg',
    acceptedUnits: ['pg', ''],
    decimals: 1,
    step: 0.1,
    min: 0,
    max: 100,
    normalLow: 27,
    normalHigh: 33,
    criticalLow: null,
    criticalHigh: null,
    highAdvice: '',
    lowAdvice: '',
    contextLabels: {},
    requestPrompt: 'Please reply with your latest MCH (e.g. 30).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة MCH (مثال: ٣٠).',
    monitorable: false,
    icon: 'flask',
    order: 250,
  },
  esr: {
    kind: 'esr',
    label: 'Erythrocyte sedimentation rate',
    shortLabel: 'ESR',
    unit: 'mm/h',
    acceptedUnits: ['mm/h', 'mmh', ''],
    decimals: 0,
    step: 1,
    min: 0,
    max: 300,
    normalLow: 0,
    normalHigh: 20,
    criticalLow: null,
    criticalHigh: 100,
    highAdvice:
      'ESR ≥100 mm/h indicates marked inflammation. Same-day assessment for the underlying cause is advised.',
    lowAdvice: '',
    contextLabels: {},
    requestPrompt: 'Please reply with your latest ESR (e.g. 12).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة سرعة التثفل (مثال: ١٢).',
    monitorable: false,
    icon: 'flask',
    order: 260,
  },
  crp: {
    kind: 'crp',
    label: 'C-reactive protein',
    shortLabel: 'CRP',
    unit: 'mg/L',
    acceptedUnits: ['mg/l', 'mg/dl', ''],
    decimals: 1,
    step: 0.1,
    min: 0,
    max: 1000,
    normalLow: 0,
    normalHigh: 5,
    criticalLow: null,
    criticalHigh: 200,
    highAdvice:
      'CRP ≥200 mg/L indicates severe inflammation or infection. Urgent assessment is advised.',
    lowAdvice: '',
    contextLabels: {},
    requestPrompt: 'Please reply with your latest CRP (e.g. 3).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة CRP (مثال: ٣).',
    monitorable: false,
    icon: 'flask',
    order: 270,
  },
  urea: {
    kind: 'urea',
    label: 'Urea (BUN)',
    shortLabel: 'Urea',
    unit: 'mg/dL',
    acceptedUnits: ['mg/dl', 'mmol/l', ''],
    decimals: 1,
    step: 0.1,
    min: 1,
    max: 300,
    normalLow: 7,
    normalHigh: 20,
    criticalLow: null,
    criticalHigh: 100,
    highAdvice:
      'Urea ≥100 mg/dL indicates severe uraemia. Urgent assessment is advised; check hydration, obstruction and medications.',
    lowAdvice: '',
    contextLabels: {},
    requestPrompt: 'Please reply with your latest urea result (e.g. 15).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة اليوريا (مثال: ١٥).',
    monitorable: false,
    icon: 'flask',
    order: 280,
  },
  microalbumin: {
    kind: 'microalbumin',
    label: 'Microalbumin (urine)',
    shortLabel: 'Microalbumin',
    unit: 'mg/L',
    acceptedUnits: ['mg/l', ''],
    decimals: 0,
    step: 1,
    min: 0,
    max: 5000,
    normalLow: 0,
    normalHigh: 30,
    criticalLow: null,
    criticalHigh: 300,
    highAdvice:
      'Microalbumin ≥300 mg/L is macroalbuminuria with significant kidney involvement. Prompt nephrology assessment is advised.',
    lowAdvice: '',
    contextLabels: {},
    requestPrompt: 'Please reply with your latest urine microalbumin (e.g. 12).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة الزلال (مثال: ١٢).',
    monitorable: false,
    icon: 'flask',
    order: 290,
  },
  urine_acr: {
    kind: 'urine_acr',
    label: 'Urine albumin/creatinine ratio',
    shortLabel: 'Urine ACR',
    unit: 'mg/g',
    acceptedUnits: ['mg/g', ''],
    decimals: 0,
    step: 1,
    min: 0,
    max: 10000,
    normalLow: 0,
    normalHigh: 30,
    criticalLow: null,
    criticalHigh: 300,
    highAdvice:
      'Urine ACR ≥300 mg/g is severely increased albuminuria. Prompt nephrology assessment is advised.',
    lowAdvice: '',
    contextLabels: {},
    requestPrompt: 'Please reply with your latest urine ACR (e.g. 15).',
    requestPromptAr: 'من فضلكم ردوا على نتيجة ACR (مثال: ١٥).',
    monitorable: false,
    icon: 'flask',
    order: 300,
  },
};

export const VITAL_KIND_LIST = Object.keys(VITAL_DEFINITIONS) as VitalKind[];

export function getVitalDefinition(kind: VitalKind): VitalDefinition {
  const def = VITAL_DEFINITIONS[kind];
  if (!def) {
    throw new Error(`Unknown vital kind: ${kind}`);
  }
  return def;
}

export function vitalLabel(kind: VitalKind): string {
  return getVitalDefinition(kind).label;
}

export function vitalUnit(kind: VitalKind): string {
  return getVitalDefinition(kind).unit;
}

export interface VitalEvaluation {
  kind: VitalKind;
  value: number;
  secondaryValue: number | null;
  unit: string;
  isAbnormal: boolean;
  isCritical: boolean;
  severity: AlertSeverity;
  interpretation: string;
  /** Range shown in the UI, e.g. "70–99 mg/dL". */
  referenceRange: string;
  /** Populated only when critical. */
  escalation: string | null;
}

export interface VitalEvaluationInput {
  kind: VitalKind;
  value: number;
  secondaryValue?: number | null;
  /** Age/sex aware reference overrides. */
  normalLow?: number | null;
  normalHigh?: number | null;
  ageYears?: number | null;
  sex?: Sex | null;
  pregnant?: boolean;
}

const OVERRIDES: Partial<Record<Sex, { hemoglobin?: readonly [number, number] }>> = {
  female: {
    hemoglobin: [12, 15.5],
  },
  male: {
    hemoglobin: [13.5, 17.5],
  },
};

function resolveRange(input: VitalEvaluationInput): { low: number; high: number } {
  const def = getVitalDefinition(input.kind);
  if (input.normalLow != null && input.normalHigh != null) {
    return { low: input.normalLow, high: input.normalHigh };
  }
  // Pediatric glucose thresholds (ADA): fasting 70-90 mg/dL for children.
  if (input.ageYears != null && input.ageYears < 18 && (input.kind === 'fasting_glucose' || input.kind === 'random_glucose')) {
    return input.kind === 'fasting_glucose' ? { low: 70, high: 90 } : { low: 70, high: 140 };
  }
  if (input.sex && input.sex !== 'unknown' && input.kind === 'hemoglobin') {
    const override = OVERRIDES[input.sex];
    if (override && override.hemoglobin) {
      return { low: override.hemoglobin[0], high: override.hemoglobin[1] };
    }
  }
  return { low: def.normalLow, high: def.normalHigh };
}

/**
 * Classify a reading. Severity rules:
 *  - critical when the value crosses a hard safety threshold (either direction)
 *  - warning  when outside the reference range but not critical
 *  - info     when within range
 */
export function evaluateVital(input: VitalEvaluationInput): VitalEvaluation {
  const def = getVitalDefinition(input.kind);
  const { low, high } = resolveRange(input);
  const value = input.value;
  const isOutOfPhysicalRange = value < def.min || value > def.max;

  const belowCritical = def.criticalLow != null && value <= def.criticalLow;
  const aboveCritical = def.criticalHigh != null && value >= def.criticalHigh;
  const isCritical = belowCritical || aboveCritical || isOutOfPhysicalRange;

  const isAbnormal = isCritical || value < low || value > high;
  const severity: AlertSeverity = isCritical ? 'critical' : isAbnormal ? 'warning' : 'info';

  let interpretation: string;
  let escalation: string | null = null;

  if (belowCritical) {
    interpretation = `${def.label} ${formatVitalValue(input.kind, value)} is critically low (≤ ${def.criticalLow} ${def.unit}).`;
    escalation = def.lowAdvice;
  } else if (aboveCritical) {
    interpretation = `${def.label} ${formatVitalValue(input.kind, value)} is critically high (≥ ${def.criticalHigh} ${def.unit}).`;
    escalation = def.highAdvice;
  } else if (value < low) {
    interpretation = `${def.label} ${formatVitalValue(input.kind, value)} is below the reference range (${low}–${high} ${def.unit}).`;
    if (def.lowAdvice) escalation = def.lowAdvice;
  } else if (value > high) {
    interpretation = `${def.label} ${formatVitalValue(input.kind, value)} is above the reference range (${low}–${high} ${def.unit}).`;
    if (def.highAdvice) escalation = def.highAdvice;
  } else {
    interpretation = `${def.label} ${formatVitalValue(input.kind, value)} is within the reference range (${low}–${high} ${def.unit}).`;
  }

  // Blood pressure is interpreted as a pair; add combined guidance.
  if (input.kind === 'systolic_bp' && input.secondaryValue != null) {
    interpretation = interpretation.replace(
      /\.$/,
      ` Paired diastolic ${input.secondaryValue} mmHg.`,
    );
  }
  if (isCritical && (input.kind === 'systolic_bp' || input.kind === 'diastolic_bp')) {
    escalation = escalation
      ? `${escalation} If the patient has chest pain, breathlessness, weakness, confusion or a severe headache, direct them to emergency care immediately.`
      : 'Direct the patient to emergency care if symptomatic.';
  }

  return {
    kind: input.kind,
    value,
    secondaryValue: input.secondaryValue ?? null,
    unit: def.unit,
    isAbnormal,
    isCritical,
    severity,
    interpretation,
    referenceRange: `${low}–${high} ${def.unit}`,
    escalation,
  };
}

export function formatVitalValue(kind: VitalKind, value: number): string {
  const def = getVitalDefinition(kind);
  const rounded = Number(value.toFixed(def.decimals));
  return `${rounded} ${def.unit}`;
}

export function evaluateVitals(inputs: readonly VitalEvaluationInput[]): VitalEvaluation[] {
  return inputs.map((i) => evaluateVital(i));
}

/** Convenience: the overall worst severity across a set of readings. */
export function worstSeverity(evals: readonly VitalEvaluation[]): AlertSeverity {
  if (evals.some((e) => e.severity === 'critical')) return 'critical';
  if (evals.some((e) => e.severity === 'warning')) return 'warning';
  return 'info';
}

export function isCriticalVitals(evals: readonly VitalEvaluation[]): boolean {
  return evals.some((e) => e.isCritical);
}
