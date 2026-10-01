import { DOCUMENT_KINDS } from '@mediflow/shared';
import { OfflineQueuedError, docBlob, docFileUrl, docOcr, docRecord, docsList } from '../data.js';
import { docKindLabel, getLang, statusLabel, t } from '../i18n.js';
import { errorText, esc, field, fileToBase64, fmtDateTime, input, sha256Hex, toast } from '../ui.js';
import { ocrPanelHtml, runImageRead, runPdfRead } from './labOcr.js';
import { attachPatientPicker, requirePicked, type PickedPatient } from './patientPicker.js';

export function renderScanner(root: HTMLElement): void {
  const ar = getLang() === 'ar';
  root.innerHTML = `
    <section class="card">
      <h2>${esc(t('scanDocument'))}</h2>
      <form id="scan-form" class="grid-form">
        ${field(t('patientTypeSearch'), input('patientId', 'text', '', ar ? 'required placeholder="اسم المريض…"' : 'required placeholder="patient name…"'))}
        ${field(t('docKindLabel'), `<select name="kind">${DOCUMENT_KINDS.map((k) => `<option value="${k}">${esc(docKindLabel(k))}</option>`).join('')}</select>`)}
        ${field(t('testNamePanel'), input('title', 'text', '', ar ? 'placeholder="مثال: سكري تراكمي"' : 'placeholder="e.g. HbA1c Q3"'))}
        ${field(t('fileLabelLong'), `<input name="file" type="file" accept="image/*,.pdf,.xls,.xlsx,.csv,.doc,.docx,.txt" capture="environment" required />`)}
        <button class="primary" type="submit">${esc(t('save'))}</button>
      </form>
      <p class="muted">${esc(t('scannerHint'))}</p>
    </section>
    ${ocrPanelHtml()}
    <section class="card">
      <h2>${esc(t('documents'))}</h2>
      <div id="doc-list"><p class="muted">${esc(t('loading'))}</p></div>
    </section>`;

  const load = (): void => {
    docsList()
      .then((items) => {
        const rows = items
          .map(
            (d) => `<tr>
              <td>${esc(d.title ?? d.fileName)}</td>
              <td>${esc(docKindLabel(d.kind ?? ''))}</td>
              <td><span class="pill">${esc(statusLabel(d.status ?? ''))}</span></td>
              <td>${esc(fmtDateTime(d.createdAt))}</td>
              <td class="row-actions">
                ${d.hasFile ? `<button data-view="${esc(d.id)}">${esc(t('view'))}</button><button data-dl="${esc(d.id)}">${esc(t('download'))}</button>` : `<span class="muted">${esc(t('noFile'))}</span>`}
                ${d.hasFile && d.mimeType.startsWith('image/') ? `<button data-reread="${esc(d.id)}" data-patient="${esc(d.patientId)}" data-name="${esc(d.fileName)}" data-mime="${esc(d.mimeType)}">${esc(t('reread'))}</button>` : ''}
                <button data-ocr="${esc(d.id)}">${esc(t('attachOcr'))}</button>
              </td>
            </tr>`,
          )
          .join('');
        const list = document.getElementById('doc-list') as HTMLElement;
        list.innerHTML = rows
          ? `<table class="table"><thead><tr><th>${esc(t('file'))}</th><th>${esc(t('kind'))}</th><th>${esc(t('status'))}</th><th>${esc(t('date'))}</th><th>${esc(t('actions'))}</th></tr></thead><tbody>${rows}</tbody></table>`
          : `<p class="muted">${esc(t('noResults'))}</p>`;

        const openUrl = (id: string, download: boolean): void => {
          // The tab must open synchronously inside the click: a window.open
          // after a network round-trip is popup-blocked, and the file would
          // silently "not open". The URL fills in once the bytes arrive.
          const win = download ? null : window.open('', '_blank', 'noopener');
          docFileUrl(id)
            .then((url) => {
              if (download) {
                const a = document.createElement('a');
                a.href = url;
                a.download = '';
                a.rel = 'noopener';
                document.body.appendChild(a);
                a.click();
                a.remove();
              } else if (win) {
                win.location.href = url;
              } else {
                // Popup blocked: fall back to a download so the file still
                // reaches the doctor instead of vanishing silently.
                window.location.href = url;
              }
            })
            .catch((error: unknown) => {
              win?.close();
              toast(errorText(error), 'error');
            });
        };
        list.querySelectorAll<HTMLButtonElement>('button[data-view]').forEach((button) => {
          button.addEventListener('click', () => openUrl(button.dataset.view ?? '', false));
        });
        list.querySelectorAll<HTMLButtonElement>('button[data-dl]').forEach((button) => {
          button.addEventListener('click', () => openUrl(button.dataset.dl ?? '', true));
        });
        // Re-run the lab reader on an already-uploaded image with the current
        // parser - no re-upload needed when the parser learns new panels.
        list.querySelectorAll<HTMLButtonElement>('button[data-reread]').forEach((button) => {
          button.addEventListener('click', () => {
            const id = button.dataset.reread ?? '';
            const patientId = button.dataset.patient ?? '';
            if (!patientId) {
              toast(t('noFileLinked'), 'error');
              return;
            }
            button.disabled = true;
            docBlob(id)
              .then((blob) => {
                const file = new File([blob], button.dataset.name ?? 'scan', {
                  type: button.dataset.mime ?? 'image/jpeg',
                });
                return runImageRead(root, patientId, file);
              })
              .catch((error: unknown) => toast(errorText(error), 'error'))
              .finally(() => {
                button.disabled = false;
              });
          });
        });
        list.querySelectorAll<HTMLButtonElement>('button[data-ocr]').forEach((button) => {
          button.addEventListener('click', () => {
            const text = window.prompt(t('ocrText'));
            if (!text) return;
            docOcr(button.dataset.ocr ?? '', text)
              .then(() => load())
              .catch((error: unknown) => {
                if (error instanceof OfflineQueuedError) toast(t('queued'));
                else toast(errorText(error), 'error');
              });
          });
        });
      })
      .catch((error: unknown) => {
        (document.getElementById('doc-list') as HTMLElement).innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };
  load();

  const form = document.getElementById('scan-form') as HTMLFormElement;
  const patientInput = form.querySelector('input[name="patientId"]') as HTMLInputElement;
  let picked: PickedPatient | null = null;
  attachPatientPicker(patientInput, (p) => {
    picked = p;
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    let patientId = '';
    try {
      patientId = requirePicked(patientInput, picked);
    } catch (error) {
      toast(errorText(error), 'error');
      return;
    }
    const data = new FormData(form);
    const file = data.get('file');
    if (!(file instanceof File)) return;
    const title = String(data.get('title') ?? '').trim();
    const submit = document.querySelector('#scan-form button[type="submit"]') as HTMLButtonElement;
    submit.disabled = true;
    const isImage = file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    Promise.all([file.arrayBuffer().then((b) => sha256Hex(b)), fileToBase64(file)])
      .then(([checksum, base64]) =>
        docRecord(
          {
            patientId,
            kind: String(data.get('kind') ?? 'other'),
            ...(title ? { title } : {}),
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            byteSize: file.size,
            checksum,
          },
          { base64, blob: file },
        ),
      )
      .then(() => {
        form.reset();
        picked = null;
        load();
        // Blood-test files read themselves (panel renders into this view).
        // Anything else keeps the manual path.
        if (isImage) {
          void runImageRead(root, patientId, file);
        } else if (isPdf) {
          void runPdfRead(root, patientId, file);
        }
      })
      .catch((error: unknown) => {
        if (error instanceof OfflineQueuedError) toast(t('queued'));
        else toast(errorText(error), 'error');
      })
      .finally(() => {
        submit.disabled = false;
      });
  });
}

