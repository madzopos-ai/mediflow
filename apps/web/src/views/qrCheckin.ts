/**
 * Patient QR quick check-in.
 *
 * The patient shows their code at the front desk, the desk scans it, and the
 * matching appointment is marked checked in. The scan resolves the patient
 * inside the signed-in clinic's own scope, so a code from another clinic reads
 * as an unknown patient rather than someone else's record.
 *
 * Two deliberate guards:
 *   - Nothing is marked arrived from the decode alone. A confirmation card shows
 *     the name and time first, because a mis-scan at a busy desk is otherwise
 *     invisible until the patient is already in the wrong room.
 *   - `apptTransition` only ever moves an appointment forward, and only that
 *     single field. The check-in reuses the existing transition rather than
 *     writing appointment status itself.
 */

import {
  apptTodayForPatient,
  apptTransition,
  patientsList,
  type UiAppointment,
  type UiPatient,
} from '../data.js';
import { errorText, esc, fmtDateTime, toast } from '../ui.js';
import { getLang, statusLabel, t } from '../i18n.js';
import { decodeQrFromImage, parsePatientQr, patientQrPayload } from '../patientQr.js';

interface ScanOutcome {
  patient: UiPatient;
  appointment: UiAppointment | null;
}

export function checkinHtml(root: HTMLElement): void {
  root.innerHTML = `
    <section class="card">
      <h2>${esc(t('patientQr'))}</h2>
      <p class="muted">${esc(t('patientQrHint'))}</p>
      <form id="qr-form" class="grid-form">
        <label>${esc(t('qrImage'))}
          <input name="photo" type="file" accept="image/*" capture="environment" required />
        </label>
        <button class="primary" type="submit">${esc(t('findPatient'))}</button>
      </form>
      <div id="qr-out"><p class="muted">${esc(t('qrNoResult'))}</p></div>
    </section>
    <section class="card">
      <h2>${esc(t('patientQrMine'))}</h2>
      <p class="muted">${esc(t('patientQrMineHint'))}</p>
      <div class="grid-form">
        <label>${esc(t('patientQrId'))}
          <input name="patientId" type="text" dir="ltr" placeholder="MF1:…" />
        </label>
        <button id="qr-open" type="button">${esc(t('show'))}</button>
      </div>
      <div class="row"><button id="qr-show" type="button">${esc(t('showQrCode'))}</button></div>
      <div id="qr-canvas"></div>
    </section>`;

  const out = root.querySelector('#qr-out') as HTMLElement;
  const form = root.querySelector('#qr-form') as HTMLFormElement | null;

  const lookup = (raw: string, patientId: string): void => {
    out.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;
    patientsList('')
      .then((all) => {
        // Match on the id from the payload only. The name is never scanned, so
        // a code can never be used to look someone up by spelling.
        const match = all.find((p) => p.id === patientId);
        if (!match) {
          out.innerHTML = `<p class="muted">${esc(t('qrUnknownPatient'))}</p>`;
          return null;
        }
        return apptTodayForPatient(patientId).then((appointment): ScanOutcome => ({ patient: match, appointment }));
      })
      .then((outcome) => {
        if (!outcome) return;
        renderConfirmation(out, outcome);
      })
      .catch((error: unknown) => {
        out.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
        toast(errorText(error), 'error');
      });
  };

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const file = data.get('photo');
    if (!(file instanceof Blob)) return;
    out.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;
    void decodeQrFromImage(file)
      .then((decoded) => {
        const patientId = decoded === null ? null : parsePatientQr(decoded);
        if (patientId === null) {
          out.innerHTML = `<p class="muted">${esc(t('qrNotReadable'))}</p>`;
          return;
        }
        lookup(decoded ?? '', patientId);
      })
      .catch((error: unknown) => {
        out.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
      });
  });

  const openBtn = root.querySelector('#qr-open') as HTMLButtonElement | null;
  openBtn?.addEventListener('click', () => {
    const field = (root.querySelector('input[name="patientId"]') as HTMLInputElement | null)?.value ?? '';
    const patientId = parsePatientQr(field) ?? (field.trim().length > 0 ? field.trim() : null);
    if (patientId === null) {
      out.innerHTML = `<p class="muted">${esc(t('qrUnknownPatient'))}</p>`;
      return;
    }
    lookup(field, patientId);
  });

  const showBtn = root.querySelector('#qr-show') as HTMLButtonElement | null;
  showBtn?.addEventListener('click', () => {
    const field = (root.querySelector('input[name="patientId"]') as HTMLInputElement | null)?.value.trim() ?? '';
    const host = root.querySelector('#qr-canvas') as HTMLElement;
    const patientId = parsePatientQr(field) ?? field;
    const payload = patientQrPayload(patientId);
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(payload)}`;
    host.innerHTML = `<p><code dir="ltr">${esc(payload)}</code></p><img alt="${esc(t('showQrCode'))}" src="${esc(url)}" width="220" height="220" />`;
  });
}

function renderConfirmation(out: HTMLElement, outcome: ScanOutcome): void {
  const { patient, appointment } = outcome;
  if (appointment === null) {
    out.innerHTML = `<div class="card">
      <h3>${esc(patient.fullName)}</h3>
      <p class="muted">${esc(t('qrNoAppointment'))}</p>
    </div>`;
    return;
  }

  const already = appointment.status === 'checked_in';
  out.innerHTML = `<div class="card">
    <h3>${esc(patient.fullName)}</h3>
    <p>${esc(fmtDateTime(appointment.startsAt))} · <span class="pill">${esc(statusLabel(appointment.status))}</span></p>
    ${already
      ? `<p class="muted">${esc(t('qrAlreadyArrived'))}</p>`
      : `<button class="primary" id="qr-arrive">${esc(t('qrMarkArrived'))}</button>`}
  </div>`;

  const arrive = out.querySelector('#qr-arrive') as HTMLButtonElement | null;
  arrive?.addEventListener('click', () => {
    arrive.disabled = true;
    apptTransition(appointment.id, 'in')
      .then(() => {
        toast(t('qrArrivedOk'));
        out.innerHTML = `<p class="muted">${esc(t('qrArrivedOk'))}</p>`;
      })
      .catch((error: unknown) => {
        arrive.disabled = false;
        toast(errorText(error), 'error');
      });
  });
}
