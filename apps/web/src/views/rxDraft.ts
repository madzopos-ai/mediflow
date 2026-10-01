/**
 * Prescription draft: predictions the doctor picked, manual items, and plan
 * lines accumulate here until saved as a prescription. Per patient, local to
 * the device - a draft is intent, not a medical record, until saved.
 */

import type { UiPrescriptionItem } from '../data.js';

export interface RxDraft {
  items: UiPrescriptionItem[];
  diet: string[];
  exercise: string[];
  notes: string;
}

const KEY = (patientId: string): string => `mf_rx_${patientId}`;

export function emptyDraft(): RxDraft {
  return { items: [], diet: [], exercise: [], notes: '' };
}

export function loadDraft(patientId: string): RxDraft {
  try {
    const raw = localStorage.getItem(KEY(patientId));
    if (!raw) return emptyDraft();
    const parsed = JSON.parse(raw) as Partial<RxDraft>;
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      diet: Array.isArray(parsed.diet) ? parsed.diet.filter((x): x is string => typeof x === 'string') : [],
      exercise: Array.isArray(parsed.exercise)
        ? parsed.exercise.filter((x): x is string => typeof x === 'string')
        : [],
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
    };
  } catch {
    return emptyDraft();
  }
}

export function saveDraft(patientId: string, draft: RxDraft): void {
  localStorage.setItem(KEY(patientId), JSON.stringify(draft));
}

export function clearDraft(patientId: string): void {
  localStorage.removeItem(KEY(patientId));
}

export function addItem(patientId: string, item: UiPrescriptionItem): RxDraft {
  const draft = loadDraft(patientId);
  draft.items.push(item);
  saveDraft(patientId, draft);
  return draft;
}
