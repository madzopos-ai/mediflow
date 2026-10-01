import { syncQueue } from '../api.js';
import { dashToday, notesList, notesReadAll, pendingSyncCount } from '../data.js';
import { severityLabel, statusLabel, t } from '../i18n.js';
import { errorText, esc, fmtDateTime, toast } from '../ui.js';

export function renderDashboard(root: HTMLElement): void {
  root.innerHTML = `
    <section class="grid">
      <div class="card" id="dash-today"><h2>${esc(t('today'))}</h2><p class="muted">${esc(t('loading'))}</p></div>
      <div class="card" id="dash-alerts"><h2>${esc(t('openAlerts'))}</h2><p class="muted">${esc(t('loading'))}</p></div>
      <div class="card" id="dash-queue"><h2>${esc(t('syncQueue'))}</h2><div id="queue-body"></div></div>
      <div class="card wide" id="dash-notes"><h2>${esc(t('notifications'))}</h2><div id="notes-body"><p class="muted">${esc(t('loading'))}</p></div></div>
    </section>`;

  dashToday()
    .then((data) => {
      const today = document.getElementById('dash-today');
      const alerts = document.getElementById('dash-alerts');
      if (today) {
        const rows = data.appointments
          .map(
            (a) =>
              `<li><strong>${esc(fmtDateTime(a.startsAt))}</strong> — ${esc(a.patientName ?? a.id)} <span class="pill">${esc(statusLabel(a.status ?? ''))}</span></li>`,
          )
          .join('');
        today.innerHTML = `<h2>${esc(t('today'))}</h2>${rows ? `<ul class="list">${rows}</ul>` : `<p class="muted">${esc(t('noResults'))}</p>`}`;
      }
      if (alerts) {
        const rows = data.alerts.items
          .map((a) => {
            const severity = a.severity ?? '';
            const cls = severity === 'critical' ? 'danger' : severity === 'warning' ? 'warn' : 'ok';
            return `<li><span class="pill ${cls}">${esc(severityLabel(severity))}</span> ${esc(a.title ?? '')}</li>`;
          })
          .join('');
        alerts.innerHTML =
          `<h2>${esc(t('openAlerts'))}</h2>` +
          (rows ? `<ul class="list">${rows}</ul>` : `<p class="muted">${esc(t('noResults'))}</p>`) +
          `<p class="muted">${esc(t('dueFollowUps'))}: ${data.followUps.due} · ${esc(t('activeFollowUps'))}: ${data.followUps.active}</p>`;
      }
    })
    .catch((error: unknown) => toast(errorText(error), 'error'));

  const paintQueue = (): void => {
    const body = document.getElementById('queue-body');
    if (!body) return;
    void pendingSyncCount().then((pending) => {
      const live = document.getElementById('queue-body');
      if (!live) return;
      live.innerHTML = `<p class="muted">${pending}</p><button id="sync-now">${esc(t('syncNow'))}</button>`;
      document.getElementById('sync-now')?.addEventListener('click', () => {
        syncQueue()
          .then(({ done }) => {
            toast(`${done}`);
            paintQueue();
          })
          .catch((error: unknown) => toast(errorText(error), 'error'));
      });
    });
  };
  paintQueue();
  window.addEventListener('mf:queue-changed', paintQueue, { once: true });

  notesList()
    .then((items) => {
      const body = document.getElementById('notes-body');
      if (!body) return;
      const rows = items
        .map((n) => `<li>${esc(n.title ?? '')} <span class="muted">${esc(n.body ?? '')}</span></li>`)
        .join('');
      body.innerHTML =
        `<button id="notes-read-all">${esc(t('markAllRead'))}</button>` +
        (rows ? `<ul class="list">${rows}</ul>` : `<p class="muted">${esc(t('noResults'))}</p>`);
      document.getElementById('notes-read-all')?.addEventListener('click', () => {
        notesReadAll()
          .then(() => renderDashboard(root))
          .catch((error: unknown) => toast(errorText(error), 'error'));
      });
    })
    .catch((error: unknown) => toast(errorText(error), 'error'));
}
