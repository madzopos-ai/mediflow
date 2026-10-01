import { SPECIALTY_LABELS } from '@mediflow/shared';

import { specialtyLabel, statusLabel, t, tx, vitalLabelAr, weekdayLabel } from '../i18n.js';

import {
  avatarObjectUrl,
  clearPatientToken,
  directory,
  doctorSlots,
  patientBilling,
  patientBookCross,
  patientCancelAppointment,
  patientProfile,
  patientRecord,
  patientUpdateProfile,
  uploadAvatar,
  type UiDirectory,
  type UiNetworkProfileFull,
  type UiPatientBilling,
} from '../data.js';
import { errorText, esc, field, fmtDateTime, fmtMoney, input, toast } from '../ui.js';

export type PatientTab = 'health' | 'doctors' | 'profile' | 'appointments' | 'meds';

/**
 * The patient app: health, doctors, مواعيدي, دوائي, and my info.
 * No staff navigation ever renders here (see main.ts paintNav).
 */
export function renderPatientHome(root: HTMLElement, tab: PatientTab = 'health'): void {
  // Firebase-native patient session: profile (file), health (records),
  // doctors (directory), appointments (مواعيدي), meds (دوائي).
  if (isFirebasePatientSession()) {
    if (tab === 'profile') {
      renderFbProfileTab(root);
      return;
    }
    if (tab === 'doctors') {
      renderFbDoctorsTab(root);
      return;
    }
    if (tab === 'appointments') {
      renderFbAppointmentsTab(root);
      return;
    }
    if (tab === 'meds') {
      renderFbMedsTab(root);
      return;
    }
    renderFbHealthTab(root);
    return;
  }
  if (tab === 'doctors') {
    renderDoctorsTab(root);
    return;
  }
  if (tab === 'profile') {
    renderProfileTab(root);
    return;
  }
  if (tab === 'appointments') {
    renderFbAppointmentsTab(root);
    return;
  }
  if (tab === 'meds') {
    renderFbMedsTab(root);
    return;
  }
  renderHealthTab(root);
}

function isFirebasePatientSession(): boolean {
  try {
    return localStorage.getItem('mf_patient_fb') !== null;
  } catch {
    return false;
  }
}

function signOutButton(): string {
  return `<button id="plogout" class="ghost">${esc(t('signOut'))}</button>`;
}

function wireSignOut(): void {
  (document.getElementById('plogout') as HTMLButtonElement).addEventListener('click', () => {
    // Local sessions die FIRST and synchronously: routing must see a
    // logged-out device even if the Firebase sign-out below is still flying.
    clearPatientToken();
    try {
      localStorage.removeItem('mf_patient_fb');
    } catch {
      // Never block sign-out on storage.
    }
    window.location.hash = '#/login';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    // Then drop the anonymous Auth session in the background (staff Auth is
    // never touched: only an anonymous user is signed out here).
    void import('../firebase.js')
      .then((fb) => {
        if (!fb.isFirebaseConfigured()) return;
        return fb
          .firebaseUser()
          .then((user) => {
            if (user?.isAnonymous) return fb.signOutDoctor().catch(() => undefined);
            return undefined;
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
  });
}

function renderHealthTab(root: HTMLElement): void {
  root.innerHTML = `
    ${signOutButton()}
    <div class="pgrid" id="p-cards"><div class="pcard"><p class="muted">…</p></div></div>
    <div id="p-modal-host"></div>`;
  wireSignOut();

  patientRecord()
    .then((record) => {
      // Billing is best-effort: the finance ledger needs connectivity, while
      // the clinical record may come from cache. A failed billing fetch must
      // never hide the health cards.
      return patientBilling()
        .then((billing) => ({ record, billing: billing as UiPatientBilling | null }))
        .catch(() => ({ record, billing: null as UiPatientBilling | null }));
    })
    .then(({ record, billing }) => {
      const now = new Date().toISOString();
      const upcoming = record.clinics
        .flatMap((c) => c.appointments.map((a) => ({ ...a, clinicName: c.clinicName })))
        .filter((a) => a.startsAt >= now && a.status !== 'cancelled')
        .sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
      const meds = record.clinics.flatMap((c) =>
        c.prescriptions.map((rx) => ({ ...rx, clinicName: c.clinicName })),
      );
      const medCount = meds.reduce((sum, rx) => sum + rx.items.length, 0);
      const reminders = record.clinics
        .flatMap((c) => c.reminders.map((r) => ({ ...r, clinicName: c.clinicName })))
        .sort((a, b) => (a.scheduledFor < b.scheduledFor ? -1 : 1));
      const tests = record.clinics.flatMap((c) =>
        c.requestedTests.filter((t) => t.status === 'requested').map((t) => ({ ...t, clinicName: c.clinicName })),
      );
      const visits = record.clinics.reduce((sum, c) => sum + c.visits.length, 0);

      const cards: { key: string; title: string; accent: string; summary: string; detail: string }[] = [
        {
          key: 'profile',
          title: record.profile.fullName,
          accent: '',
          summary: `<p class="muted" dir="ltr">${esc(record.profile.phone)}</p>`,
          detail:
            `<p dir="ltr">${esc(record.profile.phone)}</p>` +
            (record.profile.dateOfBirth ? `<p>${esc(t('dobShort'))}: ${esc(record.profile.dateOfBirth)}</p>` : '') +
            `<p>${esc(String(record.clinics.length))} ${esc(t('clinicsOnFile'))}</p>`,
        },
        {
          key: 'record',
          title: t('myHealthRecord'),
          accent: 'accent-blue',
          summary: `<div class="big">${record.clinics.length}</div><p class="muted">${record.clinics.length} ${esc(t('clinics'))} · ${visits} ${esc(t('visits'))}</p>`,
          detail:
            record.clinics.length > 0
              ? record.clinics
                  .map(
                    (c) => `<div class="vital-card">
                      <div class="vital-top"><strong>${esc(c.clinicName)}</strong></div>
                      ${
                        c.prescriptions.length > 0
                          ? `<div>${esc(t('medicationsLabel'))}: ${esc(c.prescriptions.flatMap((p) => p.items.map((i) => i.drug)).slice(0, 6).join(', '))}</div>`
                          : ''
                      }
                      ${
                        c.vitals.length > 0
                          ? `<div class="muted small">${esc(t('vitals'))}: ${esc(c.vitals[0]?.kind ?? '')} ${esc(String(c.vitals[0]?.value ?? ''))}</div>`
                          : ''
                      }
                      <div class="muted small">${c.visits.length} ${esc(t('visits'))} · ${c.appointments.length} ${esc(t('myAppointments'))}</div>
                    </div>`,
                  )
                  .join('')
              : `<p class="muted">${esc(t('noVisitsYet'))}</p>`,
        },
        {
          key: 'appts',
          title: t('myAppointments'),
          accent: 'accent-purple',
          summary:
            upcoming.length > 0
              ? `<div class="big">${upcoming.length}</div><p class="muted">${esc(fmtDateTime(upcoming[0]?.startsAt ?? ''))}</p>`
              : `<p class="muted">${esc(t('noUpcomingAppts'))}</p>`,
          detail:
            upcoming.length > 0
              ? `<ul class="list">${upcoming
                  .map(
                    (a) => `<li>${esc(fmtDateTime(a.startsAt))} <span class="muted">${esc(a.clinicName)}</span> <span class="pill">${esc(statusLabel(a.status))}</span>
                      <button data-cancelappt="${esc(a.id)}">${esc(t('cancelBtn'))}</button></li>`,
                  )
                  .join('')}</ul>`
              : `<p class="muted">${esc(t('noUpcomingAppts'))}</p>`,
        },
        {
          key: 'meds',
          title: t('myMedications'),
          accent: '',
          summary:
            medCount > 0
              ? `<div class="big">${medCount}</div><p class="muted">${esc(meds[0]?.items[0]?.drug ?? '')}${medCount > 1 ? ` +${medCount - 1}` : ''}</p>`
              : `<p class="muted">${esc(t('noActiveRx'))}</p>`,
          detail:
            meds.length > 0
              ? meds
                  .map(
                    (rx) => `<div class="vital-card">
                      <div class="muted small">${esc(rx.clinicName)}</div>
                      <ul class="list">${rx.items
                        .map(
                          (i) =>
                            `<li><strong>${esc(i.drug)}</strong> ${esc(i.dose ?? '')} — ${esc(i.frequency ?? '')}</li>`,
                        )
                        .join('')}</ul>
                    </div>`,
                  )
                  .join('')
              : `<p class="muted">${esc(t('noActiveRx'))}</p>`,
        },
        {
          key: 'reminders',
          title: t('reminders'),
          accent: 'accent-amber',
          summary:
            reminders.length > 0
              ? `<div class="big">${reminders.length}</div><p class="muted">${esc(fmtDateTime(reminders[0]?.scheduledFor ?? ''))}</p>`
              : `<p class="muted">${esc(t('noReminders'))}</p>`,
          detail:
            reminders.length > 0
              ? `<ul class="list">${reminders
                  .map((r) => `<li>${esc(fmtDateTime(r.scheduledFor))} — ${esc(r.template)} <span class="muted">${esc(r.clinicName)}</span></li>`)
                  .join('')}</ul>`
              : `<p class="muted">${esc(t('noReminders'))}</p>`,
        },
        {
          key: 'tests',
          title: t('requestedTestsTitle'),
          accent: 'accent-blue',
          summary:
            tests.length > 0
              ? `<div class="big">${tests.length}</div><p class="muted">${esc(t('pending'))}</p>`
              : `<p class="muted">${esc(t('noPendingTests'))}</p>`,
          detail:
            tests.length > 0
              ? `<ul class="list">${tests
                  .map((test) => `<li><strong>${esc(test.name)}</strong> <span class="pill">${esc(statusLabel(test.status))}</span> <span class="muted">${esc(test.clinicName)}</span></li>`)
                  .join('')}</ul>`
              : `<p class="muted">${esc(t('noPendingTests'))}</p>`,
        },
        {
          key: 'billing',
          title: t('myBilling'),
          accent: 'accent-green',
          summary: billing
            ? billing.summary.outstandingMinor > 0
              ? `<div class="big">${esc(fmtMoney(billing.summary.outstandingMinor, billing.summary.currency))}</div><p class="muted">${esc(t('outstandingPatient'))}</p>`
              : `<p class="muted">${esc(t('cleared'))} · ${esc(fmtMoney(billing.summary.paidMinor, billing.summary.currency))}</p>`
            : `<p class="muted">${esc(t('billingUnavailable'))}</p>`,
          detail: billing ? billingDetail(billing) : `<p class="muted">${esc(t('billingUnavailable'))}</p>`,
        },
      ];

      (document.getElementById('p-cards') as HTMLElement).innerHTML = cards
        .map(
          (c) =>
            `<div class="pcard ${c.accent}" data-card="${c.key}" role="button" tabindex="0">
              <h3>${esc(c.title)}</h3>${c.summary}<p class="muted small">${esc(t('tapForDetails'))}</p>
            </div>`,
        )
        .join('');

      const openCard = (key: string): void => {
        const card = cards.find((c) => c.key === key);
        if (!card) return;
        const host = document.getElementById('p-modal-host') as HTMLElement;
        host.innerHTML = `
          <div class="modal-overlay">
            <div class="modal" role="dialog" aria-label="${esc(card.title)}">
              <div class="modal-top"><h3>${esc(card.title)}</h3><button id="pmodal-close">✕</button></div>
              ${card.detail}
            </div>
          </div>`;
        const close = (): void => {
          host.innerHTML = '';
        };
        (document.getElementById('pmodal-close') as HTMLButtonElement).addEventListener('click', close);
        host.querySelector('.modal-overlay')?.addEventListener('click', (event) => {
          if ((event.target as HTMLElement).classList.contains('modal-overlay')) close();
        });
        host.querySelectorAll<HTMLButtonElement>('button[data-cancelappt]').forEach((button) => {
          button.addEventListener('click', () => {
            patientCancelAppointment(button.dataset.cancelappt ?? '')
              .then(() => {
                close();
                renderHealthTab(root);
              })
              .catch((error: unknown) => toast(errorText(error), 'error'));
          });
        });
      };

      document.querySelectorAll<HTMLElement>('#p-cards .pcard').forEach((el) => {
        const open = (): void => openCard(el.dataset.card ?? '');
        el.addEventListener('click', open);
        el.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
          }
        });
      });
    })
    .catch((error: unknown) => {
      (document.getElementById('p-cards') as HTMLElement).innerHTML =
        `<div class="pcard"><p class="muted">${esc(errorText(error))}</p></div>`;
    });
}

function specFallback(key: string): string {
  const labels = SPECIALTY_LABELS as Record<string, string>;
  return labels[key] ?? key;
}

/**
 * Patient billing detail: settled vs still-owed invoices plus payment history.
 * Money is formatted from integer minor units - never floats.
 */
function billingDetail(billing: UiPatientBilling): string {
  const head =
    `<p>${esc(t('totalBilledPatient'))}: <strong>${esc(fmtMoney(billing.summary.billedMinor, billing.summary.currency))}</strong> · ` +
    `${esc(t('totalPaidPatient'))}: <strong>${esc(fmtMoney(billing.summary.paidMinor, billing.summary.currency))}</strong> · ` +
    `${esc(t('outstandingPatient'))}: <strong>${esc(fmtMoney(billing.summary.outstandingMinor, billing.summary.currency))}</strong></p>`;
  if (billing.invoices.length === 0) return head + `<p class="muted">${esc(t('noBilling'))}</p>`;
  const rows = billing.invoices
    .map((inv) => {
      const left = Math.max(0, inv.patientShareMinor - inv.paidMinor);
      const settled = left <= 0;
      return `<li><strong>${esc(inv.number)}</strong> — ${esc(fmtMoney(inv.patientShareMinor, inv.currency))} · ` +
        `${settled ? `<span class="pill ok">${esc(t('cleared'))}</span>` : `<span class="pill warn">${esc(t('pendingBalance'))}: ${esc(fmtMoney(left, inv.currency))}</span>`} ` +
        `<span class="muted">${esc(fmtDateTime(inv.createdAt))}</span></li>`;
    })
    .join('');
  const payRows =
    billing.payments.length > 0
      ? `<h4>${esc(t('paymentHistory'))}</h4><ul class="list">${billing.payments
          .map((p) => `<li>${esc(fmtMoney(p.amountMinor, billing.summary.currency))} · ${esc(p.method ?? '—')} <span class="muted">${esc(fmtDateTime(p.createdAt))}</span></li>`)
          .join('')}</ul>`
      : '';
  return head + `<ul class="list">${rows}</ul>` + payRows;
}

function initials(name: string): string {
  const parts = name.replace(/^Dr\.?\s+/i, '').split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '•';
}

/**
 * Firebase-native health tab: the patient's own account plus one shared
 * snapshot card per linked clinic (written by staff via "share snapshot").
 * Nothing here needs the API server. No linking UI: the clinic finds the
 * patient by phone and imports them - the patient only fills their file.
 */
function renderFbHealthTab(root: HTMLElement): void {
  root.innerHTML = `
    ${signOutButton()}
    <div class="pgrid" id="p-cards"><div class="pcard"><p class="muted">…</p></div></div>
    <section class="card" id="p-history">
      <h2>${esc(t('vitalsHistory'))}</h2>
      <p class="muted">${esc(t('vitalsHistoryHint'))}</p>
      <div id="phist-list"><p class="muted">${esc(t('loading'))}</p></div>
    </section>
    <div id="p-modal-host"></div>`;
  wireSignOut();
  loadReadingsHistory();

  void import('../patientAuth.js')
    .then((pa) => Promise.all([pa.fbPatientAccount(), pa.mySharedRecords()]))
    .then(([account, records]) => {
      const cards: { key: string; title: string; accent: string; summary: string; detail: string }[] = [
        {
          key: 'profile',
          title: account.fullName,
          accent: '',
          summary: `<p class="muted" dir="ltr">${esc(account.phone)}</p>`,
          detail:
            `<p dir="ltr">${esc(account.phone)}</p>` +
            (account.dateOfBirth ? `<p>${esc(t('dobShort'))}: ${esc(account.dateOfBirth)}</p>` : '') +
            `<p>${esc(String(Object.keys(account.links).length))} ${esc(t('clinicsOnFile'))}</p>`,
        },
      ];
      if (records.length === 0) {
        cards.push({
          key: 'empty',
          title: t('myHealthRecord'),
          accent: 'accent-blue',
          summary: `<p class="muted">${esc(t('noSharedYet'))}</p>`,
          detail: `<p class="muted">${esc(t('noSharedYet'))}</p>`,
        });
      }
      for (const rec of records) {
        const medCount = rec.medications.length;
        cards.push({
          key: `rec-${rec.clinicId}`,
          title: rec.clinicName,
          accent: 'accent-blue',
          summary:
            medCount > 0
              ? `<div class="big">${medCount}</div><p class="muted">${esc(rec.medications[0]?.drug ?? '')}${medCount > 1 ? ` +${medCount - 1}` : ''}</p>`
              : `<p class="muted">${esc(fmtDateTime(rec.updatedAt))}</p>`,
          detail:
            (rec.medications.length > 0
              ? `<ul class="list">${rec.medications.map((m) => `<li><strong>${esc(m.drug)}</strong> ${esc(m.dose ?? '')} — ${esc(m.frequency ?? '')}</li>`).join('')}</ul>`
              : `<p class="muted">${esc(t('noActiveRx'))}</p>`) +
            (rec.vitals.length > 0
              ? `<ul class="list">${rec.vitals.slice(0, 8).map((v) => `<li>${esc(v.kind)}: <strong>${esc(String(v.value))} ${esc(v.unit)}</strong></li>`).join('')}</ul>`
              : '') +
            `<p class="muted">${esc(fmtDateTime(rec.updatedAt))}</p>`,
        });
      }

      (document.getElementById('p-cards') as HTMLElement).innerHTML = cards
        .map(
          (c) =>
            `<div class="pcard ${c.accent}" data-card="${esc(c.key)}" role="button" tabindex="0">
              <h3>${esc(c.title)}</h3>${c.summary}<p class="muted small">${esc(t('tapForDetails'))}</p>
            </div>`,
        )
        .join('');

      const openCard = (key: string): void => {
        const card = cards.find((c) => c.key === key);
        if (!card) return;
        const host = document.getElementById('p-modal-host') as HTMLElement;
        host.innerHTML = `
          <div class="modal-overlay">
            <div class="modal" role="dialog" aria-label="${esc(card.title)}">
              <div class="modal-top"><h3>${esc(card.title)}</h3><button id="pmodal-close">✕</button></div>
              ${card.detail}
            </div>
          </div>`;
        const close = (): void => {
          host.innerHTML = '';
        };
        (document.getElementById('pmodal-close') as HTMLButtonElement).addEventListener('click', close);
        host.querySelector('.modal-overlay')?.addEventListener('click', (event) => {
          if ((event.target as HTMLElement).classList.contains('modal-overlay')) close();
        });
      };

      document.querySelectorAll<HTMLElement>('#p-cards .pcard').forEach((el) => {
        const open = (): void => openCard(el.dataset.card ?? '');
        el.addEventListener('click', open);
        el.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
          }
        });
      });
    })
    .catch((error: unknown) => {
      (document.getElementById('p-cards') as HTMLElement).innerHTML =
        `<div class="pcard"><p class="muted">${esc(errorText(error))}</p></div>`;
    });
}

