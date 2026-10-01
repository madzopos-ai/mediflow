/**
 * Predictive lifestyle guidance: targets, diet and exercise drafted from the
 * same numbers as the dosing engine. Educational content for the clinician to
 * hand to the patient - never a diagnosis, always reviewable.
 *
 * Patient-facing strings come in clear, simple Arabic (`lang: 'ar'`) while
 * drug names and standard dosages always stay in English/Latin for medical
 * accuracy. Dosing reasons stay English: they are doctor-facing draft notes.
 */

export interface LifestyleLabs {
  hba1c: number | null;
  systolic: number | null;
  ldl: number | null;
  triglycerides: number | null;
  microalbumin: number | null;
  urineAcr: number | null;
  creatinine: number | null;
  urea: number | null;
  egfr: number | null;
}

export interface LifestyleInput {
  diagnosis: string;
  conditions: string[];
  labs: LifestyleLabs;
  weightKg: number | null;
  ageYears: number | null;
}

export type LifestyleLang = 'en' | 'ar';

export interface LifestylePlan {
  targets: string[];
  diet: string[];
  exercise: string[];
}

const DIABETES = /diabet|dm2|t2dm|t1dm|hyperglyc|سكر/i;
const HYPERTENSION = /hypertens|ضغط/i;

const STR = {
  en: {
    hba1cTarget: 'Target HbA1c below 7.0% - recheck every 3 months until stable',
    weightTarget: (a: number, b: number): string =>
      `Weight goal: -5% to -10% of current weight (${a}-${b} kg) over 6 months`,
    bpTarget: 'Target blood pressure below 130/80 mmHg - home readings twice weekly',
    kidneyTarget: 'Kidney goal: stable creatinine and no rise in albuminuria - renal panel every 3 months',
    ldlTarget: 'Target LDL below 100 mg/dL with therapy and diet',
    carbs: 'Controlled carbohydrates: whole grains over white bread and rice; sweetened drinks avoided entirely',
    plate: 'Plate method: half vegetables, quarter lean protein, quarter whole grains',
    sodium: 'Sodium restriction: under 2g of sodium daily - no added salt, pickles or processed meats',
    protein: 'Renal-safe protein: moderate portions, avoid excess red meat; dietitian review advised',
    ureaHigh: (v: number): string =>
      `Urea ${v} mg/dL is high - generous hydration unless fluid-restricted, and recheck soon`,
    fats: 'Heart-smart fats: olive oil instead of butter and ghee; fried food no more than once a week',
    bpDiet: 'Sodium restriction: under 2g daily supports blood-pressure control',
    defaultDiet: 'Balanced plate: vegetables at every meal, water instead of sweetened drinks, regular meal times',
    walk: '30 minutes of brisk walking daily, at least 5 days a week',
    walkAfterMeal: 'A 10-minute walk after the main meal blunts the glucose spike',
    gentle: 'Low-impact only at this age: walking and chair exercises; stop on chest pain or dizziness',
    resistance: 'Add light resistance (bands or body weight) twice a week as fitness improves',
  },
  ar: {
    hba1cTarget: 'الهدف: سكري تراكمي تحت 7.0% — إعادة الفحص كل 3 أشهر حتى الاستقرار',
    weightTarget: (a: number, b: number): string =>
      `هدف الوزن: خسارة 5%-10% من الوزن الحالي (${a}-${b} كغ) خلال 6 أشهر`,
    bpTarget: 'هدف الضغط تحت 130/80 — قياس منزلي مرتين بالأسبوع',
    kidneyTarget: 'هدف الكلى: كرياتينين ثابت ولا ارتفاع بالزلال — فحص كلى كل 3 أشهر',
    ldlTarget: 'هدف LDL تحت 100 مع العلاج والحمية',
    carbs: 'كربوهيدرات مضبوطة: حبوب كاملة بدل الخبز الأبيض والأرز، والمشروبات المحلاة ممنوعة تمامًا',
    plate: 'طريقة الصحن: نصفه خضار، ربعه بروتين قليل الدهن، وربعه حبوب كاملة',
    sodium: 'ملح أقل من 2غ صوديوم يوميًا — بلا ملح مضاف ولا مخلل ولا لحوم مصنعة',
    protein: 'بروتين آمن للكلى: حصص معتدلة، وتخفيف اللحوم الحمراء، ومراجعة أخصائية تغذية',
    ureaHigh: (v: number): string =>
      `اليوريا ${v} مرتفعة — سوائل كافية إلا إذا ممنوعة، وإعادة الفحص قريبًا`,
    fats: 'دهون صحية للقلب: زيت زيتون بدل الزبدة والسمنة، والمقالي مرة بالأسبوع كحد أقصى',
    bpDiet: 'تخفيف الملح تحت 2غ يوميًا بيساعد بضبط الضغط',
    defaultDiet: 'صحن متوازن: خضار بكل وجبة، ومي بدل المشروبات المحلاة، ووجبات بمواعيد منتظمة',
    walk: '30 دقيقة مشي سريع يوميًا، 5 أيام بالأسبوع على الأقل',
    walkAfterMeal: '10 دقائق مشي بعد الوجبة الرئيسية بتخفف ارتفاع السكر',
    gentle: 'بهالعمر تمارين خفيفة فقط: مشي وتمارين كرسي، وتوقف عند ألم الصدر أو الدوخة',
    resistance: 'أضف مقاومة خفيفة (أربطة أو وزن الجسم) مرتين أسبوعيًا مع تحسن اللياقة',
  },
} as const;

