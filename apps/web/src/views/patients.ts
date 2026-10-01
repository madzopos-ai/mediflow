import { DOCUMENT_KINDS, VITAL_KINDS, evaluateVital, orderKindsForSpecialty, summarizeDictation, vitalLabel, type Specialty, type VitalKind } from '@mediflow/shared';
import {
  OfflineQueuedError,
  accessCode,
  docDelete,
  docFileUrl,
  docRecord,
  docsForPatient,
  fbApproveAllAndShare,
  fbApprovePrescription,
  fbImportPatient,
  fbPatientUploads,
  fbPatientVitals,
  fbShareSnapshot,
  insurersList,
  isFirebaseMode,
  networkIdForLocal,
  networkImport,
  networkLookup,
  patientConsent,
  patientOverview,
  patientUpdate,
  patientsCreate,
  patientsList,
  practicePatterns,
  recordVital,
  rxCreate,
  rxList,
  sharedRecord,
  staffSpecialty,
  testComplete,
  testsList,
  testsOrder,
  visitCreate,
  visitsAll,
  vitalsAll,
  type UiDocument,
  type UiPrescriptionItem,
  type UiVisit,
} from '../data.js';
import { errorText, esc, field, fileToBase64, fmtDateTime, input, sha256Hex, toast } from '../ui.js';
import { docKindLabel, getLang, severityLabel, statusLabel, t, tx, vitalLabelAr } from '../i18n.js';
import { createSpeechRecognizer, type SpeechController } from '../speech.js';
import { ocrPanelHtml, ocrText, runImageRead, runPdfRead } from './labOcr.js';
import { openReport } from '../report.js';
import { addItem, clearDraft, loadDraft, saveDraft } from './rxDraft.js';

export function renderPatients(root: HTMLElement, navigate: (hash: string) => void): void {
  root.innerHTML = `
    <section class="card">
      <h2>${esc(t('networkLookup'))}</h2>
      <p class="muted">${esc(t('networkLookupHint'))}</p>
      <form id="net-lookup" class="row">
        ${field(t('phone'), input('netPhone', 'tel', '', 'required placeholder="+961…"'))}
        <button class="primary" type="submit">${esc(t('search'))}</button>
      </form>
      <div id="net-result"></div>
    </section>
    <section class="card">
      <h2>${esc(t('patients'))}</h2>
      <form id="pat-search" class="row">
        ${field(t('search'), input('q', 'search', '', 'autocomplete="off"'))}
        <button class="primary" type="submit">${esc(t('search'))}</button>
      </form>
      <div id="pat-list"><p class="muted">${esc(t('loading'))}</p></div>
    </section>
    <section class="card">
      <h2>${esc(t('newPatient'))}</h2>
      <form id="pat-new" class="grid-form">
        ${field(t('firstName'), input('firstName', 'text', '', 'required'))}
        ${field(t('lastName'), input('lastName', 'text', '', 'required'))}
        ${field(t('phone'), input('phone', 'tel', '', 'required placeholder="+9665XXXXXXXX"'))}
        ${field(t('dateOfBirth'), input('dateOfBirth', 'date', '', 'required'))}
        ${field(t('address'), input('address', 'text', '', 'required'))}
        ${field(t('heightCm'), input('heightCm', 'number', '', 'required min="20" max="260" step="1"'))}
        ${field(t('weightKg'), input('weightKg', 'number', '', 'required min="0.5" max="500" step="0.1"'))}
        <button class="primary" type="submit">${esc(t('save'))}</button>
      </form>
    </section>`;

  const list = document.getElementById('pat-list') as HTMLElement;

  const load = (q: string): void => {
    patientsList(q)
      .then((items) => {
        const rows = items
          .map(
            (p) => `<tr>
              <td><a href="#/patients/${esc(p.id)}">${esc(p.fullName ?? p.id)}</a></td>
              <td>${esc(p.mrn ?? '')}</td>
              <td dir="ltr">${esc(p.phone ?? '')}</td>
              <td><span class="pill">${p.whatsappOptIn ? esc(t('optedIn')) : esc(t('optedOut'))}</span></td>
            </tr>`,
          )
          .join('');
        list.innerHTML = rows
          ? `<table class="table"><thead><tr><th>${esc(t('name'))}</th><th>MRN</th><th>${esc(t('phone'))}</th><th>${esc(t('whatsappOptIn'))}</th></tr></thead><tbody>${rows}</tbody></table>`
          : `<p class="muted">${esc(t('noResults'))}</p>`;
      })
      .catch((error: unknown) => {
        list.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };
  load('');

  (document.getElementById('net-lookup') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const phone = String(new FormData(event.target as HTMLFormElement).get('netPhone') ?? '');
    const out = document.getElementById('net-result') as HTMLElement;
    out.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;
    // Firebase mode: the phone number IS the key. A registered app account
    // is imported (or opened when already filed) with one click.
    void isFirebaseMode().then((fbMode) => {
      if (!fbMode) {
        lookupNetwork(out, phone, navigate);
        return;
      }
      fbImportPatient(phone)
        .then(({ localId, fullName }) => {
          out.innerHTML = `<div class="vital-card">
            <div class="vital-top"><strong>${esc(fullName)}</strong><span class="pill ok">${esc(t('registered'))}</span></div>
            <div class="muted" dir="ltr">${esc(phone)}</div>
            <div class="row"><button id="net-open">${esc(t('openFile'))}</button></div>
          </div>`;
          (document.getElementById('net-open') as HTMLButtonElement).addEventListener('click', () => {
            navigate(`#/patients/${localId}`);
          });
        })
        .catch((error: unknown) => {
          out.innerHTML =
            error instanceof Error && error.message === 'not-registered'
              ? `<p class="muted">${esc(t('notRegisteredHint'))}</p>`
              : `<p class="muted">${esc(errorText(error))}</p>`;
        });
    });
  });

  function lookupNetwork(out: HTMLElement, phone: string, navigate: (hash: string) => void): void {
    networkLookup(phone)
      .then((result) => {
        if (!result.registered || !result.profile) {
          out.innerHTML = `<p class="muted">${esc(t('notRegisteredHint'))}</p>`;
          return;
        }
        const p = result.profile;
        out.innerHTML = `<div class="vital-card">
          <div class="vital-top"><strong>${esc(p.fullName)}</strong><span class="pill ok">${esc(t('registered'))}</span></div>
          <div class="muted" dir="ltr">${esc(p.phone)}</div>
          <div class="row"><button id="net-open">${esc(result.linkedLocalPatientId ? t('openFile') : t('openFileImport'))}</button></div>
        </div>`;
        (document.getElementById('net-open') as HTMLButtonElement).addEventListener('click', () => {
          if (result.linkedLocalPatientId) {
            navigate(`#/patients/${result.linkedLocalPatientId}`);
            return;
          }
          networkImport(p.id)
            .then((imported) => navigate(`#/patients/${imported.localPatientId}`))
            .catch((error: unknown) => toast(errorText(error), 'error'));
        });
      })
      .catch((error: unknown) => {
        out.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
      });
  }

  (document.getElementById('pat-search') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    load(String(data.get('q') ?? ''));
  });

  (document.getElementById('pat-new') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    patientsCreate(
      String(form.get('firstName') ?? ''),
      String(form.get('lastName') ?? ''),
      String(form.get('phone') ?? ''),
      {
        dateOfBirth: String(form.get('dateOfBirth') ?? ''),
        address: String(form.get('address') ?? ''),
        heightCm: Number(form.get('heightCm') ?? 0),
        weightKg: Number(form.get('weightKg') ?? 0),
      },
    )
      .then((created) => navigate(`#/patients/${created.id}`))
      .catch((error: unknown) => {
        if (error instanceof OfflineQueuedError) toast(t('queued'));
        else toast(errorText(error), 'error');
      });
  });
}

type PatientTab = 'overview' | 'visits' | 'vitals' | 'treatment' | 'shared';

function tabBar(id: string, active: PatientTab): string {
  const link = (tab: PatientTab, label: string): string =>
    `<a href="#/patients/${esc(id)}${tab === 'overview' ? '' : `/${tab}`}" class="${active === tab ? 'active' : ''}">${esc(label)}</a>`;
  return `<nav class="tabs">${link('overview', t('overview'))}${link('visits', t('visits'))}${link('vitals', t('vitals'))}${link('treatment', t('treatment'))}${link('shared', t('sharedRecord'))}</nav>`;
}