/** Firebase-native profile tab: the patient edits their own account doc. */
/** Firebase profile tab: filled once, then shown as cards with an edit. */
/**
 * Readings history (My health): the patient's confirmed readings grouped by
 * kind, newest first - weight, labs and vitals trending across months.
 */
function loadReadingsHistory(): void {
  const host = document.getElementById('phist-list');
  if (!host) return;
  void import('../patientAuth.js')
    .then((pa) => pa.listPatientVitals())
    .then((vitals) => {
      const el = document.getElementById('phist-list');
      if (!el) return;
      if (vitals.length === 0) {
        el.innerHTML = `<p class="muted">${esc(t('noReadingsYet'))}</p>`;
        return;
      }
      const groups = new Map<string, typeof vitals>();
      for (const v of vitals) {
        const list = groups.get(v.kind) ?? [];
        list.push(v);
        groups.set(v.kind, list);
      }
      el.innerHTML =
        `<div class="pgrid">` +
        [...groups.entries()]
          .map(
            ([kind, rows]) => `<div class="pcard accent-blue"><h3>${esc(vitalLabelAr(kind, kind))}</h3>
              <div class="big">${esc(String(rows[0]?.value ?? ''))} <small>${esc(rows[0]?.unit ?? '')}</small></div>
              <ul class="list">${rows
                .slice(0, 8)
                .map((r) => `<li>${esc(String(r.value))} ${esc(r.unit)} <span class="muted">${esc(fmtDateTime(r.measuredAt))}</span></li>`)
                .join('')}</ul>
            </div>`,
          )
          .join('') +
        `</div>`;
    })
    .catch((error: unknown) => {
      const el = document.getElementById('phist-list');
      if (el) el.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
    });
}

