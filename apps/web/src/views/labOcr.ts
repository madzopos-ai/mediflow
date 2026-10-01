import { parseLabPanel, vitalLabel, type LabValue, type VitalKind } from '@mediflow/shared';

import { OfflineQueuedError, recordVital } from '../data.js';
import { t, tx, vitalLabelAr } from '../i18n.js';
import { errorText, esc, toast } from '../ui.js';

export function ocrPanelHtml(): string {
  return `
    <section class="card" id="ocr-panel" hidden>
      <h2>${esc(t('readFromFile'))}</h2>
      <div id="ocr-body"><p class="muted">${esc(t('loading'))}</p></div>
    </section>`;
}

/**
 * Raw OCR text of any image, without parsing or saving. Used for prescription
 * photos, where the doctor - not a lab parser - decides what each line means.
 */
export async function ocrText(file: Blob): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng');
  const {
    data: { text },
  } = await worker.recognize(file);
  await worker.terminate();
  return text ?? '';
}

/**
 * Automatic lab reading: OCR the photo, extract panel values, and offer them
 * for one-click saving into the patient's vitals tab. Used by both the
 * scanner page and the patient profile upload - the flow is identical.
 * The doctor confirms every value; a misread never lands in the chart
 * silently. `onSaved` refreshes the host screen after a successful save.
 */
export async function runImageRead(
  root: HTMLElement,
  patientId: string,
  file: File,
  onSaved?: () => void,
): Promise<void> {
  const panel = root.querySelector<HTMLElement>('#ocr-panel');
  const body = root.querySelector<HTMLElement>('#ocr-body');
  if (!panel || !body) return;
  panel.hidden = false;
  body.innerHTML = `<p class="muted">${esc(t('readingImage'))}</p>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    // Lazy: the OCR engine only downloads when a doctor actually scans an
    // image, never on app boot.
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng');
    const {
      data: { text },
    } = await worker.recognize(file);
    await worker.terminate();

    showExtracted(root, patientId, text, onSaved);
  } catch (error) {
    body.innerHTML = `<p class="muted">${esc(errorText(error))} ${esc(t('enterManually'))}</p>`;
  }
}

/**
 * PDF labs go through the same confirmation: each page is rasterised
 * (pdf.js, on-device) and OCR'd, then the combined text is parsed exactly
 * like a photo. Three pages max - longer scans are archival, not data entry.
  */
export async function runPdfRead(
  root: HTMLElement,
  patientId: string,
  file: File,
  onSaved?: () => void,
): Promise<void> {
  const panel = root.querySelector<HTMLElement>('#ocr-panel');
  const body = root.querySelector<HTMLElement>('#ocr-body');
  if (!panel || !body) return;
  panel.hidden = false;
  body.innerHTML = `<p class="muted">${esc(t('renderingPdf'))}</p>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const [{ createWorker }, pdfjs] = await Promise.all([
      import('tesseract.js'),
      import('pdfjs-dist'),
    ]);
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default as string;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    const pages = Math.min(pdf.numPages, 3);
    const worker = await createWorker('eng');
    let text = '';
    for (let n = 1; n <= pages; n += 1) {
      body.innerHTML = `<p class="muted">${esc(tx('readingPage', { n, total: pages }))}</p>`;
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 2.5 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error(t('couldNotRenderPdf'));
      const result = await worker.recognize(blob);
      text += `\n${result.data.text}`;
    }
    await worker.terminate();

    showExtracted(root, patientId, text, onSaved);
  } catch (error) {
    body.innerHTML = `<p class="muted">${esc(errorText(error))} ${esc(t('enterManually'))}</p>`;
  }
}

function showExtracted(root: HTMLElement, patientId: string, text: string, onSaved?: () => void): void {
  const panel = root.querySelector<HTMLElement>('#ocr-panel');
  const body = root.querySelector<HTMLElement>('#ocr-body');
  if (!panel || !body) return;

    if (!text || text.trim().length < 3) {
      body.innerHTML = `<p class="muted">${esc(t('noTextInFile'))}</p>`;
      return;
    }

    const values: LabValue[] = parseLabPanel(text);
    if (values.length === 0) {
      body.innerHTML =
        `<p class="muted">${esc(t('noLabRecognised'))}</p>` +
        `<details><summary>${esc(t('ocrText'))}</summary><pre>${esc(text.slice(0, 2000))}</pre></details>`;
      return;
    }

    body.innerHTML =
      `<p>${esc(tx('foundReadings', { n: values.length }))}</p>` +
      `<form id="ocr-confirm"><ul class="list">` +
      values
        .map(
          (v, i) => `<li><label class="check">
            <input type="checkbox" name="v${i}" checked />
            <strong>${esc(vitalLabelAr(v.kind, vitalLabel(v.kind as VitalKind)))}</strong>: ${esc(String(v.value))} ${esc(v.unit)}
            <span class="muted small">${esc(v.matchedText)}</span>
          </label></li>`,
        )
        .join('') +
      `</ul><button class="primary" type="submit">${esc(t('saveChecked'))}</button></form>` +
      `<details><summary>${esc(t('ocrText'))}</summary><pre>${esc(text.slice(0, 2000))}</pre></details>`;

    (body.querySelector('#ocr-confirm') as HTMLFormElement).addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.target as HTMLFormElement);
      const chosen = values.filter((_, i) => form.get(`v${i}`) === 'on');
      if (chosen.length === 0) {
        toast(t('nothingChecked'));
        return;
      }
      Promise.all(chosen.map((v) => recordVital(patientId, v.kind, v.value)))
        .then(() => {
          toast(tx('savedToVitals', { n: chosen.length }));
          panel.hidden = true;
          onSaved?.();
        })
        .catch((error: unknown) => {
          if (error instanceof OfflineQueuedError) toast(t('queued'));
          else toast(errorText(error), 'error');
        });
    });
}
