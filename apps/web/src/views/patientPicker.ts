/**
 * Patient autocomplete for raw patient-id inputs.
 *
 * Typing an id from memory is how scans end up on the wrong chart, so these
 * fields search by name instead: type two letters, pick the patient from the
 * list, and the form submits the real id. A typed-but-unpicked value submits
 * nothing - the form must refuse it loudly rather than guessing.
 */

import { patientsList } from '../data.js';
import { t } from '../i18n.js';
import { errorText, esc } from '../ui.js';

export interface PickedPatient {
  id: string;
  fullName: string;
  phone: string;
  mrn: string;
}

export function attachPatientPicker(input: HTMLInputElement, onPick: (patient: PickedPatient | null) => void): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'picker';
  input.replaceWith(wrapper);
  wrapper.appendChild(input);
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('placeholder', input.getAttribute('placeholder') ?? t('typeAName'));

  const list = document.createElement('div');
  list.className = 'picker-list';
  list.hidden = true;
  wrapper.appendChild(list);

  let timer: number | undefined;
  let pickedId: string | null = null;

  const close = (): void => {
    list.hidden = true;
    list.innerHTML = '';
  };

  input.addEventListener('input', () => {
    pickedId = null;
    onPick(null);
    window.clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      close();
      return;
    }
    timer = window.setTimeout(() => {
      patientsList(q)
        .then((items) => {
          if (input.value.trim() !== q) return; // typed on meanwhile
          if (items.length === 0) {
            list.innerHTML = `<div class="picker-empty">${esc(t('noRegisteredMatch'))}</div>`;
            list.hidden = false;
            return;
          }
          list.innerHTML = items
            .slice(0, 8)
            .map(
              (p) =>
                `<button type="button" data-id="${esc(p.id)}" data-name="${esc(p.fullName)}" data-phone="${esc(p.phone)}" data-mrn="${esc(p.mrn)}">
                  <strong>${esc(p.fullName)}</strong>
                  <span class="muted">MRN ${esc(p.mrn)} · <span dir="ltr">${esc(p.phone)}</span></span>
                </button>`,
            )
            .join('');
          list.hidden = false;
          list.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach((button) => {
            button.addEventListener('click', () => {
              pickedId = button.dataset.id ?? null;
              input.value = button.dataset.name ?? '';
              close();
              onPick(
                pickedId
                  ? {
                      id: pickedId,
                      fullName: button.dataset.name ?? '',
                      phone: button.dataset.phone ?? '',
                      mrn: button.dataset.mrn ?? '',
                    }
                  : null,
              );
            });
          });
        })
        .catch((error: unknown) => {
          list.innerHTML = `<div class="picker-empty">${esc(errorText(error))}</div>`;
          list.hidden = false;
        });
    }, 250);
  });

  input.addEventListener('blur', () => {
    // Let a suggestion click land before closing.
    window.setTimeout(close, 150);
  });
}

/** Read the picked id, or throw a human message when nothing was picked. */
export function requirePicked(input: HTMLInputElement, picked: PickedPatient | null): string {
  void input;
  if (!picked) throw new Error(t('pickPatientError'));
  return picked.id;
}
