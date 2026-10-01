import {
  fbAllClinics,
  fbApproveUser,
  fbClinicStaff,
  fbClinicSubscriptionPayments,
  fbCreateActivationCode,
  fbListActivationCodes,
  fbPendingUsers,
  fbReadClinicSubscription,
  fbRecordSubscriptionPayment,
  fbRevokeActivationCode,
  fbSaveClinicSubscription,
  fbSetClinicDisabled,
  fbSetUserDisabled,
  isFirebaseMode,
  resellerApprove,
  resellerClinics,
  resellerCollect,
  resellerPending,
  resellerStatement,
  resellerSubscription,
  resellerSuspend,
} from '../data.js';
import { errorText, esc, field, fmtDateTime, fmtMoney, input, toast } from '../ui.js';
import { roleLabel, statusLabel, t } from '../i18n.js';

function dollarsToMinor(raw: string): number {
  const value = Number(String(raw ?? '').trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(t('amountPositive'));
  return Math.round(value * 100);
}

/**
 * Reseller console: pending practices to accept, every clinic's subscription
 * state, per-clinic statements, and subscription collections - the whole
 * selling operation without touching a terminal.
 */
export function renderAdmin(root: HTMLElement): void {  void isFirebaseMode().then((firebase) => {
    if (firebase) renderFirebaseAdmin(root);
    else renderApiAdmin(root);
  });
}

/**
 * Firebase-mode console: activation codes, pending practices, and per-clinic
 * finance (subscription, doctors, collections, disables). No API server.
 */
function renderFirebaseAdmin(root: HTMLElement): void {
  let reseller = false;
  try {
    reseller = localStorage.getItem('mf_reseller') === '1';
  } catch {
    reseller = false;
  }
  if (!reseller) {
    root.innerHTML = `<section class="card"><p class="muted">${esc(t('notReseller'))}</p></section>`;
    return;
  }
  root.innerHTML = `
    <section class="card"><h2>${esc(t('activationCodes'))}</h2>
      <p class="muted">${esc(t('activationCodesHint'))}</p>
      <form id="code-new" class="row">
        ${field(t('noteOptional'), input('note', 'text', ''))}
        <button class="primary" type="submit">${esc(t('newCode'))}</button>
      </form>
      <div id="code-list"><p class="muted">…</p></div>
    </section>
    <section class="card"><h2>${esc(t('pendingApprovalTitle'))}</h2><div id="admin-pending"><p class="muted">…</p></div></section>
    <section class="card wide"><h2>${esc(t('clinics'))}</h2><div id="admin-clinics"><p class="muted">…</p></div></section>
    ${futureModulesHtml()}
    <div id="admin-detail"></div>`;

  const loadCodes = (): void => {
    fbListActivationCodes()
      .then((items) => {
        const host = document.getElementById('code-list') as HTMLElement;
        host.innerHTML =
          items.length > 0
            ? `<ul class="list">${items
                .map(
                  (c) => `<li><strong dir="ltr">${esc(c.code)}</strong>
                    ${c.note ? `<span class="muted">${esc(c.note)}</span>` : ''}
                    ${c.usedBy ? `<span class="pill ok">${esc(t('inviteUsed'))}</span>` : `<span class="pill warn">${esc(t('inviteFresh'))}</span>`}
                    ${c.usedBy ? '' : `<button data-revoke="${esc(c.code)}">${esc(t('revokeInvite'))}</button>`}</li>`,
                )
                .join('')}</ul>`
            : `<p class="muted">${esc(t('noInvites'))}</p>`;
        host.querySelectorAll<HTMLButtonElement>('button[data-revoke]').forEach((button) => {
          button.addEventListener('click', () => {
            fbRevokeActivationCode(button.dataset.revoke ?? '')
              .then(() => loadCodes())
              .catch((error: unknown) => toast(errorText(error), 'error'));
          });
        });
      })
      .catch((error: unknown) => {
        (document.getElementById('code-list') as HTMLElement).innerHTML =
          `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };

  (document.getElementById('code-new') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const note = String(new FormData(event.target as HTMLFormElement).get('note') ?? '').trim() || null;
    fbCreateActivationCode(note)
      .then(() => {
        (event.target as HTMLFormElement).reset();
        loadCodes();
      })
      .catch((error: unknown) => toast(errorText(error), 'error'));
  });

  const loadPending = (): void => {
    fbPendingUsers()
      .then((items) => {
        const host = document.getElementById('admin-pending') as HTMLElement;
        if (items.length === 0) {
          host.innerHTML = `<p class="muted">${esc(t('nothingWaiting'))}</p>`;
          return;
        }
        host.innerHTML = `<ul class="list">${items
          .map(
            (p) => `<li><strong>${esc(p.name)}</strong> <span class="muted" dir="ltr">${esc(p.email)}</span>
              <span class="muted">${esc(p.clinicId)}</span>
              <button data-approve="${esc(p.uid)}">${esc(t('accept'))}</button></li>`,
          )
          .join('')}</ul>`;
        host.querySelectorAll<HTMLButtonElement>('button[data-approve]').forEach((button) => {
          button.addEventListener('click', () => {
            fbApproveUser(button.dataset.approve ?? '')
              .then(() => {
                toast(t('practiceAccepted'));
                loadPending();
                loadClinics();
              })
              .catch((error: unknown) => toast(errorText(error), 'error'));
          });
        });
      })
      .catch((error: unknown) => {
        (document.getElementById('admin-pending') as HTMLElement).innerHTML =
          `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };

  const loadClinics = (): void => {
    fbAllClinics()
      .then((items) => {
        const host = document.getElementById('admin-clinics') as HTMLElement;
        host.innerHTML =
          items.length > 0
            ? `<table class="table"><thead><tr><th>${esc(t('clinic'))}</th><th>${esc(t('date'))}</th><th></th></tr></thead><tbody>${items
                .map(
                  (c) => `<tr><td><strong>${esc(c.name)}</strong><br /><span class="muted small">${esc(c.id)}</span></td>
                    <td class="muted small">${c.createdAt ? esc(fmtDateTime(c.createdAt)) : '—'}</td>
                    <td><button data-open="${esc(c.id)}" data-name="${esc(c.name)}">${esc(t('account'))}</button></td></tr>`,
                )
                .join('')}</tbody></table>`
            : `<p class="muted">${esc(t('noClinicsYet'))}</p>`;
        host.querySelectorAll<HTMLButtonElement>('button[data-open]').forEach((button) => {
          button.addEventListener('click', () => {
            renderFbClinicAccount(root, button.dataset.open ?? '', button.dataset.name ?? '', () => {
              loadPending();
              loadClinics();
            });
          });
        });
      })
      .catch((error: unknown) => {
        (document.getElementById('admin-clinics') as HTMLElement).innerHTML =
          `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };

  loadCodes();
  loadPending();
  loadClinics();
}

/** One clinic's money: subscription, doctors vs limit, collections, disable. */
function renderFbClinicAccount(root: HTMLElement, clinicId: string, name: string, onChanged: () => void): void {
  const host = document.getElementById('admin-detail') as HTMLElement;
  host.innerHTML = `<section class="card"><p class="muted">${esc(t('loading'))}</p></section>`;
  Promise.all([
    fbReadClinicSubscription(clinicId),
    fbClinicStaff(clinicId),
    fbClinicSubscriptionPayments(clinicId),
  ])
    .then(([sub, staff, receipts]) => {
      const doctors = staff.filter((s) => s.role === 'doctor' || s.role === 'owner');
      const overLimit = doctors.length > sub.doctorLimit;
      const collected = receipts.reduce((sum, r) => sum + r.amountMinor, 0);
      const paidByDoctor = new Map<string, number>();
      for (const r of receipts) {
        if (r.doctorId) paidByDoctor.set(r.doctorId, (paidByDoctor.get(r.doctorId) ?? 0) + r.amountMinor);
      }
      host.innerHTML = `
      <section class="card wide">
        <h2>${esc(name)} — ${esc(t('subscriptionTitle'))}</h2>
        ${overLimit ? `<p class="warning">${esc(t('overLimitWarn'))}: ${doctors.length} / ${sub.doctorLimit}</p>` : ''}
        <form id="sub-edit" class="grid-form">
          ${field(t('plan'), input('plan', 'text', sub.plan ?? '', 'placeholder="standard"'))}
          ${field(t('pricePerDoctor'), input('price', 'text', String(sub.pricePerDoctorMinor), 'required inputmode="numeric"'))}
          ${field(t('currency3'), input('currency', 'text', sub.currency, 'required minlength="3" maxlength="3"'))}
          ${field(t('doctorLimit'), input('doctorLimit', 'number', String(sub.doctorLimit), 'required min="1"'))}
          ${field(t('subscribedAt'), input('subscribedAt', 'date', (sub.subscribedAt ?? '').slice(0, 10)))}
          ${field(t('expiresAt'), input('expiresAt', 'date', (sub.expiresAt ?? '').slice(0, 10)))}
          <button class="primary" type="submit">${esc(t('save'))}</button>
        </form>
        <div class="row">
          <button id="clinic-disable" class="${sub.disabled ? 'primary' : ''}">${esc(sub.disabled ? t('enableClinic') : t('disableClinic'))}</button>
          ${sub.disabled ? `<span class="pill danger">${esc(t('disabledWord'))}</span>` : `<span class="pill ok">${esc(t('active'))}</span>`}
        </div>
        <h3>${esc(t('doctors'))} (${doctors.length} / ${esc(t('doctorLimit'))} ${sub.doctorLimit})</h3>
        <ul class="list">${doctors
          .map(
            (d) => `<li><strong>${esc(d.name)}</strong> <span class="muted" dir="ltr">${esc(d.email)}</span>
              <span class="pill">${esc(roleLabel(d.role))} · ${esc(statusLabel(d.status || 'pending'))}</span>
              ${d.disabled ? `<span class="pill danger">${esc(t('disabledWord'))}</span>` : ''}
              <span class="muted">${esc(t('paidLabel'))}: ${esc(fmtMoney(paidByDoctor.get(d.uid) ?? 0, sub.currency))}</span>
              <button data-u-disable="${esc(d.uid)}" data-off="${d.disabled ? '0' : '1'}">${esc(d.disabled ? t('enableDoctor') : t('disableDoctor'))}</button></li>`,
          )
          .join('')}</ul>
        <h3>${esc(t('recordCollection'))}</h3>
        <form id="sub-collect" class="grid-form">
          ${field(t('collectUsd'), input('amount', 'text', '', 'required inputmode="decimal"'))}
          ${field(t('doctorOptional'), `<select name="doctorId"><option value="">—</option>${doctors.map((d) => `<option value="${esc(d.uid)}">${esc(d.name)}</option>`).join('')}</select>`)}
          ${field(t('reference'), input('reference', 'text', ''))}
          <button class="primary" type="submit">${esc(t('recordCollection'))}</button>
        </form>
        <h3>${esc(t('receipts'))} (${esc(t('collected'))}: ${esc(fmtMoney(collected, sub.currency))})</h3>
        ${receipts.length > 0
          ? `<ul class="list">${receipts
              .map(
                (r) =>
                  `<li>${esc(fmtMoney(r.amountMinor, r.currency || sub.currency))}` +
                  `${r.reference ? ` · ${esc(t('reference'))}: ${esc(r.reference)}` : ''} <span class="muted">${esc(fmtDateTime(r.receivedAt))}</span></li>`,
              )
              .join('')}</ul>`
          : `<p class="muted">${esc(t('nothingCollectedYet'))}</p>`}
      </section>`;

      (document.getElementById('sub-edit') as HTMLFormElement).addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(event.target as HTMLFormElement);
        const text = (k: string): string | null => {
          const v = String(data.get(k) ?? '').trim();
          return v ? v : null;
        };
        const priceRaw = String(data.get('price') ?? '').trim();
        // Dollars shown, minor units stored - same convention as the API.
        const priceMinor = Math.round(Number(priceRaw) * 100);
        if (!Number.isFinite(priceMinor) || priceMinor < 0) {
          toast(t('amountPositive'), 'error');
          return;
        }
        fbSaveClinicSubscription(clinicId, {
          plan: text('plan'),
          pricePerDoctorMinor: priceMinor,
          currency: (String(data.get('currency') ?? 'USD').trim() || 'USD').toUpperCase(),
          doctorLimit: Number(data.get('doctorLimit') ?? 1),
          subscribedAt: text('subscribedAt'),
          expiresAt: text('expiresAt'),
        })
          .then(() => {
            toast(t('saved'));
            renderFbClinicAccount(root, clinicId, name, onChanged);
            onChanged();
          })
          .catch((error: unknown) => toast(errorText(error), 'error'));
      });

      (document.getElementById('clinic-disable') as HTMLButtonElement).addEventListener('click', (event) => {
        const button = event.target as HTMLButtonElement;
        const disable = !sub.disabled;
        if (disable && !window.confirm(t('disableClinicConfirm'))) return;
        button.disabled = true;
        fbSetClinicDisabled(clinicId, disable)
          .then(() => {
            toast(disable ? t('clinicDisabled') : t('clinicEnabled'));
            renderFbClinicAccount(root, clinicId, name, onChanged);
            onChanged();
          })
          .catch((error: unknown) => {
            button.disabled = false;
            toast(errorText(error), 'error');
          });
      });

      host.querySelectorAll<HTMLButtonElement>('button[data-u-disable]').forEach((button) => {
        button.addEventListener('click', () => {
          const disable = button.dataset.off === '1';
          button.disabled = true;
          fbSetUserDisabled(button.dataset.uDisable ?? '', disable)
            .then(() => renderFbClinicAccount(root, clinicId, name, onChanged))
            .catch((error: unknown) => {
              button.disabled = false;
              toast(errorText(error), 'error');
            });
        });
      });

      (document.getElementById('sub-collect') as HTMLFormElement).addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(event.target as HTMLFormElement);
        const dollars = Number(String(data.get('amount') ?? ''));
        if (!Number.isFinite(dollars) || dollars <= 0) {
          toast(t('amountPositive'), 'error');
          return;
        }
        const doctorId = String(data.get('doctorId') ?? '').trim() || null;
        fbRecordSubscriptionPayment(clinicId, {
          amountMinor: Math.round(dollars * 100),
          currency: sub.currency,
          doctorId,
          periodStart: null,
          periodEnd: null,
          reference: String(data.get('reference') ?? '').trim() || null,
          note: null,
        })
          .then(() => renderFbClinicAccount(root, clinicId, name, onChanged))
          .catch((error: unknown) => toast(errorText(error), 'error'));
      });
    })
    .catch((error: unknown) => {
      host.innerHTML = `<section class="card"><p class="muted">${esc(errorText(error))}</p></section>`;
    });
}

function renderApiAdmin(root: HTMLElement): void {
  root.innerHTML = `
    <section class="card"><h2>${esc(t('pendingApprovalTitle'))}</h2><div id="admin-pending"><p class="muted">…</p></div></section>
    <section class="card wide"><h2>${esc(t('clinics'))}</h2><div id="admin-clinics"><p class="muted">…</p></div></section>
    ${futureModulesHtml()}
    <div id="admin-statement"></div>`;

  const loadPending = (): void => {
    resellerPending()
      .then((data) => {
        const host = document.getElementById('admin-pending') as HTMLElement;
        if (data.items.length === 0) {
          host.innerHTML = `<p class="muted">${esc(t('nothingWaiting'))}</p>`;
          return;
        }
        host.innerHTML = `<ul class="list">${data.items
          .map(
            (p) => `<li><strong>${esc(p.fullName)}</strong> <span class="muted" dir="ltr">${esc(p.email)}</span>
              <span class="pill">${esc(p.clinicKind)}</span> <span class="muted">${esc(p.clinic)}</span>
              <button data-approve="${esc(p.clinicId)}">${esc(t('accept'))}</button></li>`,
          )
          .join('')}</ul>`;
        host.querySelectorAll<HTMLButtonElement>('button[data-approve]').forEach((button) => {
          button.addEventListener('click', () => {
            resellerApprove(button.dataset.approve ?? '')
              .then(() => {
                toast(t('practiceAccepted'));
                loadPending();
                loadClinics();
              })
              .catch((error: unknown) => toast(errorText(error), 'error'));
          });
        });
      })
      .catch((error: unknown) => {
        (document.getElementById('admin-pending') as HTMLElement).innerHTML =
          `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };

  const loadClinics = (): void => {
    resellerClinics()
      .then((data) => {
        const rows = data.items
          .map(
            (c) => `<tr>
              <td><strong>${esc(c.name)}</strong><br /><span class="muted small" dir="ltr">${esc(c.ownerEmail ?? '')}</span></td>
              <td>${esc(c.kind)}</td>
              <td>${esc(c.plan)} <span class="pill ${c.subscriptionStatus === 'active' ? 'ok' : c.subscriptionStatus === 'suspended' ? 'danger' : ''}">${esc(statusLabel(c.subscriptionStatus))}</span></td>
              <td class="muted small">${esc(t('subscribed'))}: ${esc(c.subscribedAt ?? '—')}<br />${esc(t('expires'))}: ${esc(c.expiresAt ?? '—')}</td>
              <td>${esc(fmtMoney(c.collectedMinor, ''))}</td>
              <td>${esc(String(c.patientCount))} / ${esc(String(c.staffCount))}</td>
              <td class="row-actions">
                <button data-statement="${esc(c.id)}" data-name="${esc(c.name)}">${esc(t('account'))}</button>
                ${c.isActive ? `<button data-suspend="${esc(c.id)}">${esc(t('suspend'))}</button>` : `<button data-approve="${esc(c.id)}">${esc(t('accept'))}</button>`}
              </td>
            </tr>`,
          )
          .join('');
        const host = document.getElementById('admin-clinics') as HTMLElement;
        host.innerHTML = rows
          ? `<table class="table"><thead><tr><th>${esc(t('clinic'))}</th><th>${esc(t('kind'))}</th><th>${esc(t('plan'))}</th><th>${esc(t('subscription'))}</th><th>${esc(t('collected'))}</th><th>${esc(t('patients'))}/${esc(t('staff'))}</th><th>${esc(t('actions'))}</th></tr></thead><tbody>${rows}</tbody></table>`
          : `<p class="muted">${esc(t('noClinicsYet'))}</p>`;
        host.querySelectorAll<HTMLButtonElement>('button[data-approve]').forEach((button) => {
          button.addEventListener('click', () => {
            resellerApprove(button.dataset.approve ?? '')
              .then(() => {
                loadPending();
                loadClinics();
              })
              .catch((error: unknown) => toast(errorText(error), 'error'));
          });
        });
        host.querySelectorAll<HTMLButtonElement>('button[data-suspend]').forEach((button) => {
          button.addEventListener('click', () => {
            if (!window.confirm(t('suspendConfirm'))) return;
            resellerSuspend(button.dataset.suspend ?? '')
              .then(() => {
                loadClinics();
              })
              .catch((error: unknown) => toast(errorText(error), 'error'));
          });
        });
        host.querySelectorAll<HTMLButtonElement>('button[data-statement]').forEach((button) => {
          button.addEventListener('click', () => {
            void renderClinicAccount(button.dataset.statement ?? '', button.dataset.name ?? '');
          });
        });
      })
      .catch((error: unknown) => {
        (document.getElementById('admin-clinics') as HTMLElement).innerHTML =
          `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };

  loadPending();
  loadClinics();
}

async function renderClinicAccount(clinicId: string, name: string): Promise<void> {
  const host = document.getElementById('admin-statement') as HTMLElement;
  host.innerHTML = `<section class="card"><p class="muted">${esc(t('loading'))}</p></section>`;
  try {
    const statement = await resellerStatement(clinicId);
    const c = statement.clinic;
    host.innerHTML = `
      <section class="card">
        <h2>${esc(name)} - ${esc(t('subscriptionCollections'))}</h2>
        <p>${esc(t('plan'))}: <strong>${esc(c.plan)}</strong> <span class="pill">${esc(statusLabel(c.subscriptionStatus))}</span> ·
           ${esc(t('subscribed'))}: ${esc(c.subscribedAt ?? '—')} · ${esc(t('expires'))}: ${esc(c.expiresAt ?? '—')} ·
           ${esc(t('collected'))}: <strong>${esc(fmtMoney(statement.collectedMinor, ''))}</strong></p>
        <form id="sub-set" class="row">
          ${field(t('plan'), input('plan', 'text', c.plan))}
          ${field(t('status'), `<select name="status">
            ${['trial', 'active', 'expired', 'suspended'].map((s) => `<option value="${s}">${esc(statusLabel(s))}</option>`).join('')}
          </select>`)}
          ${field(t('expires'), input('expiresAt', 'date', c.expiresAt ?? ''))}
          <button type="submit">${esc(t('saveSubscription'))}</button>
        </form>
        <form id="sub-collect" class="row">
          ${field(t('collectUsd'), input('amount', 'text', '', 'required inputmode="decimal"'))}
          ${field(t('from'), input('periodStart', 'date', ''))}
          ${field(t('to'), input('periodEnd', 'date', ''))}
          ${field(t('reference'), input('reference', 'text', ''))}
          <button class="primary" type="submit">${esc(t('recordCollection'))}</button>
        </form>
        <h3>${esc(t('receipts'))} (${statement.receipts.length})</h3>
        ${
          statement.receipts.length > 0
            ? `<ul class="list">${statement.receipts
                .map(
                  (r) =>
                    `<li>${esc(fmtMoney(r.amountMinor, ''))}${r.reference ? ` · ${esc(t('reference'))}: ${esc(r.reference)}` : ''} <span class="muted">${esc(fmtDateTime(r.receivedAt))}</span></li>`,
                )
                .join('')}</ul>`
            : `<p class="muted">${esc(t('nothingCollectedYet'))}</p>`
        }
      </section>`;

    (document.querySelector('#sub-set select[name="status"]') as HTMLSelectElement).value = c.subscriptionStatus;
    (document.getElementById('sub-set') as HTMLFormElement).addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(event.target as HTMLFormElement);
      const text = (k: string): string | null => {
        const v = String(data.get(k) ?? '').trim();
        return v ? v : null;
      };
      resellerSubscription({
        clinicId,
        plan: String(data.get('plan') ?? c.plan),
        status: String(data.get('status') ?? c.subscriptionStatus),
        expiresAt: text('expiresAt'),
      })
        .then(() => renderClinicAccount(clinicId, name))
        .catch((error: unknown) => toast(errorText(error), 'error'));
    });
    (document.getElementById('sub-collect') as HTMLFormElement).addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(event.target as HTMLFormElement);
      const text = (k: string): string | null => {
        const v = String(data.get(k) ?? '').trim();
        return v ? v : null;
      };
      let amount = 0;
      try {
        amount = dollarsToMinor(String(data.get('amount') ?? ''));
      } catch (error) {
        toast(errorText(error), 'error');
        return;
      }
      resellerCollect({
        clinicId,
        amountMinor: amount,
        periodStart: text('periodStart'),
        periodEnd: text('periodEnd'),
        reference: text('reference'),
      })
        .then(() => renderClinicAccount(clinicId, name))
        .catch((error: unknown) => toast(errorText(error), 'error'));
    });
  } catch (error) {
    host.innerHTML = `<section class="card"><p class="muted">${esc(errorText(error))}</p></section>`;
  }
}

/**
 * Future modules, visibly inert: pharmacy + lab exist in types, tables and
 * API stubs, and switch on with one flag. Disabled here so nobody mistakes
 * them for live features.
 */
function futureModulesHtml(): string {
  const card = (icon: string, title: string): string =>
    `<div class="pcard"><h3>${icon} ${esc(title)}</h3>
      <p><span class="pill warn">${esc(t('comingSoon'))}</span></p>
      <p class="muted small">${esc(t('futureModulesHint'))}</p></div>`;
  return `<section class="card"><div class="pgrid">${card('💊', t('pharmacy'))}${card('🧪', t('laboratory'))}</div></section>`;
}
