/**
 * Recall radar: who is due, and one reviewed batch into the WhatsApp outbox.
 *
 * The flow is deliberately two steps. A recall list is a clinical judgement
 * ("is this person actually due?"), and a mis-send reaches a real patient, so
 * nothing is queued until the doctor has seen the list and ticked who to
 * contact. No auto-enqueue path exists in this view by design.
 *
 * Consent is checked twice: `whatsappOptIn` decides whether the row is
 * selectable at all, and the enqueue re-checks on the server. A patient can opt
 * out between the list rendering and the send, and the second check is what
 * stops that race.
 */

import { renderTemplate } from '@mediflow/shared';

import {
  followUpsDue,
  patientsList,
  recallEnqueue,
  type UiFollowUp,
  type UiPatient,
} from '../data.js';
import { errorText, esc, fmtDateTime, toast } from '../ui.js';
import { getLang, t } from '../i18n.js';

interface Candidate {
  followUp: UiFollowUp;
  patient: UiPatient | null;
  /** Days past due; negative when it is still upcoming. */
  daysOverdue: number;
  selectable: boolean;
  /** Why the row cannot be selected, shown instead of a checkbox. */
  blockedReason: string | null;
}

const DAY_MS = 86_400_000;

/** Upcoming follow-ups are shown but not offered for batch contact. */
const UPCOMING_WINDOW_DAYS = 7;

function daysBetween(fromMs: number, toMs: number): number {
  return Math.round((fromMs - toMs) / DAY_MS);
}

function toCandidate(followUp: UiFollowUp, patient: UiPatient | null): Candidate {
  const dueMs = followUp.nextDueAt ? Date.parse(followUp.nextDueAt) : Number.NaN;
  const daysOverdue = Number.isNaN(dueMs) ? 0 : daysBetween(Date.now(), dueMs);
  if (patient === null) {
    return { followUp, patient, daysOverdue, selectable: false, blockedReason: t('recallNoRecord') };
  }
  if (!patient.phone) {
    return { followUp, patient, daysOverdue, selectable: false, blockedReason: t('recallNoPhone') };
  }
  if (!patient.whatsappOptIn) {
    return { followUp, patient, daysOverdue, selectable: false, blockedReason: t('recallOptedOut') };
  }
  if (daysOverdue < -UPCOMING_WINDOW_DAYS) {
    return { followUp, patient, daysOverdue, selectable: false, blockedReason: t('recallNotDueYet') };
  }
  return { followUp, patient, daysOverdue, selectable: true, blockedReason: null };
}

/**
 * Builds the message body from the shared follow-up template.
 *
 * Falls back to a plain line if a required placeholder is missing, because a
 * slightly plain recall is better than a message that fails to queue at all.
 */
function messageFor(candidate: Candidate, clinicName: string): string {
  const rendered = renderTemplate(
    'followup_checkin',
    getLang() === 'ar' ? 'ar' : 'en',
    {
      patientName: candidate.patient?.fullName ?? '',
      clinicName,
      daysSinceVisit: String(Math.max(candidate.daysOverdue, 0)),
      question: candidate.followUp.name,
      prompt: getLang() === 'ar' ? 'هل يناسبك موعد هذا الأسبوع؟' : 'Would a slot this week suit you?',
    },
  );
  if (rendered.ok) return rendered.body;
  return getLang() === 'ar'
    ? `مرحباً ${candidate.patient?.fullName ?? ''}، حان وقت متابعة: ${candidate.followUp.name}.`
    : `Hello ${candidate.patient?.fullName ?? ''}, it is time for your follow-up: ${candidate.followUp.name}.`;
}

function dueBadge(daysOverdue: number): string {
  if (daysOverdue > 0) {
    const label = getLang() === 'ar' ? `متأخر ${daysOverdue} يوم` : `${daysOverdue}d overdue`;
    return `<span class="pill danger">${esc(label)}</span>`;
  }
  if (daysOverdue === 0) return `<span class="pill warn">${esc(t('recallDueToday'))}</span>`;
  return `<span class="pill">${esc(t('recallUpcoming'))}</span>`;
}