/** Patient labs: upload a test photo, OCR it like the clinic does, keep data. */
function loadPatientLabs(): void {
  const listHost = document.getElementById('plab-list');
  const paint = (): void => {
    if (!listHost) return;
    void import('../patientAuth.js')
      .then((pa) => Promise.all([pa.listPatientUploads(), pa.listPatientVitals()]))
      .then(([uploads, vitals]) => {
        const host = document.getElementById('plab-list');
        if (!host) return;
        host.innerHTML =
          (vitals.length > 0
            ? `<h4>${esc(t('myReadings'))}</h4><ul class="list">${vitals
                .slice(0, 20)
                .map((v) => `<li>${esc(vitalLabelAr(v.kind, v.kind))}: <strong>${esc(String(v.value))} ${esc(v.unit)}</strong></li>`)
                .join('')}</ul>`
            : '') +
          (uploads.length > 0
            ? `<h4>${esc(t('myUploads'))}</h4><div class="pgrid">${uploads
                .map(
                  (u) => `<div class="pcard"><div class="muted small">${esc(u.fileName)}</div>
                    ${u.dataUrl ? `<img src="${esc(u.dataUrl)}" alt="" loading="lazy" style="max-width:100%;border-radius:8px" />` : ''}</div>`,
                )
                .join('')}</div>`
            : `<p class="muted">${esc(t('noUploadsYet'))}</p>`);
      })
      .catch((error: unknown) => {
        if (listHost) listHost.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };
  paint();

  (document.getElementById('plab-upload') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const file = (new FormData(event.target as HTMLFormElement).get('photo') as File | null) ?? null;
    if (!(file instanceof File)) return;
    const ocrHost = document.getElementById('plab-ocr') as HTMLElement;
    ocrHost.innerHTML = `<p class="muted">${esc(t('readingPhoto'))}</p>`;
    void import('../patientAuth.js')
      .then((pa) => pa.uploadPatientFile(file, file.name))
      .then(async (uploaded) => {
        paint();
        // Same OCR-to-data pipeline the clinic uses: read, parse, confirm.
        const [{ ocrText }, shared] = await Promise.all([
          import('./labOcr.js'),
          import('@mediflow/shared'),
        ]);
        void uploaded;
        const text = await ocrText(file);
        const values = shared.parseLabPanel(text);
        if (values.length === 0) {
          ocrHost.innerHTML = `<p class="muted">${esc(t('noLabRecognised'))}</p>`;
          return;
        }
        ocrHost.innerHTML =
          `<p>${esc(tx('foundReadings', { n: values.length }))}</p>` +
          `<form id="plab-confirm"><ul class="list">` +
          values
            .map(
              (v, i) => `<li><label class="check"><input type="checkbox" name="v${i}" checked />
                <strong>${esc(vitalLabelAr(v.kind, shared.vitalLabel(v.kind)))}</strong>: ${esc(String(v.value))} ${esc(v.unit)}
              </label></li>`,
            )
            .join('') +
          `</ul><button class="primary" type="submit">${esc(t('saveChecked'))}</button></form>`;
        (document.getElementById('plab-confirm') as HTMLFormElement).addEventListener('submit', (ev) => {
          ev.preventDefault();
          const picked = values.filter((_, i) => (new FormData(ev.target as HTMLFormElement).get(`v${i}`) === 'on'));
          if (picked.length === 0) {
            toast(t('nothingChecked'));
            return;
          }
          void import('../patientAuth.js')
            .then((pa2) => pa2.savePatientVitals(picked.map((v) => ({ kind: v.kind, value: v.value, unit: v.unit }))))
            .then((n) => {
              toast(tx('savedToVitals', { n }));
              ocrHost.innerHTML = '';
              paint();
            })
            .catch((error: unknown) => toast(errorText(error), 'error'));
        });
      })
      .catch((error: unknown) => {
        ocrHost.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
      });
  });
}

function renderFbProfileTab(root: HTMLElement, editMode = false): void {
  root.innerHTML = `
    ${signOutButton()}
    <section class="card">
      <h2>${esc(t('myHealthFile'))}</h2>
      <p class="muted">${esc(t('myHealthFileHint'))}</p>
      <div id="p-profile-form"><p class="muted">…</p></div>
    </section>
    <section class="card" id="p-labs">
      <h2>${esc(t('myLabs'))}</h2>
      <p class="muted">${esc(t('myLabsHint'))}</p>
      <form id="plab-upload" class="row">
        ${field(t('labPhotoTitle'), `<input name="photo" type="file" accept="image/*" required />`)}
        <button class="primary" type="submit">${esc(t('uploadPhoto'))}</button>
      </form>
      <div id="plab-ocr"></div>
      <div id="plab-list"><p class="muted">${esc(t('loading'))}</p></div>
    </section>`;
  wireSignOut();
  loadPatientLabs();

  void import('../patientAuth.js')
    .then((pa) => pa.fbPatientAccount())
    .then((account) => {
      // First visit: empty file -> fill form. Afterwards: pretty cards + Edit.
      const showForm =
        editMode ||
        !(
          account.address ||
          account.weightKg !== null ||
          account.heightCm !== null ||
          account.bloodGroup ||
          account.chronicConditions.length > 0 ||
          account.allergies.length > 0 ||
          account.currentMedications.length > 0 ||
          account.pastSurgeries.length > 0 ||
          account.healthNotes
        );
      if (!showForm) {
        renderFbProfileCards(root, account);
        return;
      }
      const num = (v: number | null): string => (v === null || v === undefined ? '' : String(v));
      (document.getElementById('p-profile-form') as HTMLElement).innerHTML = `
        <form id="fb-profile-edit" class="grid-form">
          ${field(t('firstName'), input('firstName', 'text', account.firstName, 'required'))}
          ${field(t('lastName'), input('lastName', 'text', account.lastName, 'required'))}
          ${field(t('phoneLoginFixed'), input('phone', 'tel', account.phone, 'disabled'))}
          ${field(t('dateOfBirth'), input('dateOfBirth', 'date', account.dateOfBirth ?? ''))}
          ${field(t('address'), input('address', 'text', account.address ?? ''))}
          ${field(t('weightKg'), input('weightKg', 'number', num(account.weightKg), 'min="0.5" max="500" step="0.1"'))}
          ${field(t('heightCm'), input('heightCm', 'number', num(account.heightCm), 'min="20" max="260" step="1"'))}
          ${field(t('bloodGroup'), input('bloodGroup', 'text', account.bloodGroup ?? '', 'placeholder="A+"'))}
          ${field(t('chronicLabel'), input('chronicConditions', 'text', account.chronicConditions.join(', ')))}
          ${field(t('allergiesLabel'), input('allergies', 'text', account.allergies.join(', ')))}
          ${field(t('currentMedsLabel'), input('currentMedications', 'text', account.currentMedications.join(', ')))}
          ${field(t('surgeriesLabel'), input('pastSurgeries', 'text', account.pastSurgeries.join(', ')))}
          ${field(t('healthNotesLabel'), `<textarea name="healthNotes" rows="3">${esc(account.healthNotes ?? '')}</textarea>`)}
          <button class="primary" type="submit">${esc(t('save'))}</button>
        </form>`;
      (document.getElementById('fb-profile-edit') as HTMLFormElement).addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(event.target as HTMLFormElement);
        const dob = String(data.get('dateOfBirth') ?? '').trim();
        const text = (k: string): string | null => {
          const v = String(data.get(k) ?? '').trim();
          return v ? v : null;
        };
        const numOrNull = (k: string): number | null => {
          const raw = String(data.get(k) ?? '').trim();
          if (!raw) return null;
          const n = Number(raw);
          return Number.isFinite(n) ? n : null;
        };
        const csv = (k: string): string[] =>
          String(data.get(k) ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        void import('../patientAuth.js')
          .then((pa2) =>
            pa2.updateFbPatientProfile({
              firstName: String(data.get('firstName') ?? ''),
              lastName: String(data.get('lastName') ?? ''),
              dateOfBirth: dob ? dob : null,
              address: text('address'),
              weightKg: numOrNull('weightKg'),
              heightCm: numOrNull('heightCm'),
              bloodGroup: text('bloodGroup'),
              chronicConditions: csv('chronicConditions'),
              allergies: csv('allergies'),
              currentMedications: csv('currentMedications'),
              pastSurgeries: csv('pastSurgeries'),
              healthNotes: text('healthNotes'),
            }),
          )
          .then(() => {
            toast(t('saved'));
            renderFbProfileTab(root);
          })
          .catch((error: unknown) => toast(errorText(error), 'error'));
      });
    })
    .catch((error: unknown) => {
      (document.getElementById('p-profile-form') as HTMLElement).innerHTML =
        `<p class="muted">${esc(errorText(error))}</p>`;
    });
}

type FbAccountShape = {
  fullName: string;
  phone: string;
  dateOfBirth: string | null;
  address: string | null;
  weightKg: number | null;
  heightCm: number | null;
  bloodGroup: string | null;
  chronicConditions: string[];
  allergies: string[];
  currentMedications: string[];
  pastSurgeries: string[];
  healthNotes: string | null;
};

/** Read-only pretty cards + one Edit button. */
function renderFbProfileCards(root: HTMLElement, account: FbAccountShape): void {
  const host = document.getElementById('p-profile-form') as HTMLElement;
  const csv = (items: string[]): string => (items.length > 0 ? items.join('، ') : '—');
  const val = (v: string | number | null | undefined, suffix = ''): string =>
    v === null || v === undefined || v === '' ? '—' : `${v}${suffix}`;
  host.innerHTML = `
    <div class="pgrid">
      <div class="pcard"><h3>${esc(account.fullName)}</h3>
        <p class="muted" dir="ltr">${esc(account.phone)}</p>
        <p>${esc(t('dobShort'))}: ${esc(account.dateOfBirth ?? '—')}</p>
        <p>${esc(t('address'))}: ${esc(account.address ?? '—')}</p>
      </div>
      <div class="pcard accent-blue"><h3>${esc(t('vitals'))}</h3>
        <p>${esc(t('weight'))}: <strong>${esc(val(account.weightKg, ' كغ'))}</strong></p>
        <p>${esc(t('height'))}: <strong>${esc(val(account.heightCm, ' سم'))}</strong></p>
        <p>${esc(t('bloodGroup'))}: <strong>${esc(val(account.bloodGroup))}</strong></p>
      </div>
      <div class="pcard accent-purple"><h3>${esc(t('chronicTitle'))}</h3><p>${esc(csv(account.chronicConditions))}</p>
        <h3>${esc(t('allergiesTitle'))}</h3><p>${esc(csv(account.allergies))}</p>
      </div>
      <div class="pcard accent-amber"><h3>${esc(t('currentMedsTitle'))}</h3><p>${esc(csv(account.currentMedications))}</p>
        <h3>${esc(t('surgeriesTitle'))}</h3><p>${esc(csv(account.pastSurgeries))}</p>
      </div>
      ${account.healthNotes ? `<div class="pcard"><h3>${esc(t('healthNotesLabel'))}</h3><p>${esc(account.healthNotes)}</p></div>` : ''}
    </div>
    <div class="row"><button id="p-edit" class="primary">${esc(t('edit'))}</button></div>`;
  (document.getElementById('p-edit') as HTMLButtonElement).addEventListener('click', () => {
    renderFbProfileTab(root, true);
  });
}

/**
 * Firebase doctors tab: every registered doctor as a beautiful card, with a
 * search bar, a recently-visited row, and a booking request on each card.
 */