function headerHtml(
  id: string,
  fullName: string,
  mrn: string,
  phone: string,
  whatsappOptIn: boolean,
  active: PatientTab,
  details: { ageYears: number | null; heightCm: number | null; weightKg: number | null; address: string | null; insurer?: string | null } | null = null,
): string {
  // Labeled facts in a fixed order: RTL auto-mirroring scrambles bare
  // numbers ("cm · 110 kg 178"), labels keep every value readable.
  const facts: string[] = [];
  if (details) {
    if (details.ageYears !== null) facts.push(`${esc(t('age'))}: ${details.ageYears}`);
    if (details.heightCm !== null) facts.push(`${esc(t('height'))}: ${details.heightCm} cm`);
    if (details.weightKg !== null) facts.push(`${esc(t('weight'))}: ${details.weightKg} kg`);
    if (details.address) facts.push(`${esc(t('address'))}: ${esc(details.address)}`);
    if (details.insurer) facts.push(details.insurer);
  }
  return `
    <button id="back" class="ghost">← ${esc(t('back'))}</button>
    <section class="card">
      <div class="name-row"><h2>${esc(fullName ?? id)}</h2><button id="edit-open">${esc(t('edit'))}</button></div>
      <p class="muted">MRN ${esc(mrn ?? '')} · <span dir="ltr">${esc(phone ?? '')}</span> · ${whatsappOptIn ? esc(t('optedIn')) : esc(t('optedOut'))}</p>
      ${facts.length > 0 ? `<p>${facts.join(' · ')}</p>` : ''}
      <div class="row">
        <button id="consent-toggle">${whatsappOptIn ? esc(t('optOut')) : esc(t('optIn'))}</button>
        <a class="button" href="#/review/${esc(id)}">${esc(t('decisionSupport'))}</a>
        <button id="access-code">${esc(t('patientAppCode'))}</button>
        <span id="access-code-out"></span>
        <span id="fb-share-out"></span>
      </div>
    </section>
    ${tabBar(id, active)}`;
}

function wireHeader(root: HTMLElement, id: string, whatsappOptIn: boolean, patientAppId: string | null = null): void {
  (document.getElementById('back') as HTMLButtonElement).addEventListener('click', () => window.history.back());
  document.getElementById('edit-open')?.addEventListener('click', () => openEditModal(root, id));
  (document.getElementById('access-code') as HTMLButtonElement).addEventListener('click', (event) => {
    const button = event.target as HTMLButtonElement;
    button.disabled = true;
    accessCode(id)
      .then((code) => {
        const out = document.getElementById('access-code-out') as HTMLElement;
        // Shown once: the code itself is never stored or listed anywhere.
        out.innerHTML = esc(tx('accessCodeHint', { code }));
      })
      .catch((error: unknown) => {
        button.disabled = false;
        toast(errorText(error), 'error');
      });
  });
  (document.getElementById('consent-toggle') as HTMLButtonElement).addEventListener('click', () => {
    patientConsent(id, !whatsappOptIn)
      .then(() => renderPatientDetail(root, id, currentTab()))
      .catch((error: unknown) => {
        if (error instanceof OfflineQueuedError) toast(t('queued'));
        else toast(errorText(error), 'error');
      });
  });

  // Firebase-mode snapshot sharing for linked patients. API mode keeps the
  // access-code flow above; this row stays empty there. Linking itself
  // happens from the Patients list (import by phone).
  void isFirebaseMode().then((fbMode) => {
    if (!fbMode) return;
    const host = document.getElementById('fb-share-out');
    if (!host || !patientAppId) return;
    host.innerHTML = `<span class="pill ok">${esc(t('linkedOk'))}</span> <button id="fb-share">${esc(t('shareSnapshot'))}</button>`;
    (document.getElementById('fb-share') as HTMLButtonElement).addEventListener('click', (event) => {
      const button = event.target as HTMLButtonElement;
      button.disabled = true;
      fbShareSnapshot(id)
        .then((clinicName) => {
          toast(`${t('sharedOk')} · ${clinicName}`);
          button.disabled = false;
        })
        .catch((error: unknown) => {
          button.disabled = false;
          toast(errorText(error), 'error');
        });
    });
  });
}