export function renderRecall(root: HTMLElement): void {
  root.innerHTML = `
    <section class="card">
      <h2>${esc(t('recall'))}</h2>
      <p class="muted">${esc(t('recallHint'))}</p>
      <div id="recall-out"><p class="muted">${esc(t('loading'))}</p></div>
    </section>`;

  const out = root.querySelector('#recall-out') as HTMLElement;

  Promise.all([followUpsDue(), patientsList('')])
    .then(([followUps, patients]) => {
      if (followUps.length === 0) {
        out.innerHTML = `<p class="muted">${esc(t('recallNone'))}</p>`;
        return;
      }
      // Earliest due first: the most overdue is the one worth contacting today.
      const candidates = followUps
        .map((f) => toCandidate(f, patients.find((p) => p.id === f.patientId) ?? null))
        .sort((a, b) => b.daysOverdue - a.daysOverdue);

      const selectableCount = candidates.filter((c) => c.selectable).length;
      out.innerHTML = `
        <div class="row">
          <label class="muted"><input type="checkbox" id="recall-all" ${selectableCount === 0 ? 'disabled' : ''} /> ${esc(t('recallSelectAll'))}</label>
          <button class="primary" id="recall-send" disabled>${esc(t('recallQueueSelected'))}</button>
        </div>
        <ul class="list" id="recall-list">
          ${candidates
            .map((c, i) => `<li class="recall-row" data-i="${i}">
              ${c.selectable
                ? `<input type="checkbox" data-pick="${i}" />`
                : `<span class="muted" title="${esc(c.blockedReason ?? '')}">—</span>`}
              <div>
                <strong>${esc(c.patient?.fullName ?? '—')}</strong> ${dueBadge(c.daysOverdue)}
                <div class="muted small">${esc(c.followUp.name)}</div>
                ${c.blockedReason ? `<div class="muted small">${esc(c.blockedReason)}</div>` : ''}
                ${c.followUp.nextDueAt ? `<div class="muted small">${esc(fmtDateTime(c.followUp.nextDueAt))}</div>` : ''}
              </div>
            </li>`)
            .join('')}
        </ul>
        <div id="recall-result"></div>`;

      const boxes = [...out.querySelectorAll<HTMLInputElement>('input[data-pick]')];
      const sendBtn = out.querySelector('#recall-send') as HTMLButtonElement;
      const allBox = out.querySelector('#recall-all') as HTMLInputElement;
      const result = out.querySelector('#recall-result') as HTMLElement;

      const sync = (): void => {
        const count = boxes.filter((b) => b.checked).length;
        sendBtn.disabled = count === 0;
        sendBtn.textContent =
          count === 0 ? t('recallQueueSelected') : t('recallQueueCount').replace('{n}', String(count));
      };

      boxes.forEach((box) => box.addEventListener('change', sync));
      allBox.addEventListener('change', () => {
        boxes.forEach((b) => {
          b.checked = allBox.checked;
        });
        sync();
      });
      sync();

      sendBtn.addEventListener('click', () => {
        const picked = boxes.filter((b) => b.checked).map((b) => candidates[Number(b.dataset.pick ?? -1)]);
        const usable = picked.filter((c): c is Candidate => c !== undefined && c.patient !== null);
        if (usable.length === 0) return;

        sendBtn.disabled = true;
        result.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;

        // Sequential on purpose: a burst of parallel writes is exactly the
        // shape that outruns a rate limit or a consent re-check, and the batch
        // is small enough that the difference in time is not worth it.
        const outcomes: { name: string; reason: string }[] = [];
        usable
          .reduce(
            (chain, candidate) =>
              chain.then(async () => {
                const name = candidate.patient?.fullName ?? '';
                try {
                  const res = await recallEnqueue(
                    candidate.patient?.id ?? '',
                    messageFor(candidate, t('clinicName')),
                    candidate.followUp.id,
                  );
                  outcomes.push({ name, reason: res.queued ? 'queued' : res.reason });
                } catch (error: unknown) {
                  outcomes.push({ name, reason: errorText(error) });
                }
              }),
            Promise.resolve(),
          )
          .then(() => {
            const queued = outcomes.filter((o) => o.reason === 'queued').length;
            const skipped = outcomes.length - queued;
            result.innerHTML = `<p>${esc(
              t('recallQueuedSummary')
                .replace('{queued}', String(queued))
                .replace('{skipped}', String(skipped)),
            )}</p>` +
              (skipped > 0
                ? `<ul class="list">${outcomes
                    .filter((o) => o.reason !== 'queued')
                    .map((o) => `<li class="muted">${esc(o.name)}: ${esc(o.reason)}</li>`)
                    .join('')}</ul>`
                : '');
            sendBtn.disabled = false;
            boxes.forEach((b) => {
              b.checked = false;
              b.disabled = true;
            });
            allBox.disabled = true;
            sync();
            toast(t('recallDone'));
          });
      });
    })
    .catch((error: unknown) => {
      out.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
      toast(errorText(error), 'error');
    });
}
