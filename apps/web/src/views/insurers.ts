import { OfflineQueuedError, insurerCollect, insurerCreate, insurerStatement, insurerUpdate, insurersList } from '../data.js';
import { getLang, statusLabel, t } from '../i18n.js';
import { errorText, esc, field, fmtMoney, input, toast, fmtDateTime } from '../ui.js';

function dollarsToMinor(raw: string): number | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) throw new Error(getLang() === 'ar' ? 'يجب أن تكون الحدود مبالغ موجبة بالدولار.' : 'Limits must be positive dollar amounts.');
  return Math.round(value * 100);
}

export function renderInsurers(root: HTMLElement): void {
  root.innerHTML = `
    <section class="card">
      <h2>${esc(t('insurers'))}</h2>
      <form id="ins-new" class="grid-form">
        ${field(t('name'), input('name', 'text', '', 'required'))}
        ${field(t('arabicName'), input('nameAr', 'text', ''))}
        ${field(t('coveragePct'), input('coveragePercent', 'number', '', 'required min="0" max="100" step="1"'))}
        ${field(t('annualLimitOpt'), input('annualLimit', 'text', '', 'inputmode="decimal"'))}
        ${field(t('perVisitLimitOpt'), input('perVisitLimit', 'text', '', 'inputmode="decimal"'))}
        ${field(t('phone'), input('phone', 'tel', ''))}
        ${field(t('notes'), input('notes', 'text', ''))}
        <button class="primary" type="submit">${esc(t('addInsurer'))}</button>
      </form>
    </section>
    <section class="card wide"><h2>${esc(t('contractedInsurers'))}</h2><div id="ins-list"><p class="muted">…</p></div></section>`;

  const load = (): void => {
    insurersList()
      .then((items) => {
        const rows = items
          .map(
            (ins) => `<tr>
              <td><strong>${esc(ins.name)}</strong>${ins.nameAr ? ` <span class="muted">${esc(ins.nameAr)}</span>` : ''}</td>
              <td>${esc(String(ins.coveragePercent))}%</td>
              <td>${ins.annualLimitMinor !== null ? esc(fmtMoney(ins.annualLimitMinor, '')) : '—'}</td>
              <td>${ins.perVisitLimitMinor !== null ? esc(fmtMoney(ins.perVisitLimitMinor, '')) : '—'}</td>
              <td><span class="pill ${ins.isActive ? 'ok' : ''}">${esc(ins.isActive ? t('active') : t('off'))}</span></td>
              <td class="row-actions">
                <button data-account="${esc(ins.id)}" data-name="${esc(ins.name)}">${esc(t('account'))}</button>
                <button data-toggle="${esc(ins.id)}" data-active="${ins.isActive ? '0' : '1'}">${
                ins.isActive ? esc(t('deactivate')) : esc(t('activate'))
              }</button>
              </td>
            </tr>`,
          )
          .join('');
        const list = document.getElementById('ins-list') as HTMLElement;
        list.innerHTML = rows
          ? `<table class="table"><thead><tr><th>${esc(t('name'))}</th><th>${esc(t('coverHeader'))}</th><th>${esc(t('annualCap'))}</th><th>${esc(t('visitCap'))}</th><th>${esc(t('status'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table>
              <div id="ins-account"></div>`
          : `<p class="muted">${esc(t('noInsurersYet'))}</p>`;
        list.querySelectorAll<HTMLButtonElement>('button[data-toggle]').forEach((button) => {
          button.addEventListener('click', () => {
            insurerUpdate(button.dataset.toggle ?? '', { isActive: button.dataset.active === '1' })
              .then(() => load())
              .catch((error: unknown) => toast(errorText(error), 'error'));
          });
        });
        list.querySelectorAll<HTMLButtonElement>('button[data-account]').forEach((button) => {
          button.addEventListener('click', () => {
            void renderAccount(button.dataset.account ?? '', button.dataset.name ?? '');
          });
        });
      })
      .catch((error: unknown) => {
        (document.getElementById('ins-list') as HTMLElement).innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };
  load();

  (document.getElementById('ins-new') as HTMLFormElement).addEventListener('submit', (event) => {    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const text = (k: string): string | null => {
      const v = String(data.get(k) ?? '').trim();
      return v ? v : null;
    };
    let annual: number | null = null;
    let perVisit: number | null = null;
    try {
      annual = dollarsToMinor(String(data.get('annualLimit') ?? ''));
      perVisit = dollarsToMinor(String(data.get('perVisitLimit') ?? ''));
    } catch (error) {
      toast(errorText(error), 'error');
      return;
    }
    insurerCreate({
      name: String(data.get('name') ?? ''),
      nameAr: text('nameAr'),
      coveragePercent: Number(data.get('coveragePercent') ?? 0),
      annualLimitMinor: annual,
      perVisitLimitMinor: perVisit,
      phone: text('phone'),
      notes: text('notes'),
    })
      .then(() => {
        (event.target as HTMLFormElement).reset();
        load();
      })
      .catch((error: unknown) => {
        if (error instanceof OfflineQueuedError) toast(t('queued'));
        else toast(errorText(error), 'error');
      });
  });
}

/**
 * One insurer's running account: billed to them, collected from them, and
 * what is still outstanding - plus the receipts ledger and a collection form.
 * Outstanding is always billed minus collected, shown live after each receipt.
 */
async function renderAccount(insurerId: string, name: string): Promise<void> {
  const host = document.getElementById('ins-account') as HTMLElement;
  host.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;
  try {
    const statement = await insurerStatement(insurerId);
    const ar = getLang() === 'ar';
    host.innerHTML = `
      <section class="card">
        <h3>${esc(name)} - ${esc(t('account'))}</h3>
        <p>${ar ? 'المطالَب به من الجهة' : 'billed to insurer'}: <strong>${esc(fmtMoney(statement.billedMinor, ''))}</strong> ·
           ${esc(t('collected'))}: <strong>${esc(fmtMoney(statement.collectedMinor, ''))}</strong> ·
           ${esc(t('outstanding'))}: <strong>${esc(fmtMoney(statement.outstandingMinor, ''))}</strong></p>
        <form id="ins-collect" class="row">
          ${field(t('collectUsd'), input('amount', 'text', '', 'required inputmode="decimal"'))}
          ${field(t('reference'), input('reference', 'text', '', ar ? 'placeholder="رقم الحوالة"' : 'placeholder="transfer no."'))}
          <button class="primary" type="submit">${esc(t('recordCollection'))}</button>
        </form>
        <h4>${esc(t('invoicesBilled'))} (${statement.invoices.length})</h4>
        ${
          statement.invoices.length > 0
            ? `<table class="table"><thead><tr><th>${esc(t('patientCol'))}</th><th>${esc(t('reference'))}</th><th>${esc(t('share'))}</th><th>${esc(t('status'))}</th><th>${esc(t('date'))}</th></tr></thead><tbody>${statement.invoices
                .map(
                  (i) =>
                    `<tr><td>${esc(i.patientName)}</td><td dir="ltr">${esc(i.policyNo ?? '—')}</td>` +
                    `<td>${esc(fmtMoney(i.insurerShareMinor, ''))} <span class="muted">${ar ? 'من' : 'of'} ${esc(fmtMoney(i.totalMinor, ''))}</span></td>` +
                    `<td><span class="pill">${esc(statusLabel(i.status))}</span></td><td>${esc(fmtDateTime(i.createdAt))}</td></tr>`,
                )
                .join('')}</tbody></table>
              <p><strong>${esc(t('totalBilled'))}: ${esc(fmtMoney(statement.billedMinor, ''))}</strong> ·
                 ${esc(t('collected'))}: <strong>${esc(fmtMoney(statement.collectedMinor, ''))}</strong> ·
                 ${esc(t('outstanding'))}: <strong>${esc(fmtMoney(statement.outstandingMinor, ''))}</strong></p>`
            : `<p class="muted">${esc(t('noInvoicesBilled'))}</p>`
        }
        <h4>${esc(t('receipts'))} (${statement.receipts.length})</h4>
        ${
          statement.receipts.length > 0
            ? `<ul class="list">${statement.receipts
                .map(
                  (r) =>
                    `<li>${esc(fmtMoney(r.amountMinor, ''))}` +
                    `${r.reference ? ` · ${ar ? 'مرجع' : 'ref'} ${esc(r.reference)}` : ''} <span class="muted">${esc(fmtDateTime(r.receivedAt))}</span></li>`,
                )
                .join('')}</ul>`
            : `<p class="muted">${esc(t('nothingCollectedYet'))}</p>`
        }
      </section>`;

    (document.getElementById('ins-collect') as HTMLFormElement).addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(event.target as HTMLFormElement);
      const dollars = Number(String(data.get('amount') ?? ''));
      if (!Number.isFinite(dollars) || dollars <= 0) {
        toast(t('amountPositive'), 'error');
        return;
      }
      insurerCollect(insurerId, Math.round(dollars * 100), String(data.get('reference') ?? '').trim() || null)
        .then(() => renderAccount(insurerId, name))
        .catch((error: unknown) => {
          if (error instanceof OfflineQueuedError) toast(t('queued'));
          else toast(errorText(error), 'error');
        });
    });
  } catch (error) {
    host.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
  }
}
