/**
 * Drug–drug interaction engine.
 *
 * Two complementary mechanisms:
 *  1. Explicit pair rules for well-documented, clinically important combinations.
 *  2. Class-level rules that fire whenever two drugs from the flagged classes
 *     co-occur, which generalises the explicit pairs.
 *
 * Every finding carries a severity, mechanism, clinical effect and a concrete
 * management suggestion. Sources are cited so a clinician can verify.
 */

import type { DrugInteraction } from '../domain/types.js';
import type { Drug } from './drugs.js';
import { DRUG_CATALOG, DRUGS_BY_ID, resolveMedicationString } from './drugs.js';

export type InteractionSeverity = DrugInteraction['severity'];

interface PairRule {
  id: string;
  drugs: [string, string];
  severity: InteractionSeverity;
  mechanism: string;
  clinicalEffect: string;
  management: string;
  evidence: string;
  source: string;
}

interface ClassRule {
  id: string;
  /** Substring match on `class` or `subClass` (lowercase). */
  classA: string;
  classB: string;
  /** Which drug is flagged for the classA/classB pairing. */
  direction: 'a-uses-b' | 'b-uses-a' | 'both';
  severity: InteractionSeverity;
  mechanism: string;
  clinicalEffect: string;
  management: string;
  evidence: string;
  source: string;
  /** Only fire when the *other* drug's id is in this allow-list (empty = any). */
  requires?: string[];
}

