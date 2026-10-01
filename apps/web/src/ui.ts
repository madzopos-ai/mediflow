/**
 * Tiny view helpers. All server-controlled strings go through `esc()`: a
 * patient name is untrusted input and must never become markup.
 */

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);
  window.setTimeout(() => el.remove(), 4200);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(document.documentElement.lang === 'ar' ? 'ar' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(document.documentElement.lang === 'ar' ? 'ar' : 'en-GB', {
    dateStyle: 'medium',
  });
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

export function fmtMoney(minor: number | null | undefined, currency = ''): string {
  if (minor === null || minor === undefined) return '—';
  const major = (minor / 100).toLocaleString(document.documentElement.lang === 'ar' ? 'ar' : 'en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (!currency) return major;
  return `${CURRENCY_SYMBOLS[currency] ?? `${currency} `}${major}`;
}

export function field(label: string, inner: string): string {
  return `<label class="field"><span>${esc(label)}</span>${inner}</label>`;
}

export function input(name: string, type = 'text', value = '', attrs = ''): string {
  return `<input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" ${attrs} />`;
}

export function errorText(error: unknown): string {
  const ar = document.documentElement.lang === 'ar';
  if (error instanceof Error) return error.message;
  return ar ? 'فشل الطلب.' : 'Request failed.';
}

export function formDataObject(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new FormData(form).entries()) {
    out[key] = String(value);
  }
  return out;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = (): void =>
      reject(reader.error ?? new Error(document.documentElement.lang === 'ar' ? 'تعذر قراءة الملف.' : 'Could not read the file.'));
    reader.readAsDataURL(file);
  });
}
