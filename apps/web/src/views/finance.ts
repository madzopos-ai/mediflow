import {
  OfflineQueuedError,
  finSummary,
  invCreate,
  invList,
  invoicesForPatient,
  insurersList,
  payRecord,
  paymentsList,
  type UiPayment,
} from '../data.js';import { getLang, methodLabel, statusLabel, t } from '../i18n.js';
import { errorText, esc, field, fmtDateTime, fmtMoney, input, toast } from '../ui.js';
import { attachPatientPicker, requirePicked, type PickedPatient } from './patientPicker.js';

const METHODS: { value: string; labelEn: string }[] = [
  { value: 'cash', labelEn: 'Cash' },
  { value: 'whish', labelEn: 'Whish Money' },
  { value: 'card', labelEn: 'Credit Card' },
  { value: 'transfer', labelEn: 'Transfer' },
];

/** Dollars typed by a human into integer minor units. $20 -> 2000, never 20. */
function dollarsToMinor(raw: string): number {
  const value = Number(String(raw ?? '').trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(getLang() === 'ar' ? 'يجب أن يكون المبلغ رقمًا موجبًا بالدولار.' : 'Amount must be a positive number of dollars.');
  return Math.round(value * 100);
}

export function renderFinance(root: HTMLElement): void {
  const ar = getLang() === 'ar';
  root.innerHTML = `
    <section class="grid">
      <div class="card" id="fin-summary"><h2>${esc(t('finance'))}</h2><p class="muted">${esc(t('loading'))}</p></div>
      <div class="card">
        <h2>${esc(t('newInvoice'))}</h2>
        <form id="inv-new" class="grid-form">
          ${field(t('patientTypeSearch'), input('invPatient', 'text', '', ar ? 'required placeholder="اسم المريض…"' : 'required placeholder="patient name…"'))}
          ${field(`${esc(t('amount'))} ($)`, input('totalDollars', 'text', '', 'required inputmode="decimal" placeholder="20"'))}
          ${field(t('taxOptional'), input('taxPercent', 'text', '', 'inputmode="decimal" placeholder="0"'))}
          <button class="primary" type="submit">${esc(t('save'))}</button>
        </form>
      </div>
      <div class="card wide">
        <h2>${esc(t('patientStatement'))}</h2>
        <form id="stmt-pick" class="row">
          ${field(t('patientTypeSearch'), input('stmtPatient', 'text', '', ar ? 'placeholder="اسم المريض…"' : 'placeholder="patient name…"'))}
          <button class="primary" type="submit">${esc(t('search'))}</button>
        </form>
        <div id="stmt-body"><p class="muted">${esc(t('patientStatementHint'))}</p></div>
      </div>
      <div class="card wide"><h2>${esc(t('invoices'))}</h2><div id="inv-list"><p class="muted">${esc(t('loading'))}</p></div></div>
      <div class="card wide">
        <h2>${esc(t('detailsByDay'))}</h2>
        <form id="fin-range" class="row">
          ${field(t('from'), input('from', 'date', ''))}
          ${field(t('to'), input('to', 'date', ''))}
          <button type="button" data-preset="today">${esc(t('today'))}</button>
          <button type="button" data-preset="week">${esc(t('thisWeek'))}</button>
          <button type="button" data-preset="month">${esc(t('thisMonth'))}</button>
          <button class="primary" type="submit">${esc(t('show'))}</button>
        </form>
        <div id="fin-details"><p class="muted">${esc(t('detailsHint'))}</p></div>
      </div>
    </section>`;

  finSummary()
    .then((data) => {
      const el = document.getElementById('fin-summary');
      if (el) {
        el.innerHTML = `<h2>${esc(t('finance'))}</h2>
          <p>${esc(t('outstanding'))}: <strong>${esc(fmtMoney(data.outstandingMinor, data.currency))}</strong></p>
          <p>${esc(t('collected'))}: <strong>${esc(fmtMoney(data.collectedMinor, data.currency))}</strong></p>`;
      }
    })
    .catch((error: unknown) => toast(errorText(error), 'error'));

  const load = (): void => {
    invList()
      .then((items) => {
        const rows = items
          .map((i) => {
            const left = Math.max(0, i.patientShareMinor - i.paidMinor);
            return `<tr><td>${esc(i.id.slice(0, 8))}…</td><td><span class="pill">${esc(statusLabel(i.status ?? ''))}</span></td>
              <td>${esc(fmtMoney(i.totalMinor, i.currency))}</td><td>${esc(fmtMoney(left, i.currency))}</td><td>${esc(fmtDateTime(i.createdAt))}</td></tr>`;
          })
          .join('');
        (document.getElementById('inv-list') as HTMLElement).innerHTML = rows
          ? `<table class="table"><thead><tr><th>${esc(t('id'))}</th><th>${esc(t('status'))}</th><th>${esc(t('amount'))}</th><th>${esc(t('left'))}</th><th>${esc(t('date'))}</th></tr></thead><tbody>${rows}</tbody></table>`
          : `<p class="muted">${esc(t('noResults'))}</p>`;
      })
      .catch((error: unknown) => {
        (document.getElementById('inv-list') as HTMLElement).innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };
  load();

  const invForm = document.getElementById('inv-new') as HTMLFormElement;
  let invPicked: PickedPatient | null = null;
  attachPatientPicker(invForm.querySelector('input[name="invPatient"]') as HTMLInputElement, (p) => {
    invPicked = p;
  });

  invForm.addEventListener('submit', (event) => {
    event.preventDefault();
    let patientId = '';
    try {
      patientId = requirePicked(
        invForm.querySelector('input[name="invPatient"]') as HTMLInputElement,
        invPicked,
      );
    } catch (error) {
      toast(errorText(error), 'error');
      return;
    }
    const data = new FormData(invForm);
    let totalMinor = 0;
    try {
      totalMinor = dollarsToMinor(String(data.get('totalDollars') ?? ''));
    } catch (error) {
      toast(errorText(error), 'error');
      return;
    }
    const taxRaw = String(data.get('taxPercent') ?? '').trim();
    const taxPercent = taxRaw ? Number(taxRaw) : undefined;
    if (taxPercent !== undefined && (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100)) {
      toast(t('taxRange'), 'error');
      return;
    }
    invCreate(patientId, totalMinor, taxPercent)
      .then(() => {
        invForm.reset();
        invPicked = null;
        load();
      })
      .catch((error: unknown) => {
        if (error instanceof OfflineQueuedError) toast(t('queued'));
        else toast(errorText(error), 'error');
      });
  });

  const stmtForm = document.getElementById('stmt-pick') as HTMLFormElement;
  let stmtPicked: PickedPatient | null = null;
  attachPatientPicker(stmtForm.querySelector('input[name="stmtPatient"]') as HTMLInputElement, (p) => {
    stmtPicked = p;
    if (p) void renderStatement(p.id, p.fullName);
  });
  stmtForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!stmtPicked) {
      toast(t('pickPatientError'), 'error');
      return;
    }
    void renderStatement(stmtPicked.id, stmtPicked.fullName);
  });

  const rangeForm = document.getElementById('fin-range') as HTMLFormElement;
  const dayKeyOf = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const setRange = (from: string, to: string): void => {
    (rangeForm.querySelector('input[name="from"]') as HTMLInputElement).value = from;
    (rangeForm.querySelector('input[name="to"]') as HTMLInputElement).value = to;
    void renderDetails(from, to);
  };
  rangeForm.querySelectorAll<HTMLButtonElement>('button[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const now = new Date();
      const today = dayKeyOf(now);
      const preset = button.dataset.preset ?? 'today';
      if (preset === 'today') setRange(today, today);
      else if (preset === 'week') {
        const start = new Date(now);
        start.setDate(start.getDate() - 6);
        setRange(dayKeyOf(start), today);
      } else {
        setRange(today.slice(0, 8) + '01', today);
      }
    });
  });
  rangeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(rangeForm);
    const from = String(data.get('from') ?? '');
    const to = String(data.get('to') ?? '');
    if (!from || !to) {
      toast(t('pickBothDates'), 'error');
      return;
    }
    void renderDetails(from, to);
  });
}

