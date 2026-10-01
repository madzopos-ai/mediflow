/**
 * Allergy cross-reactivity and contraindication screening.
 *
 * A recorded allergy is free text ("penicillin", "PCN allergy", "sulfa drugs").
 * This module maps those strings onto drug classes and flags any suggested drug
 * that shares a beta-lactam or sulfonamide core with the recorded allergen.
 */

import type { AllergyConflict } from '../domain/types.js';
import type { Drug } from './drugs.js';
import { resolveMedicationString } from './drugs.js';

interface AllergyClassRule {
  /** Canonical allergen key. */
  allergen: string;
  /** Substrings matched against the recorded allergy text. */
  aliases: string[];
  /** Drug classes that cross-react. */
  crossReactiveClasses: string[];
  /** Classes that are safe to use (used for the "not a real cross-reaction" note). */
  toleratedClasses: string[];
  crossReactivity: string;
  advice: string;
  severity: AllergyConflict['severity'];
}

export const ALLERGY_RULES: AllergyClassRule[] = [
  {
    allergen: 'penicillin',
    aliases: ['penicillin', 'penicillins', 'pcn', 'pen', 'augmentin', 'amoxil', 'amoxicillin', 'clavulanate', 'pip-tazo'],
    crossReactiveClasses: ['penicillin antibiotic'],
    toleratedClasses: ['cephalosporin antibiotic', 'monobactam'],
    crossReactivity:
      'Overall cross-reactivity between penicillins and cephalosporins is about 2%, but it rises to roughly 10–15% with first-generation cephalosporins whose R1 side chain resembles ampicillin/amoxicillin.',
    advice:
      'If the recorded reaction was anaphylaxis, urticaria or angioedema, avoid cephalosporins and use a non-beta-lactam such as azithromycin or clindamycin. If the reaction was a childhood rash only, cefuroxime is generally acceptable with observation.',
    severity: 'major',
  },
  {
    allergen: 'cephalosporin',
    aliases: ['cephalosporin', 'cephalexin', 'ceftriaxone', 'cefixime', 'cefuroxime', 'cefaclor', 'cefuroxime', 'cefazolin', 'ceftazidime'],
    crossReactiveClasses: ['cephalosporin antibiotic', 'penicillin antibiotic'],
    toleratedClasses: ['carbapenem', 'monobactam'],
    crossReactivity:
      'Cross-reactivity between cephalosporins and penicillins is driven by the R1 side chain rather than the shared beta-lactam ring. Carbapenems cross-react in under 1%.',
    advice: 'Carbapenems (meropenem) are usually tolerated in cephalosporin allergy. Monobactams cross-react with ceftazidime but not with other cephalosporins.',
    severity: 'major',
  },
  {
    allergen: 'sulfonamide',
    aliases: ['sulfa', 'sulfonamide', 'sulphamide', 'co-trimoxazole', 'trimethoprim', 'sulfamethoxazole', 'bactrim', 'septrin'],
    crossReactiveClasses: ['sulfonamide', 'thiazide', 'carbonic anhydrase inhibitor'],
    toleratedClasses: ['sulfonylurea'],
    crossReactivity:
      'Immunologic cross-reactivity between non-antibiotic sulfonamides and sulfonamide antibiotics is very low (under 2%) despite structural similarity. The clinically important reaction is with the same antibiotic class.',
    advice:
      'A patient allergic to co-trimoxazole can usually receive a thiazide diuretic and sulfonylurea safely, but should avoid other sulfonamide antibiotics. If the reaction was severe, involve pharmacy before prescribing.',
    severity: 'moderate',
  },
  {
    allergen: 'aspirin',
    aliases: ['aspirin', 'asa', 'acetylsalicylic', 'bayer'],
    crossReactiveClasses: ['NSAID'],
    toleratedClasses: ['Para-aminophenol'],
    crossReactivity:
      'Aspirin-exacerbated respiratory disease means all COX-1 inhibitors — ibuprofen, naproxen, diclofenac — trigger bronchospasm in sensitive patients.',
    advice: 'Use paracetamol at standard doses. COX-2 selective agents are usually tolerated if a non-aspirin NSAID is required. Refer if there is a history of asthma or nasal polyps.',
    severity: 'major',
  },
  {
    allergen: 'nsaid',
    aliases: ['nsaid', 'ibuprofen', 'brufen', 'nurofen', 'diclofenac', 'voltaren', 'naproxen', 'aleve', 'aspirin-exacerbated'],
    crossReactiveClasses: ['NSAID'],
    toleratedClasses: ['Para-aminophenol'],
    crossReactivity: 'Cross-reactivity among non-aspirin NSAIDs is about 70% in asthmatics who react to aspirin.',
    advice: 'Switch to paracetamol; if an NSAID is essential, trial a COX-2 selective agent under supervision.',
    severity: 'major',
  },
  {
    allergen: 'morphine',
    aliases: ['morphine', 'opiate allergy', 'opioid allergy', 'codeine', 'morphine sulfate'],
    crossReactiveClasses: ['Opioid analgesic'],
    toleratedClasses: [],
    crossReactivity:
      'Allergy to one opioid is not reliably predictive for another, but products sharing histamine release (morphine, meperidine) cause more pseudoallergy.',
    advice: 'Use a different opioid class such as hydromorphone or oxycodone and monitor closely for the first dose.',
    severity: 'moderate',
  },
  {
    allergen: 'iodine',
    aliases: ['iodine', 'iodinated contrast', 'contrast allergy', 'contrast dye', 'iodocontrast'],
    crossReactiveClasses: [],
    toleratedClasses: [],
    crossReactivity: 'There is no cross-reactivity between iodinated contrast and shellfish or iodine allergy.',
    advice: 'Pre-medicate with antihistamine and corticosteroid and use low-osmolar non-ionic contrast; radiology protocols apply.',
    severity: 'moderate',
  },
  {
    allergen: 'latex',
    aliases: ['latex', 'rubber allergy', 'latex allergy'],
    crossReactiveClasses: [],
    toleratedClasses: [],
    crossReactivity: 'No drug cross-reactivity.',
    advice: 'Use latex-free equipment. Propofol, pancuronium and some catheter materials are also latex associated.',
    severity: 'moderate',
  },
  {
    allergen: 'macrolide',
    aliases: ['macrolide', 'erythromycin', 'azithromycin', 'clarithromycin', 'azithral'],
    crossReactiveClasses: ['Macrolide'],
    toleratedClasses: [],
    crossReactivity: 'IntRA-class cross-reactivity is high because of the shared macrolide lactone ring.',
    advice: 'Use a non-macrolide antibiotic such as doxycycline or amoxicillin.',
    severity: 'major',
  },
  {
    allergen: 'vancomycin',
    aliases: ['vancomycin', 'vancomycin allergy', 'vanc'],
    crossReactiveClasses: ['Glycopeptide'],
    toleratedClasses: [],
    crossReactivity: 'True allergy is uncommon; infusion reactions are frequently confused with allergy.',
    advice: 'Distinguish infusion reaction (red man syndrome, rate-related, responds to slowing the infusion) from IgE-mediated allergy.',
    severity: 'moderate',
  },
  {
    allergen: 'statins',
    aliases: ['statin', 'statins', 'atorvastatin', 'simvastatin', 'lipitor', 'myopathy'],
    crossReactiveClasses: ['Statin'],
    toleratedClasses: [],
    crossReactivity: 'Statin intolerance is usually class-wide for myopathy, but some patients tolerate lower doses or hydrophilic agents.',
    advice: 'Trial a lower dose, an alternate-day schedule, or a hydrophilic statin such as rosuvastatin or pravastatin.',
    severity: 'moderate',
  },
  {
    allergen: 'clavulanate',
    aliases: ['clavulanic acid', 'clavulanate', 'augmentin allergy', 'augmentin'],
    crossReactiveClasses: ['Penicillin antibiotic with beta-lactamase inhibitor'],
    toleratedClasses: ['Penicillin antibiotic', 'cephalosporin antibiotic'],
    crossReactivity: 'Clavulanate-specific reactions are rare and usually mild; most reactions are to the amoxicillin component.',
    advice: 'Use plain amoxicillin or cefuroxime if the reaction was mild; if severe, use azithromycin.',
    severity: 'moderate',
  },
];

