/**
 * Clinical decision support.
 *
 * Given a patient context and a working diagnosis, produce a structured
 * suggestion set: differential, drug regimen, interactions, allergy conflicts,
 * dosing adjustments, monitoring, investigations and red flags.
 *
 * This is the deterministic engine. It is the sole engine when no LLM is
 * configured, and it is the *validator* when one is: any LLM output is checked
 * against these rules and can never suppress a contraindication.
 */

import type { AlertSeverity, Specialty } from '../domain/enums.js';
import type { AllergyConflict, DecisionSupportResult, DrugInteraction, DrugSuggestion } from '../domain/types.js';
import { checkAllergyConflicts } from './allergies.js';
import { evaluateDosing, monitoringVitalsFor, type PatientClinicalContext } from './dosing.js';
import { getDrug, type Drug } from './drugs.js';
import { checkDrugInteractions, countBySeverity, sortInteractions } from './interactions.js';
import { CLINICAL_PROTOCOLS, matchProtocols, resolveRegimen, type ClinicalProtocol } from './protocols.js';

export const DECISION_SUPPORT_DISCLAIMER =
  'Clinical decision support output is generated from a curated protocol library and interaction rules. It is a decision aid only and must be reviewed, modified and confirmed by a qualified clinician before any prescription or clinical action is taken. It is not a diagnosis and must never be used as the sole basis for patient care.';

export interface DecisionSupportInput {
  /** Working diagnosis or free-text clinical impression. */
  diagnosis: string;
  context: PatientClinicalContext;
  /** Clinic specialty, used to rank protocols and drugs. */
  specialty?: Specialty;
  /** Additional conditions from the record, used to enrich the context. */
  knownConditions?: string[];
  /** Existing medications as free text or catalog ids. */
  currentMedications?: string[];
  /** Maximum number of drug suggestions. */
  maxSuggestions?: number;
  /** Candidate drugs to safety-screen (e.g. an AI proposal). */
  candidateDrugIds?: string[];
  /** Whether the patient is known to be pregnant. */
  isPregnant?: boolean;
}

export interface DecisionSupportOptions {
  /** Suppress drugs with a critical contraindication (default true). */
  excludeContraindicated?: boolean;
  /** Suppress drugs with a major or worse interaction with current meds. */
  excludeInteractionBlocked?: boolean;
  /** Include drugs whose role is 'rescue' or 'adjunct'. */
  includeAdjuncts?: boolean;
  /** Reason recorded in `contextUsed` for auditability. */
  label?: string;
}