export function recommendLifestyle(input: LifestyleInput, lang: LifestyleLang = 'en'): LifestylePlan {
  const t = STR[lang] ?? STR.en;
  const targets: string[] = [];
  const diet: string[] = [];
  const exercise: string[] = [];
  const { labs } = input;

  const diabetic =
    (labs.hba1c !== null && labs.hba1c >= 6.5) ||
    DIABETES.test(input.diagnosis) ||
    input.conditions.some((c) => DIABETES.test(c));
  const hypertensive =
    (labs.systolic !== null && labs.systolic >= 140) ||
    HYPERTENSION.test(input.diagnosis) ||
    input.conditions.some((c) => HYPERTENSION.test(c));
  const renal =
    (labs.urineAcr !== null && labs.urineAcr > 30) ||
    (labs.microalbumin !== null && labs.microalbumin > 30) ||
    (labs.creatinine !== null && labs.creatinine > 1.2) ||
    (labs.urea !== null && labs.urea >= 60) ||
    (labs.egfr !== null && labs.egfr < 60);

  // ---- Targets: numbers the patient can aim at ----
  if (diabetic) targets.push(t.hba1cTarget);
  if (input.weightKg !== null && input.weightKg > 0) {
    targets.push(t.weightTarget(Math.round(input.weightKg * 0.05), Math.round(input.weightKg * 0.1)));
  }
  if (hypertensive) targets.push(t.bpTarget);
  if (renal) targets.push(t.kidneyTarget);
  if (labs.ldl !== null && labs.ldl >= 130) targets.push(t.ldlTarget);

  // ---- Diet: matched to the lab picture ----
  if (diabetic) {
    diet.push(t.carbs);
    diet.push(t.plate);
  }
  if (renal) {
    diet.push(t.sodium);
    diet.push(t.protein);
    if (labs.urea !== null && labs.urea >= 60) {
      diet.push(t.ureaHigh(Math.round(labs.urea * 10) / 10));
    }
  }
  if ((labs.ldl !== null && labs.ldl >= 130) || (labs.triglycerides !== null && labs.triglycerides >= 150)) {
    diet.push(t.fats);
  }
  if (hypertensive && !renal) diet.push(t.bpDiet);
  if (diet.length === 0) {
    diet.push(t.defaultDiet);
  }

  // ---- Exercise: one clear routine ----
  exercise.push(t.walk);
  if (diabetic) exercise.push(t.walkAfterMeal);
  if (input.ageYears !== null && input.ageYears >= 65) {
    exercise.push(t.gentle);
  } else {
    exercise.push(t.resistance);
  }

  return { targets, diet, exercise };
}