export const PAIR_INTERACTION_RULES: PairRule[] = [
  {
    id: 'warfarin-aspirin-major',
    drugs: ['warfarin', 'aspirin'],
    severity: 'major',
    mechanism: 'Additive inhibition of vitamin K-dependent clotting factors combined with irreversible platelet inhibition and direct gastric mucosal injury by aspirin.',
    clinicalEffect: 'Roughly a 2–3 fold increase in major bleeding risk, predominantly gastrointestinal and intracranial.',
    management: 'Avoid the combination. If anticoagulation is essential, use a PPI gastroprotection and consider a lower aspirin dose with close INR and haemoglobin monitoring.',
    evidence: 'High — consistent across anticoagulation registries',
    source: 'ACC/AHA Antithrombotic Therapy Guidance',
  },
  {
    id: 'warfarin-nsaid-major',
    drugs: ['warfarin', 'ibuprofen'],
    severity: 'major',
    mechanism: 'NSAID inhibition of COX-1 reduces platelet aggregation and prostaglandin-mediated gastric mucosal protection, additive to the anticoagulant effect.',
    clinicalEffect: 'Approximately threefold increase in gastrointestinal bleeding risk.',
    management: 'Avoid. Use paracetamol for analgesia, or add a PPI if an NSAID is unavoidable. Monitor INR and haemoglobin.',
    evidence: 'High',
    source: 'Class warning — COX inhibitors with VKA',
  },
  {
    id: 'warfarin-tramadol-major',
    drugs: ['warfarin', 'tramadol'],
    severity: 'major',
    mechanism: 'Tramadol competes for CYP2C9-mediated metabolism and increases INR substantially; it also lowers the seizure threshold relevant to warfarin-induced skin necrosis differentials.',
    clinicalEffect: 'Unpredictable INR elevation with high bleeding risk.',
    management: 'Prefer a non-tramadol analgesic. If unavoidable, check INR within 3–5 days of starting and after dose changes and reduce the warfarin dose.',
    evidence: 'Moderate–high',
    source: 'Case series and pharmacokinetic studies',
  },
  {
    id: 'warfarin-ciprofloxacin-major',
    drugs: ['warfarin', 'amoxicillin-clavulanate'],
    severity: 'moderate',
    mechanism: 'Antibiotic-associated loss of gut flora reduces vitamin K synthesis while the infection and reduced intake suppress appetite, compounding anticoagulation.',
    clinicalEffect: 'INR rise with bleeding risk, typically in the first week of antibiotics.',
    management: 'Check INR 3–5 days after starting the antibiotic and again after it finishes. Consider a 10–20% warfarin dose reduction.',
    evidence: 'High',
    source: 'Interaction guidance for antibiotics and VKA',
  },
  {
    id: 'warfarin-metronidazole-major',
    drugs: ['warfarin', 'metronidazole'],
    severity: 'major',
    mechanism: 'Metronidazole inhibits CYP2C9, the main enzyme clearing the more potent S-warfarin enantiomer.',
    clinicalEffect: 'Rapid, marked INR increase; clinically significant bleeding has been reported within days.',
    management: 'Avoid if possible. If used, reduce warfarin by 25–50%, monitor INR within 3 days, then weekly until stable.',
    evidence: 'High',
    source: 'Case reports with consistent INR pattern',
  },
  {
    id: 'ssri-nsaid-major',
    drugs: ['sertraline', 'ibuprofen'],
    severity: 'major',
    mechanism: 'SSRIs block platelet serotonin uptake and deplete platelet stores; NSAIDs add direct platelet inhibition and gastric mucosal damage.',
    clinicalEffect: 'Approximately threefold higher upper-GI bleeding risk than either drug alone.',
    management: 'Add a PPI, or substitute paracetamol for analgesia. Counsel on melaena and haematemesis.',
    evidence: 'High',
    source: 'Meta-analyses of NSAID + SSRI bleeding risk',
  },
  {
    id: 'ssri-aspirin-major',
    drugs: ['escitalopram', 'aspirin'],
    severity: 'moderate',
    mechanism: 'Additive impairment of platelet function with GI mucosal injury from aspirin.',
    clinicalEffect: 'Increased upper-GI bleeding risk.',
    management: 'Add PPI gastroprotection; continue only when aspirin is clearly indicated.',
    evidence: 'High',
    source: 'Pharmacoepidemiology studies',
  },
  {
    id: 'acei-potassium-major',
    drugs: ['ramipril', 'spironolactone'],
    severity: 'moderate',
    mechanism: 'ACE inhibition reduces aldosterone while spironolactone blocks the mineralocorticoid receptor; both raise serum potassium.',
    clinicalEffect: 'Hyperkalaemia, which can precipitate fatal arrhythmia.',
    management: 'Check potassium and creatinine at 1 week and 1 month, then every 3–6 months. Advise against potassium supplements and salt substitutes.',
    evidence: 'High',
    source: 'NICE/ACC hyperkalaemia guidance',
  },
  {
    id: 'losartan-spironolactone-major',
    drugs: ['losartan', 'spironolactone'],
    severity: 'moderate',
    mechanism: 'Additive potassium retention from ARB blockade of angiotensin II plus aldosterone antagonism.',
    clinicalEffect: 'Hyperkalaemia and possible acute kidney injury.',
    management: 'Monitor potassium and renal function closely after initiation and each dose change.',
    evidence: 'High',
    source: 'NICE/ACC hyperkalaemia guidance',
  },
  {
    id: 'lisinopril-spironolactone-major',
    drugs: ['lisinopril', 'spironolactone'],
    severity: 'moderate',
    mechanism: 'Additive potassium retention from ACE inhibition plus aldosterone antagonism.',
    clinicalEffect: 'Hyperkalaemia.',
    management: 'Monitor potassium and renal function; consider lower starting doses of both agents.',
    evidence: 'High',
    source: 'NICE/ACC hyperkalaemia guidance',
  },
  {
    id: 'metformin-ct-contrast-moderate',
    drugs: ['metformin', 'aztreonam'],
    severity: 'moderate',
    mechanism: 'Iodinated contrast and acute illness cause transient renal impairment, reducing metformin clearance and increasing the risk of lactic acidosis.',
    clinicalEffect: 'Lactic acidosis risk; usually managed by withholding metformin for 48 hours.',
    management: 'Hold metformin around contrast studies and during acute dehydration or illness; restart after 48 hours once renal function is confirmed.',
    evidence: 'High',
    source: 'ADA Standards of Care',
  },
  {
    id: 'lisinopril-potassium-clavulanate-moderate',
    drugs: ['lisinopril', 'amoxicillin-clavulanate'],
    severity: 'moderate',
    mechanism: 'Potassium-containing antibiotics and reduced renal perfusion in infection can raise potassium; ACE inhibitors reduce its excretion.',
    clinicalEffect: 'Mild hyperkalaemia, occasionally severe.',
    management: 'Check potassium during acute infection in patients on an ACE inhibitor.',
    evidence: 'Moderate',
    source: 'Case reports',
  },
  {
    id: 'clarithromycin-qt-moderate',
    drugs: ['azithromycin', 'ondansetron'],
    severity: 'major',
    mechanism: 'Both drugs prolong the QT interval by blocking cardiac potassium channels (hERG); the effect is additive.',
    clinicalEffect: 'Torsades de pointes and ventricular arrhythmia.',
    management: 'Avoid the combination. Use an alternative antiemetic such as domperidone (after checking hepatic function) or metoclopramide.',
    evidence: 'High',
    source: 'CredibleMeds QT drug list',
  },
  {
    id: 'ciprofloxacin-tizanidine-contraindicated',
    drugs: ['azithromycin', 'clindamycin'],
    severity: 'minor',
    mechanism: 'Both antibiotics can produce overlapping GI adverse effects (nausea, diarrhoea) and interact with CYP3A4 to a minor degree.',
    clinicalEffect: 'Increased nausea and diarrhoea risk; no pharmacokinetic danger.',
    management: 'No action needed. Counsel on the increased likelihood of stomach upset.',
    evidence: 'Low',
    source: 'Product information',
  },
  {
    id: 'benzodiazepine-opioid-major',
    drugs: ['alprazolam', 'tramadol'],
    severity: 'major',
    mechanism: 'Additive central nervous system and respiratory depression through GABAergic and mu-opioid receptor agonism.',
    clinicalEffect: 'Profound sedation, respiratory depression and death risk.',
    management: 'Avoid concurrent prescribing. If unavoidable, use the lowest doses, avoid alcohol, and monitor respiration. The combination is listed on the FDA boxed warning.',
    evidence: 'High',
    source: 'FDA Drug Safety Communication (boxed warning)',
  },
  {
    id: 'lisinopril-nsaid-moderate',
    drugs: ['lisinopril', 'ibuprofen'],
    severity: 'moderate',
    mechanism: 'NSAIDs inhibit prostaglandin-mediated afferent arteriolar vasodilation, removing the mechanism that protects renal perfusion when GFR falls.',
    clinicalEffect: 'Acute kidney injury and a blunted antihypertensive effect, with "triple whammy" risk when combined with a diuretic.',
    management: 'Use paracetamol instead. If an NSAID is essential, check creatinine in 1–2 weeks and limit duration.',
    evidence: 'High',
    source: 'National Kidney Foundation guidance',
  },
  {
    id: 'losartan-ibuprofen-moderate',
    drugs: ['losartan', 'ibuprofen'],
    severity: 'moderate',
    mechanism: 'NSAID-induced prostaglandin inhibition antagonises ARB-mediated efferent arteriolar dilation.',
    clinicalEffect: 'Acute kidney injury, hyperkalaemia and reduced blood-pressure control.',
    management: 'Prefer paracetamol; monitor renal function if co-prescribed.',
    evidence: 'High',
    source: 'National Kidney Foundation guidance',
  },
  {
    id: 'ramipril-ibuprofen-moderate',
    drugs: ['ramipril', 'ibuprofen'],
    severity: 'moderate',
    mechanism: 'NSAID-induced prostaglandin inhibition antagonises ACE-inhibitor-mediated efferent arteriolar dilation.',
    clinicalEffect: 'Acute kidney injury and hyperkalaemia.',
    management: 'Prefer paracetamol; monitor renal function if co-prescribed.',
    evidence: 'High',
    source: 'National Kidney Foundation guidance',
  },
  {
    id: 'clopidogrel-omeprazole-major',
    drugs: ['clopidogrel', 'omeprazole'],
    severity: 'major',
    mechanism: 'Omeprazole is a strong CYP2C19 inhibitor, and CYP2C19 converts clopidogrel to its active metabolite. Pantoprazole is a far weaker inhibitor.',
    clinicalEffect: 'Loss of clopidogrel antiplatelet effect with increased stent thrombosis and recurrent cardiovascular events.',
    management: 'Switch to pantoprazole, or separate clopidogrel and omeprazole by 12 hours with the PPI taken before breakfast.',
    evidence: 'High — outcome data from COGENT',
    source: 'ACC/AHA and CPIC guidance',
  },
  {
    id: 'clopidogrel-pantoprazole-minor',
    drugs: ['clopidogrel', 'pantoprazole'],
    severity: 'minor',
    mechanism: 'Pantoprazole has minimal CYP2C19 inhibition compared with omeprazole and esomeprazole.',
    clinicalEffect: 'Clinically insignificant reduction in clopidogrel activation.',
    management: 'No change needed — pantoprazole is the preferred PPI with clopidogrel.',
    evidence: 'High',
    source: 'CPIC',
  },
  {
    id: 'metronidazole-warfarin-see-above',
    drugs: ['amoxicillin', 'warfarin'],
    severity: 'moderate',
    mechanism: 'Reduction of vitamin K–producing gut flora and decreased oral intake during infection.',
    clinicalEffect: 'INR elevation and bleeding risk.',
    management: 'Check INR 3–5 days after starting the antibiotic.',
    evidence: 'High',
    source: 'Interaction guidance',
  },
  {
    id: 'fluoroquinolone-nsaid-major',
    drugs: ['azithromycin', 'gabapentin'],
    severity: 'moderate',
    mechanism: 'Both can cause central nervous system effects; fluoroquinolones lower the seizure threshold and potentiate GABAergic sedation.',
    clinicalEffect: 'Increased dizziness, somnolence and seizure risk.',
    management: 'Advise against driving; monitor for excessive sedation when initiating gabapentin.',
    evidence: 'Moderate',
    source: 'Product information and pharmacovigilance',
  },
  {
    id: 'statin-azithromycin-moderate',
    drugs: ['atorvastatin', 'azithromycin'],
    severity: 'moderate',
    mechanism: 'Azithromycin inhibits CYP3A4 more than clarithromycin but still can raise statin exposure; risk of myopathy and rhabdomyolysis increases.',
    clinicalEffect: 'Elevated creatine kinase, myalgia and rarely rhabdomyolysis.',
    management: 'Suspend or reduce the atorvastatin dose during the antibiotic course; ask about new muscle pain or dark urine.',
    evidence: 'High',
    source: 'Product information and case reports',
  },
  {
    id: 'statin-rosuvastatin-azithromycin-moderate',
    drugs: ['rosuvastatin', 'azithromycin'],
    severity: 'moderate',
    mechanism: 'Rosuvastatin is only minimally metabolised by CYP3A4, so the interaction is much weaker than with clarithromycin.',
    clinicalEffect: 'Small increase in statin exposure; monitor for myalgia.',
    management: 'Routine co-administration is acceptable; counsel on muscle symptoms.',
    evidence: 'Moderate',
    source: 'Product information',
  },
];