function renderFbDoctorsTab(root: HTMLElement): void {
  root.innerHTML = `
    ${signOutButton()}
    <section class="card docs-light">
      <h2>${esc(t('doctors'))}</h2>
      <p class="muted">${esc(t('doctorsFbHint'))}</p>
      <div class="row">
        ${field(t('searchDoctors'), input('doc-q', 'search', '', 'autocomplete="off"'))}
        <button type="button" id="doc-near">${esc(t('nearestFirst'))}</button>
      </div>
      <div id="doc-specs" class="row"></div>
      <div id="doc-recent"></div>
      <div id="doc-list"><p class="muted">…</p></div>
    </section>`;
  wireSignOut();

  interface DocEntry {
    doctor: { uid: string; name: string; avatarUrl: string | null; specialty: string | null; phone: string | null };
    clinicId: string;
    clinicName: string;
    clinicPhone: string | null;
    clinicAddress: string | null;
    location: { lat: number; lng: number } | null;
    workingHours: { weekday: number; enabled: boolean; start: string; end: string; start2?: string | null; end2?: string | null }[] | null;
    slotDurationMinutes: number;
    visitDurations: { consultation: number; follow_up: number; procedure: number; teleconsult: number } | null;
    distanceKm: number | null;
  }

  let all: DocEntry[] = [];
  let nearestOn = false;
  let activeSpec: string | null = null;
  let mapsLink: (lat: number, lng: number) => string = () => '#';

  /** Specialties present, with Arabic labels for chips + smart search. */
  function presentSpecs(): { key: string; label: string }[] {
    const keys = [...new Set(all.map((e) => e.doctor.specialty ?? 'general'))];
    return keys.map((key) => ({ key, label: specialtyLabel(key, t('generalSpec')) }));
  }

  function paintChips(): void {
    const host = document.getElementById('doc-specs');
    if (!host) return;
    const specs = presentSpecs();
    host.innerHTML =
      `<button data-spec="" class="${activeSpec === null ? 'chip-active' : ''}">${esc(t('all'))}</button>` +
      specs
        .map((s) => `<button data-spec="${esc(s.key)}" class="${activeSpec === s.key ? 'chip-active' : ''}">${esc(s.label)}</button>`)
        .join('');
    host.querySelectorAll<HTMLButtonElement>('button[data-spec]').forEach((button) => {
      button.addEventListener('click', () => {
        activeSpec = button.dataset.spec || null;
        paintChips();
        paintDocs(currentQuery());
      });
    });
  }

  function currentQuery(): string {
    return (document.querySelector('input[name="doc-q"]') as HTMLInputElement).value.trim().toLowerCase();
  }

  /** Smart search: typing a specialty name (ar/en) jumps to its tab. */
  function smartSpec(q: string): void {
    if (!q) {
      if (activeSpec !== null) {
        activeSpec = null;
        paintChips();
      }
      return;
    }
    const hit = presentSpecs().find(
      (s) => s.label.toLowerCase().includes(q) || s.key.toLowerCase().includes(q),
    );
    const next = hit ? hit.key : null;
    if (next !== activeSpec) {
      activeSpec = next;
      paintChips();
    }
  }

  void import('../patientAuth.js')
    .then(async (pa) => {
      mapsLink = pa.mapsLink;
      const [clinics, records] = await Promise.all([
        pa.listPublicClinics(),
        pa.mySharedRecords().catch(() => []),
      ]);
      const recentClinics = new Set(records.map((r) => r.clinicId));
      const withDoctors = await Promise.all(
        clinics.map(async (c) => ({
          clinic: c,
          doctors: await pa.listPublicDoctors(c.clinicId).catch(() => []),
        })),
      );
      const flat: DocEntry[] = [];
      for (const e of withDoctors) {
        for (const d of e.doctors) {
          flat.push({
            doctor: { uid: d.uid, name: d.name, avatarUrl: d.avatarUrl, specialty: d.specialty, phone: d.phone },
            clinicId: e.clinic.clinicId,
            clinicName: e.clinic.name,
            clinicPhone: e.clinic.phone,
            clinicAddress: e.clinic.address,
            location: e.clinic.location,
            workingHours: e.clinic.workingHours,
            slotDurationMinutes: e.clinic.slotDurationMinutes,
            visitDurations: e.clinic.visitDurations,
            distanceKm: null,
          });
        }
      }
      return { flat, recentClinics };
    })
    .then(({ flat, recentClinics }) => {
      all = flat;
      const recent = all.filter((e) => recentClinics.has(e.clinicId));
      const recentHost = document.getElementById('doc-recent') as HTMLElement;
      if (recent.length > 0) {
        recentHost.innerHTML = `<h3>${esc(t('recentlyVisited'))}</h3><div class="pgrid">${recent
          .slice(0, 4)
          .map((e) => miniDocCard(e))
          .join('')}</div>`;
      }
      paintDocs('');
      paintChips();
      (document.querySelector('input[name="doc-q"]') as HTMLInputElement).addEventListener('input', (event) => {
        const q = (event.target as HTMLInputElement).value.trim().toLowerCase();
        smartSpec(q);
        paintDocs(q);
      });
      (document.getElementById('doc-near') as HTMLButtonElement).addEventListener('click', (event) => {
        const button = event.target as HTMLButtonElement;
        if (!('geolocation' in navigator)) {
          toast(t('gpsUnavailable'), 'error');
          return;
        }
        button.disabled = true;
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const { latitude, longitude } = pos.coords;
            for (const e of all) {
              e.distanceKm = e.location ? haversineKm(latitude, longitude, e.location.lat, e.location.lng) : null;
            }
            all.sort((a, b) => (a.distanceKm ?? 99999) - (b.distanceKm ?? 99999));
            nearestOn = true;
            paintDocs((document.querySelector('input[name="doc-q"]') as HTMLInputElement).value.trim().toLowerCase());
            button.disabled = false;
          },
          () => {
            button.disabled = false;
            toast(t('gpsDenied'), 'error');
          },
          { timeout: 15000, maximumAge: 60000 },
        );
      });
    })
    .catch((error: unknown) => {
      (document.getElementById('doc-list') as HTMLElement).innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
    });

  function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const rad = (d: number): number => (d * Math.PI) / 180;
    const a =
      Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(a));
  }

  function miniDocCard(e: DocEntry): string {
    return `<div class="pcard accent-blue"><div class="doc-row">
      ${e.doctor.avatarUrl ? `<img class="avatar" src="${esc(e.doctor.avatarUrl)}" alt="" loading="lazy" />` : `<span class="avatar">${esc(initials(e.doctor.name))}</span>`}
      <div><strong>${esc(e.doctor.name)}</strong><br /><span class="muted small">${esc(e.clinicName)}</span></div>
    </div></div>`;
  }

  function paintDocs(q: string): void {
    const list = document.getElementById('doc-list') as HTMLElement;
    const digits = q.replace(/\D/g, '');
    const bySpec = activeSpec ? all.filter((e) => (e.doctor.specialty ?? 'general') === activeSpec) : all;
    const shown = q
      ? bySpec.filter(
          (e) =>
            e.doctor.name.toLowerCase().includes(q) ||
            specialtyLabel(e.doctor.specialty ?? '', '').toLowerCase().includes(q) ||
            (e.doctor.specialty ?? '').toLowerCase().includes(q) ||
            (e.doctor.phone ?? '').replace(/\D/g, '').includes(digits) ||
            (e.clinicPhone ?? '').replace(/\D/g, '').includes(digits) ||
            e.clinicName.toLowerCase().includes(q) ||
            (e.clinicAddress ?? '').toLowerCase().includes(q),
        )
      : bySpec;
    if (shown.length === 0) {
      list.innerHTML = `<p class="muted">${esc(all.length === 0 ? t('noClinicsDir') : t('noResults'))}</p>`;
      return;
    }
    // Nearest mode: flat distance-sorted list. Otherwise: collapsible groups
    // by specialty, each doctor with specialty + phone always visible.
    if (nearestOn) {
      list.innerHTML = `<div class="pgrid">` + shown.map((e) => docCard(e)).join('') + `</div>`;
      wireSlotBrowsers(list);
      wireBookingForms(list);
      return;
    }
    const groups = new Map<string, { label: string; items: typeof shown }>();
    for (const e of shown) {
      const key = e.doctor.specialty ?? 'general';
      const group = groups.get(key) ?? { label: specialtyLabel(key, t('generalSpec')), items: [] };
      group.items.push(e);
      groups.set(key, group);
    }
    list.innerHTML = [...groups.entries()]
      .map(
        ([key, g]) => `<section class="spec-group">
          <h3><button class="spec-pill" aria-expanded="true"><span class="chev">▾</span>
            ${esc(g.label)} <span class="spec-count">${g.items.length}</span></button></h3>
          <div class="collapse-body"><div class="pgrid">${g.items.map((e) => docCard(e)).join('')}</div></div>
        </section>`,
      )
      .join('');
    list.querySelectorAll<HTMLButtonElement>('.spec-pill').forEach((toggle) => {
      toggle.addEventListener('click', () => {
        const section = toggle.closest('section');
        if (!section) return;
        const collapsed = section.classList.toggle('collapsed');
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });
    });
    wireSlotBrowsers(list);
    wireBookingForms(list);
  }

  function docCard(e: {
    doctor: { uid: string; name: string; avatarUrl: string | null; specialty: string | null; phone: string | null };
    clinicId: string;
    clinicName: string;
    clinicPhone: string | null;
    clinicAddress: string | null;
    location: { lat: number; lng: number } | null;
    workingHours: { weekday: number; enabled: boolean; start: string; end: string; start2?: string | null; end2?: string | null }[] | null;
    slotDurationMinutes: number;
    visitDurations: { consultation: number; follow_up: number; procedure: number; teleconsult: number } | null;
    distanceKm: number | null;
  }): string {
    return `<div class="doc-card-light">
      <div class="doc-row">
        ${e.doctor.avatarUrl ? `<img class="avatar xl" src="${esc(e.doctor.avatarUrl)}" alt="" loading="lazy" />` : `<span class="avatar xl">${esc(initials(e.doctor.name))}</span>`}
        <div><h3>${esc(e.doctor.name)}</h3>
          <span class="pill spec">${esc(specialtyLabel(e.doctor.specialty ?? 'general', t('generalSpec')))}</span>
        </div>
      </div>
      <p>${e.doctor.phone ? `<a href="tel:${esc(e.doctor.phone.replace(/\s/g, ''))}" dir="ltr">${esc(e.doctor.phone)}</a>` : e.clinicPhone ? `<span class="muted" dir="ltr">${esc(e.clinicPhone)}</span>` : `<span class="muted">—</span>`}</p>
      <p class="muted">${esc(e.clinicName)}${e.distanceKm !== null ? ` · <strong>${esc(e.distanceKm < 1 ? `${Math.round(e.distanceKm * 1000)} م` : `${e.distanceKm.toFixed(1)} كم`)}</strong>` : ''}</p>
      ${e.clinicAddress ? `<p class="muted small">${esc(e.clinicAddress)}</p>` : ''}
      <div class="row">
        ${e.location ? `<a class="button" href="${esc(mapsLink(e.location.lat, e.location.lng))}" target="_blank" rel="noopener">${esc(t('openInMaps'))}</a>` : ''}
      </div>
            <form data-req="${esc(e.clinicId)}" data-clinic-name="${esc(e.clinicName)}" data-doctor="${esc(e.doctor.name)}" class="grid-form">
              <input type="hidden" name="startsAt" value="" />
              ${field(t('bookingVisitType'), `<select name="visitType">
                <option value="consultation">${esc(statusLabel('consultation'))} (${e.visitDurations?.consultation ?? e.slotDurationMinutes}′)</option>
                <option value="follow_up">${esc(statusLabel('follow_up'))} (${e.visitDurations?.follow_up ?? Math.min(e.slotDurationMinutes, 15)}′)</option>
                <option value="procedure">${esc(statusLabel('procedure'))} (${e.visitDurations?.procedure ?? Math.max(e.slotDurationMinutes, 60)}′)</option>
                <option value="teleconsult">${esc(statusLabel('teleconsult'))} (${e.visitDurations?.teleconsult ?? Math.min(e.slotDurationMinutes, 20)}′)</option>
              </select>`)}
              <div class="slot-browser" data-clinic="${esc(e.clinicId)}"><p class="muted small">${esc(t('loadingSlots'))}</p></div>
              ${field(t('bookingNote'), input('note', 'text', ''))}
              <button class="primary" type="submit" disabled>${esc(t('pickTimeFirst'))}</button>
            </form>
          </div>`;
  }

  type SlotDay = { dateKey: string; slots: { startsAt: string; localStart: string }[] };
  const slotCache = new Map<string, SlotDay[]>();
  // Just-claimed times per clinic (other patients' instant bookings) + my own
  // live bookings: both hide chips instantly, no staff republish wait.
  const takenCache = new Map<string, Set<string>>();
  let ownStarts: Set<string> | null = null;

  function wireSlotBrowsers(scope: HTMLElement): void {
    scope.querySelectorAll<HTMLElement>('.slot-browser').forEach((box) => {
      const clinicId = box.dataset.clinic ?? '';
      const form = box.closest('form') as HTMLFormElement | null;
      const hidden = form?.querySelector('input[name="startsAt"]') as HTMLInputElement | null;
      const submit = form?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      const visitSelect = form?.querySelector('select[name="visitType"]') as HTMLSelectElement | null;
      const entry = all.find((x) => x.clinicId === clinicId);
      const baseMins = entry?.slotDurationMinutes ?? 30;
      const visitMins = (): number => {
        const v = visitSelect?.value ?? 'consultation';
        const d = entry?.visitDurations;
        if (v === 'follow_up') return d?.follow_up ?? Math.min(baseMins, 15);
        if (v === 'procedure') return d?.procedure ?? Math.max(baseMins, 60);
        if (v === 'teleconsult') return d?.teleconsult ?? Math.min(baseMins, 20);
        return d?.consultation ?? baseMins;
      };
      const dayLabel = (dateKey: string): string => {
        const dt = new Date(`${dateKey}T12:00:00Z`);
        const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const wd = names[dt.getUTCDay()] ?? '';
        return `${weekdayLabel(wd)} ${dateKey.slice(5)}`;
      };
      const refreshSubmit = (): void => {
        if (!submit) return;
        const picked = hidden?.value ?? '';
        // Button stays enabled so tapping it always answers (toast if no
        // time yet). A disabled green button that silently ignores taps is
        // what made "طلب حجز ما انحجز".
        submit.disabled = false;
        submit.textContent = picked ? t('confirmBooking') : t('pickTimeFirst');
      };
      const summaryHtml = (daysList: SlotDay[]): string => {
        const picked = hidden?.value ?? '';
        if (!picked) return `<p class="muted small" data-summary>…</p>`;
        const d = daysList.find((x) => x.slots.some((s) => s.startsAt === picked));
        const slot = d?.slots.find((s) => s.startsAt === picked);
        const label = d && slot ? tx('pickedReady', { day: dayLabel(d.dateKey), time: slot.localStart }) : picked;
        return `<p class="picked-line" data-summary>✅ ${esc(label)}</p>`;
      };
      /** Free starts that fit the whole visit: a 60′ visit needs two free 30′ cells in a row. */
      const fittingSlots = (day: SlotDay | undefined, mins: number): { startsAt: string; localStart: string }[] => {
        const slots = (day?.slots ?? []).slice().sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
        if (slots.length === 0) return [];
        if (mins <= baseMins) return slots;
        const need = mins * 60_000;
        return slots.filter((s, i) => {
          const start = new Date(s.startsAt).getTime();
          const end = start + need;
          let cursor = start;
          let j = i;
          while (cursor < end) {
            if (j >= slots.length) return false;
            const sj = new Date(slots[j]?.startsAt ?? '').getTime();
            if (sj !== cursor) return false;
            cursor += baseMins * 60_000;
            j += 1;
          }
          return true;
        });
      };
      const render = (days: SlotDay[]): void => {
        if (days.length === 0) {
          // No published times: fall back to a plain day wish.
          // min=today so the phone keyboard offers a sane day; the class
          // keeps the native date text dark on the white doctor card.
          const today = new Date().toISOString().slice(0, 10);
          box.innerHTML =
            field(t('preferredDay'), `<input name="day" type="date" value="" required min="${today}" class="day-wish" />`) +
            `<p class="muted small">${esc(t('noSlotsPublished'))}</p>`;
          if (hidden) hidden.value = '';
          if (submit) {
            submit.disabled = false;
            submit.textContent = t('requestBooking');
          }
          return;
        }
        // Hide just-booked times: others' claims + my own live bookings.
        // Without this the patient taps a taken chip and only gets an error.
        const blocked = new Set<string>([
          ...(takenCache.get(clinicId) ?? []),
          ...(ownStarts ?? []),
        ]);
        const visible: SlotDay[] =
          blocked.size === 0
            ? days
            : days.map((d) => ({ dateKey: d.dateKey, slots: d.slots.filter((s) => !blocked.has(s.startsAt)) }));
        const keys = days.map((d) => d.dateKey).sort();
        const todayStr = new Date().toISOString().slice(0, 10);
        let pickedDate = keys.includes(todayStr) ? todayStr : (keys[0] ?? '');
        const paint = (): void => {
          const active = visible.find((d) => d.dateKey === pickedDate) ?? visible[0] ?? days[0];
          if (active) pickedDate = active.dateKey;
          const times = fittingSlots(active, visitMins());
          box.innerHTML =
            `<div>${field(t('stepPickDay'), `<input name="daypick" type="date" value="${esc(pickedDate)}" required min="${esc(keys[0] ?? '')}" max="${esc(keys[keys.length - 1] ?? '')}" class="day-wish" />`)}</div>` +
            `<p class="slot-step">${esc(t('stepPickTime'))}</p><div class="slot-chips times">` +
            (times
              .map((s) => `<button type="button" data-slot="${esc(s.startsAt)}" class="${hidden?.value === s.startsAt ? 'chip-active' : ''}">${esc(s.localStart)}</button>`)
              .join('') || `<span class="muted small">${esc(t('noSlotsDay'))}</span>`) +
            `</div>` + summaryHtml(visible);
          const dateInput = box.querySelector('input[name="daypick"]') as HTMLInputElement | null;
          dateInput?.addEventListener('change', () => {
            pickedDate = dateInput.value || pickedDate;
            if (hidden) hidden.value = '';
            paint();
            refreshSubmit();
          });
          box.querySelectorAll<HTMLButtonElement>('button[data-slot]').forEach((b) => {
            b.addEventListener('click', () => {
              if (hidden) hidden.value = b.dataset.slot ?? '';
              paint();
              refreshSubmit();
            });
          });
        };
        paint();
        refreshSubmit();
      };
      // Visit length changes which starts fit → repaint times, drop old pick.
      if (visitSelect && !(visitSelect as HTMLSelectElement & { __wired?: boolean }).__wired) {
        (visitSelect as HTMLSelectElement & { __wired?: boolean }).__wired = true;
        visitSelect.addEventListener('change', () => {
          if (hidden) hidden.value = '';
          const cached = slotCache.get(clinicId);
          if (cached && box.isConnected) render(cached);
        });
      }
      const cached = slotCache.get(clinicId);
      if (cached && takenCache.has(clinicId) && ownStarts !== null) {
        render(cached);
        // Refresh claims quietly in the background for next paint.
        void import('../patientAuth.js')
          .then((pa) => pa.listTakenSlots(clinicId).catch(() => [] as string[]))
          .then((taken) => {
            takenCache.set(clinicId, new Set(taken));
          })
          .catch(() => undefined);
        return;
      }
      void import('../patientAuth.js')
        .then((pa) =>
          Promise.all([
            pa.listClinicSlots(clinicId),
            pa.listTakenSlots(clinicId).catch(() => [] as string[]),
            ownStarts !== null
              ? Promise.resolve([...ownStarts])
              : pa
                  .listMyBookings()
                  .then((mine) =>
                    mine
                      .filter((b) => b.status === 'confirmed' || b.status === 'requested' || b.status === 'rescheduled')
                      .map((b) => b.startsAt),
                  )
                  .catch(() => [] as string[]),
          ]),
        )
        .then(([days, taken, own]) => {
          slotCache.set(clinicId, days);
          takenCache.set(clinicId, new Set(taken));
          if (ownStarts === null) ownStarts = new Set(own);
          else for (const s of own) ownStarts.add(s);
          if (box.isConnected) render(days);
        })
        .catch(() => {
          if (box.isConnected) render([]);
        });
    });
  }

  function wireBookingForms(scope: HTMLElement): void {
    scope.querySelectorAll<HTMLFormElement>('form[data-req]').forEach((form) => {
      // Button label is owned by wireSlotBrowsers (step flow). Here we only
      // validate on submit so a tap always answers with a toast, never silence.
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const startsAt = String(data.get('startsAt') ?? '');
        const fallbackDay = String(data.get('day') ?? '');
        const visitType = String(data.get('visitType') ?? 'consultation');
        const note = String(data.get('note') ?? '').trim() || null;
        const button = form.querySelector('button[type="submit"]') as HTMLButtonElement;
        const hasSlotBrowser = form.querySelector('.slot-browser') !== null && fallbackDay === '';
        if (!startsAt && hasSlotBrowser) {
          // Slots mode but no time picked: guide, don't silently ignore.
          toast(t('pickATime'), 'error');
          form.querySelector('.slot-chips.times')?.classList.add('need-pick');
          window.setTimeout(
            () => form.querySelector('.slot-chips.times')?.classList.remove('need-pick'),
            1600,
          );
          return;
        }
        button.disabled = true;
        const clinicId = form.dataset.req ?? '';
        const clinicName = form.dataset.clinicName ?? '';
        const doctorName = form.dataset.doctor ?? '';
        void import('../patientAuth.js').then((pa) => {
          if (startsAt) {
            // Instant path: free slot picked → confirmed booking, no doctor click.
            const entry = all.find((x) => x.clinicId === clinicId);
            const durations = entry?.visitDurations;
            const fallbackSlot = entry?.slotDurationMinutes ?? 30;
            const mins =
              visitType === 'follow_up'
                ? (durations?.follow_up ?? Math.min(fallbackSlot, 15))
                : visitType === 'procedure'
                  ? (durations?.procedure ?? Math.max(fallbackSlot, 60))
                  : visitType === 'teleconsult'
                    ? (durations?.teleconsult ?? Math.min(fallbackSlot, 20))
                    : (durations?.consultation ?? fallbackSlot);
            const start = new Date(startsAt).getTime();
            const endsAt = new Date(start + mins * 60_000).toISOString();
            return pa
              .bookDirectSlot(clinicId, clinicName, { startsAt, endsAt, visitType, note, doctorName })
              .then(() => {
                form.reset();
                const hidden = form.querySelector('input[name="startsAt"]') as HTMLInputElement | null;
                if (hidden) hidden.value = '';
                button.disabled = false;
                button.textContent = t('pickTimeFirst');
                // Drop the just-booked chip immediately so it can't be tapped twice.
                try {
                  const chip = form.querySelector(`button[data-slot="${startsAt.replace(/"/g, '')}"]`);
                  chip?.remove();
                } catch {
                  // ignore selector edge cases; next publish cleans up anyway
                }
                const cached = slotCache.get(clinicId);
                if (cached) {
                  for (const d of cached) d.slots = d.slots.filter((s) => s.startsAt !== startsAt);
                }
                takenCache.get(clinicId)?.add(startsAt);
                if (takenCache.has(clinicId) === false) takenCache.set(clinicId, new Set([startsAt]));
                if (ownStarts === null) ownStarts = new Set([startsAt]);
                else ownStarts.add(startsAt);
                const summary = form.querySelector('[data-summary]');
                if (summary) summary.textContent = '…';
                scheduleLocalReminders();
                showBookedPopup({
                  clinic: doctorName || clinicName,
                  day: startsAt.slice(0, 10),
                  time: new Date(startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                  visit: visitLabel(visitType),
                });
              })
              .catch((error: unknown) => {
                button.disabled = false;
                toast(errorText(error), 'error');
              });
          }
          // Fallback path: no published slots → day wish, clinic confirms manually.
          const day = fallbackDay;
          if (!day) {
            toast(t('pickATime'), 'error');
            button.disabled = false;
            return Promise.resolve();
          }
          return pa
            .fileBookingRequest(clinicId, { preferredDate: day, note, startsAt: null })
            .then(() => {
              toast(t('bookingSent'));
              form.reset();
              button.disabled = false;
            })
            .catch((error: unknown) => {
              button.disabled = false;
              toast(errorText(error), 'error');
            });
        });
      });
    });
  }
}

