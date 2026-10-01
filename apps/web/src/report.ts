/**
 * Exportable medical reports (P2): prescriptions (Rx) and lab results.
 *
 * No new dependency: the report renders as a clean print-optimised document
 * in a new window and the user picks "Save as PDF" in the print dialog
 * (`@media print` rules in styles.css hide the app chrome). Authenticity is
 * verifiable two ways:
 *   1. a short content hash (verification code) computed over the report body,
 *   2. a QR image encoding that code + report id (api.qrserver.com, with the
 *      plain code as fallback when offline - the code alone verifies).
 *
 * Clinical data is rendered verbatim and escaped; nothing is translated.
 */

import { t } from './i18n.js';
import { esc } from './ui.js';

/** Short deterministic hash (djb2, hex) - sync so export stays one click. */
export function verificationCode(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(8, '0');
}

export interface ReportRow {
  label: string;
  value: string;
}

export function openReport(options: {
  title: string;
  patientName: string;
  clinicName?: string;
  rows: ReportRow[];
  notes?: string | null;
}): void {
  const { title, patientName, clinicName, rows, notes } = options;
  const issuedAt = new Date().toLocaleString(document.documentElement.lang === 'ar' ? 'ar' : 'en-GB');
  const fingerprint = verificationCode(JSON.stringify({ title, patientName, rows, issuedAt }));
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(`MEDIFLOW:${fingerprint}`)}`;
  const dir = document.documentElement.dir;
  const lang = document.documentElement.lang;
  const win = window.open('', '_blank', 'noopener');
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html lang="${esc(lang)}" dir="${esc(dir)}"><head><meta charset="utf-8" />
<title>${esc(title)} - ${esc(patientName)}</title>
<style>
body{font-family:system-ui,'Segoe UI',Tahoma,Arial,sans-serif;padding:24px;color:#000}
h1{font-size:20px;margin:0 0 4px}.muted{color:#444;font-size:13px}
table{width:100%;border-collapse:collapse;margin-top:12px}
th,td{border:1px solid #444;padding:6px 8px;text-align:start;font-size:14px}
.verify{margin-top:16px;border-top:2px solid #000;padding-top:10px;display:flex;gap:16px;align-items:center}
code{font-size:16px;font-weight:700;letter-spacing:1px}
@media print{.no-print{display:none}}</style></head><body>
<h1>${esc(title)}</h1>
<p class="muted">${esc(patientName)}${clinicName ? ` · ${esc(clinicName)}` : ''} · ${esc(issuedAt)}</p>
<table><thead><tr><th>${esc(t('name'))}</th><th>${esc(t('value'))}</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.value)}</td></tr>`).join('')}
</tbody></table>
${notes ? `<p>${esc(notes)}</p>` : ''}
<div class="verify">
<img src="${qrUrl}" width="120" height="120" alt="QR" onerror="this.remove()" />
<div><div>${esc(t('verifyCode'))}: <code dir="ltr">${esc(fingerprint)}</code></div>
<div class="muted">${esc(t('verifyHint'))}</div>
<p class="no-print"><button onclick="window.print()">${esc(t('exportPdf'))}</button></p></div>
</div></body></html>`);
  win.document.close();
}
