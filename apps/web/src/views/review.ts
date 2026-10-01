import { interactionsCheck, practicePatterns, reviewRun } from '../data.js';
import { severityLabel, t, tx, vitalLabelAr } from '../i18n.js';
import { errorText, esc, field, input, toast } from '../ui.js';
import { openReport } from '../report.js';
import { addItem, loadDraft } from './rxDraft.js';

export function renderReview(root: HTMLElement, patientId: string): void {
  root.innerHTML = `
    <button id="back" class="ghost">← ${esc(t('back'))}</button>
    <section class="card">
      <h2>${esc(t('decisionSupport'))}</h2>
      <p class="warning">${esc(t('clinicianReview'))}</p>
      <form id="rev-form" class="grid-form">
        ${field(t('diagnosis'), `<textarea name="diagnosis" rows="3" required></textarea>`)}
        ${field(t('medications'), input('medications', 'text', ''))}
        <button class="primary" type="submit">${esc(t('runReview'))}</button>
      </form>
      <div id="rev-out"></div>
    </section>
    <section class="card">
      <h2>${esc(t('checkInteractions'))}</h2>
      <form id="int-form" class="row">
        ${field(t('medications'), input('medications', 'text', ''))}
        <button class="primary" type="submit">${esc(t('checkInteractions'))}</button>
      </form>
      <div id="int-out"></div>
    </section>`;

  (document.getElementById('back') as HTMLButtonElement).addEventListener('click', () => window.history.back());

  (document.getElementById('rev-form') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const diagnosis = String(data.get('diagnosis') ?? '');
    const medications = String(data.get('medications') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const out = document.getElementById('rev-out') as HTMLElement;
    out.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;
    reviewRun(patientId, diagnosis, medications)
      .then((result) => {
        const labMap = new Map(result.labs.map((l) => [l.kind, l.value]));
        const currentLabs = {
          hba1c: labMap.get('hba1c') ?? null,
          creatinine: labMap.get('creatinine') ?? null,
          ldl: labMap.get('ldl') ?? null,
          systolic: labMap.get('systolic_bp') ?? null,
        };
        return practicePatterns(diagnosis, currentLabs).then((practice) => ({ result, practice }));
      })
      .then(({ result, practice }) => {
        const warnings = result.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
        const suggestions = result.suggestions.map((s) => `<li>${esc(s)}</li>`).join('');
        const labs = result.labs
          .map((l) => `<li>${esc(vitalLabelAr(l.kind, l.kind))}: <strong>${esc(String(l.value))} ${esc(l.unit)}</strong> <span class="muted">${esc(l.measuredAt.slice(0, 10))}</span></li>`)
          .join('');
        // Critical bar: severe values jump out before anything else.
        const labVal = (k: string): number | null => {
          const found = result.labs.find((l) => l.kind === k);
          return found ? found.value : null;
        };
        const critical: string[] = [];
        const chba1c = labVal('hba1c');
        if (chba1c !== null && chba1c >= 9) critical.push(`HbA1c ${chba1c}% — dangerously high blood sugar`);
        const curea = labVal('urea') ?? labVal('blood_urea');
        if (curea !== null && curea >= 100) critical.push(`Urea ${curea} mg/dL — severe uremia, renal review promptly`);
        const csys = labVal('systolic_bp');
        if (csys !== null && csys >= 180) critical.push(`Systolic ${csys} mmHg — hypertensive urgency range`);
        const lifestyle = result.lifestyle ?? { targets: [], diet: [], exercise: [] };
        const lifeSection =
          lifestyle.targets.length + lifestyle.diet.length + lifestyle.exercise.length > 0
            ? `<h3>🥗 ${esc(t('lifestyleTitle'))}</h3>` +
              (lifestyle.targets.length > 0 ? `<h4>${esc(t('lifestyleTargets'))}</h4><ul class="list">${lifestyle.targets.map((x) => `<li>🎯 ${esc(x)}</li>`).join('')}</ul>` : '') +
              (lifestyle.diet.length > 0 ? `<h4>${esc(t('lifestyleDiet'))}</h4><ul class="list">${lifestyle.diet.map((x) => `<li>🍽️ ${esc(x)}</li>`).join('')}</ul>` : '') +
              (lifestyle.exercise.length > 0 ? `<h4>${esc(t('lifestyleExercise'))}</h4><ul class="list">${lifestyle.exercise.map((x) => `<li>🚶 ${esc(x)}</li>`).join('')}</ul>` : '')
            : '';
        const regimen = result.regimen
          .map(
            (r, i) => `<li>
              <strong>${esc(r.drug)}</strong> ${esc(r.dose ?? '')} ${esc(r.frequency ?? '')}
              <span class="muted small">${esc(r.instructions ?? '')}</span>
              <button data-rx="${i}">${esc(t('addToRx'))}</button>
            </li>`,
          )
          .join('');
        // Doses computed from this patient's labs: drug + dose + the values
        // behind it. A withheld drug renders as its own warning row.
        const guided = result.labGuided
          .map(
            (g, i) => `<li>
              <strong>${esc(g.drug)}</strong> ${esc(g.dose)} ${esc(g.frequency)}
              ${g.contraindicated ? `<span class="pill danger">${esc(t('withhold'))}</span>` : `<button data-guided="${i}">${esc(t('addToRx'))}</button>`}
              <div class="muted small">${g.reasons.map((r) => esc(r)).join(' · ')}</div>
            </li>`,
          )
          .join('');
        const usual = practice
          .map(
            (p, i) => `<li>
              <strong>${esc(p.drug)}</strong> ${esc(p.dose ?? '')} ${esc(p.frequency ?? '')}
              <span class="muted small">${esc(p.basis ?? `${t('usualPractice')} ×${p.times}`)}</span>
              <button data-usual="${i}">${esc(t('addToRx'))}</button>
            </li>`,
          )
          .join('');
        out.innerHTML =
          (critical.length > 0
            ? `<p class="warning">🚨 <strong>${esc(t('criticalTitle'))}</strong><br />${critical.map((c) => esc(c)).join('<br />')}</p>`
            : '') +
          `<p class="warning">${esc(t('clinicianReview'))}</p>` +
          `<p>${esc(t('severity'))}: <span class="pill ${result.severity === 'info' ? 'ok' : 'danger'}">${esc(severityLabel(result.severity))}</span></p>` +
          (labs ? `<h3>${esc(t('labBasis'))}</h3><ul class="list">${labs}</ul>` : `<p class="muted">${esc(t('noLabValues'))}</p>`) +
          (warnings ? `<h3>${esc(t('warnings'))}</h3><ul class="list">${warnings}</ul>` : `<p class="muted">${esc(t('noSafetyWarnings'))}</p>`) +
          `<h3>${esc(t('recommendedDoses'))}</h3>` +
          (guided
            ? `<ul class="list">${guided}</ul>`
            : `<p class="muted">${esc(t('noDoseGuidance'))}</p>`) +
          (regimen
            ? `<h3>${esc(t('suggestedRegimen'))}</h3><ul class="list">${regimen}</ul>`
            : '') +
          (usual
            ? `<h3>${esc(t('usualPracticeLearned'))}</h3><ul class="list">${usual}</ul>`
            : '') +
          (suggestions ? `<h3>${esc(t('followUp'))}</h3><ul class="list">${suggestions}</ul>` : '') +
          lifeSection +
          ((result.labGuided.some((g) => !g.contraindicated) || result.regimen.length > 0)
            ? `<div class="row"><button id="apply-all" class="primary">${esc(t('applyAll'))}</button></div>`
            : '') +
          `<div class="row"><button id="care-plan">${esc(t('printPlan'))}</button></div>` +
          `<p><a class="button" href="#/patients/${esc(patientId)}/treatment">${esc(t('openTreatment'))}</a></p>` +
          `<details><summary>${esc(t('raw'))}</summary><pre>${esc(JSON.stringify(result.raw, null, 2))}</pre></details>`;

        (document.getElementById('apply-all') as HTMLButtonElement | null)?.addEventListener('click', (event) => {
          const button = event.target as HTMLButtonElement;
          button.disabled = true;
          let n = 0;
          for (const g of result.labGuided) {
            if (g.contraindicated || !g.drug) continue;
            addItem(patientId, {
              drug: g.drug,
              dose: g.dose || null,
              frequency: g.frequency || null,
              durationDays: 30,
              instructions: g.reasons.join('; ').slice(0, 500) || null,
            });
            n += 1;
          }
          for (const r of result.regimen) {
            if (!r.drug) continue;
            addItem(patientId, r);
            n += 1;
          }
          toast(tx('appliedToDraft', { n }));
        });

        (document.getElementById('care-plan') as HTMLButtonElement | null)?.addEventListener('click', () => {
          openCarePlan(patientId, diagnosis, result, critical);
        });

        const addRegimen = (index: number): void => {
          const item = result.regimen[index];
          if (!item || !item.drug) return;
          addItem(patientId, item);
          toast(`${item.drug}: ${t('addToDraft')}`);
        };
        out.querySelectorAll<HTMLButtonElement>('button[data-rx]').forEach((button) => {
          button.addEventListener('click', () => addRegimen(Number(button.dataset.rx ?? -1)));
        });
        out.querySelectorAll<HTMLButtonElement>('button[data-guided]').forEach((button) => {
          button.addEventListener('click', () => {
            const item = result.labGuided[Number(button.dataset.guided ?? -1)];
            if (!item || !item.drug) return;
            addItem(patientId, {
              drug: item.drug,
              dose: item.dose || null,
              frequency: item.frequency || null,
              durationDays: 30,
              instructions: item.reasons.join('; ').slice(0, 500) || null,
            });
            toast(`${item.drug} ${item.dose}: ${t('addToDraft')}`);
          });
        });
        out.querySelectorAll<HTMLButtonElement>('button[data-usual]').forEach((button) => {
          button.addEventListener('click', () => {
            const item = practice[Number(button.dataset.usual ?? -1)];
            if (!item || !item.drug) return;
            addItem(patientId, {
              drug: item.drug,
              dose: item.dose,
              frequency: item.frequency,
              durationDays: null,
              instructions: null,
            });
            toast(`${item.drug}: ${t('addToDraft')}`);
          });
        });
      })
      .catch((error: unknown) => {
        out.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
        toast(errorText(error), 'error');
      });
  });

  (document.getElementById('int-form') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const out = document.getElementById('int-out') as HTMLElement;
    out.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;
    interactionsCheck(patientId, String(data.get('medications') ?? ''))
      .then((items) => {
        const rows = items
          .map((i) => `<li><span class="pill danger">${esc(severityLabel(i.severity ?? ''))}</span> ${esc(i.drug ?? '')} × ${esc(i.interactingDrug ?? '')} — ${esc(i.message ?? '')}</li>`)
          .join('');
        out.innerHTML = rows ? `<ul class="list">${rows}</ul>` : `<p class="muted">${esc(t('noResults'))}</p>`;
      })
      .catch((error: unknown) => {
        out.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
        toast(errorText(error), 'error');
      });
  });
}