/** Class-level rules that generalise beyond the explicit pairs. */
export const CLASS_INTERACTION_RULES: ClassRule[] = [
  {
    id: 'nsri-serotonergic-major',
    classA: 'SSRI',
    classB: 'TCA',
    direction: 'both',
    severity: 'major',
    mechanism: 'Additive serotonin reuptake inhibition and muscarinic blockade.',
    clinicalEffect: 'Serotonin syndrome (agitation, hyperreflexia, clonus, hyperthermia) plus anticholinergic delirium.',
    management: 'Avoid. If both are required, start the TCA at half the usual dose and monitor closely for serotonin toxicity.',
    evidence: 'High',
    source: 'Interaction compendia',
  },
  {
    id: 'ssri-tramadol-serotonin-major',
    classA: 'SSRI',
    classB: 'Weak opioid',
    direction: 'both',
    severity: 'major',
    mechanism: 'Additive serotonergic activity: SSRIs inhibit serotonin reuptake while tramadol has independent serotonergic activity and also lowers the seizure threshold.',
    clinicalEffect: 'Serotonin syndrome (agitation, clonus, hyperreflexia, fever) and a lowered seizure threshold.',
    management: 'Avoid the combination where possible. If co-prescribed, start tramadol at the lowest dose, counsel on agitation, tremor and sweating, and review within 72 hours.',
    evidence: 'High',
    source: 'MHRA Drug Safety Update on tramadol; product information',
  },
  {
    id: 'acei-arbi-contraindicated',
    classA: 'ACE inhibitor',
    classB: 'ARB',
    direction: 'both',
    severity: 'major',
    mechanism: 'Dual blockade of the renin–angiotensin–aldosterone system.',
    clinicalEffect: 'Hyperkalaemia, acute kidney injury and hypotension with no outcome benefit.',
    management: 'Avoid dual blockade; choose one agent from the class.',
    evidence: 'High — ONTARGET trial',
    source: 'KDIGO / ACC guidance',
  },
  {
    id: 'ondansetron-macrolide-qt-major',
    classA: '5-HT3 antagonist',
    classB: 'Macrolide',
    direction: 'a-uses-b',
    severity: 'major',
    mechanism: 'Additive QT prolongation through cardiac potassium channel blockade by both agents.',
    clinicalEffect: 'Torsades de pointes and other ventricular arrhythmias; risk is highest with intravenous ondansetron at high dose.',
    management: 'Select an antiemetic that does not prolong the QT interval, correct potassium and magnesium, and avoid the combination in cardiac disease.',
    evidence: 'High',
    source: 'CredibleMeds; FDA drug safety communication on ondansetron',
  },
  {
    id: 'nsaid-steroid-major',
    classA: 'NSAID',
    classB: 'Topical corticosteroid',
    direction: 'both',
    severity: 'moderate',
    mechanism: 'Additive gastrointestinal mucosal injury; systemic absorption of topical steroids may also increase GI risk.',
    clinicalEffect: 'Increased peptic ulcer and GI bleeding risk.',
    management: 'Limit to short courses, add a PPI if the risk is high, and prefer paracetamol for longer analgesia.',
    evidence: 'Moderate–high',
    source: 'Epidemiological studies',
  },
  {
    id: 'nsaid-anticoagulant-major',
    classA: 'NSAID',
    classB: 'Anticoagulant',
    direction: 'both',
    severity: 'major',
    mechanism: 'Additive impairment of haemostasis and direct mucosal damage.',
    clinicalEffect: 'Major bleeding, particularly gastrointestinal.',
    management: 'Avoid. Use paracetamol and add PPI gastroprotection if an NSAID is unavoidable.',
    evidence: 'High',
    source: 'Interaction guidance',
  },
  {
    id: 'statin-fibrate-myopathy-major',
    classA: 'Statin',
    classB: 'Fibrate',
    direction: 'both',
    severity: 'moderate',
    mechanism: 'Additive myotoxicity through shared HMG-CoA reductase inhibition and gemfibrozil CYP2C8 inhibition.',
    clinicalEffect: 'Myopathy and rhabdomyolysis risk.',
    management: 'Check creatine kinase and muscle symptoms; prefer fenofibrate or a lower statin dose, and avoid gemfibrozil with simvastatin.',
    evidence: 'Moderate',
    source: 'Product information',
  },
  {
    id: 'macrolide-theophylline-major',
    classA: 'Macrolide',
    classB: 'Methylxanthine',
    direction: 'both',
    severity: 'major',
    mechanism: 'CYP1A2 and CYP3A4 inhibition reduces theophylline clearance.',
    clinicalEffect: 'Theophylline toxicity: nausea, tremor, tachyarrhythmias, seizures.',
    management: 'Avoid macrolides in patients on theophylline; use azithromycin (the least CYP-inhibiting) only if essential, with level monitoring.',
    evidence: 'High',
    source: 'Product information',
  },
  {
    id: 'fluoroquinolone-theophylline-major',
    classA: 'Fluoroquinolone',
    classB: 'Methylxanthine',
    direction: 'both',
    severity: 'major',
    mechanism: 'Ciprofloxacin inhibits CYP1A2, markedly reducing theophylline clearance.',
    clinicalEffect: 'Theophylline toxicity: nausea, tremor, tachyarrhythmias, seizures.',
    management: 'Avoid if possible. If essential, reduce the theophylline dose, check the serum level after 48 hours, and monitor closely.',
    evidence: 'High',
    source: 'Product information; BNF interactions',
  },
  {
    id: 'thiazide-antihypertensive-hypotension',
    classA: 'Thiazide',
    classB: 'Beta blocker',
    direction: 'both',
    severity: 'minor',
    mechanism: 'Additive blood-pressure lowering, including first-dose hypotension.',
    clinicalEffect: 'Dizziness and postural hypotension, especially in the elderly.',
    management: 'Start at low doses and counsel about rising slowly from sitting.',
    evidence: 'Moderate',
    source: 'Interaction guidance',
  },
  {
    id: 'metformin-contrast-moderate',
    classA: 'Biguanide',
    classB: 'Proton pump inhibitor',
    direction: 'a-uses-b',
    severity: 'minor',
    mechanism: 'Proton pump inhibitors can alter metformin absorption and reduce the efficacy of enteric-coated preparations.',
    clinicalEffect: 'Variable change in glycaemic control.',
    management: 'Monitor glucose after a sustained change in PPI therapy.',
    evidence: 'Low–moderate',
    source: 'Pharmacokinetic studies',
  },
  {
    id: 'beta-blocker-bronchodilator-major',
    classA: 'Beta blocker',
    classB: 'Inhaled corticosteroid',
    direction: 'both',
    requires: ['salbutamol-inhaler', 'budesonide-inhaler'],
    severity: 'moderate',
    mechanism: 'Beta blockade antagonises the bronchodilator effect of beta-2 agonists; inhaled steroids are not affected directly.',
    clinicalEffect: 'Worse control of asthma symptoms and reduced reliever efficacy.',
    management: 'Prefer cardioselective beta blockers (bisoprolol, atenolol) at low dose; avoid carvedilol and propranolol in asthma.',
    evidence: 'High',
    source: 'NICE / GINA guidance',
  },
  {
    id: 'acei-cough-minor',
    classA: 'ACE inhibitor',
    classB: 'Antihistamine',
    direction: 'a-uses-b',
    severity: 'minor',
    mechanism: 'Bradykinin accumulation is unaffected; risk arises from additive hypotension and sedation rather than mechanism.',
    clinicalEffect: 'Mild additive dizziness.',
    management: 'No routine action; counsel about postural symptoms.',
    evidence: 'Low',
    source: 'Interaction guidance',
  },
  {
    id: 'statin-corticosteroid-moderate',
    classA: 'Statin',
    classB: 'Corticosteroid',
    direction: 'both',
    severity: 'moderate',
    mechanism: 'Additive myopathy risk, particularly with high-dose or long-term systemic corticosteroids.',
    clinicalEffect: 'Myalgia and elevated creatine kinase.',
    management: 'Report muscle pain promptly; check creatine kinase if symptoms appear.',
    evidence: 'Moderate',
    source: 'Product information',
  },
  {
    id: 'macrolide-fluoroquinolone-hepatotoxicity',
    classA: 'Macrolide',
    classB: 'Fluoroquinolone',
    direction: 'both',
    severity: 'minor',
    mechanism: 'Overlapping gastrointestinal and hepatic adverse effects; the tendon and neuropathy risks are quinolone-specific and are covered by the drug monograph.',
    clinicalEffect: 'Increased GI upset, and a higher risk of transaminase elevation when either is used at the upper dose range.',
    management: 'Monitor liver enzymes during the course, particularly with extended or high-dose therapy.',
    evidence: 'Low',
    source: 'Product information',
  },
  {
    id: 'sulfonhydurea-insulin-major',
    classA: 'Sulfonylurea',
    classB: 'Rapid-acting insulin',
    direction: 'both',
    severity: 'major',
    mechanism: 'Additive glucose-lowering effect.',
    clinicalEffect: 'Severe and prolonged hypoglycaemia, particularly overnight.',
    management: 'Do not combine routinely; if unavoidable, reduce the sulfonylurea dose and provide close glucose monitoring and hypo education.',
    evidence: 'High',
    source: 'Diabetes guidance',
  },
  {
    id: 'metformin-insulin-major',
    classA: 'Biguanide',
    classB: 'Rapid-acting insulin',
    direction: 'both',
    severity: 'moderate',
    mechanism: 'Additive glucose lowering without intrinsic hypoglycaemia risk from metformin alone.',
    clinicalEffect: 'Hypoglycaemia driven mainly by the insulin component; increased overall risk.',
    management: 'Reasonable combination — titrate metformin first and monitor glucose at the same frequency as insulin.',
    evidence: 'High',
    source: 'ADA Standards of Care',
  },
  {
    id: 'sglt2-insulin-hypo',
    classA: 'SGLT2 inhibitor',
    classB: 'Long-acting insulin',
    direction: 'both',
    severity: 'moderate',
    mechanism: 'Insulin dose down-titration is usually required because glycaemic exposure falls, but SGLT2 inhibitors alone do not cause hypoglycaemia.',
    clinicalEffect: 'Increased hypoglycaemia risk if the insulin dose is not reduced.',
    management: 'Reduce basal insulin by 10–20% when adding an SGLT2 inhibitor, then titrate to fasting glucose.',
    evidence: 'High',
    source: 'ADA Standards of Care',
  },
  {
    id: 'penicillin-cephalosporin-major',
    classA: 'Penicillin antibiotic',
    classB: 'Cephalosporin antibiotic',
    direction: 'both',
    severity: 'moderate',
    mechanism: 'Shared beta-lactam structural motif produces cross-reactivity through IgE recognition of the R1 side chain.',
    clinicalEffect: 'Approximately 2% cross-reactivity overall, but higher with specific side chains (e.g. ceftazidime and aztreonam).',
    management: 'In a patient with an immediate-type penicillin allergy, use cefuroxime only if the reaction was non-severe; otherwise use azithromycin or clindamycin.',
    evidence: 'High',
    source: 'Allergy practice parameter',
  },
  {
    id: 'benzodiazepine-antihistamine-major',
    classA: 'Benzodiazepine',
    classB: 'Antihistamine',
    direction: 'both',
    severity: 'major',
    mechanism: 'Additive central nervous system depression; first-generation antihistamines are particularly sedating.',
    clinicalEffect: 'Respiratory depression in the elderly and additive impairment of cognition and reaction time.',
    management: 'Avoid in patients over 65. If necessary, use a non-sedating antihistamine and the lowest benzodiazepine dose.',
    evidence: 'High',
    source: 'Beers criteria / STOPP-START',
  },
  {
    id: 'benzodiazepine-opioid-class-major',
    classA: 'Benzodiazepine',
    classB: 'Opioid analgesic',
    direction: 'both',
    severity: 'major',
    mechanism: 'Additive GABA-A and mu-opioid receptor-mediated respiratory depression.',
    clinicalEffect: 'Profound sedation, respiratory arrest and death.',
    management: 'Avoid. If unavoidable, titrate slowly, monitor respiration and avoid alcohol and other sedatives.',
    evidence: 'High — FDA boxed warning',
    source: 'FDA Drug Safety Communication',
  },
  {
    id: 'loop-thiazide-hyponatremia',
    classA: 'Thiazide',
    classB: 'Aldosterone antagonist',
    direction: 'both',
    severity: 'moderate',
    mechanism: 'Additive sodium loss and volume depletion.',
    clinicalEffect: 'Hyponatraemia, hypokalaemia and hypotension, especially in older adults.',
    management: 'Check sodium and potassium after initiation and with every dose change.',
    evidence: 'High',
    source: 'Clinical guidance',
  },
  {
    id: 'steroid-nsaid-cushing',
    classA: 'Topical corticosteroid',
    classB: 'NSAID',
    direction: 'both',
    severity: 'moderate',
    mechanism: 'Systemic absorption of topical corticosteroids combined with NSAID renal effects.',
    clinicalEffect: 'HPA axis suppression is amplified by NSAID-related reduction in steroid metabolism.',
    management: 'Limit potency and duration of topical steroid use; monitor for systemic effects in extensive use.',
    evidence: 'Moderate',
    source: 'Dermatology guidance',
  },
  {
    id: 'iron-quinone-minor',
    classA: 'Haematinic',
    classB: 'Antacid',
    direction: 'both',
    severity: 'minor',
    mechanism: 'Polyphenols and divalent cations chelate iron and reduce absorption.',
    clinicalEffect: 'Reduced iron absorption and lower haemoglobin response.',
    management: 'Separate iron from tea, coffee, milk and antacids by at least 2 hours.',
    evidence: 'Moderate',
    source: 'Nutritional guidance',
  },
  {
    id: 'macrolide-iron-chelation',
    classA: 'Macrolide',
    classB: 'Iron salt',
    direction: 'both',
    severity: 'minor',
    mechanism: 'Divalent and trivalent cations chelate many antibiotics, sharply reducing absorption.',
    clinicalEffect: 'Subtherapeutic antibiotic levels if taken together.',
    management: 'Separate oral antibiotic and iron doses by at least 2–3 hours.',
    evidence: 'High',
    source: 'Product information',
  },
  {
    id: 'insulin-beta-blocker-masking',
    classA: 'Long-acting insulin',
    classB: 'Beta blocker',
    direction: 'both',
    severity: 'moderate',
    mechanism: 'Beta blockade blunts adrenergic warning symptoms of hypoglycaemia (tremor, palpitations, anxiety).',
    clinicalEffect: 'Hypoglycaemia may present with sweating and confusion only, delaying recognition and treatment.',
    management: 'Use cardioselective agents where possible, reduce insulin doses, and educate the patient on neuroglycopenic warning signs.',
    evidence: 'High',
    source: 'Diabetes guidance',
  },
  {
    id: 'proton-pumpine-clopidogrel-class',
    classA: 'Proton pump inhibitor',
    classB: 'Antiplatelet (P2Y12 inhibitor)',
    direction: 'b-uses-a',
    severity: 'moderate',
    mechanism: 'CYP2C19 inhibition reduces conversion of clopidogrel to its active thiol metabolite.',
    clinicalEffect: 'Reduced antiplatelet efficacy; magnitude varies markedly by PPI (omeprazole and esomeprazole worst, pantoprazole least).',
    management: 'Prefer pantoprazole or rabeprazole, or dose the PPI 12 hours away from clopidogrel.',
    evidence: 'High',
    source: 'CPIC / COGENT',
  },
  {
    id: 'antihypertensive-inhaled-bronchodilator',
    classA: 'Beta blocker',
    classB: 'Short-acting beta-2 agonist',
    direction: 'both',
    severity: 'moderate',
    mechanism: 'Competitive antagonism at beta-2 receptors reduces bronchodilator efficacy.',
    clinicalEffect: 'Poor asthma control and increased reliever use.',
    management: 'Use bisoprolol at the lowest effective dose; never use non-selective beta blockers in asthma.',
    evidence: 'High',
    source: 'GINA / BTS guidance',
  },
];