async function renderDetails(from: string, to: string): Promise<void> {
  const body = document.getElementById('fin-details') as HTMLElement;
  body.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;
  try {
    const [summary, invoices, payments] = await Promise.all([
      finSummary(from, to),
      invList(from, to),
      paymentsList(undefined, undefined, from, to),
    ]);
    const collected = payments
      .filter((p) => p.method)
      .reduce((sum, p) => sum + p.amountMinor, 0);
    const ar = getLang() === 'ar';
    body.innerHTML =
      `<p>${esc(t('collected'))}: <strong>${esc(fmtMoney(summary.collectedMinor, summary.currency))}</strong> · ` +
      `${esc(t('outstanding'))}: <strong>${esc(fmtMoney(summary.outstandingMinor, summary.currency))}</strong> · ` +
      `${invoices.length} ${ar ? 'فاتورة' : 'invoice(s)'}، ${payments.length} ${ar ? 'دفعة' : 'payment(s)'} ${ar ? 'من' : 'from'} ${esc(from)} ${ar ? 'إلى' : 'to'} ${esc(to)}</p>` +
      (invoices.length > 0
        ? `<table class="table"><thead><tr><th>${esc(t('id'))}</th><th>${esc(t('status'))}</th><th>${esc(t('total'))}</th><th>${esc(t('left'))}</th><th>${esc(t('date'))}</th></tr></thead><tbody>${invoices
            .map(
              (i) =>
                `<tr><td>${esc(i.id.slice(0, 8))}…</td><td>${esc(statusLabel(i.status))}</td><td>${esc(fmtMoney(i.totalMinor, i.currency))}</td>` +
                `<td>${esc(fmtMoney(Math.max(0, i.patientShareMinor - i.paidMinor), i.currency))}</td><td>${esc(fmtDateTime(i.createdAt))}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : `<p class="muted">${esc(t('noInvoicesRange'))}</p>`) +
      (payments.length > 0
        ? `<table class="table"><thead><tr><th>${esc(t('amount'))}</th><th>${esc(t('method'))}</th><th>${esc(t('date'))}</th></tr></thead><tbody>${payments
            .map(
              (p) =>
                `<tr><td>${esc(fmtMoney(p.amountMinor, summary.currency))}</td><td>${esc(methodLabel(p.method))}</td><td>${esc(fmtDateTime(p.createdAt))}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : `<p class="muted">${esc(t('noPaymentsRange'))}</p>`) +
      `<p class="muted">${esc(t('collectedInRange'))}: ${esc(fmtMoney(collected, summary.currency))}</p>`;
  } catch (error) {
    body.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
  }
}

