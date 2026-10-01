import {
  clinicProfile,
  clinicSaveProfile,
  clinicSaveSchedule,
  clinicSaveSettings,
  clinicSchedule,
  clinicSettings,
  fbSyncDirectory,
  isFirebaseMode,
} from '../data.js';
import { getLang, t, weekdayLabel } from '../i18n.js';
import { errorText, esc, field, input, toast } from '../ui.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Clinic setup: the practice fixes its own page once - profile, address and
 * info, working hours from-to per weekday, slot sizing, and booking rules.
 * Everything here maps one-to-one onto the PUT endpoints, so what the doctor
 * sees is exactly what books.
 */
export function renderClinic(root: HTMLElement): void {
  root.innerHTML = `
    <section class="card"><h2>${esc(t('clinicProfile'))}</h2><div id="clinic-profile"><p class="muted">…</p></div></section>
    <section class="card"><h2>${esc(t('workingHours'))}</h2><div id="clinic-hours"><p class="muted">…</p></div></section>
    <section class="card"><h2>${esc(t('bookingRules'))}</h2><div id="clinic-rules"><p class="muted">…</p></div></section>`;

  clinicProfile()
    .then((profile) => {
      const host = document.getElementById('clinic-profile') as HTMLElement;
      const ar = getLang() === 'ar';
      host.innerHTML = `
        <form id="clinic-form" class="grid-form">
          ${field(t('name'), input('name', 'text', profile.name, 'required'))}
          ${field(t('arabicName'), input('nameAr', 'text', profile.nameAr ?? ''))}
          ${field(t('phone'), input('phone', 'tel', profile.phone ?? ''))}
          ${field(t('email'), input('email', 'email', profile.email ?? ''))}
          ${field(t('addressDetailed'), input('address', 'text', profile.address ?? '', ar ? 'required placeholder="الشارع، البناء، الطابق"' : 'required placeholder="street, building, floor"'))}
          ${field(t('country'), input('country', 'text', profile.country ?? ''))}
          ${field(t('timezone'), input('timezone', 'text', profile.timeZone, 'required placeholder="Asia/Beirut"'))}
          ${field(t('currency3'), input('currency', 'text', profile.currency, 'required minlength="3" maxlength="3"'))}
          <button class="primary" type="submit">${esc(t('saveProfile'))}</button>
        </form>`;
      (document.getElementById('clinic-form') as HTMLFormElement).addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(event.target as HTMLFormElement);
        const text = (k: string): string | null => {
          const v = String(data.get(k) ?? '').trim();
          return v ? v : null;
        };
        clinicSaveProfile({
          name: String(data.get('name') ?? ''),
          nameAr: text('nameAr'),
          phone: text('phone'),
          email: text('email'),
          address: text('address'),
          country: text('country'),
          timezone: String(data.get('timezone') ?? ''),
          currency: String(data.get('currency') ?? ''),
        })
          .then(() => {
            toast(t('profileSaved'));
            // Keep the public directory card in sync (Firebase mode only).
            void isFirebaseMode()
              .then((fbMode) => {
                if (fbMode) return fbSyncDirectory().catch(() => undefined);
                return undefined;
              })
              .catch(() => undefined);
          })
          .catch((error: unknown) => toast(errorText(error), 'error'));
      });
    })
    .catch((error: unknown) => {
      (document.getElementById('clinic-profile') as HTMLElement).innerHTML =
        `<p class="muted">${esc(errorText(error))}</p>`;
    });

  clinicSchedule()
    .then((schedule) => {
      const host = document.getElementById('clinic-hours') as HTMLElement;
      host.innerHTML = `
        <form id="hours-form">
          <table class="table"><thead><tr><th>${esc(t('day'))}</th><th>${esc(t('open'))}</th><th>${esc(t('from'))}</th><th>${esc(t('to'))}</th></tr></thead><tbody>
          ${schedule.workingHours
            .map(
              (d) => `<tr>
                <td>${esc(weekdayLabel(DAYS[d.weekday] ?? String(d.weekday)))}</td>
                <td><input type="checkbox" name="open_${d.weekday}" ${d.enabled ? 'checked' : ''} /></td>
                <td><input type="time" name="start_${d.weekday}" value="${esc(d.start)}" /></td>
                <td><input type="time" name="end_${d.weekday}" value="${esc(d.end)}" /></td>
              </tr>`,
            )
            .join('')}
          </tbody></table>
          <div class="grid-form">
            ${field(t('slotMinutes'), input('slotDurationMinutes', 'number', String(schedule.slotDurationMinutes), 'required min="5" max="480"'))}
            ${field(t('gapBetweenSlots'), input('slotIntervalMinutes', 'number', String(schedule.slotIntervalMinutes), 'required min="5" max="480"'))}
            ${field(t('bufferMinutes'), input('bufferMinutes', 'number', String(schedule.bufferMinutes), 'min="0" max="120"'))}
            ${field(t('maxPerDay'), input('maxDailyAppointments', 'number', schedule.maxDailyAppointments === null ? '' : String(schedule.maxDailyAppointments), 'min="1" max="500"'))}
            <button class="primary" type="submit">${esc(t('saveSchedule'))}</button>
          </div>
        </form>`;
      (document.getElementById('hours-form') as HTMLFormElement).addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(event.target as HTMLFormElement);
        const num = (k: string): number => Number(data.get(k) ?? 0);
        clinicSaveSchedule({
          workingHours: schedule.workingHours.map((d) => ({
            weekday: d.weekday,
            enabled: data.get(`open_${d.weekday}`) === 'on',
            start: String(data.get(`start_${d.weekday}`) ?? d.start),
            end: String(data.get(`end_${d.weekday}`) ?? d.end),
            breaks: d.breaks,
          })),
          slotDurationMinutes: num('slotDurationMinutes'),
          bufferMinutes: num('bufferMinutes'),
          slotIntervalMinutes: num('slotIntervalMinutes'),
          maxDailyAppointments: String(data.get('maxDailyAppointments') ?? '').trim()
            ? num('maxDailyAppointments')
            : null,
        })
          .then(() => toast(t('scheduleSaved')))
          .catch((error: unknown) => toast(errorText(error), 'error'));
      });
    })
    .catch((error: unknown) => {
      (document.getElementById('clinic-hours') as HTMLElement).innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
    });

  clinicSettings()
    .then((settings) => {
      const host = document.getElementById('clinic-rules') as HTMLElement;
      host.innerHTML = `
        <form id="rules-form" class="grid-form">
          ${field(t('minNoticeHours'), input('minNoticeHours', 'number', String(settings.booking.minNoticeHours), 'required min="0"'))}
          ${field(t('bookingHorizon'), input('maxAdvanceDays', 'number', String(settings.booking.maxAdvanceDays), 'required min="1"'))}
          ${field(t('publicBookingLink'), `<select name="publicBookingLink"><option value="1">${esc(t('on'))}</option><option value="0">${esc(t('offWord'))}</option></select>`)}
          ${field(t('depositRequired'), `<select name="requireDepositOnBooking"><option value="1">${esc(t('yes'))}</option><option value="0">${esc(t('no'))}</option></select>`)}
          <button class="primary" type="submit">${esc(t('saveRules'))}</button>
        </form>`;
      (
        document.querySelector('#rules-form select[name="publicBookingLink"]') as HTMLSelectElement
      ).value = settings.features.publicBookingLink ? '1' : '0';
      (
        document.querySelector('#rules-form select[name="requireDepositOnBooking"]') as HTMLSelectElement
      ).value = settings.features.requireDepositOnBooking ? '1' : '0';
      (document.getElementById('rules-form') as HTMLFormElement).addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(event.target as HTMLFormElement);
        clinicSaveSettings({
          booking: {
            minNoticeHours: Number(data.get('minNoticeHours') ?? 0),
            maxAdvanceDays: Number(data.get('maxAdvanceDays') ?? 0),
          },
          features: {
            publicBookingLink: String(data.get('publicBookingLink') ?? '0') === '1',
            requireDepositOnBooking: String(data.get('requireDepositOnBooking') ?? '0') === '1',
          },
        })
          .then(() => toast(t('rulesSaved')))
          .catch((error: unknown) => toast(errorText(error), 'error'));
      });
    })
    .catch((error: unknown) => {
      (document.getElementById('clinic-rules') as HTMLElement).innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
    });
}