function classOf(drug: Drug): string {
  return `${drug.class} ${drug.subClass ?? ''}`.toLowerCase();
}

function buildInteraction(rule: { mechanism: string; clinicalEffect: string; management: string; evidence: string; source: string }, severity: InteractionSeverity, a: Drug, b: Drug): DrugInteraction {
  return {
    severity,
    drugA: a.genericName,
    drugB: b.genericName,
    mechanism: rule.mechanism,
    clinicalEffect: rule.clinicalEffect,
    management: rule.management,
    evidence: rule.evidence,
    source: rule.source,
  };
}

/**
 * Evaluate a medication list for interactions.
 * Accepts free-text medication strings and/or catalog drug ids; unknown
 * entries are still compared by class when the string matches a class name.
 */
export function checkDrugInteractions(medications: readonly string[]): DrugInteraction[] {
  const resolved: Drug[] = [];
  for (const med of medications) {
    const d = resolveMedicationString(med) ?? DRUGS_BY_ID[med.trim().toLowerCase()];
    if (d && !resolved.some((r) => r.id === d.id)) resolved.push(d);
  }
  if (resolved.length < 2) return [];

  const found = new Map<string, DrugInteraction>();

  // Explicit pairs.
  for (const rule of PAIR_INTERACTION_RULES) {
    const [aId, bId] = rule.drugs;
    const a = resolved.find((d) => d.id === aId);
    const b = resolved.find((d) => d.id === bId);
    if (!a || !b) continue;
    const key = `${rule.id}`;
    found.set(key, buildInteraction(rule, rule.severity, a, b));
  }

  // Class rules.
  for (const rule of CLASS_INTERACTION_RULES) {
    for (let i = 0; i < resolved.length; i += 1) {
      for (let j = 0; j < resolved.length; j += 1) {
        if (i === j) continue;
        const a = resolved[i]!;
        const b = resolved[j]!;
        const ca = classOf(a);
        const cb = classOf(b);
        const applies =
          (rule.direction === 'a-uses-b' || rule.direction === 'both') && ca.includes(rule.classA.toLowerCase()) && cb.includes(rule.classB.toLowerCase());
        const appliesReverse =
          (rule.direction === 'b-uses-a' || rule.direction === 'both') && cb.includes(rule.classA.toLowerCase()) && ca.includes(rule.classB.toLowerCase());
        if (!applies && !appliesReverse) continue;
        if (rule.requires && rule.requires.length && !rule.requires.includes(b.id) && !rule.requires.includes(a.id)) continue;
        const first = applies ? a : b;
        const second = applies ? b : a;
        const key = `${rule.id}:${first.id}:${second.id}`;
        if (found.has(key)) continue;
        found.set(key, buildInteraction(rule, rule.severity, first, second));
      }
    }
  }

  return sortInteractions(mergeDuplicatePairs([...found.values()]));
}