/** Rules-based engine. Deterministic, offline, auditable. */
export function runRuleBasedDecisionSupport(
  input: DecisionSupportInput,
  options: DecisionSupportOptions = {},
): DecisionSupportResult {
  const opts: Required<DecisionSupportOptions> = {
    excludeContraindicated: options.excludeContraindicated ?? true,
    excludeInteractionBlocked: options.excludeInteractionBlocked ?? true,
    includeAdjuncts: options.includeAdjuncts ?? true,
    label: options.label ?? 'rules-engine',
  };

  const context: PatientClinicalContext = {
    ...input.context,
    currentMedications: input.currentMedications ?? input.context.currentMedications,
    isPregnant: input.isPregnant ?? input.context.isPregnant,
  };

  const specialties = input.specialty ? [input.specialty] : undefined;
  const matches = matchProtocols(input.diagnosis, { specialties, limit: 3 });
  const contextUsed: string[] = [
    `Diagnosis input: "${input.diagnosis}"`,
    `Age: ${context.ageYears ?? 'unknown'}`,
    `Sex: ${context.sex}`,
    `Allergies: ${context.allergies.length ? context.allergies.join(', ') : 'none recorded'}`,
    `Current medications: ${context.currentMedications.length}`,
  ];

  // ---- Differential
  const differential = matches.map((m) => ({
    title: m.protocol.condition,
    icdCode: m.protocol.icdCode,
    score: Math.min(100, Math.round(m.score)),
    supportingFeatures: m.matchedTerms,
  }));

  // If no protocol matched, fall back to any condition present in the record.
  let protocols: ClinicalProtocol[] = matches.map((m) => m.protocol);
  if (!protocols.length) {
    protocols = CLINICAL_PROTOCOLS.filter((p) =>
      (input.knownConditions ?? []).some((c) => p.condition.toLowerCase().includes(c.toLowerCase()) || c.toLowerCase().includes(p.condition.toLowerCase().split(' ')[0]!)),
    ).slice(0, 2);
    if (protocols.length) contextUsed.push(`Matched from existing record conditions: ${protocols.map((p) => p.condition).join(', ')}`);
  } else {
    contextUsed.push(`Protocol match: ${protocols.map((p) => `${p.condition} (score ${m_score(matches, p.id)})`).join(', ')}`);
  }

  // ---- Candidate drugs
  const candidateIds = new Set<string>();
  for (const p of protocols) {
    for (const { option } of resolveRegimen(p.regimen)) {
      if (!opts.includeAdjuncts && (option.role === 'adjunct' || option.role === 'rescue')) continue;
      candidateIds.add(option.drugId);
    }
  }
  for (const id of input.candidateDrugIds ?? []) {
    if (getDrug(id)) candidateIds.add(id);
  }

  // ---- Allergy screening across the whole candidate set
  const candidateDrugs = [...candidateIds].map((id) => getDrug(id)).filter((d): d is Drug => Boolean(d));
  const allergyConflicts = checkAllergyConflicts(context.allergies, candidateDrugs);
  const blockedByAllergy = new Set(
    allergyConflicts.filter((c) => c.severity === 'contraindicated').map((c) => c.drugId),
  );

  // ---- Build suggestions
  const suggestions: DrugSuggestion[] = [];
  const contraindicationNotes: string[] = [];
  const dosingAdjustments: DecisionSupportResult['dosingAdjustments'] = [];

  for (const drug of candidateDrugs) {
    if (blockedByAllergy.has(drug.id) && opts.excludeContraindicated) {
      const conflict = allergyConflicts.find((c) => c.drugId === drug.id);
      if (conflict) {
        contraindicationNotes.push(`Excluded ${drug.genericName}: ${conflict.advice}`);
      }
      continue;
    }

    const { adjustments, contraindications } = evaluateDosing(drug, context);
    for (const adj of adjustments) {
      dosingAdjustments.push({ drugId: adj.drugId, drugName: adj.drugName, note: adj.note, severity: adj.severity });
    }
    for (const contra of contraindications) {
      contraindicationNotes.push(`${contra.drugName}: ${contra.reason}`);
    }
    if (contraindications.length && opts.excludeContraindicated) {
      continue;
    }

    // Interactions of this candidate with what the patient is already taking.
    const newMeds = context.currentMedications.filter((m) => getDrug(m) || m);
    const interactions = checkDrugInteractions([...newMeds, drug.genericName]);
    const selfRelated = interactions.filter((i) => i.drugA === drug.genericName || i.drugB === drug.genericName);
    const blocking = selfRelated.filter((i) => i.severity === 'contraindicated' || i.severity === 'major');
    if (blocking.length && opts.excludeInteractionBlocked) {
      for (const b of blocking) {
        contraindicationNotes.push(`Excluded ${drug.genericName}: ${b.severity} interaction with ${b.drugA === drug.genericName ? b.drugB : b.drugA} — ${b.management}`);
      }
      continue;
    }

    // Protocol rationale, if this drug came from a protocol.
    let rationale = drug.indication;
    let indication = drug.indication;
    for (const p of protocols) {
      for (const { option } of resolveRegimen(p.regimen)) {
        if (option.drugId === drug.id) {
          rationale = option.rationale;
          indication = `${p.condition} — ${option.role.replace('_', ' ')}`;
          break;
        }
      }
    }

    suggestions.push({
      drugId: drug.id,
      genericName: drug.genericName,
      brandNames: drug.brandNames.slice(0, 3),
      class: drug.class,
      strength: drug.strengths[0]?.label ?? '',
      dose: drug.typicalDose,
      frequency: drug.frequency,
      durationDays: drug.durationDays,
      route: drug.route,
      indication,
      rationale,
      renalCaution: drug.renalCaution,
      hepaticCaution: drug.hepaticCaution,
      monitoring: drug.monitoring,
      contraindications: drug.contraindications,
      interactionCount: selfRelated.length,
      maxDose: drug.maxDose,
    });
  }

  // ---- Interactions among the patient's whole medication list
  const allInteractions = sortInteractions(checkDrugInteractions(context.currentMedications));

  // ---- Monitoring
  const monitoring: DecisionSupportResult['monitoring'] = [];
  const seen = new Set<string>();
  for (const p of protocols) {
    for (const m of p.monitoring) {
      const key = `${p.id}:${m.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      monitoring.push({ label: m.label, frequency: m.frequency, reason: m.reason, kind: m.kind });
    }
  }
  for (const drug of candidateDrugs.slice(0, 6)) {
    for (const m of monitoringVitalsFor(drug)) {
      const key = `drug:${m.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      monitoring.push({ label: m.label, frequency: m.frequency, reason: m.reason, kind: m.kind });
    }
  }

  // ---- Investigations and red flags
  const investigations = dedupeStrings(protocols.flatMap((p) => p.investigations)).slice(0, 12);
  const redFlags = dedupeStrings(protocols.flatMap((p) => p.redFlags));
  const guidelineRefs = dedupeBy(
    protocols.flatMap((p) => p.guidelineRefs),
    (r) => r.title,
  );
  const lifestyle = dedupeStrings(protocols.flatMap((p) => p.lifestyle)).slice(0, 8);
  if (lifestyle.length) contextUsed.push('Lifestyle counselling available from matched protocols');

  // Escalate the overall severity from any critical contraindication.
  const criticalAdjustment = dosingAdjustments.some((a) => a.severity === 'critical');
  if (criticalAdjustment) {
    contextUsed.push('CRITICAL: at least one proposed drug requires dose adjustment or avoidance');
  }

  const maxSuggestions = input.maxSuggestions ?? 8;
  const ordered = suggestions.slice(0, maxSuggestions);

  return {
    differential,
    suggestedRegimen: ordered,
    interactions: allInteractions,
    allergyConflicts,
    contraindicationNotes: dedupeStrings(contraindicationNotes).slice(0, 20),
    dosingAdjustments: dedupeBy(dosingAdjustments, (a) => `${a.drugId}:${a.note}`).slice(0, 20),
    monitoring: monitoring.slice(0, 15),
    requiredInvestigations: investigations,
    redFlags,
    guidelineRefs,
    requiresClinicianReview: true,
    generatedBy: 'rules',
    model: null,
    disclaimer: DECISION_SUPPORT_DISCLAIMER,
    contextUsed,
  };
}

function m_score(matches: { protocol: ClinicalProtocol; score: number }[], id: string): number {
  return matches.find((m) => m.protocol.id === id)?.score ?? 0;
}

function dedupeStrings(items: readonly string[]): string[] {
  return [...new Set(items.filter((s) => s && s.trim().length > 0))];
}

function dedupeBy<T>(items: readonly T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Severity summary used for the alert banner in the UI. */
export function summariseDecisionSupport(result: DecisionSupportResult): {
  severity: AlertSeverity;
  headline: string;
  counts: { interactions: number; majorInteractions: number; contraindications: number; criticalAdjustments: number; allergies: number };
} {
  const interactionCounts = countBySeverity(result.interactions);
  const major = interactionCounts.contraindicated + interactionCounts.major;
  const criticalAdjustments = result.dosingAdjustments.filter((a) => a.severity === 'critical').length;
  const contraindicatedAllergies = result.allergyConflicts.filter((c) => c.severity === 'contraindicated').length;

  let severity: AlertSeverity = 'info';
  const reasons: string[] = [];
  if (contraindicatedAllergies > 0) {
    severity = 'critical';
    reasons.push(`${contraindicatedAllergies} allergy contraindication${contraindicatedAllergies > 1 ? 's' : ''}`);
  }
  if (criticalAdjustments > 0) {
    severity = 'critical';
    reasons.push(`${criticalAdjustments} critical dose adjustment${criticalAdjustments > 1 ? 's' : ''}`);
  }
  if (interactionCounts.contraindicated > 0) {
    severity = 'critical';
    reasons.push(`${interactionCounts.contraindicated} contraindicated drug interaction`);
  }
  if (major > 0) {
    if (severity !== 'critical') severity = 'warning';
    reasons.push(`${major} significant interaction${major > 1 ? 's' : ''}`);
  }
  if (result.contraindicationNotes.length > 0 && severity === 'info') {
    severity = 'warning';
    reasons.push(`${result.contraindicationNotes.length} safety note${result.contraindicationNotes.length > 1 ? 's' : ''}`);
  }

  return {
    severity,
    headline: reasons.length ? reasons.join(' · ') : 'No significant safety findings',
    counts: {
      interactions: result.interactions.length,
      majorInteractions: major,
      contraindications: result.contraindicationNotes.length,
      criticalAdjustments,
      allergies: result.allergyConflicts.length,
    },
  };
}

/**
 * Merge an AI-proposed result with the deterministic safety screen.
 * The AI may add narrative and rank options, but it can never remove a
 * contraindication, interaction or red flag found by the rules engine.
 */
export function mergeWithSafetyScreen(
  aiResult: DecisionSupportResult,
  ruleResult: DecisionSupportResult,
): DecisionSupportResult {
  const bannedDrugs = new Set(
    ruleResult.allergyConflicts
      .filter((c) => c.severity === 'contraindicated')
      .map((c) => c.drugId),
  );
  const criticalDoses = new Set(
    ruleResult.dosingAdjustments.filter((a) => a.severity === 'critical').map((a) => a.drugId),
  );

  const safeRegimen = aiResult.suggestedRegimen.filter((s) => !bannedDrugs.has(s.drugId));

  const removedForAllergy = aiResult.suggestedRegimen.filter((s) => bannedDrugs.has(s.drugId));
  const removedForDose = safeRegimen.filter((s) => criticalDoses.has(s.drugId));

  return {
    ...aiResult,
    suggestedRegimen: safeRegimen.filter((s) => !criticalDoses.has(s.drugId)),
    interactions: sortInteractions([
      ...ruleResult.interactions,
      ...aiResult.interactions,
    ]),
    allergyConflicts: ruleResult.allergyConflicts.length ? ruleResult.allergyConflicts : aiResult.allergyConflicts,
    contraindicationNotes: dedupeStrings([
      ...ruleResult.contraindicationNotes,
      ...aiResult.contraindicationNotes,
      ...removedForAllergy.map((s) => `AI proposed ${s.genericName}, which the allergy screen excluded.`),
      ...removedForDose.map((s) => `AI proposed ${s.genericName}, which requires a critical dose adjustment for this patient.`),
    ]).slice(0, 25),
    dosingAdjustments: ruleResult.dosingAdjustments.length ? ruleResult.dosingAdjustments : aiResult.dosingAdjustments,
    requiredInvestigations: dedupeStrings([...aiResult.requiredInvestigations, ...ruleResult.requiredInvestigations]).slice(0, 15),
    redFlags: dedupeStrings([...aiResult.redFlags, ...ruleResult.redFlags]),
    monitoring: dedupeBy([...aiResult.monitoring, ...ruleResult.monitoring], (m) => m.label).slice(0, 18),
    guidelineRefs: dedupeBy([...aiResult.guidelineRefs, ...ruleResult.guidelineRefs], (g) => g.title),
    generatedBy: aiResult.generatedBy === 'rules' ? 'rules' : 'hybrid',
    requiresClinicianReview: true,
    disclaimer: DECISION_SUPPORT_DISCLAIMER,
  };
}

/** Convenience for the API: run the rules engine for a list of candidate drugs. */
export function screenCandidateDrugs(
  drugIds: readonly string[],
  context: PatientClinicalContext,
): {
  approved: { drug: Drug; adjustments: ReturnType<typeof evaluateDosing>['adjustments'] }[];
  blocked: { drug: Drug; reasons: string[] }[];
  interactions: DrugInteraction[];
  allergyConflicts: AllergyConflict[];
} {
  const approved: { drug: Drug; adjustments: ReturnType<typeof evaluateDosing>['adjustments'] }[] = [];
  const blocked: { drug: Drug; reasons: string[] }[] = [];
  const meds = context.currentMedications;

  const drugObjects = drugIds.map((id) => getDrug(id)).filter((d): d is Drug => Boolean(d));
  const allergyConflicts = checkAllergyConflicts(context.allergies, drugObjects);

  for (const drug of drugObjects) {
    const reasons: string[] = [];
    const { adjustments, contraindications } = evaluateDosing(drug, context);
    for (const c of contraindications) reasons.push(c.reason);

    for (const conflict of allergyConflicts.filter((c) => c.drugId === drug.id)) {
      if (conflict.severity === 'contraindicated') reasons.push(conflict.advice);
    }

    const interactions = checkDrugInteractions([...meds, drug.genericName]).filter(
      (i) => i.drugA === drug.genericName || i.drugB === drug.genericName,
    );
    for (const i of interactions.filter((x) => x.severity === 'contraindicated' || x.severity === 'major')) {
      reasons.push(`${i.severity} interaction with ${i.drugA === drug.genericName ? i.drugB : i.drugA}: ${i.management}`);
    }

    if (reasons.length) blocked.push({ drug, reasons });
    else approved.push({ drug, adjustments });
  }

  return {
    approved,
    blocked,
    interactions: checkDrugInteractions(meds),
    allergyConflicts,
  };
}