async function renderStatement(patientId: string, name: string): Promise<void> {
  const body = document.getElementById('stmt-body') as HTMLElement;
  body.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;
  try {
    const [mine, payments, insurers] = await Promise.all([
      invoicesForPatient(patientId),
      paymentsList(patientId),
      insurersList().catch(() => []),
    ]);
    const insurerName = (id: string | null): string => {
      if (!id) return '';
      const found = insurers.find((i) => i.id === id);
      return found ? `${found.name} ${found.coveragePercent}%` : '';
    };
    const open = mine.filter((i) => i.status !== 'paid');
    const byInvoice = new Map<string, UiPayment[]>();
    for (const p of payments) {
      if (!p.invoiceId) continue;
      const list = byInvoice.get(p.invoiceId) ?? [];
      list.push(p);
      byInvoice.set(p.invoiceId, list);
    }
    const fmtMinor = (minor: number): string => fmtMoney(minor, mine[0]?.currency ?? '');
    body.innerHTML =
      `<h3>${esc(name)}</h3>` +
      (open.length === 0
        ? `<p class="muted">${esc(t('nothingOutstanding'))}</p>`
        : open
            .map((i) => {
              const left = Math.max(0, i.patientShareMinor - i.paidMinor);
              const insurance =
                i.insurerShareMinor > 0
                  ? `<div>${esc(t('insuranceCovers'))} ${esc(fmtMoney(i.insurerShareMinor, i.currency))} <span class="muted">(${esc(insurerName(i.insurerId))})</span> · ${esc(t('youOwe'))} <strong>${esc(fmtMoney(i.patientShareMinor, i.currency))}</strong></div>`
                  : '';
              return `<div class="vital-card">
                <div class="vital-top"><strong>${esc(fmtMoney(i.totalMinor, i.currency))}</strong><span class="pill">${esc(statusLabel(i.status))}</span></div>
                ${insurance}
                <div>${esc(t('paid'))} ${esc(fmtMinor(i.paidMinor))} · ${esc(t('left'))} <strong>${esc(fmtMinor(left))}</strong> <span class="muted">${esc(fmtDateTime(i.createdAt))}</span></div>
                <form data-pay="${esc(i.id)}" class="row">
                  ${field(t('amountUsd'), input('amount', 'text', (left / 100).toString(), 'required inputmode="decimal"'))}
                  ${field(t('method'), `<select name="method">${METHODS.map((m) => `<option value="${m.value}">${esc(methodLabel(m.value))}</option>`).join('')}</select>`)}
                  <button type="submit" data-full="${left}">${esc(t('pay'))}</button>
                  <button type="button" data-payfull="${esc(i.id)}" data-amount="${left}">${esc(t('payFull'))} ${esc(fmtMinor(left))}</button>
                </form>
              </div>`;
            })
            .join('')) +
      `<h3>${esc(t('paymentHistory'))}</h3>` +
      (payments.length > 0
        ? `<ul class="list">${payments
            .map((p) => `<li>${esc(fmtMoney(p.amountMinor, mine[0]?.currency ?? ''))} · ${esc(methodLabel(p.method))} <span class="muted">${esc(fmtDateTime(p.createdAt))}</span></li>`)
            .join('')}</ul>`
        : `<p class="muted">${esc(t('noPaymentsYet'))}</p>`);

    body.querySelectorAll<HTMLFormElement>('form[data-pay]').forEach((form) => {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(form);
        let amountMinor = 0;
        try {
          amountMinor = dollarsToMinor(String(data.get('amount') ?? ''));
        } catch (error) {
          toast(errorText(error), 'error');
          return;
        }
        payRecord(patientId, form.dataset.pay ?? null, amountMinor, String(data.get('method') ?? 'cash'))
          .then(() => renderStatement(patientId, name))
          .catch((error: unknown) => {
            if (error instanceof OfflineQueuedError) toast(t('queued'));
            else toast(errorText(error), 'error');
          });
      });
    });
    body.querySelectorAll<HTMLButtonElement>('button[data-payfull]').forEach((button) => {
      button.addEventListener('click', () => {
        const form = button.closest('form') as HTMLFormElement | null;
        const method = (form?.querySelector('select[name="method"]') as HTMLSelectElement | null)?.value ?? 'cash';
        payRecord(patientId, button.dataset.payfull ?? null, Number(button.dataset.amount ?? 0), method)
          .then(() => renderStatement(patientId, name))
          .catch((error: unknown) => {
            if (error instanceof OfflineQueuedError) toast(t('queued'));
            else toast(errorText(error), 'error');
          });
      });
    });
  } catch (error) {
    body.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
  }
}