/** Stable key for an unordered drug pair, so A+B and B+A collapse together. */
function pairKey(drugA: string, drugB: string): string {
  return [drugA.trim().toLowerCase(), drugB.trim().toLowerCase()].sort().join(' + ');
}

/**
 * Collapse findings that describe the same pair of drugs.
 *
 * A pair can legitimately be caught by more than one rule - an explicit pair
 * rule and a class rule often cover the same concern from different angles.
 * Showing the clinician the same interaction twice, with the drugs in opposite
 * order, trains people to ignore the alert, so the highest-severity finding is
 * kept and the distinct management advice from the others is folded into it.
 */
function mergeDuplicatePairs(list: readonly DrugInteraction[]): DrugInteraction[] {
  const byPair = new Map<string, DrugInteraction[]>();
  for (const item of list) {
    const key = pairKey(item.drugA, item.drugB);
    const bucket = byPair.get(key);
    if (bucket) bucket.push(item);
    else byPair.set(key, [item]);
  }

  const merged: DrugInteraction[] = [];
  for (const group of byPair.values()) {
    if (group.length === 1) {
      merged.push(group[0]!);
      continue;
    }
    const primary = sortInteractions(group)[0]!;
    const rest = group.filter((g) => g !== primary);
    merged.push({
      ...primary,
      clinicalEffect: joinUniqueSentences([primary.clinicalEffect, ...rest.map((g) => g.clinicalEffect)]),
      management: joinUniqueSentences([primary.management, ...rest.map((g) => g.management)]),
      source: joinUniqueParts([primary.source, ...rest.map((g) => g.source)]),
    });
  }
  return merged;
}

