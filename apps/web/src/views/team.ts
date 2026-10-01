import { SPECIALTY_LABELS } from '@mediflow/shared';

import { staffCreate, staffList, staffUpdate } from '../data.js';
import { roleLabel, specialtyLabel, statusLabel, t } from '../i18n.js';
import { errorText, esc, field, fmtDateTime, input, toast } from '../ui.js';

/**
 * Team: the owner sees every account in their practice, activates or
 * freezes them, and sets doctor specialties (which is what puts them in
 * the patient directory). Cross-clinic approvals stay with the reseller
 * console - this screen never sees another clinic's staff.
 */
export function renderTeam(root: HTMLElement): void {
  root.innerHTML = `
    <section class="card">
      <h2>${esc(t('teamTitle'))}</h2>
      <div id="team-list"><p class="muted">…</p></div>
    </section>
    <section class="card">
      <h2>${esc(t('addStaff'))}</h2>
      <form id="staff-new" class="grid-form">
        ${field(t('fullName'), input('fullName', 'text', '', 'required'))}
        ${field(t('email'), input('email', 'email', '', 'required'))}
        ${field(t('password10chars'), input('password', 'password', '', 'required minlength="10"'))}
        ${field(t('role'), `<select name="role">
          <option value="doctor">${esc(roleLabel('doctor'))}</option><option value="nurse">${esc(roleLabel('nurse'))}</option>
          <option value="assistant">${esc(roleLabel('assistant'))}</option><option value="receptionist">${esc(roleLabel('receptionist'))}</option>
          <option value="billing">${esc(roleLabel('billing'))}</option><option value="owner">${esc(roleLabel('owner'))}</option>
        </select>`)}
        ${field(t('specialtyDoctors'), `<select name="specialty"><option value="">—</option>${Object.entries(
          SPECIALTY_LABELS as Record<string, string>,
        )
          .map(([key, label]) => `<option value="${esc(key)}">${esc(specialtyLabel(key, label))}</option>`)
          .join('')}</select>`)}
        ${field(t('phone'), input('phone', 'tel', ''))}
        <button class="primary" type="submit">${esc(t('createAccount'))}</button>
      </form>
    </section>`;

  const load = (): void => {
    staffList()
      .then((items) => {
        const rows = items
          .map(
            (s) => `<tr>
              <td><strong>${esc(s.fullName)}</strong><br /><span class="muted" dir="ltr">${esc(s.email)}</span></td>
              <td>${esc(roleLabel(s.role))}${s.specialty ? `<br /><span class="pill spec">${esc(specialtyLabel(s.specialty, s.specialty))}</span>` : ''}</td>
              <td><span class="pill ${s.isActive ? 'ok' : ''}">${s.isActive ? esc(t('active')) : esc(t('off'))}</span></td>
              <td class="muted small">${s.lastLoginAt ? esc(fmtDateTime(s.lastLoginAt)) : esc(t('never'))}</td>
              <td class="row-actions"><button data-toggle="${esc(s.id)}" data-active="${s.isActive ? '0' : '1'}">${
                s.isActive ? esc(t('deactivate')) : esc(t('activate'))
              }</button></td>
            </tr>`,
          )
          .join('');
        (document.getElementById('team-list') as HTMLElement).innerHTML = rows
          ? `<table class="table"><thead><tr><th>${esc(t('name'))}</th><th>${esc(t('role'))}</th><th>${esc(t('status'))}</th><th>${esc(t('lastLogin'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
          : `<p class="muted">${esc(t('noStaffYet'))}</p>`;
        document.querySelectorAll<HTMLButtonElement>('button[data-toggle]').forEach((button) => {
          button.addEventListener('click', () => {
            staffUpdate(button.dataset.toggle ?? '', { isActive: button.dataset.active === '1' })
              .then(() => load())
              .catch((error: unknown) => toast(errorText(error), 'error'));
          });
        });
      })
      .catch((error: unknown) => {
        (document.getElementById('team-list') as HTMLElement).innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };
  load();

  (document.getElementById('staff-new') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const text = (k: string): string | null => {
      const v = String(data.get(k) ?? '').trim();
      return v ? v : null;
    };
    staffCreate({
      email: String(data.get('email') ?? ''),
      password: String(data.get('password') ?? ''),
      fullName: String(data.get('fullName') ?? ''),
      role: String(data.get('role') ?? 'receptionist'),
      specialty: text('specialty'),
      phone: text('phone'),
    })
      .then(() => {
        (event.target as HTMLFormElement).reset();
        load();
      })
      .catch((error: unknown) => toast(errorText(error), 'error'));
  });
}