/**
 * مواعيدي: upcoming / postponed / past from instant bookings + shared snapshots.
 * Bell = count of bookings within 3 days. Local reminders fire via Notification
 * API when the doctor enabled them (24h / 3d); WhatsApp confirm stays staff-side.
 */
function renderFbAppointmentsTab(root: HTMLElement): void {
  root.innerHTML = `
    ${signOutButton()}
    <section class="appt-wrap">
      <div class="appt-bg" aria-hidden="true">
        <svg class="bg-plus" viewBox="0 0 64 64" fill="none">
          <rect x="8" y="8" width="48" height="48" rx="14" stroke="rgba(127,255,228,0.30)" stroke-width="2"/>
          <path d="M32 22 V42 M22 32 H42" stroke="rgba(127,255,228,0.35)" stroke-width="3" stroke-linecap="round"/>
        </svg>
        <svg class="bg-ecg" viewBox="0 0 300 24" preserveAspectRatio="none" fill="none">
          <path d="M0 12 H104 L116 4 L128 20 L140 9 L148 12 H300" stroke="rgba(47,224,182,0.35)" stroke-width="1.6"/>
        </svg>
        <span class="bg-spark bg-s1">+</span>
        <span class="bg-spark bg-s2">+</span>
        <span class="bg-spark bg-s3">+</span>
      </div>
      <p class="appt-hello" id="appt-hello">…</p>
      <div class="appt-hero">
        <div class="appt-title">
          <span class="appt-title-ico">🗓️</span>
          <div><h2>${esc(t('myAppointmentsTab'))}</h2><p class="appt-sub">${esc(t('apptHeroSub'))}</p></div>
        </div>
        <div class="appt-count"><span class="appt-count-ico">🗓️</span><strong id="appt-total">0</strong><span>${esc(t('apptWord'))}</span><span id="appt-bell">🔔 0</span></div>
      </div>
      <div class="appt-tools">
        <div class="appt-search"><span>🔍</span><input id="appt-q" type="search" placeholder="${esc(t('filterAppointments'))}" autocomplete="off" /></div>
        <div id="appt-tabs" class="appt-seg">
          <button data-atab="up" class="chip-active">📅 ${esc(t('upcoming'))}</button>
          <button data-atab="post">✅ ${esc(t('postponed'))}</button>
          <button data-atab="past">🕘 ${esc(t('past'))}</button>
        </div>
      </div>
      <div class="row"><button type="button" id="notif-enable" class="ghost small">${esc(t('enableNotifications'))}</button></div>
      <div id="appt-list"><p class="muted">${esc(t('loading'))}</p></div>
      <div class="appt-sign">
        <svg class="sign-heart" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 21 C 6 16, 2 12.5, 2 8.8 C 2 6, 4.2 4, 6.8 4 C 9 4, 11 5.6, 12 7.4 C 13 5.6, 15 4, 17.2 4 C 19.8 4, 22 6, 22 8.8 C 22 12.5, 18 16, 12 21 Z" fill="rgba(20,201,164,0.22)" stroke="#2fe0b6" stroke-width="1.4"/>
        </svg>
        <span>${esc(t('apptSign'))}</span>
        <svg class="sign-ecg" viewBox="0 0 120 24" fill="none" aria-hidden="true">
          <path d="M0 12 H38 L46 4 L54 20 L62 8 L68 12 H120" stroke="#12b5a0" stroke-width="1.6" opacity="0.7"/>
        </svg>
      </div>
    </section>`;
  wireSignOut();

  (document.getElementById('notif-enable') as HTMLButtonElement).addEventListener('click', async () => {
    try {
      if (!('Notification' in window)) {
        toast(t('notifBlocked'), 'error');
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        try {
          localStorage.setItem('mf_notif', '1');
        } catch {
          // ignore
        }
        toast(t('notifEnabled'));
        scheduleLocalReminders();
      } else {
        toast(t('notifBlocked'), 'error');
      }
    } catch {
      toast(t('notifBlocked'), 'error');
    }
  });

  let active: 'up' | 'post' | 'past' = 'up';
  let query = '';
  type Row = {
    id: string;
    group: string;
    clinicId: string;
    clinic: string;
    doctor: string;
    startsAt: string;
    endsAt: string;
    visit: string;
    status: string;
    note: string | null;
    mine: boolean;
  };
  let rows: Row[] = [];

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const apptDay = (iso: string): { date: string; week: string; time: string } => {
    const d = new Date(iso);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const h = d.getHours();
    const period = h < 12 ? 'صباحاً' : 'مساءً';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return {
      date: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`,
      week: weekdayLabel(WEEKDAYS[d.getDay()] ?? ''),
      time: `${h12}:${pad(d.getMinutes())} ${period}`,
    };
  };
  const statusPill = (s: string): string =>
    s === 'confirmed' ? 'ok' : s === 'cancelled' ? 'danger' : s === 'requested' || s === 'rescheduled' ? 'warn' : '';

  const paint = (): void => {
    const list = document.getElementById('appt-list') as HTMLElement;
    const now = Date.now();
    const asc = (a: Row, b: Row): number => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0);
    const desc = (a: Row, b: Row): number => -asc(a, b);
    // Nearest first for upcoming/postponed; most recent first for past.
    const upcoming = rows
      .filter((r) => new Date(r.startsAt).getTime() >= now && r.status === 'confirmed')
      .sort(asc);
    const postponed = rows
      .filter((r) => r.status === 'rescheduled' || r.status === 'requested')
      .sort(asc);
    const past = rows
      .filter(
        (r) => new Date(r.startsAt).getTime() < now || r.status === 'cancelled' || r.status === 'completed',
      )
      .sort(desc);
    const shownBase = active === 'up' ? upcoming : active === 'post' ? postponed : past;
    const q = query.trim().toLowerCase();
    const shown = q
      ? shownBase.filter((r) =>
          `${r.doctor} ${r.clinic} ${r.startsAt} ${visitLabel(r.visit)} ${statusLabel(r.status)}`
            .toLowerCase()
            .includes(q),
        )
      : shownBase;
    const bell = document.getElementById('appt-bell');
    if (bell) {
      const soon = upcoming.filter((r) => new Date(r.startsAt).getTime() - now < 3 * 86_400_000).length;
      bell.textContent = `🔔 ${soon}`;
    }
    const total = document.getElementById('appt-total');
    if (total) total.textContent = String(upcoming.length);
    if (shown.length === 0) {
      list.innerHTML = `<p class="muted">${esc(q ? t('noResults') : active === 'past' ? t('noPastBookings') : t('noUpcomingBookings'))}</p>`;
      return;
    }
    list.innerHTML = shown
      .map((r) => {
        const f = apptDay(r.startsAt);
        const cancellable = r.mine && r.status === 'confirmed' && new Date(r.startsAt).getTime() >= now;
        return `<div class="appt-card">
          <div class="appt-row" data-exp="${esc(r.id)}" role="button" tabindex="0">
            <div class="appt-date"><span class="appt-ico">🗓️</span><div><strong dir="ltr">${esc(f.date)}</strong><span>📅 ${esc(f.week)}</span></div></div>
            <div class="appt-mid"><span class="appt-time">🕘 ${esc(f.time)}</span><span class="pill ${statusPill(r.status)}">✓ ${esc(statusLabel(r.status))}</span></div>
            <div class="appt-who"><span class="appt-ico">👨‍⚕️</span><strong>${esc(r.doctor || r.clinic)}</strong></div>
            <span class="pill spec">👁 ${esc(visitLabel(r.visit))}</span>
            <span class="appt-chev">›</span>
          </div>
          <div class="appt-detail" hidden>
            ${r.note ? `<p class="appt-note">📝 ${esc(r.note)}</p>` : ''}
            ${cancellable ? `<div class="row"><button data-cancelbook="${esc(r.id)}">${esc(t('cancelBooking'))}</button></div>` : ''}
          </div>
        </div>`;
      })
      .join('');
    list.querySelectorAll<HTMLElement>('.appt-row[data-exp]').forEach((row) => {
      const toggle = (): void => {
        const card = row.closest('.appt-card');
        const detail = card?.querySelector('.appt-detail');
        if (!detail) return;
        const open = detail.hasAttribute('hidden');
        if (open) detail.removeAttribute('hidden');
        else detail.setAttribute('hidden', '');
        card?.classList.toggle('open', open);
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
        }
      });
    });
    list.querySelectorAll<HTMLButtonElement>('button[data-cancelbook]').forEach((b) => {
      b.addEventListener('click', () => {
        b.disabled = true;
        void import('../patientAuth.js')
          .then((pa) => pa.cancelMyBooking(b.dataset.cancelbook ?? ''))
          .then(() => {
            toast(t('bookingCancelled'));
            load();
          })
          .catch((error: unknown) => {
            b.disabled = false;
            toast(errorText(error), 'error');
          });
      });
    });
  };

  const load = (): void => {
    void import('../patientAuth.js')
      .then((pa) =>
        Promise.all([
          pa.listMyBookings().catch(() => []),
          pa.mySharedRecords().catch(() => []),
          pa.fbPatientAccount().catch(() => null),
        ]),
      )
      .then(([mine, shared, account]) => {
        const hello = document.getElementById('appt-hello');
        if (hello) {
          const name = (account?.fullName ?? '').trim() || (account?.phone ?? '');
          hello.textContent = name ? tx('helloUser', { n: name.split(' ')[0] ?? name }) : '';
        }
        const fromMine: Row[] = mine.map((b) => ({
          id: b.id,
          group: b.doctorName || b.clinicId || b.clinicName,
          clinicId: b.clinicId,
          clinic: b.clinicName || b.clinicId,
          doctor: b.doctorName,
          startsAt: b.startsAt,
          endsAt: b.endsAt,
          visit: b.visitType,
          status: b.status,
          note: b.note ?? null,
          mine: true,
        }));
        const fromShared: Row[] = shared.flatMap((rec) =>
          (rec.appointments ?? []).map((a, i) => ({
            id: `${rec.clinicId}-${i}`,
            group: rec.clinicId,
            clinicId: rec.clinicId,
            clinic: rec.clinicName,
            doctor: '',
            startsAt: a.startsAt,
            endsAt: a.startsAt,
            visit: 'consultation',
            status: a.status,
            note: null as string | null,
            mine: false,
          })),
        );
        rows = [...fromMine, ...fromShared];
        paint();
        scheduleLocalReminders(rows);
        // Old bookings without a doctor name: resolve the clinic's doctor once.
        const missing = [...new Set(rows.filter((r) => !r.doctor && r.clinicId).map((r) => r.clinicId))];
        if (missing.length > 0) {
          void import('../patientAuth.js')
            .then((pa2) =>
              Promise.all(
                missing.map((cid) =>
                  pa2
                    .listPublicDoctors(cid)
                    .then((docs) => ({ cid, name: docs[0]?.name ?? '' }))
                    .catch(() => ({ cid, name: '' })),
                ),
              ),
            )
            .then((resolved) => {
              const map = new Map(resolved.map((r) => [r.cid, r.name]));
              let changed = false;
              for (const r of rows) {
                if (!r.doctor && map.get(r.clinicId)) {
                  r.doctor = map.get(r.clinicId) ?? '';
                  r.group = r.doctor;
                  changed = true;
                }
              }
              if (changed) paint();
            })
            .catch(() => undefined);
        }
      })
      .catch((error: unknown) => {
        (document.getElementById('appt-list') as HTMLElement).innerHTML =
          `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };

  document.querySelectorAll<HTMLButtonElement>('#appt-tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      active = (b.dataset.atab as 'up' | 'post' | 'past') ?? 'up';
      document.querySelectorAll('#appt-tabs button').forEach((x) => x.classList.remove('chip-active'));
      b.classList.add('chip-active');
      paint();
    });
  });
  (document.getElementById('appt-q') as HTMLInputElement).addEventListener('input', (event) => {
    query = (event.target as HTMLInputElement).value;
    paint();
  });
  load();
}