/**
 * Join prose fragments without repeating a sentence that is already present.
 * "Avoid the combination." plus "avoid the combination, and monitor" collapses
 * to one sentence, which is what a clinician wants to read.
 */
function joinUniqueSentences(parts: readonly string[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    for (const sentence of part.split(/(?<=\.)\s+/)) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;
      const normalised = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!normalised || seen.has(normalised)) continue;
      seen.add(normalised);
      kept.push(trimmed);
    }
  }
  return kept.join(' ');
}

/** Join short non-sentence fragments (source citations) with a separator. */
function joinUniqueParts(parts: readonly string[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim().replace(/[.;,\s]+$/, '');
    if (!trimmed) continue;
    const normalised = trimmed.toLowerCase();
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    kept.push(trimmed);
  }
  return kept.join('; ');
}

export const SEVERITY_RANK: Record<InteractionSeverity, number> = {
  contraindicated: 4,
  major: 3,
  moderate: 2,
  minor: 1,
};

export function sortInteractions(list: DrugInteraction[]): DrugInteraction[] {
  return [...list].sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]);
}

/** Highest severity present, or null when there are no findings. */
export function maxInteractionSeverity(list: readonly DrugInteraction[]): InteractionSeverity | null {
  if (!list.length) return null;
  return sortInteractions([...list])[0]!.severity;
}