/**
 * Printable Arabic care plan: prescribed drugs + schedules, lifestyle tips,
 * critical flags and the next visit date. Opens the print dialog (Save as PDF).
 */
function openCarePlan(
  patientId: string,
  diagnosis: string,
  result: Awaited<ReturnType<typeof reviewRun>>,
  critical: string[],
): void {
  const draft = loadDraft(patientId);
  type PlanDrug = { drug: string; sched: string };
  const fromDraft: PlanDrug[] = draft.items.map((i) => ({
    drug: i.drug,
    sched: `${i.dose ?? ''} ${i.frequency ?? ''}${i.durationDays ? ` × ${i.durationDays} يوم` : ''}${i.instructions ? ` — ${i.instructions}` : ''}`.trim(),
  }));
  const fromAi: PlanDrug[] = [
    ...result.labGuided
      .filter((g) => !g.contraindicated && g.drug)
      .map((g) => ({ drug: g.drug, sched: `${g.dose} ${g.frequency}`.trim() })),
    ...result.regimen
      .filter((r) => r.drug)
      .map((r) => ({ drug: r.drug, sched: `${r.dose ?? ''} ${r.frequency ?? ''}`.trim() })),
  ];
  const drugs = fromDraft.length > 0 ? fromDraft : fromAi;
  const life = result.lifestyle ?? { targets: [], diet: [], exercise: [] };
  const next = new Date(Date.now() + 30 * 86_400_000);
  const nextDefault = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-label="${esc(t('carePlan'))}">
      <div class="modal-top"><h3>🖨️ ${esc(t('carePlan'))}</h3><button id="cp-close">✕</button></div>
      ${critical.length > 0 ? `<p class="warning">🚨 ${critical.map((c) => esc(c)).join('<br />')}</p>` : ''}
      <p class="muted">${esc(diagnosis)}</p>
      ${drugs.length > 0 ? `<ul class="list">${drugs.map((d) => `<li><strong>${esc(d.drug)}</strong> ${esc(d.sched)}</li>`).join('')}</ul>` : `<p class="muted">${esc(t('noActiveRx'))}</p>`}
      ${(life.diet.length > 0 || life.exercise.length > 0 || life.targets.length > 0)
        ? `<h4>${esc(t('lifestyleTitle'))}</h4><ul class="list">` +
          [...life.targets.map((x) => `🎯 ${x}`), ...life.diet.map((x) => `🍽️ ${x}`), ...life.exercise.map((x) => `🚶 ${x}`)]
            .map((x) => `<li>${esc(x)}</li>`)
            .join('') +
          `</ul>`
        : ''}
      <div class="grid-form">${field(t('nextVisit'), `<input id="cp-next" type="date" value="${nextDefault}" />`)}</div>
      <div class="row"><button id="cp-print" class="primary">${esc(t('printPlan'))}</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = (): void => overlay.remove();
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  (overlay.querySelector('#cp-close') as HTMLButtonElement).addEventListener('click', close);
  (overlay.querySelector('#cp-print') as HTMLButtonElement).addEventListener('click', () => {
    const nextVisit = (overlay.querySelector('#cp-next') as HTMLInputElement).value || nextDefault;
    openReport({
      title: t('carePlanTitle'),
      patientName: patientId,
      rows: [
        ...(diagnosis ? [{ label: t('diagnosis'), value: diagnosis }] : []),
        ...drugs.map((d) => ({ label: `💊 ${d.drug}`, value: d.sched || '—' })),
        ...(life.targets.length > 0 ? [{ label: t('lifestyleTargets'), value: life.targets.join('؛ ') }] : []),
        ...(life.diet.length > 0 ? [{ label: t('lifestyleDiet'), value: life.diet.join('؛ ') }] : []),
        ...(life.exercise.length > 0 ? [{ label: t('lifestyleExercise'), value: life.exercise.join('؛ ') }] : []),
        ...(critical.length > 0 ? [{ label: `🚨 ${t('criticalTitle')}`, value: critical.join('؛ ') }] : []),
        { label: `📅 ${t('nextVisit')}`, value: nextVisit },
      ],
    });
  });
}