function visitLabel(v: string): string {
  try {
    return statusLabel(v);
  } catch {
    return v;
  }
}

/** Confirmation popup after instant booking: clinic + day + time + visit. */
function showBookedPopup(detail: { clinic: string; day: string; time: string; visit: string }): void {  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-label="${esc(t('bookedTitle'))}">
      <div class="modal-top"><h3>✅ ${esc(t('bookedTitle'))}</h3></div>
      <p><strong>${esc(detail.clinic)}</strong></p>
      <p>📅 <span dir="ltr">${esc(detail.day)}</span> · 🕘 ${esc(detail.time)} · ${esc(detail.visit)}</p>
      <div class="row">
        <button id="booked-go" class="primary">${esc(t('goToAppointments'))}</button>
        <button id="booked-close">${esc(t('close'))}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = (): void => overlay.remove();
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  (overlay.querySelector('#booked-close') as HTMLButtonElement).addEventListener('click', close);
  (overlay.querySelector('#booked-go') as HTMLButtonElement).addEventListener('click', () => {
    close();
    window.location.hash = '#/my/appointments';
  });
}

/** Local reminders: 24h + 3d before each confirmed booking (no server needed). */
function scheduleLocalReminders(preset?: { startsAt: string; clinic: string }[]): void {
  try {
    if (localStorage.getItem('mf_notif') !== '1') return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
  } catch {
    return;
  }
  const fire = (title: string, body: string, delay: number): void => {
    if (delay < 0 || delay > 14 * 86_400_000) return;
    window.setTimeout(() => {
      try {
        if (Notification.permission === 'granted') {
          if ('serviceWorker' in navigator) {
            void navigator.serviceWorker.ready.then((reg) => {
              void reg.showNotification(title, { body, tag: `${title}-${body}` });
            });
          } else {
            new Notification(title, { body });
          }
        }
      } catch {
        // Never break the app for a reminder.
      }
    }, Math.min(delay, 2_147_483_647));
  };
  const act = (rows: { startsAt: string; clinic: string }[]): void => {
    const now = Date.now();
    for (const r of rows.slice(0, 20)) {
      const at = new Date(r.startsAt).getTime();
      if (!Number.isFinite(at) || at <= now) continue;
      const label = `${r.clinic} · ${new Date(r.startsAt).toLocaleString()}`;
      fire(t('myAppointmentsTab'), `${t('remind24h')}: ${label}`, at - now - 24 * 3_600_000);
      fire(t('myAppointmentsTab'), `${t('remind3d')}: ${label}`, at - now - 3 * 86_400_000);
    }
  };
  if (preset) {
    act(preset);
    return;
  }
  void import('../patientAuth.js')
    .then((pa) => pa.listMyBookings().catch(() => []))
    .then((mine) => act(mine.map((b) => ({ startsAt: b.startsAt, clinic: b.clinicName || b.clinicId }))))
    .catch(() => undefined);
}