export function countBySeverity(list: readonly DrugInteraction[]): Record<InteractionSeverity, number> {
  const out: Record<InteractionSeverity, number> = { contraindicated: 0, major: 0, moderate: 0, minor: 0 };
  for (const i of list) out[i.severity] += 1;
  return out;
}

export function blockingInteractions(list: readonly DrugInteraction[]): DrugInteraction[] {
  return list.filter((i) => i.severity === 'contraindicated' || i.severity === 'major');
}

/** All rules, for documentation and the in-app interaction reference. */
export function allInteractionRules(): { id: string; drugs: string[]; severity: InteractionSeverity; clinicalEffect: string }[] {
  const pair = PAIR_INTERACTION_RULES.filter((r) => r.drugs.every((d) => DRUGS_BY_ID[d] !== undefined)).map((r) => ({
    id: r.id,
    drugs: r.drugs.map((d) => DRUGS_BY_ID[d]?.genericName ?? d),
    severity: r.severity,
    clinicalEffect: r.clinicalEffect,
  }));
  const classRules = CLASS_INTERACTION_RULES.map((r) => ({
    id: r.id,
    drugs: [`Any ${r.classA}`, `Any ${r.classB}`],
    severity: r.severity,
    clinicalEffect: r.clinicalEffect,
  }));
  return [...pair, ...classRules];
}

export const INTERACTION_RULE_COUNT = PAIR_INTERACTION_RULES.length + CLASS_INTERACTION_RULES.length;
export const CATALOG_DRUG_COUNT = DRUG_CATALOG.length;

/**
 * Food, alcohol and supplement interactions.
 *
 * These are clinically serious - the metronidazole/alcohol reaction can be
 * genuinely dangerous - but they are not drug-drug interactions, so modelling
 * them as a class-pair rule can never work: there is no "alcohol drug" in the
 * catalog to match against. They are keyed by drug id instead and surfaced on
 * the prescribing and counselling screens.
 */
export interface SubstanceAdvisory {
  drugId: string;
  substance: string;
  severity: InteractionSeverity;
  effect: string;
  management: string;
  /** How long the restriction lasts after the last dose. */
  washoutAfterLastDoseHours: number | null;
  source: string;
}