function normalizeAllergen(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\ballergy\b|\ballergic\b|\bintolerance\b|\breaction\b|\bsensitivity\b/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchAllergyRule(allergyText: string): AllergyClassRule | null {
  const normalized = normalizeAllergen(allergyText);
  if (!normalized) return null;
  let best: { rule: AllergyClassRule; score: number } | null = null;
  for (const rule of ALLERGY_RULES) {
    for (const alias of rule.aliases) {
      if (normalized.includes(alias) && (!best || alias.length > best.score)) {
        best = { rule, score: alias.length };
      }
    }
  }
  return best?.rule ?? null;
}

function drugClassMatches(drug: Drug, className: string): boolean {
  const target = className.toLowerCase();
  const drugClass = `${drug.class} ${drug.subClass ?? ''}`.toLowerCase();
  if (drugClass.includes(target)) return true;
  // "sulfonamide" should not match a sulfonylurea, and vice versa.
  if (target === 'sulfonamide') return drugClass.includes('sulfonamide');
  return false;
}

/**
 * Screen a set of suggested drugs against the patient's recorded allergies.
 * Direct matches (same drug) are always reported as contraindicated-ish.
 */
export function checkAllergyConflicts(
  allergies: readonly string[],
  drugs: readonly (Drug | string)[],
): AllergyConflict[] {
  if (!allergies.length || !drugs.length) return [];
  const conflicts: AllergyConflict[] = [];

  for (const allergy of allergies) {
    const rule = matchAllergyRule(allergy);
    for (const item of drugs) {
      const drug = typeof item === 'string' ? resolveMedicationString(item) : item;
      if (!drug) continue;

      // 1. Direct name match — the strongest signal.
      const normalizedAllergy = normalizeAllergen(allergy);
      const isDirectName =
        drug.genericName.toLowerCase().includes(normalizedAllergy) ||
        drug.brandNames.some((b) => b.toLowerCase().includes(normalizedAllergy)) ||
        drug.class.toLowerCase().includes(normalizedAllergy);
      if (isDirectName) {
        conflicts.push({
          severity: 'contraindicated',
          drugId: drug.id,
          drugName: drug.genericName,
          allergen: allergy,
          class: drug.class,
          crossReactivity: 'The patient has recorded a direct allergy to this drug.',
          advice: `Do not prescribe ${drug.genericName}. Document the reaction and select an alternative class.`,
        });
        continue;
      }

      if (!rule) continue;
      const hits = rule.crossReactiveClasses.filter((c) => drugClassMatches(drug, c));
      if (hits.length) {
        const tolerated = rule.toleratedClasses.some((c) => drugClassMatches(drug, c));
        conflicts.push({
          severity: tolerated ? 'moderate' : rule.severity,
          drugId: drug.id,
          drugName: drug.genericName,
          allergen: allergy,
          class: drug.class,
          crossReactivity: rule.crossReactivity,
          advice: tolerated
            ? `${rule.advice} ${drug.genericName} belongs to a class that is generally tolerated, so it may be acceptable — document the discussion.`
            : `${rule.advice} ${drug.genericName} is a ${hits[0]} and should be avoided or used only after specialist review.`,
        });
      }
    }
  }

  return conflicts.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function severityRank(s: AllergyConflict['severity']): number {
  return s === 'contraindicated' ? 3 : s === 'major' ? 2 : 1;
}

export function hasContraindicatedAllergy(conflicts: readonly AllergyConflict[]): boolean {
  return conflicts.some((c) => c.severity === 'contraindicated');
}

export function formatAllergyList(allergies: readonly string[]): string {
  return allergies.length ? allergies.join(', ') : 'None recorded';
}