/**
 * دوائي: every shared prescription with how-to-take, one-tap dose logging,
 * and a dose history. Reminders are local (morning/evening) and only run
 * when the clinic keeps medication reminders enabled.
 */
function renderFbMedsTab(root: HTMLElement): void {
  root.innerHTML = `
    ${signOutButton()}
    <section class="appt-wrap">
      <div class="appt-bg" aria-hidden="true">
        <svg class="bg-plus" viewBox="0 0 64 64" fill="none">
          <rect x="8" y="8" width="48" height="48" rx="14" stroke="rgba(127,255,228,0.30)" stroke-width="2"/>
          <path d="M32 22 V42 M22 32 H42" stroke="rgba(127,255,228,0.35)" stroke-width="3" stroke-linecap="round"/>
        </svg>
        <svg class="bg-ecg" viewBox="0 0 300 24" preserveAspectRatio="none" fill="none">
          <path d="M0 12 H104 L116 4 L128 20 L140 9 L148 12 H300" stroke="rgba(47,224,182,0.35)" stroke-width="1.6"/>
        </svg>
        <span class="bg-spark bg-s1">+</span>
        <span class="bg-spark bg-s2">+</span>
        <span class="bg-spark bg-s3">+</span>
      </div>
      <p class="appt-hello" id="meds-hello">…</p>
      <div class="appt-hero">
        <div class="appt-title">
          <span class="appt-title-ico">💊</span>
          <div><h2>${esc(t('myMedsTab'))}</h2><p class="appt-sub">${esc(t('myMedsSub'))}</p></div>
        </div>
        <div class="appt-count"><span class="appt-count-ico">💊</span><strong id="meds-total">0</strong><span>${esc(t('apptWord'))}</span></div>
      </div>
      <div class="appt-card" id="meds-remind"><p class="muted">${esc(t('loading'))}</p></div>
      <div id="meds-list"><p class="muted">${esc(t('loading'))}</p></div>
      <h3 style="margin-top:0.8rem">🧪 ${esc(t('requestedTestsTitle'))}</h3>
      <div id="meds-tests"><p class="muted">${esc(t('loading'))}</p></div>
      <div id="meds-life"></div>
      <h3 style="margin-top:0.8rem">📝 ${esc(t('doseHistory'))}</h3>
      <div id="meds-hist"><p class="muted">${esc(t('loading'))}</p></div>
      <div class="appt-sign">
        <svg class="sign-heart" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 21 C 6 16, 2 12.5, 2 8.8 C 2 6, 4.2 4, 6.8 4 C 9 4, 11 5.6, 12 7.4 C 13 5.6, 15 4, 17.2 4 C 19.8 4, 22 6, 22 8.8 C 22 12.5, 18 16, 12 21 Z" fill="rgba(20,201,164,0.22)" stroke="#2fe0b6" stroke-width="1.4"/>
        </svg>
        <span>${esc(t('apptSign'))}</span>
      </div>
    </section>`;
  wireSignOut();

  type Med = { drug: string; dose: string | null; frequency: string | null; clinicId: string; clinic: string };
  let meds: Med[] = [];
  let takes: { drug: string; dose: string | null; clinicName: string; takenAt: string }[] = [];
  let sharedRecs: {
    clinicName: string;
    requestedTests: { name: string; priority: string; prepNotes: string | null; createdAt: string }[];
    lifestyle: { targets: string[]; diet: string[]; exercise: string[] };
  }[] = [];
  let doctorMedsOn = true;

  const medPref = (k: string, fallback: string): string => {
    try {
      return localStorage.getItem(k) ?? fallback;
    } catch {
      return fallback;
    }
  };

  const paintRemind = (): void => {
    const host = document.getElementById('meds-remind') as HTMLElement;
    if (!doctorMedsOn) {
      host.innerHTML = `<p class="muted">🔕 ${esc(t('medRemindOff'))}</p>`;
      return;
    }
    const on = medPref('mf_med_on', '1') === '1';
    host.innerHTML = `
      <div class="appt-doc"><span class="appt-avatar">⏰</span><strong>${esc(t('medRemindTitle'))}</strong></div>
      <p class="muted small">${esc(t('medRemindHint'))}</p>
      <div class="row">
        ${field(t('medMorning'), `<input name="med-mor" type="time" value="${esc(medPref('mf_med_mor', '08:00'))}" />`)}
        ${field(t('medEvening'), `<input name="med-eve" type="time" value="${esc(medPref('mf_med_eve', '20:00'))}" />`)}
        <label class="check"><input type="checkbox" name="med-on" ${on ? 'checked' : ''} /> ${esc(t('enableNotifications'))}</label>
        <button id="meds-save" class="primary">${esc(t('save'))}</button>
      </div>`;
    (document.getElementById('meds-save') as HTMLButtonElement).addEventListener('click', () => {
      try {
        const mor = (host.querySelector('input[name="med-mor"]') as HTMLInputElement).value || '08:00';
        const eve = (host.querySelector('input[name="med-eve"]') as HTMLInputElement).value || '20:00';
        const enabled = (host.querySelector('input[name="med-on"]') as HTMLInputElement).checked;
        localStorage.setItem('mf_med_mor', mor);
        localStorage.setItem('mf_med_eve', eve);
        localStorage.setItem('mf_med_on', enabled ? '1' : '0');
      } catch {
        // Never block on storage.
      }
      toast(t('saved'));
      scheduleMedReminders();
    });
  };

  const paint = (): void => {
    const total = document.getElementById('meds-total');
    if (total) total.textContent = String(meds.length);
    const list = document.getElementById('meds-list') as HTMLElement;
    const today = new Date().toISOString().slice(0, 10);
    const takenToday = new Set(takes.filter((x) => x.takenAt.slice(0, 10) === today).map((x) => x.drug));
    if (meds.length === 0) {
      list.innerHTML = `<p class="muted">${esc(t('noMeds'))}</p>`;
    } else {
      list.innerHTML = meds
        .map((m, i) => {
          const done = takenToday.has(m.drug);
          const how = [m.dose, m.frequency].filter(Boolean).join(' · ');
          return `<div class="appt-card">
            <div class="appt-doc"><span class="appt-avatar">💊</span><strong>${esc(m.drug)}</strong>
              <span class="pill ${done ? 'ok' : 'warn'}">${esc(done ? t('doseDoneToday') : t('dosePendingToday'))}</span>
            </div>
            ${how ? `<p class="muted small">${esc(t('howToTake'))}: ${esc(how)}</p>` : ''}
            <div class="appt-line">
              <span class="pill spec">🏥 ${esc(m.clinic)}</span>
              <button data-take="${i}">${esc(t('takeDose'))}</button>
            </div>
          </div>`;
        })
        .join('');
      list.querySelectorAll<HTMLButtonElement>('button[data-take]').forEach((b) => {
        b.addEventListener('click', () => {
          const m = meds[Number(b.dataset.take ?? '-1')];
          if (!m) return;
          b.disabled = true;
          void import('../patientAuth.js')
            .then((pa) => pa.logMedTake({ drug: m.drug, dose: m.dose, clinicId: m.clinicId, clinicName: m.clinic }))
            .then(() => {
              toast(t('saved'));
              load();
            })
            .catch((error: unknown) => {
              b.disabled = false;
              toast(errorText(error), 'error');
            });
        });
      });
    }
    const hist = document.getElementById('meds-hist') as HTMLElement;
    hist.innerHTML =
      takes.length === 0
        ? `<p class="muted">${esc(t('noTakesYet'))}</p>`
        : `<div class="appt-card">${takes
            .slice(0, 20)
            .map(
              (x) => `<div class="appt-line">
                <span>✅ <strong>${esc(x.drug)}</strong>${x.dose ? ` <span class="muted">${esc(x.dose)}</span>` : ''}</span>
                <span class="muted" dir="ltr">${esc(fmtDateTime(x.takenAt))}</span>
              </div>`,
            )
            .join('')}</div>`;
    // Pending lab orders across linked clinics.
    const testsHost = document.getElementById('meds-tests') as HTMLElement;
    const pending = sharedRecs.flatMap((r) =>
      (r.requestedTests ?? []).map((x) => ({ ...x, clinic: r.clinicName })),
    );
    testsHost.innerHTML =
      pending.length === 0
        ? `<p class="muted">${esc(t('noPendingTests'))}</p>`
        : `<div class="appt-card">${pending
            .map(
              (x) => `<div class="appt-line">
                <span>🧪 <strong>${esc(x.name)}</strong></span>
                ${x.priority === 'urgent' ? `<span class="pill danger">⚡ ${esc(t('urgent'))}</span>` : ''}
                ${x.prepNotes ? `<span class="muted">📋 ${esc(x.prepNotes)}</span>` : ''}
                <span class="muted">${esc(x.clinic)}</span>
              </div>`,
            )
            .join('')}</div>`;
    // Lifestyle & nutrition plan from the latest review snapshot.
    const lifeHost = document.getElementById('meds-life') as HTMLElement;
    const life = sharedRecs.map((r) => r.lifestyle).find((l) => l && l.targets.length + l.diet.length + l.exercise.length > 0);
    lifeHost.innerHTML = life
      ? `<h3 style="margin-top:0.8rem">🥗 ${esc(t('lifestyleTitle'))}</h3><div class="appt-card">` +
        (life.targets.length > 0 ? `<h4>${esc(t('lifestyleTargets'))}</h4><ul class="list">${life.targets.map((x) => `<li>🎯 ${esc(x)}</li>`).join('')}</ul>` : '') +
        (life.diet.length > 0 ? `<h4>${esc(t('lifestyleDiet'))}</h4><ul class="list">${life.diet.map((x) => `<li>🍽️ ${esc(x)}</li>`).join('')}</ul>` : '') +
        (life.exercise.length > 0 ? `<h4>${esc(t('lifestyleExercise'))}</h4><ul class="list">${life.exercise.map((x) => `<li>🚶 ${esc(x)}</li>`).join('')}</ul>` : '') +
        `</div>`
      : '';
  };

  const load = (): void => {
    void import('../patientAuth.js')
      .then((pa) =>
        Promise.all([
          pa.mySharedRecords().catch(() => []),
          pa.listMedTakes(60).catch(() => []),
          pa.fbPatientAccount().catch(() => null),
          pa.listPublicClinics().catch(() => []),
        ]),
      )
      .then(([records, takesList, account, clinics]) => {
        const hello = document.getElementById('meds-hello');
        if (hello) {
          const name = (account?.fullName ?? '').trim();
          hello.textContent = name ? tx('helloUser', { n: name.split(' ')[0] ?? name }) : '';
        }
        meds = records.flatMap((rec) =>
          (rec.medications ?? []).map((m) => ({
            drug: m.drug,
            dose: m.dose ?? null,
            frequency: m.frequency ?? null,
            clinicId: rec.clinicId,
            clinic: rec.clinicName,
          })),
        );
        takes = takesList;
        sharedRecs = records.map((rec) => ({
          clinicName: rec.clinicName,
          requestedTests: rec.requestedTests ?? [],
          lifestyle: rec.lifestyle ?? { targets: [], diet: [], exercise: [] },
        }));
        // Doctor gate: reminders run only if some linked clinic keeps them on.
        const linked = new Set(records.map((r) => r.clinicId));
        const relevant = clinics.filter((c) => linked.has(c.clinicId));
        doctorMedsOn =
          relevant.length === 0 || relevant.some((c) => c.reminderSettings?.medsReminders !== false);
        paintRemind();
        paint();
        scheduleMedReminders();
      })
      .catch((error: unknown) => {
        (document.getElementById('meds-list') as HTMLElement).innerHTML =
          `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };
  load();
}

/** Daily med alarms (morning/evening) for the active prescriptions. */
function scheduleMedReminders(): void {
  try {
    if (localStorage.getItem('mf_notif') !== '1') return;
    if (localStorage.getItem('mf_med_on') !== '1' && localStorage.getItem('mf_med_on') !== null) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
  } catch {
    return;
  }
  const at = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date();
    d.setHours(h ?? 8, m ?? 0, 0, 0);
    let diff = d.getTime() - Date.now();
    if (diff < 0) diff += 86_400_000;
    return diff;
  };
  const fire = (title: string, body: string, delay: number): void => {
    if (delay < 0 || delay > 86_400_000) return;
    window.setTimeout(() => {
      try {
        if (Notification.permission === 'granted') {
          if ('serviceWorker' in navigator) {
            void navigator.serviceWorker.ready.then((reg) => {
              void reg.showNotification(title, { body, tag: `meds-${body}` });
            });
          } else {
            new Notification(title, { body });
          }
        }
      } catch {
        // Never break the app for a reminder.
      }
    }, Math.min(delay, 2_147_483_647));
  };
  void import('../patientAuth.js')
    .then((pa) => Promise.all([pa.mySharedRecords().catch(() => []), pa.listPublicClinics().catch(() => [])]))
    .then(([records, clinics]) => {
      const linked = new Set(records.map((r) => r.clinicId));
      const relevant = clinics.filter((c) => linked.has(c.clinicId));
      if (relevant.length > 0 && !relevant.some((c) => c.reminderSettings?.medsReminders !== false)) return;
      const names = [...new Set(records.flatMap((r) => r.medications.map((m) => m.drug)))].slice(0, 4);
      if (names.length === 0) return;
      let mor = '08:00';
      let eve = '20:00';
      try {
        mor = localStorage.getItem('mf_med_mor') ?? mor;
        eve = localStorage.getItem('mf_med_eve') ?? eve;
      } catch {
        // Defaults stand.
      }
      const body = `${t('medRemindTitle')}: ${names.join('، ')}`;
      fire(t('myMedsTab'), `${t('medMorning')}: ${body}`, at(mor));
      fire(t('myMedsTab'), `${t('medEvening')}: ${body}`, at(eve));
    })
    .catch(() => undefined);
}

function renderDoctorsTab(root: HTMLElement): void {
  root.innerHTML = `
    ${signOutButton()}
    <section class="card">
      <h2>${esc(t('doctors'))}</h2>
      <p class="muted">${esc(t('doctorsHint'))}</p>
      <div id="doc-filter" class="row"></div>
      <div id="doc-list"><p class="muted">…</p></div>
    </section>`;
  wireSignOut();

  directory()
    .then((dir) => {
      const myInsurers = new Set(
        (JSON.parse(localStorage.getItem('mf_my_insurers') ?? '[]') as string[]).map((s) => s.toLowerCase()),
      );
      patientProfile()
        .then((profile) => {
          const mine = new Set((profile.insurers ?? []).map((i) => i.insurerName.toLowerCase()));
          localStorage.setItem('mf_my_insurers', JSON.stringify([...mine]));
          paint(dir, mine);
        })
        .catch(() => paint(dir, myInsurers));

      const paint = (dir: UiDirectory, mine: Set<string>): void => {
        const chips = document.getElementById('doc-filter') as HTMLElement;
        const list = document.getElementById('doc-list') as HTMLElement;
        const slugByClinic = new Map(dir.clinics.map((c) => [c.id, c.slug]));
        const present = [...new Set(dir.doctors.map((d) => d.specialty ?? 'general'))];

        const renderList = (filter: string | null): void => {
          const shown = filter ? dir.doctors.filter((d) => (d.specialty ?? 'general') === filter) : dir.doctors;
          list.innerHTML =
            shown.length > 0
              ? `<div class="cards-grid">` +
                shown
                  .map((d) => {
                    const contracted = d.clinicInsurers.some((name) => mine.has(name.toLowerCase()));
                    return `<div class="doc-card">
                      <div class="doc-top"><span class="avatar">${esc(initials(d.name))}</span>
                        <div><strong>${esc(d.name)}</strong><br /><span class="pill spec">${esc(specialtyLabel(d.specialty ?? 'general', specFallback(d.specialty ?? 'general')))}</span></div>
                      </div>
                      <div class="muted small">${esc(d.clinicName)}${d.clinicPhone ? ` · <span dir="ltr">${esc(d.clinicPhone)}</span>` : ''}</div>
                      ${contracted ? `<div><span class="pill ok">${esc(t('contractsWithInsurer'))}</span></div>` : ''}
                      <button data-slots="${esc(d.id)}" data-clinic="${esc(d.clinicId)}">${esc(t('viewOpenSlots'))}</button>
                      <div data-slotlist="${esc(d.id)}"></div>
                    </div>`;
                  })
                  .join('') +
                `</div>`
              : `<p class="muted">${esc(t('noDoctorsSpecialty'))}</p>`;

          list.querySelectorAll<HTMLButtonElement>('button[data-slots]').forEach((button) => {
            button.addEventListener('click', () => {
              const doctorId = button.dataset.slots ?? '';
              const clinicId = button.dataset.clinic ?? '';
              const slug = slugByClinic.get(clinicId) ?? '';
              const host = list.querySelector(`div[data-slotlist="${doctorId}"]`) as HTMLElement | null;
              if (!host) return;
              if (host.dataset.loaded === '1') {
                host.innerHTML = '';
                delete host.dataset.loaded;
                return;
              }
              host.innerHTML = `<p class="muted">${esc(t('loadingSlots'))}</p>`;
              doctorSlots(slug, doctorId, 7)
                .then((days) => {
                  host.dataset.loaded = '1';
                  const upcoming = days.filter((d) => d.slots.length > 0).slice(0, 7);
                  if (upcoming.length === 0) {
                    host.innerHTML = `<p class="muted">${esc(t('noOpenSlots7'))}</p>`;
                    return;
                  }
                  host.innerHTML = upcoming
                    .map(
                      (d) => `<div class="slot-day"><strong>${esc(d.dateKey)}</strong><div class="slot-chips">` +
                        d.slots
                          .slice(0, 8)
                          .map(
                            (s) =>
                              `<button data-book="${esc(s.startsAt)}" data-doc="${esc(doctorId)}" data-clinic="${esc(clinicId)}">${esc(s.localStart)}</button>`,
                          )
                          .join('') +
                        `</div></div>`,
                    )
                    .join('');
                  host.querySelectorAll<HTMLButtonElement>('button[data-book]').forEach((chip) => {
                    chip.addEventListener('click', () => {
                      patientBookCross(chip.dataset.clinic ?? '', chip.dataset.book ?? '', null)
                        .then(() => toast(t('apptRequested')))
                        .catch((error: unknown) => toast(errorText(error), 'error'));
                    });
                  });
                })
                .catch((error: unknown) => {
                  host.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
                });
            });
          });
        };

        chips.innerHTML =
          `<button data-spec="" class="chip-active">${esc(t('all'))}</button>` +
          present.map((s) => `<button data-spec="${esc(s)}">${esc(specialtyLabel(s, specFallback(s)))}</button>`).join('');
        chips.querySelectorAll<HTMLButtonElement>('button[data-spec]').forEach((button) => {
          button.addEventListener('click', () => {
            chips.querySelectorAll('button').forEach((b) => b.classList.remove('chip-active'));
            button.classList.add('chip-active');
            renderList(button.dataset.spec || null);
          });
        });
        renderList(null);
      };
    })
    .catch((error: unknown) => {
      (document.getElementById('doc-list') as HTMLElement).innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
    });
}

function renderProfileTab(root: HTMLElement): void {
  root.innerHTML = `
    ${signOutButton()}
    <section class="card">
      <h2>${esc(t('myProfile'))}</h2>
      <p class="muted">${esc(t('myProfileHint'))}</p>
      <div id="p-photo" class="photo-row"></div>
      <div id="p-insurers"></div>
      <div id="p-profile-form"><p class="muted">…</p></div>
    </section>`;
  wireSignOut();

  const paint = (profile: UiNetworkProfileFull): void => {
    (document.getElementById('p-profile-form') as HTMLElement).innerHTML = `
      <form id="profile-edit" class="grid-form">
        ${field(t('firstName'), input('firstName', 'text', profile.firstName, 'required'))}
        ${field(t('lastName'), input('lastName', 'text', profile.lastName, 'required'))}
        ${field(t('phoneLoginFixed'), input('phone', 'tel', profile.phone, 'disabled'))}
        ${field(t('dateOfBirth'), input('dateOfBirth', 'date', profile.dateOfBirth ?? ''))}
        ${field(t('address'), input('address', 'text', profile.address ?? ''))}
        ${field(t('city'), input('city', 'text', profile.city ?? ''))}
        ${field(t('bloodGroup'), input('bloodGroup', 'text', profile.bloodGroup ?? '', 'placeholder="A+"'))}
        ${field(t('emergencyContact'), input('emergencyContactName', 'text', profile.emergencyContactName ?? ''))}
        ${field(t('emergencyPhone'), input('emergencyContactPhone', 'text', profile.emergencyContactPhone ?? ''))}
        ${field(t('conditionsCsv'), input('chronicConditions', 'text', profile.chronicConditions.join(', ')))}
        ${field(t('allergiesCsv'), input('allergies', 'text', profile.allergies.join(', ')))}
        ${field(t('medicationsCsv'), input('currentMedications', 'text', profile.currentMedications.join(', ')))}
        <button class="primary" type="submit">${esc(t('save'))}</button>
      </form>`;

    (document.getElementById('profile-edit') as HTMLFormElement).addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(event.target as HTMLFormElement);
      const text = (k: string): string | null => {
        const v = String(data.get(k) ?? '').trim();
        return v ? v : null;
      };
      const csv = (k: string): string[] =>
        String(data.get(k) ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      const dob = String(data.get('dateOfBirth') ?? '').trim();
      patientUpdateProfile({
        firstName: String(data.get('firstName') ?? ''),
        lastName: String(data.get('lastName') ?? ''),
        dateOfBirth: dob ? dob : null,
        address: text('address'),
        city: text('city'),
        bloodGroup: text('bloodGroup'),
        emergencyContactName: text('emergencyContactName'),
        emergencyContactPhone: text('emergencyContactPhone'),
        chronicConditions: csv('chronicConditions'),
        allergies: csv('allergies'),
        currentMedications: csv('currentMedications'),
      })
        .then((updated) => {
          toast(t('saved'));
          paint(updated);
        })
        .catch((error: unknown) => toast(errorText(error), 'error'));
    });
  };

  patientProfile()
    .then((profile) => {
      paint(profile);
      paintPhoto(profile);
      paintInsurers(profile);
    })
    .catch((error: unknown) => {
      (document.getElementById('p-profile-form') as HTMLElement).innerHTML =
        `<p class="muted">${esc(errorText(error))}</p>`;
    });
}

function paintPhoto(profile: UiNetworkProfileFull): void {
  const host = document.getElementById('p-photo') as HTMLElement;
  host.innerHTML = `
    <div class="photo-wrap"><span class="avatar xl" id="p-avatar">•</span>
      <label class="button">${esc(t('changePhoto'))}<input id="p-photo-input" type="file" accept="image/jpeg,image/png,image/webp" hidden /></label>
    </div>`;
  avatarObjectUrl(profile.id, true)
    .then((url) => {
      if (url) {
        (document.getElementById('p-avatar') as HTMLElement).outerHTML =
          `<img class="avatar xl" id="p-avatar" src="${esc(url)}" alt="" />`;
      }
    })
    .catch(() => undefined);
  (document.getElementById('p-photo-input') as HTMLInputElement).addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    uploadAvatar(file)
      .then(() => {
        toast(t('photoUpdated'));
        paintPhoto(profile);
      })
      .catch((error: unknown) => toast(errorText(error), 'error'));
  });
}

function paintInsurers(profile: UiNetworkProfileFull): void {
  const host = document.getElementById('p-insurers') as HTMLElement;
  const insurers = profile.insurers ?? [];
  host.innerHTML =
    insurers.length > 0
      ? `<div>${insurers
          .map(
            (i) => `<span class="pill ok">${esc(i.insurerName)} ${i.coveragePercent}%</span> <span class="muted small">${esc(i.clinicName)}</span>`,
          )
          .join(' ')}</div>`
      : `<p class="muted">${esc(t('noInsuranceLinked'))}</p>`;
}