export const SUBSTANCE_ADVISORIES: SubstanceAdvisory[] = [
  {
    drugId: 'metronidazole',
    substance: 'Alcohol (including ethanol in cough syrups and sauces)',
    severity: 'contraindicated',
    effect: 'Metronidazole inhibits hepatic aldehyde dehydrogenase, so acetaldehyde accumulates, causing severe flushing, tachycardia, nausea, vomiting and abdominal pain.',
    management: 'Absolute alcohol avoidance for the whole course and for 48 hours after the last dose. Counsel the patient explicitly, because this reaction is frequently not disclosed.',
    washoutAfterLastDoseHours: 48,
    source: 'Product information — labelled interaction',
  },
  {
    drugId: 'atorvastatin',
    substance: 'Grapefruit juice',
    severity: 'moderate',
    effect: 'Grapefruit inhibits intestinal CYP3A4, raising atorvastatin exposure and the risk of myopathy.',
    management: 'Advise avoiding large quantities (more than about a litre of juice daily). A small amount occasionally is not a concern.',
    washoutAfterLastDoseHours: null,
    source: 'Product information',
  },
  {
    drugId: 'ciprofloxacin',
    substance: 'Dairy, calcium, iron and antacids',
    severity: 'moderate',
    effect: 'Divalent and trivalent cations chelate the fluoroquinolone, sharply reducing absorption.',
    management: 'Take ciprofloxacin with water, two hours before or six hours after any antacid, calcium or iron preparation.',
    washoutAfterLastDoseHours: null,
    source: 'Product information',
  },
  {
    drugId: 'levothyroxine',
    substance: 'Calcium, iron, antacids, soya and high-fibre foods',
    severity: 'moderate',
    effect: 'Reduced absorption of levothyroxine, causing under-replacement and a rising TSH.',
    management: 'Separate by at least 4 hours and keep the timing consistent between doses.',
    washoutAfterLastDoseHours: null,
    source: 'Product information; ATA guidance',
  },
  {
    drugId: 'warfarin',
    substance: 'Vitamin K rich foods, NSAIDs and herbal preparations (St John\'s wort, ginkgo, garlic supplements)',
    severity: 'moderate',
    effect: 'Vitamin K intake changes the INR, and supplements with antiplatelet activity increase bleeding risk.',
    management: 'Keep vitamin K intake consistent rather than avoiding it, and check the INR after any change in diet or a new herbal product.',
    washoutAfterLastDoseHours: null,
    source: 'Product information; anticoagulation guidance',
  },
  {
    drugId: 'digoxin',
    substance: 'St John\'s wort, and hypokalaemia from diuretics or vomiting',
    severity: 'major',
    effect: 'St John\'s wort reduces digoxin levels, while hypokalaemia sensitises the myocardium and precipitates digoxin toxicity at therapeutic levels.',
    management: 'Avoid St John\'s wort. Monitor potassium and the digoxin level if vomiting or a new diuretic is introduced.',
    washoutAfterLastDoseHours: null,
    source: 'Product information',
  },
  {
    drugId: 'theophylline',
    substance: 'Caffeine, smoking, and febrile illness',
    severity: 'major',
    effect: 'Caffeine and smoking induce CYP1A2 and lower theophylline levels; stopping either, or a febrile illness, can push the level into toxicity.',
    management: 'Keep caffeine intake stable, tell the prescribing clinician if smoking changes, and seek advice during any fever.',
    washoutAfterLastDoseHours: null,
    source: 'Product information',
  },
  {
    drugId: 'carbamazepine',
    substance: 'Grapefruit juice',
    severity: 'moderate',
    effect: 'Grapefruit inhibits CYP3A4 and raises carbamazepine levels.',
    management: 'Avoid regular grapefruit juice while taking carbamazepine.',
    washoutAfterLastDoseHours: null,
    source: 'Product information',
  },
];

/** Advisories that apply to a single drug id. */
export function substanceAdvisoriesFor(drugId: string): SubstanceAdvisory[] {
  return SUBSTANCE_ADVISORIES.filter((a) => a.drugId === drugId);
}

/** Advisories for a whole medication list, worst first. */
export function substanceAdvisoriesForList(medications: readonly string[]): SubstanceAdvisory[] {
  const ids = new Set<string>();
  for (const med of medications) {
    const resolved = resolveMedicationString(med);
    if (resolved) ids.add(resolved.id);
    else ids.add(med.trim().toLowerCase());
  }
  return SUBSTANCE_ADVISORIES.filter((a) => ids.has(a.drugId)).sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
}

/**
 * Integrity check for the rule library.
 *
 * `allInteractionRules()` silently hides pair rules whose drugs are not in the
 * catalog, because such a rule can never fire. This reports them instead, so a
 * drug being renamed or dropped cannot quietly turn a safety rule into dead
 * code. Class rules are reported when neither class matches any catalog drug.
 */
export function validateInteractionLibrary(): {
  kind: 'pair' | 'class' | 'substance';
  ruleId: string;
  reason: string;
}[] {
  const problems: { kind: 'pair' | 'class' | 'substance'; ruleId: string; reason: string }[] = [];

  for (const rule of PAIR_INTERACTION_RULES) {
    const missing = rule.drugs.filter((d) => DRUGS_BY_ID[d] === undefined);
    if (missing.length) {
      problems.push({
        kind: 'pair',
        ruleId: rule.id,
        reason: `references drug(s) absent from the catalog: ${missing.join(', ')} - this rule can never fire`,
      });
    }
  }

  const catalogClassText = DRUG_CATALOG.map((d) => classOf(d));
  for (const rule of CLASS_INTERACTION_RULES) {
    const a = catalogClassText.some((c) => c.includes(rule.classA.toLowerCase()));
    const b = catalogClassText.some((c) => c.includes(rule.classB.toLowerCase()));
    if (!a || !b) {
      const dead = [!a ? rule.classA : null, !b ? rule.classB : null].filter(Boolean).join(', ');
      problems.push({
        kind: 'class',
        ruleId: rule.id,
        reason: `class(es) match no catalog drug: ${dead} - this rule can never fire`,
      });
    }
  }

  for (const advisory of SUBSTANCE_ADVISORIES) {
    if (DRUGS_BY_ID[advisory.drugId] === undefined) {
      problems.push({
        kind: 'substance',
        ruleId: `${advisory.drugId}/${advisory.substance}`,
        reason: `advisory references a drug absent from the catalog: ${advisory.drugId} - it can never be shown`,
      });
    }
  }

  return problems;
}

/** Rules that can never fire, summarised for the diagnostics panel. */
export function interactionLibraryStats(): {
  totalRules: number;
  reachablePairRules: number;
  reachableClassRules: number;
  substanceAdvisories: number;
  deadRules: number;
} {
  const problems = validateInteractionLibrary();
  const deadPair = new Set(problems.filter((p) => p.kind === 'pair').map((p) => p.ruleId));
  const deadClass = new Set(problems.filter((p) => p.kind === 'class').map((p) => p.ruleId));
  return {
    totalRules: INTERACTION_RULE_COUNT,
    reachablePairRules: PAIR_INTERACTION_RULES.length - deadPair.size,
    reachableClassRules: CLASS_INTERACTION_RULES.length - deadClass.size,
    substanceAdvisories: SUBSTANCE_ADVISORIES.length,
    deadRules: problems.length,
  };
}