/** Edit form in a modal popup next to the workflow, not a section below it. */
function openEditModal(root: HTMLElement, id: string): void {
  Promise.all([patientOverview(id), insurersList()])
    .then(([data, insurers]) => {
      const p = data.patient;
      const active = insurers.filter((i) => i.isActive || i.id === (p?.insurerId ?? ''));
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" role="dialog" aria-label="${esc(t('edit'))}">
          <div class="modal-top"><h3>${esc(t('edit'))} - ${esc(p?.fullName ?? '')}</h3><button id="modal-close">✕</button></div>
          <form id="modal-edit" class="grid-form">
            ${field(t('firstName'), input('firstName', 'text', p?.firstName ?? ''))}
            ${field(t('lastName'), input('lastName', 'text', p?.lastName ?? ''))}
            ${field(t('phone'), input('phone', 'tel', p?.phone ?? ''))}
            ${field(t('dateOfBirth'), input('dateOfBirth', 'date', p?.dateOfBirth ?? ''))}
            ${field(t('address'), input('address', 'text', p?.address ?? ''))}
            ${field(t('heightCm'), input('heightCm', 'number', p?.heightCm === null || p?.heightCm === undefined ? '' : String(p.heightCm), 'min="20" max="260" step="1"'))}
            ${field(t('weightKg'), input('weightKg', 'number', p?.weightKg === null || p?.weightKg === undefined ? '' : String(p.weightKg), 'min="0.5" max="500" step="0.1"'))}
            ${field(t('insurer'), `<select name="insurerId">
              <option value="">${esc(t('none'))}</option>
              ${active.map((i) => `<option value="${esc(i.id)}" ${i.id === (p?.insurerId ?? '') ? 'selected' : ''}>${esc(i.name)} ${i.coveragePercent}%</option>`).join('')}
            </select>`)}
            ${field(t('policyNo'), input('insurerPolicyNo', 'text', p?.insurerPolicyNo ?? ''))}
            <button class="primary" type="submit">${esc(t('save'))}</button>
          </form>
        </div>`;
      root.appendChild(overlay);
      const close = (): void => overlay.remove();
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
      });
      (overlay.querySelector('#modal-close') as HTMLButtonElement).addEventListener('click', close);

      (overlay.querySelector('#modal-edit') as HTMLFormElement).addEventListener('submit', (event) => {
        event.preventDefault();
        const form = new FormData(event.target as HTMLFormElement);
        const text = (k: string): string | undefined => {
          const v = String(form.get(k) ?? '').trim();
          return v ? v : undefined;
        };
        const num = (k: string): number | undefined => {
          const raw = String(form.get(k) ?? '').trim();
          if (!raw) return undefined;
          const n = Number(raw);
          return Number.isFinite(n) ? n : undefined;
        };
        const update: {
          firstName?: string;
          lastName?: string;
          phone?: string;
          dateOfBirth?: string;
          heightCm?: number | null;
          weightKg?: number | null;
          address?: string;
          insurerId?: string | null;
          insurerPolicyNo?: string | null;
        } = {};
        const assign = <K extends keyof typeof update>(key: K, value: (typeof update)[K] | undefined): void => {
          if (value !== undefined) update[key] = value;
        };
        assign('firstName', text('firstName'));
        assign('lastName', text('lastName'));
        assign('phone', text('phone'));
        assign('address', text('address'));
        const dob = String(form.get('dateOfBirth') ?? '').trim();
        if (dob) update.dateOfBirth = dob;
        assign('heightCm', num('heightCm'));
        assign('weightKg', num('weightKg'));
        const insurerId = String(form.get('insurerId') ?? '');
        update.insurerId = insurerId ? insurerId : null;
        const policy = String(form.get('insurerPolicyNo') ?? '').trim();
        update.insurerPolicyNo = policy ? policy : null;
        patientUpdate(id, update)
          .then(() => {
            close();
            renderPatientDetail(root, id, currentTab());
          })
          .catch((error: unknown) => {
            if (error instanceof OfflineQueuedError) toast(t('queued'));
            else toast(errorText(error), 'error');
          });
      });
    })
    .catch((error: unknown) => toast(errorText(error), 'error'));
}
function currentTab(): PatientTab {
  const hash = window.location.hash;
  if (hash.includes('/visits')) return 'visits';
  if (hash.includes('/vitals')) return 'vitals';
  if (hash.includes('/treatment')) return 'treatment';
  if (hash.includes('/shared')) return 'shared';
  return 'overview';
}

export function renderPatientDetail(root: HTMLElement, id: string, tab: PatientTab = 'overview'): void {
  if (tab === 'visits') {
    renderVisitsTab(root, id);
    return;
  }
  if (tab === 'vitals') {
    renderVitalsTab(root, id);
    return;
  }
  if (tab === 'treatment') {
    renderTreatmentTab(root, id);
    return;
  }
  if (tab === 'shared') {
    renderSharedTab(root, id);
    return;
  }
  renderOverviewTab(root, id);
}

function renderSharedTab(root: HTMLElement, id: string): void {
  root.innerHTML = `<section class="card"><p class="muted">${esc(t('loading'))}</p></section>`;
  networkIdForLocal(id)
    .then((networkId) => {
      if (!networkId) {
        root.innerHTML = `<section class="card"><p class="muted">${esc(t('notLinkedHint'))}</p></section>`;
        return null;
      }
      return sharedRecord(networkId);
    })
    .then((record) => {
      if (!record) return;
      root.innerHTML =
        `<section class="card"><h2>${esc(t('sharedRecord'))}</h2>
          <p class="muted">${esc(record.profile.fullName)} · <span dir="ltr">${esc(record.profile.phone)}</span> · ${esc(tx('sharedRecordHint', { n: record.clinics.length }))}</p>
        </section>` +
        record.clinics
          .map(
            (c) => `<section class="card">
              <h3>${esc(c.clinicName)}</h3>
              ${
                c.prescriptions.length > 0
                  ? `<div>${esc(t('medicationsLabel'))}: ${esc(c.prescriptions.flatMap((p) => p.items.map((i) => i.drug)).slice(0, 8).join(', '))}</div>`
                  : ''
              }
              ${
                c.vitals.length > 0
                  ? `<ul class="list">${c.vitals.slice(0, 10).map((v) => `<li>${esc(vitalLabelAr(v.kind, v.kind))}: <strong>${esc(String(v.value))} ${esc(v.unit)}</strong> <span class="muted">${esc(fmtDateTime(v.measuredAt))}</span></li>`).join('')}</ul>`
                  : `<p class="muted">${esc(t('noVitalsShared'))}</p>`
              }
              ${
                c.visits.length > 0
                  ? `<div class="muted small">${c.visits.length} ${esc(t('visits'))}${c.visits[0]?.diagnosis ? `، ${esc(t('diagnosisLabel'))}: ${esc(c.visits[0]?.diagnosis ?? '')}` : ''}</div>`
                  : ''
              }
            </section>`,
          )
          .join('');
    })
    .catch((error: unknown) => {
      root.innerHTML = `<section class="card"><p class="muted">${esc(errorText(error))}</p></section>`;
    });
}

function renderOverviewTab(root: HTMLElement, id: string): void {
  root.innerHTML = `<section class="card"><p class="muted">${esc(t('loading'))}</p></section>`;
  Promise.all([patientOverview(id), docsForPatient(id), insurersList()])
    .then(([data, documents, insurers]) => {
      const p = data.patient;
      const insurer = insurers.find((i) => i.id === (p?.insurerId ?? ''));
      const details = {
        ageYears: p?.ageYears ?? null,
        heightCm: p?.heightCm ?? null,
        weightKg: p?.weightKg ?? null,
        address: p?.address ?? null,
        insurer: insurer ? `${t('insurer')}: ${insurer.name} ${insurer.coveragePercent}%${p?.insurerPolicyNo ? ` · ${p.insurerPolicyNo}` : ''}` : null,
      };
      root.innerHTML =
        headerHtml(id, p?.fullName ?? id, p?.mrn ?? '', p?.phone ?? '', p?.whatsappOptIn ?? false, 'overview', details) +
        `<section class="grid">
          <div class="card"><h3>${esc(t('vitals'))}</h3>${vitalsSummary(data.vitals ?? [])}
            <p><a class="button" href="#/patients/${esc(id)}/vitals">${esc(t('overview'))} ←</a></p>
          </div>
          <div class="card"><h3>${esc(t('visits'))}</h3>${visitsList(data.visits ?? [])}</div>
          <div class="card"><h3>${esc(t('appointments'))}</h3>${apptsList(data.appointments ?? [])}</div>
          <div class="card"><h3>${esc(t('openAlerts'))}</h3>${alertsList(data.alerts ?? [])}</div>
          <div class="card wide"><h3>${esc(t('documents'))}</h3>${documentsList(documents)}
            <form id="doc-upload" class="row">
              ${field(t('docKindLabel'), `<select name="kind">${DOCUMENT_KINDS.map((k) => `<option value="${k}">${esc(docKindLabel(k))}</option>`).join('')}</select>`)}
              ${field(t('testName'), input('title', 'text', '', getLang() === 'ar' ? 'placeholder="مثال: سكري تراكمي"' : 'placeholder="e.g. HbA1c Q3"'))}
              ${field(t('file'), `<input name="file" type="file" accept="image/*,.pdf,.xls,.xlsx,.csv,.doc,.docx,.txt" capture="environment" required />`)}
              <button class="primary" type="submit">${esc(t('save'))}</button>
            </form>
            ${ocrPanelHtml()}
          </div>
          <div class="card wide" id="pat-app-uploads" hidden></div>
        </section>`;
      wireHeader(root, id, p?.whatsappOptIn ?? false, p?.patientAppId ?? null);
      wireDocuments(root, id);
      if (p?.patientAppId) loadPatientAppUploads(root, p.patientAppId);
    })
    .catch((error: unknown) => {
      root.innerHTML = `<section class="card"><p class="muted">${esc(errorText(error))}</p></section>`;
    });
}

/** Patient-app readings + test photos as cards inside the staff vitals tab. */
function loadPatientAppVitals(root: HTMLElement, appId: string): void {
  const host = root.querySelector('#pat-app-vitals') as HTMLElement | null;
  if (!host) return;
  Promise.all([fbPatientUploads(appId), fbPatientVitals(appId)])
    .then(([uploads, vitals]) => {
      if (uploads.length === 0 && vitals.length === 0) {
        host.hidden = true;
        return;
      }
      host.hidden = false;
      const groups = new Map<string, typeof vitals>();
      for (const v of vitals) {
        const list = groups.get(v.kind) ?? [];
        list.push(v);
        groups.set(v.kind, list);
      }
      host.innerHTML = `<h3>📲 ${esc(t('patientUploadsTitle'))}</h3>
        ${vitals.length > 0
          ? `<div class="pgrid">` +
            [...groups.entries()]
              .map(
                ([kind, rows]) => `<div class="pcard accent-blue"><h3>${esc(vitalLabelAr(kind, kind))}</h3>
                  <div class="big">${esc(String(rows[0]?.value ?? ''))} <small>${esc(rows[0]?.unit ?? '')}</small></div>
                  <ul class="list">${rows
                    .slice(0, 6)
                    .map((r) => `<li>${esc(String(r.value))} ${esc(r.unit)} <span class="muted">${esc(fmtDateTime(r.measuredAt))}</span></li>`)
                    .join('')}</ul>
                </div>`,
              )
              .join('') +
            `</div>`
          : ''}
        ${uploads.length > 0
          ? `<div class="pgrid" style="margin-top:.6rem">` +
            uploads
              .slice(0, 12)
              .map(
                (u) => `<div class="pcard"><div class="muted small">${esc(u.fileName)}</div>
                  <div class="muted small">${esc(fmtDateTime(u.createdAt))}</div>
                  ${u.dataUrl ? `<img src="${esc(u.dataUrl)}" alt="" loading="lazy" style="max-width:100%;border-radius:8px" />` : ''}</div>`,
              )
              .join('') +
            `</div>`
          : ''}`;
    })
    .catch(() => {
      host.hidden = true;
    });
}

/** Files + confirmed readings the patient uploaded from their own app. */
function loadPatientAppUploads(root: HTMLElement, appId: string): void {  const host = root.querySelector('#pat-app-uploads') as HTMLElement | null;
  if (!host) return;
  Promise.all([fbPatientUploads(appId), fbPatientVitals(appId)])
    .then(([uploads, vitals]) => {
      if (uploads.length === 0 && vitals.length === 0) {
        host.hidden = true;
        return;
      }
      host.hidden = false;
      host.innerHTML = `<h3>${esc(t('patientUploadsTitle'))}</h3>` +
        (vitals.length > 0
          ? `<ul class="list">${vitals.map((v) => `<li>${esc(vitalLabelAr(v.kind, v.kind))}: <strong>${esc(String(v.value))} ${esc(v.unit)}</strong> <span class="muted">${esc(fmtDateTime(v.measuredAt))}</span></li>`).join('')}</ul>`
          : '') +
        (uploads.length > 0
          ? `<div class="pgrid">${uploads
              .map(
                (u) => `<div class="pcard"><div class="muted small">${esc(u.fileName)} · ${esc(fmtDateTime(u.createdAt))}</div>
                  ${u.dataUrl ? `<img src="${esc(u.dataUrl)}" alt="" loading="lazy" style="max-width:100%;border-radius:8px" />` : ''}</div>`,
              )
              .join('')}</div>`
          : '');
    })
    .catch(() => {
      host.hidden = true;
    });
}

function renderVisitsTab(root: HTMLElement, id: string): void {  root.innerHTML = `<section class="card"><p class="muted">${esc(t('loading'))}</p></section>`;
  Promise.all([patientOverview(id), visitsAll(id), testsList(id), docsForPatient(id)])
    .then(([data, visits, tests, documents]) => {
      const p = data.patient;
      root.innerHTML =
        headerHtml(id, p?.fullName ?? id, p?.mrn ?? '', p?.phone ?? '', p?.whatsappOptIn ?? false, 'visits') +
        `<section class="card">
          <h3>${esc(t('orderTests'))}</h3>
          <form id="test-order" class="row">
            ${field(t('testName'), input('testName', 'text', '', getLang() === 'ar' ? 'placeholder="سكري تراكمي، تعداد عام…"' : 'placeholder="HbA1c, CBC…"'))}
            ${field(t('priority'), `<select name="priority"><option value="routine">${esc(t('routine'))}</option><option value="urgent">${esc(t('urgent'))}</option></select>`)}
            ${field(t('prepNotes'), input('prepNotes', 'text', '', getLang() === 'ar' ? 'placeholder="صيام 8 ساعات…"' : 'placeholder="fasting 8h…"'))}
            ${field(t('notes'), input('testNotes', 'text', ''))}
            <button class="primary" type="submit">${esc(t('order'))}</button>
          </form>
          <h3>${esc(t('requestedTests'))} (${tests.length})</h3>
          <div id="tests-list">${requestedTestsList(tests, documents)}</div>
        </section>
        <section class="card">
          <h3>${esc(t('newVisit'))}</h3>
          <form id="visit-form" class="grid-form">
            ${field(t('visitType'), `<select name="visitType"><option value="consultation">${esc(statusLabel('consultation'))}</option><option value="follow_up">${esc(statusLabel('follow_up'))}</option><option value="procedure">${esc(statusLabel('procedure'))}</option><option value="teleconsult">${esc(statusLabel('teleconsult'))}</option><option value="review">${esc(statusLabel('review'))}</option></select>`)}
            ${field(t('chiefComplaint'), input('chiefComplaint', 'text', ''))}
            ${field(t('diagnosisShort'), input('diagnosis', 'text', ''))}
            ${field(t('plan'), `<textarea name="plan" rows="2"></textarea>`)}
            ${field(t('notes'), `<textarea name="notes" rows="2"></textarea>`)}
            <button class="primary" type="submit">${esc(t('save'))}</button>
          </form>
        </section>
        <section class="card"><h3>${esc(t('visits'))} (${visits.length})</h3>${visitsFullList(visits)}</section>`;
      wireHeader(root, id, p?.whatsappOptIn ?? false, p?.patientAppId ?? null);
      wireVisitsTab(root, id);
    })
    .catch((error: unknown) => {
      root.innerHTML = `<section class="card"><p class="muted">${esc(errorText(error))}</p></section>`;
    });
}

function requestedTestsList(
  tests: { id: string; name: string; status: string; isShared?: boolean; priority?: string | null; prepNotes?: string | null; documentId: string | null; notes: string | null; createdAt: string }[],
  documents: UiDocument[],
): string {
  if (tests.length === 0) return `<p class="muted">${esc('—')}</p>`;
  const docName = (docId: string | null): string => {
    if (!docId) return '';
    const found = documents.find((d) => d.id === docId);
    return found ? ` → ${found.title ?? found.fileName}` : '';
  };
  return `<ul class="list">${tests
    .map(
      (test) => `<li>
        <strong>${esc(test.name)}</strong>
        <span class="pill ${test.status === 'done' ? 'ok' : test.status === 'cancelled' ? 'danger' : ''}">${esc(statusLabel(test.status))}</span>
        ${test.isShared === false ? `<span class="pill warn">${esc(t('unshared'))}</span>` : ''}
        ${test.priority === 'urgent' ? `<span class="pill danger">⚡ ${esc(t('urgent'))}</span>` : ''}
        ${test.prepNotes ? `<span class="muted">📋 ${esc(test.prepNotes)}</span>` : ''}
        ${test.notes ? `<span class="muted">${esc(test.notes)}</span>` : ''}
        <span class="muted">${esc(docName(test.documentId))} · ${esc(fmtDateTime(test.createdAt))}</span>
        ${test.status === 'requested' ? `<span class="row-actions">
          <select data-testdoc="${esc(test.id)}">
            <option value="">${esc(t('linkResult'))}</option>
            ${documents.map((d) => `<option value="${esc(d.id)}">${esc(d.title ?? d.fileName)}</option>`).join('')}
          </select>
          <button data-testdone="${esc(test.id)}">${esc(t('markDone'))}</button>
        </span>` : ''}
      </li>`,
    )
    .join('')}</ul>`;
}

function wireVisitsTab(root: HTMLElement, id: string): void {
  (document.getElementById('test-order') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    testsOrder(
      id,
      String(data.get('testName') ?? ''),
      String(data.get('testNotes') ?? '').trim() || null,
      {
        priority: String(data.get('priority') ?? 'routine'),
        prepNotes: String(data.get('prepNotes') ?? '').trim() || null,
      },
    )
      .then(() => renderVisitsTab(root, id))
      .catch((error: unknown) => {
        if (error instanceof OfflineQueuedError) toast(t('queued'));
        else toast(errorText(error), 'error');
      });
  });

  root.querySelectorAll<HTMLButtonElement>('button[data-testdone]').forEach((button) => {
    button.addEventListener('click', () => {
      const testId = button.dataset.testdone ?? '';
      const select = root.querySelector(`select[data-testdoc="${testId}"]`) as HTMLSelectElement | null;
      const documentId = select?.value ? select.value : null;
      testComplete(testId, documentId)
        .then(() => renderVisitsTab(root, id))
        .catch((error: unknown) => {
          if (error instanceof OfflineQueuedError) toast(t('queued'));
          else toast(errorText(error), 'error');
        });
    });
  });

  (document.getElementById('visit-form') as HTMLFormElement).addEventListener('submit', (event) => {
        event.preventDefault();
        const form = new FormData(event.target as HTMLFormElement);
        const text = (k: string): string | null => {
          const v = String(form.get(k) ?? '').trim();
          return v ? v : null;
        };
        visitCreate({
          patientId: id,
          visitType: String(form.get('visitType') ?? 'consultation'),
          chiefComplaint: text('chiefComplaint'),
          diagnosis: text('diagnosis'),
          plan: text('plan'),
          notes: text('notes'),
        })
          .then(() => renderVisitsTab(root, id))
          .catch((error: unknown) => {
            if (error instanceof OfflineQueuedError) toast(t('queued'));
            else toast(errorText(error), 'error');
          });
      });
}

function renderVitalsTab(root: HTMLElement, id: string): void {
  root.innerHTML = `<section class="card"><p class="muted">${esc(t('loading'))}</p></section>`;
  Promise.all([patientOverview(id), vitalsAll(id), staffSpecialty().catch(() => null)])
    .then(([data, vitals, specialty]) => {
      const p = data.patient;
      // The kind list leads with this specialty's panel: a nephrologist sees
      // creatinine first. Everything else stays below, never hidden.
      const kinds = specialty ? orderKindsForSpecialty(VITAL_KINDS, specialty as Specialty) : [...VITAL_KINDS];
      root.innerHTML =
        headerHtml(id, p?.fullName ?? id, p?.mrn ?? '', p?.phone ?? '', p?.whatsappOptIn ?? false, 'vitals') +
        `<section class="card"><h3>${esc(t('vitals'))} (${vitals.length})</h3>${vitalsGrouped(vitals)}
          <div class="row"><button id="vitals-pdf">${esc(t('exportPdf'))} — ${esc(t('labReportTitle'))}</button></div>
          <h3>${esc(t('addReading'))}</h3>
          <form id="vital-form" class="grid-form">
            ${field(t('kind'), `<select name="kind">${kinds.map((k) => `<option value="${k}">${esc(vitalLabelAr(k, vitalLabel(k)))}</option>`).join('')}</select>`)}
            ${field(t('value'), input('value', 'number', '', 'required step="any"'))}
            <button class="primary" type="submit">${esc(t('recordVitals'))}</button>
          </form>
        </section>
        <section class="card" id="pat-app-vitals" hidden></section>`;
      wireHeader(root, id, p?.whatsappOptIn ?? false, p?.patientAppId ?? null);
      if (p?.patientAppId) loadPatientAppVitals(root, p.patientAppId);

      document.getElementById('vitals-pdf')?.addEventListener('click', () => {
        openReport({
          title: t('labReportTitle'),
          patientName: p?.fullName ?? id,
          rows: vitals.slice(0, 60).map((v) => ({
            label: vitalLabelAr(v.kind, v.kind),
            value: `${v.value} ${v.unit} · ${fmtDateTime(v.measuredAt)}`,
          })),
        });
      });

      (document.getElementById('vital-form') as HTMLFormElement).addEventListener('submit', (event) => {
        event.preventDefault();
        const form = new FormData(event.target as HTMLFormElement);
        recordVital(id, String(form.get('kind') ?? ''), Number(form.get('value') ?? 0))
          .then(() => renderVitalsTab(root, id))
          .catch((error: unknown) => {
            if (error instanceof OfflineQueuedError) toast(t('queued'));
            else toast(errorText(error), 'error');
          });
      });
    })
    .catch((error: unknown) => {
      root.innerHTML = `<section class="card"><p class="muted">${esc(errorText(error))}</p></section>`;
    });
}

function renderTreatmentTab(root: HTMLElement, id: string): void {
  root.innerHTML = `<section class="card"><p class="muted">${esc(t('loading'))}</p></section>`;
  Promise.all([patientOverview(id), rxList(id), vitalsAll(id)])
    .then(([data, allRx, vitals]) => {
      const p = data.patient;
      const draft = loadDraft(id);
      const active = allRx.filter((r) => r.status === 'active');
      const drafts = allRx.filter((r) => r.status !== 'active');
      const labOf = (kind: string): number | null => vitals.find((v) => v.kind === kind)?.value ?? null;
      const lifeInput = {
        diagnosis: '',
        conditions: [] as string[],
        labs: {
          hba1c: labOf('hba1c'),
          systolic: labOf('systolic_bp'),
          ldl: labOf('ldl'),
          triglycerides: labOf('triglycerides'),
          microalbumin: labOf('microalbumin'),
          urineAcr: labOf('urine_acr'),
          creatinine: labOf('creatinine'),
          urea: labOf('urea') ?? labOf('blood_urea'),
          egfr: null,
        },
        weightKg: p?.weightKg ?? null,
        ageYears: p?.ageYears ?? null,
      };
      root.innerHTML =
        headerHtml(id, p?.fullName ?? id, p?.mrn ?? '', p?.phone ?? '', p?.whatsappOptIn ?? false, 'treatment') +
        `<section class="card">
          <div class="row" style="justify-content:space-between;align-items:center">
            <h3 style="margin:0">✅ ${esc(t('approveShare'))}</h3>
            <button id="rx-share" class="primary">${esc(t('approveShare'))}</button>
          </div>
          <p class="muted">${esc(t('approveShareHint'))}</p>
        </section>
        ${drafts.length > 0 ? `<section class="card"><h3>📝 ${esc(t('draftsPending'))} (${drafts.length})</h3>
          <ul class="list">${drafts
            .map(
              (r) => `<li><span class="pill warn">${esc(t('draftStatus'))}</span>
                ${esc(r.items.map((i) => i.drug).join('، ') || '—')}
                <button data-approve="${esc(r.id)}">${esc(t('approve'))}</button></li>`,
            )
            .join('')}</ul></section>` : ''}
        <section class="card"><h3>${esc(t('activePrescriptions'))} (${active.length})</h3>${prescriptionsList(active)}
          <div class="row"><button id="rx-pdf">${esc(t('exportPdf'))} — ${esc(t('rxReportTitle'))}</button></div></section>
        <section class="card" id="life-card"><h3>🥗 ${esc(t('lifestyleTitle'))}</h3><div id="life-body"><p class="muted">${esc(t('loading'))}</p></div></section>
        <section class="card">
          <h3>${esc(t('prescriptionDraft'))} ${draft.items.length > 0 ? `(${draft.items.length})` : ''}</h3>
          <p class="muted">${esc(t('prescriptionDraftHint'))}</p>
          <div id="rx-items">${draftItems(draft.items)}</div>
          <form id="rx-add" class="grid-form">
            ${field(t('drug'), `<input name="drug" type="text" list="rx-drugs" required /><datalist id="rx-drugs"></datalist>`)}
            ${field(t('dose'), input('dose', 'text', '', getLang() === 'ar' ? 'placeholder="500 ملغ"' : 'placeholder="500mg"'))}
            ${field(t('frequency'), input('frequency', 'text', '', getLang() === 'ar' ? 'placeholder="مرتين يوميًا"' : 'placeholder="twice daily"'))}
            ${field(t('days'), input('durationDays', 'number', '', 'min="1"'))}
            ${field(t('instructions'), input('instructions', 'text', ''))}
            <button type="submit">${esc(t('addItem'))}</button>
          </form>
          <form id="rx-save" class="grid-form">
            ${field(t('diet'), input('diet', 'text', draft.diet.join(', ')))}
            ${field(t('exercise'), input('exercise', 'text', draft.exercise.join(', ')))}
            ${field(t('notes'), `<textarea name="notes" rows="2">${esc(draft.notes)}</textarea>`)}
            <button class="primary" type="submit">${esc(t('savePrescription'))}</button>
          </form>
        </section>
        <section class="card">
          <h3>${esc(t('usualPractice'))}</h3>
          <p class="muted">${esc(t('usualPracticeHint'))}</p>
          <form id="rx-usual" class="row">
            ${field(t('diagnosisShort'), input('usualDiagnosis', 'text', ''))}
            <button type="submit">${esc(t('show'))}</button>
          </form>
          <div id="rx-usual-out"></div>
        </section>
        <section class="card">
          <h3>${esc(t('dictate'))}</h3>
          <p class="muted">${esc(t('dictateHint'))}</p>
          <div class="row"><button id="voice-start">${esc(t('record'))}</button><button id="voice-stop" disabled>${esc(t('stopAttach'))}</button><span id="voice-state" class="muted"></span></div>
          <p class="muted">${esc(t('voiceSummaryHint'))}</p>
          <div class="grid-form">
            ${field(t('dictatedText'), `<textarea id="voice-text" rows="3"></textarea>`)}
          </div>
          <div class="row"><button id="voice-summarize">${esc(t('summarize'))}</button></div>
          <div class="row">
            <button id="voice-listen">${esc(t('startListening'))}</button>
            <span id="voice-listen-state" class="muted"></span>
          </div>
          <div id="voice-summary"></div>
        </section>
        <section class="card">
          <h3>${esc(t('photoRx'))}</h3>
          <p class="muted">${esc(t('photoRxHint'))}</p>
          <form id="rx-photo" class="row">
            ${field(t('photo'), `<input name="photo" type="file" accept="image/*" capture="environment" required />`)}
            <button class="primary" type="submit">${esc(t('readPhoto'))}</button>
          </form>
          <div id="rx-lines"></div>
        </section>`;
      wireHeader(root, id, p?.whatsappOptIn ?? false, p?.patientAppId ?? null);
      wireTreatment(root, id);
      // Lifestyle plan, auto-drafted from the chart labs the doctor already sees.
      void import('@mediflow/shared')
        .then((shared) => {
          const host = document.getElementById('life-body');
          if (!host) return;
          const plan = shared.recommendLifestyle(lifeInput, getLang() === 'ar' ? 'ar' : 'en');
          host.innerHTML =
            (plan.targets.length > 0 ? `<h4>${esc(t('lifestyleTargets'))}</h4><ul class="list">${plan.targets.map((x) => `<li>🎯 ${esc(x)}</li>`).join('')}</ul>` : '') +
            (plan.diet.length > 0 ? `<h4>${esc(t('lifestyleDiet'))}</h4><ul class="list">${plan.diet.map((x) => `<li>🍽️ ${esc(x)}</li>`).join('')}</ul>` : '') +
            (plan.exercise.length > 0 ? `<h4>${esc(t('lifestyleExercise'))}</h4><ul class="list">${plan.exercise.map((x) => `<li>🚶 ${esc(x)}</li>`).join('')}</ul>` : '');
        })
        .catch(() => undefined);
    })
    .catch((error: unknown) => {
      root.innerHTML = `<section class="card"><p class="muted">${esc(errorText(error))}</p></section>`;
    });
}

function prescriptionsList(items: { items: UiPrescriptionItem[]; diet: string[]; exercise: string[]; notes: string | null; createdAt: string }[]): string {
  if (items.length === 0) return `<p class="muted">${esc('—')}</p>`;
  return `<div class="cards-grid">` + items
    .map(
      (rx) => `<div class="vital-card">
        <div class="muted small">${esc(fmtDateTime(rx.createdAt))}</div>
        <ul class="list">${rx.items.map((i) => `<li><strong>${esc(i.drug)}</strong> ${esc(i.dose ?? '')} ${esc(i.frequency ?? '')} <span class="muted">${esc(i.instructions ?? '')}</span></li>`).join('')}</ul>
        ${rx.diet.length > 0 ? `<div>${esc(t('dietLabel'))}: ${esc(rx.diet.join('; '))}</div>` : ''}
        ${rx.exercise.length > 0 ? `<div>${esc(t('exerciseLabel'))}: ${esc(rx.exercise.join('; '))}</div>` : ''}
        ${rx.notes ? `<div class="muted">${esc(t('notesLabel'))}: ${esc(rx.notes)}</div>` : ''}
      </div>`,
    )
    .join('') + `</div>`;
}

function draftItems(items: UiPrescriptionItem[]): string {
  if (items.length === 0) return `<p class="muted">${esc(t('emptyDraft'))}</p>`;
  return `<ul class="list">${items
    .map(
      (item, i) => `<li><strong>${esc(item.drug)}</strong> ${esc(item.dose ?? '')} ${esc(item.frequency ?? '')}
        <button data-rm="${i}">${esc(t('remove'))}</button></li>`,
    )
    .join('')}</ul>`;
}

function wireTreatment(root: HTMLElement, id: string): void {
  const refresh = (): void => renderTreatmentTab(root, id);

  // Payment/share gate: approve everything pending and push it to the patient.
  (document.getElementById('rx-share') as HTMLButtonElement | null)?.addEventListener('click', (event) => {
    const button = event.target as HTMLButtonElement;
    button.disabled = true;
    fbApproveAllAndShare(id)
      .then(({ prescriptions, tests }) => {
        toast(`${t('sharedOk')} (${prescriptions}+${tests})`);
        refresh();
      })
      .catch((error: unknown) => {
        button.disabled = false;
        toast(errorText(error), 'error');
      });
  });
  root.querySelectorAll<HTMLButtonElement>('button[data-approve]').forEach((button) => {
    button.addEventListener('click', () => {
      button.disabled = true;
      fbApprovePrescription(button.dataset.approve ?? '')
        .then(() => refresh())
        .catch((error: unknown) => {
          button.disabled = false;
          toast(errorText(error), 'error');
        });
    });
  });

  // P2: one-click Rx PDF with verification code + QR (print dialog = Save as PDF).
  document.getElementById('rx-pdf')?.addEventListener('click', () => {
    rxList(id, 'active')
      .then((active) => {
        const rows = active.flatMap((rx) =>
          rx.items.map((item) => ({
            label: item.drug,
            value: `${item.dose ?? ''} ${item.frequency ?? ''} ${item.instructions ?? ''}`.trim(),
          })),
        );
        openReport({
          title: t('rxReportTitle'),
          patientName: id,
          rows: rows.length > 0 ? rows : [{ label: '—', value: '—' }],
        });
      })
      .catch((error: unknown) => toast(errorText(error), 'error'));
  });

  // Live dictation: the transcript lands in the same box, so the summarize
  // button and the deterministic parser stay the only path into the chart.
  const listenBtn = document.getElementById('voice-listen') as HTMLButtonElement | null;
  const listenState = document.getElementById('voice-listen-state') as HTMLElement | null;
  if (listenBtn && listenState) {
    let controller: SpeechController | null = null;
    listenBtn.addEventListener('click', () => {
      if (controller?.isActive()) {
        controller.stop();
        return;
      }
      const box = document.getElementById('voice-text') as HTMLTextAreaElement | null;
      if (!box) return;
      // Interim results are dropped on purpose: keeping them would double the
      // text every time a phrase is revised mid-sentence.
      const base = box.value.replace(/\s+$/u, '');
      controller = createSpeechRecognizer({
        lang: getLang() === 'ar' ? 'ar' : 'en',
        continuous: true,
        interimResults: false,
        onResult: (result) => {
          if (!result.isFinal) return;
          box.value = base ? `${base} ${result.text}` : result.text;
        },
        onError: (error) => {
          listenState.textContent =
            error.code === 'no-permission' ? t('micDenied') : error.code === 'not-supported' ? t('micNotSupported') : error.message;
          listenBtn.textContent = t('startListening');
        },
        onEnd: () => {
          listenState.textContent = '';
          listenBtn.textContent = t('startListening');
        },
      });
      controller.start();
      listenState.textContent = t('listening');
      listenBtn.textContent = t('stopListening');
    });
  }

  // P2: rule-based voice structuring - suggestions only, doctor picks.
  document.getElementById('voice-summarize')?.addEventListener('click', () => {
    const host = document.getElementById('voice-summary') as HTMLElement;
    const text = (document.getElementById('voice-text') as HTMLTextAreaElement).value;
    const summary = summarizeDictation(text);
    const empty =
      !summary.diagnosis &&
      summary.vitals.length === 0 &&
      summary.prescriptions.length === 0 &&
      summary.labOrders.length === 0;
    if (empty) {
      host.innerHTML = `<p class="muted">${esc(t('nothingStructured'))}</p>`;
      return;
    }
    host.innerHTML =
      (summary.diagnosis ? `<p><strong>${esc(t('suggestedDiagnosis'))}:</strong> ${esc(summary.diagnosis)}</p>` : '') +
      (summary.vitals.length > 0
        ? `<p><strong>${esc(t('suggestedVitals'))}:</strong></p><ul class="list">${summary.vitals
            .map((v, i) => {
              const label =
                getLang() === 'ar' ? vitalLabelAr(v.kind, vitalLabel(v.kind)) : vitalLabel(v.kind);
              return `<li>${esc(label)}: <strong>${esc(v.value)}</strong> <button data-vital="${i}">${esc(t('saveVitals'))}</button></li>`;
            })
            .join('')}</ul>`
        : '') +
      (summary.prescriptions.length > 0
        ? `<p><strong>${esc(t('suggestedRx'))}:</strong></p><ul class="list">${summary.prescriptions
            .map((rx, i) => {
              const parts = [rx.dose, rx.frequency].filter((p): p is string => Boolean(p));
              if (rx.durationDays != null) parts.push(`${rx.durationDays} ${t('dictatedDays')}`);
              return `<li><strong>${esc(rx.drug)}</strong> ${esc(parts.join(' '))} <button data-vrx="${i}">${esc(t('addToRx'))}</button></li>`;
            })
            .join('')}</ul>`
        : '') +
      (summary.medications.length > 0 && summary.prescriptions.length === 0
        ? `<p><strong>${esc(t('suggestedMeds'))}:</strong></p><ul class="list">${summary.medications.map((m, i) => `<li>${esc(m)} <button data-vmed="${i}">${esc(t('applyToForm'))}</button></li>`).join('')}</ul>`
        : '') +
      (summary.labOrders.length > 0
        ? `<p><strong>${esc(t('suggestedLabs'))}:</strong></p><ul class="list">${summary.labOrders.map((l, i) => `<li>${esc(l)} <button data-vlab="${i}">${esc(t('applyToForm'))}</button></li>`).join('')}</ul>`
        : '');
    host.querySelectorAll<HTMLButtonElement>('button[data-vital]').forEach((button) => {
      button.addEventListener('click', () => {
        const vital = summary.vitals[Number(button.dataset.vital ?? -1)];
        if (!vital) return;
        button.disabled = true;
        recordVital(id, vital.kind, vital.value)
          .then(() => {
            toast(t('saved'));
            refresh();
          })
          .catch((error: unknown) => {
            button.disabled = false;
            if (error instanceof OfflineQueuedError) toast(t('queued'));
            else toast(errorText(error), 'error');
          });
      });
    });
    host.querySelectorAll<HTMLButtonElement>('button[data-vrx]').forEach((button) => {
      button.addEventListener('click', () => {
        const rx = summary.prescriptions[Number(button.dataset.vrx ?? -1)];
        if (!rx) return;
        addItem(id, {
          drug: rx.drug,
          dose: rx.dose,
          frequency: rx.frequency,
          durationDays: rx.durationDays,
          instructions: null,
        });
        toast(`${esc(t('add'))} ${rx.drug.slice(0, 40)}`);
        refresh();
      });
    });
    host.querySelectorAll<HTMLButtonElement>('button[data-vmed]').forEach((button) => {
      button.addEventListener('click', () => {
        const drug = summary.medications[Number(button.dataset.vmed ?? -1)] ?? '';
        addItem(id, { drug: drug.slice(0, 200) });
        toast(`${esc(t('add'))} ${drug.slice(0, 40)}`);
        refresh();
      });
    });
    host.querySelectorAll<HTMLButtonElement>('button[data-vlab]').forEach((button) => {
      button.addEventListener('click', () => {
        const lab = summary.labOrders[Number(button.dataset.vlab ?? -1)] ?? '';
        testsOrder(id, lab.slice(0, 200), null)
          .then(() => toast(t('order')))
          .catch((error: unknown) => {
            if (error instanceof OfflineQueuedError) toast(t('queued'));
            else toast(errorText(error), 'error');
          });
      });
    });
  });

  // The drug picker leads with this specialty's drugs: an orthopedist meets
  // orthopedic drugs first, not antidiabetics.
  staffSpecialty()
    .then((specialty) => {
      if (!specialty) return;
      import('@mediflow/shared')
        .then((shared) => {
          const drugs = shared.drugsForSpecialty(specialty as Specialty);
          const list = document.getElementById('rx-drugs');
          if (!list) return;
          list.innerHTML = drugs
            .slice(0, 80)
            .map((d) => `<option value="${esc(d.genericName)}">${esc(d.typicalDose)} ${esc(d.frequency)}</option>`)
            .join('');
        })
        .catch(() => undefined);
    })
    .catch(() => undefined);
  (document.getElementById('rx-usual') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const diagnosis = String(new FormData(event.target as HTMLFormElement).get('usualDiagnosis') ?? '');
    const out = document.getElementById('rx-usual-out') as HTMLElement;
    out.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;
    vitalsAll(id)
      .then((vitals) => {
        const latest = new Map(vitals.map((v) => [v.kind, v.value]));
        return practicePatterns(diagnosis, {
          hba1c: latest.get('hba1c') ?? null,
          creatinine: latest.get('creatinine') ?? null,
          ldl: latest.get('ldl') ?? null,
          systolic: latest.get('systolic_bp') ?? null,
        });
      })
      .then((patterns) => {
        if (patterns.length === 0) {
          out.innerHTML = `<p class="muted">${esc(t('noHistoryYet'))}</p>`;
          return;
        }
        out.innerHTML =
          `<ul class="list">` +
          patterns
            .map(
              (p, i) => `<li><strong>${esc(p.drug)}</strong> ${esc(p.dose ?? '')} ${esc(p.frequency ?? '')}
                <span class="muted small">${esc(p.basis ?? `×${p.times}`)}</span>
                <button data-pick="${i}">${esc(t('add'))}</button></li>`,
            )
            .join('') +
          `</ul>`;
        out.querySelectorAll<HTMLButtonElement>('button[data-pick]').forEach((button) => {
          button.addEventListener('click', () => {
            const item = patterns[Number(button.dataset.pick ?? -1)];
            if (!item) return;
            addItem(id, { drug: item.drug, dose: item.dose, frequency: item.frequency, durationDays: null, instructions: null });
            toast(`${esc(t('add'))} ${item.drug}`);
            refresh();
          });
        });
      })
      .catch((error: unknown) => {
        out.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
      });
  });

  root.querySelectorAll<HTMLButtonElement>('button[data-rm]').forEach((button) => {
    button.addEventListener('click', () => {
      const draft = loadDraft(id);
      draft.items.splice(Number(button.dataset.rm ?? -1), 1);
      saveDraft(id, draft);
      refresh();
    });
  });

  (document.getElementById('rx-add') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const duration = Number(data.get('durationDays') ?? '');
    addItem(id, {
      drug: String(data.get('drug') ?? ''),
      dose: String(data.get('dose') ?? '') || null,
      frequency: String(data.get('frequency') ?? '') || null,
      durationDays: Number.isInteger(duration) && duration > 0 ? duration : null,
      instructions: String(data.get('instructions') ?? '') || null,
    });
    refresh();
  });

  (document.getElementById('rx-save') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const draft = loadDraft(id);
    if (draft.items.length === 0) {
      toast(t('addAtLeastOne'));
      return;
    }
    const data = new FormData(event.target as HTMLFormElement);
    const split = (v: FormDataEntryValue | null): string[] =>
      String(v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    rxCreate({
      patientId: id,
      items: draft.items,
      diet: split(data.get('diet')),
      exercise: split(data.get('exercise')),
      notes: String(data.get('notes') ?? '') || null,
    })
      .then(() => {
        clearDraft(id);
        toast(t('prescriptionSaved'));
        refresh();
      })
      .catch((error: unknown) => {
        if (error instanceof OfflineQueuedError) toast(t('queued'));
        else toast(errorText(error), 'error');
      });
  });

  // Voice memo: MediaRecorder straight to a voice_note document.
  const startBtn = document.getElementById('voice-start') as HTMLButtonElement;
  const stopBtn = document.getElementById('voice-stop') as HTMLButtonElement;
  const state = document.getElementById('voice-state') as HTMLElement;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  startBtn.addEventListener('click', () => {
    if (!window.MediaRecorder) {
      toast(t('voiceNotSupported'), 'error');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        chunks = [];
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (event: BlobEvent): void => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' });
          const name = `voice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`;
          void blob
            .arrayBuffer()
            .then((buffer) => sha256Hex(buffer))
            .then((checksum) =>
              fileToBase64(new File([blob], name, { type: blob.type })).then((base64) => ({ checksum, base64 })),
            )
            .then(({ checksum, base64 }) =>
              docRecord(
                {
                  patientId: id,
                  kind: 'voice_note',
                  title: `Voice note ${new Date().toLocaleString()}`,
                  fileName: name,
                  mimeType: blob.type || 'audio/webm',
                  byteSize: blob.size,
                  checksum,
                },
                { base64, blob: new File([blob], name, { type: blob.type }) },
              ),
            )
            .then(() => toast(t('voiceAttached')))
            .catch((error: unknown) => toast(errorText(error), 'error'))
            .finally(() => {
              state.textContent = '';
              startBtn.disabled = false;
              stopBtn.disabled = true;
            });
        };
        recorder.start();
        state.textContent = t('recording');
        startBtn.disabled = true;
        stopBtn.disabled = false;
      })
      .catch(() => toast(t('micUnavailable'), 'error'));
  });
  stopBtn.addEventListener('click', () => {
    recorder?.stop();
  });

  // Handwritten prescription photo: OCR lines become candidate items.
  (document.getElementById('rx-photo') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const file = data.get('photo');
    if (!(file instanceof File)) return;
    const host = document.getElementById('rx-lines') as HTMLElement;
    host.innerHTML = `<p class="muted">${esc(t('reading'))}</p>`;
    ocrText(file)
      .then((text) => {
        const lines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 2);
        if (lines.length === 0) {
          host.innerHTML = `<p class="muted">${esc(t('noTextFound'))}</p>`;
          return;
        }
        host.innerHTML =
          `<p class="muted">${esc(t('pickLinesHint'))}</p><ul class="list">` +
          lines
            .slice(0, 30)
            .map((line, i) => `<li>${esc(line)} <button data-line="${i}">${esc(t('add'))}</button></li>`)
            .join('') +
          `</ul>`;
        host.querySelectorAll<HTMLButtonElement>('button[data-line]').forEach((button) => {
          button.addEventListener('click', () => {
            const line = lines[Number(button.dataset.line ?? -1)] ?? '';
            addItem(id, { drug: line.slice(0, 200) });
            toast(`${esc(t('add'))} “${line.slice(0, 40)}”.`);
            refresh();
          });
        });
      })
      .catch((error: unknown) => toast(errorText(error), 'error'));
  });
}

interface VitalRow {
  kind: string;
  value: number;
  unit: string;
  measuredAt: string;
}

const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return SPARKS[3]?.repeat(values.length) ?? '';
  return values
    .map((v) => {
      const step = Math.round(((v - min) / (max - min)) * (SPARKS.length - 1));
      return SPARKS[Math.max(0, Math.min(SPARKS.length - 1, step))];
    })
    .join('');
}

function severityPill(severity: string): string {
  const cls = severity === 'critical' ? 'danger' : severity === 'warning' ? 'warn' : 'ok';
  return `<span class="pill ${cls}">${esc(severityLabel(severity))}</span>`;
}

/**
 * Compact patient status for the overview: one line per measurement with its
 * trend, plus an overall banner. The overview answers "stable, improving, or
 * declining?" - full cards live in the vitals tab.
 */
function vitalsSummary(vitals: VitalRow[]): string {
  if (vitals.length === 0) return `<p class="muted">${esc('—')}</p>`;
  const groups = new Map<string, VitalRow[]>();
  for (const v of vitals) {
    const list = groups.get(v.kind) ?? [];
    list.push(v);
    groups.set(v.kind, list);
  }
  const rank = (severity: string): number => (severity === 'critical' ? 2 : severity === 'warning' ? 1 : 0);
  let worst = 0;
  const rows = [...groups.entries()].map(([kind, list]) => {
    const latest = list[0] as VitalRow;
    const previous = list[1];
    const evaluation = evaluateVital({ kind: kind as VitalKind, value: latest.value });
    if (rank(evaluation.severity) > worst) worst = rank(evaluation.severity);
    let trend = '<span class="muted">·</span>';
    if (previous) {
      const diff = latest.value - previous.value;
      trend = `<span class="muted">${diff > 0 ? '▲' : diff < 0 ? '▼' : '='}</span>`;
    }
    const dot = evaluation.severity === 'critical' ? 'danger' : evaluation.severity === 'warning' ? 'warn' : 'ok';
    return `<li><span class="pill ${dot}">${esc(severityLabel(evaluation.severity))}</span> ${esc(vitalLabelAr(kind, vitalLabel(kind as VitalKind)))}:
      <strong>${esc(String(latest.value))} ${esc(latest.unit)}</strong> ${trend}</li>`;
  });
  const ar = getLang() === 'ar';
  const banner =
    worst >= 2
      ? `<p><span class="pill danger">${esc(severityLabel('critical'))}</span> ${ar ? 'يحتاج مراجعة عاجلة.' : 'Needs urgent review.'}</p>`
      : worst === 1
        ? `<p><span class="pill warn">${esc(severityLabel('attention'))}</span> ${ar ? 'بعض القراءات خارج المجال.' : 'Some readings out of range.'}</p>`
        : `<p><span class="pill ok">${esc(severityLabel('stable'))}</span> ${ar ? 'كل القراءات ضمن المجال.' : 'All readings in range.'}</p>`;
  return `${banner}<ul class="list">${rows.join('')}</ul>`;
}

function vitalsGrouped(vitals: VitalRow[]): string {
  if (vitals.length === 0) return `<p class="muted">${esc('—')}</p>`;
  const groups = new Map<string, VitalRow[]>();
  for (const v of vitals) {
    const list = groups.get(v.kind) ?? [];
    list.push(v);
    groups.set(v.kind, list);
  }
  return `<div class="cards-grid">` + [...groups.entries()]
    .map(([kind, rows]) => {
      const latest = rows[0] as VitalRow;
      const previous = rows[1];
      const history = rows.slice(0, 12).reverse().map((r) => r.value);
      const evaluation = evaluateVital({ kind: kind as VitalKind, value: latest.value });

      let delta = '';
      if (previous) {
        const diff = latest.value - previous.value;
        const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '=';
        const signed = diff > 0 ? `+${diff}` : `${diff}`;
        delta = `<span class="muted">${arrow} ${esc(signed)} ${esc(latest.unit)} · ${esc(fmtDateTime(previous.measuredAt))}</span>`;
      } else {
        delta = `<span class="muted">${esc(getLang() === 'ar' ? 'أول قراءة' : 'first reading')}</span>`;
      }

      return `<div class="vital-card">
        <div class="vital-top"><strong>${esc(vitalLabelAr(kind, vitalLabel(kind as VitalKind)))}</strong>${severityPill(evaluation.severity)}</div>
        <div class="vital-value">${esc(String(latest.value))} <small>${esc(latest.unit)}</small></div>
        <div>${delta}</div>
        <div class="spark" aria-hidden="true">${esc(sparkline(history))}</div>
        <div class="muted small">${esc(evaluation.interpretation)}</div>
        <div class="muted small">${esc(fmtDateTime(latest.measuredAt))}</div>
      </div>`;
    })
    .join('') + `</div>`;
}

function visitsList(visits: { visitType: string; chiefComplaint: string | null; createdAt: string }[]): string {
  if (visits.length === 0) return `<p class="muted">${esc('—')}</p>`;
  return `<ul class="list">${visits.map((v) => `<li><strong>${esc(statusLabel(v.visitType ?? ''))}</strong> — ${esc(v.chiefComplaint ?? '')} <span class="muted">${esc(fmtDateTime(v.createdAt))}</span></li>`).join('')}</ul>`;
}

function visitsFullList(visits: UiVisit[]): string {
  if (visits.length === 0) return `<p class="muted">${esc('—')}</p>`;
  return `<div class="cards-grid">` + visits
    .map(
      (v) => `<div class="vital-card">
        <div class="vital-top"><strong>${esc(statusLabel(v.visitType))}</strong><span class="muted">${esc(fmtDateTime(v.createdAt))}</span></div>
        ${v.chiefComplaint ? `<div>${esc(t('complaint'))}: ${esc(v.chiefComplaint)}</div>` : ''}
        ${v.diagnosis ? `<div>${esc(t('diagnosisLabel'))}: <strong>${esc(v.diagnosis)}</strong></div>` : ''}
        ${v.plan ? `<div>${esc(t('planLabel'))}: ${esc(v.plan)}</div>` : ''}
        ${v.notes ? `<div class="muted">${esc(t('notesLabel'))}: ${esc(v.notes)}</div>` : ''}
      </div>`,
    )
    .join('') + `</div>`;
}

function documentsList(documents: UiDocument[]): string {
  if (documents.length === 0) return `<p class="muted">${esc('—')}</p>`;
  return `<ul class="list">${documents
    .map(
      (d) => `<li>${esc(d.title ?? d.fileName)} <span class="muted">${esc(docKindLabel(d.kind))} · ${esc(fmtDateTime(d.createdAt))}</span>
        <span class="row-actions">
          ${d.mimeType.startsWith('audio/') ? `<button data-docplay="${esc(d.id)}">${esc(t('play'))}</button><span data-audio="${esc(d.id)}"></span>` : ''}
          ${d.hasFile ? `<button data-docview="${esc(d.id)}">${esc(t('view'))}</button>` : ''}
          <button data-docdel="${esc(d.id)}">${esc(t('delete'))}</button>
        </span></li>`,
    )
    .join('')}</ul>`;
}

function wireDocuments(root: HTMLElement, patientId: string): void {
  root.querySelectorAll<HTMLButtonElement>('button[data-docplay]').forEach((button) => {
    button.addEventListener('click', () => {
      const host = root.querySelector(`span[data-audio="${button.dataset.docplay ?? ''}"]`) as HTMLElement | null;
      if (!host) return;
      docFileUrl(button.dataset.docplay ?? '')
        .then((url) => {
          host.innerHTML = `<audio controls src="${esc(url)}"></audio>`;
        })
        .catch((error: unknown) => toast(errorText(error), 'error'));
    });
  });
  root.querySelectorAll<HTMLButtonElement>('button[data-docview]').forEach((button) => {
    button.addEventListener('click', () => {
      const win = window.open('', '_blank', 'noopener');
      docFileUrl(button.dataset.docview ?? '')
        .then((url) => {
          if (win) win.location.href = url;
          else window.location.href = url;
        })
        .catch((error: unknown) => {
          win?.close();
          toast(errorText(error), 'error');
        });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('button[data-docdel]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!window.confirm(t('deleteDocConfirm'))) return;
      docDelete(button.dataset.docdel ?? '')
        .then(() => renderOverviewTab(root, patientId))
        .catch((error: unknown) => toast(errorText(error), 'error'));
    });
  });

  const form = document.getElementById('doc-upload') as HTMLFormElement | null;
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const file = data.get('file');
    if (!(file instanceof File)) return;
    const title = String(data.get('title') ?? '').trim();
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
        // No re-render here: it would wipe the OCR panel below. The list
        // refreshes after the readings are saved (onSaved), or immediately
        // for non-image uploads.
        const isImage = file.type.startsWith('image/');
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
        if (isImage || isPdf) {
          toast('Document saved.');
          const run = isImage ? runImageRead : runPdfRead;
          void run(root, patientId, file, () => renderOverviewTab(root, patientId));
        } else {
          renderOverviewTab(root, patientId);
        }
      })
      .catch((error: unknown) => {
        if (error instanceof OfflineQueuedError) toast(t('queued'));
        else toast(errorText(error), 'error');
      });
  });
}

function apptsList(appts: { startsAt: string; status: string }[]): string {
  if (appts.length === 0) return `<p class="muted">${esc('—')}</p>`;
  return `<ul class="list">${appts.map((a) => `<li>${esc(fmtDateTime(a.startsAt))} <span class="pill">${esc(statusLabel(a.status ?? ''))}</span></li>`).join('')}</ul>`;
}

function alertsList(alerts: { severity: string; title: string }[]): string {
  if (alerts.length === 0) return `<p class="muted">${esc('—')}</p>`;
  return `<ul class="list">${alerts.map((a) => `<li><span class="pill danger">${esc(severityLabel(a.severity ?? ''))}</span> ${esc(a.title ?? '')}</li>`).join('')}</ul>`;
}
