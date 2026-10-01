import { ApiRequestError } from '../api.js';
import {
  OfflineQueuedError,
  apptBook,
  apptCancel,
  apptReschedule,
  apptTransition,
  apptsRange,
  fbAcceptBookingRequest,
  fbCancelDirectBooking,
  fbDeclineBookingRequest,
  fbListBookingRequests,
  fbListDirectBookings,
  fbPublishAvailability,
  isFirebaseMode,
  scheduleAvailability,
  type InitiatedBy,
} from '../data.js';
import { statusLabel, t } from '../i18n.js';
import { errorText, esc, field, fmtDateTime, input, toast } from '../ui.js';
import { attachPatientPicker, type PickedPatient } from './patientPicker.js';

function dayKey(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function renderCalendar(root: HTMLElement): void {
  root.innerHTML = `
    <section class="card">
      <h2>${esc(t('calendar'))}</h2>
      <form id="cal-range" class="row">
        ${field(t('date'), input('from', 'date', dayKey(0), 'required'))}
        ${field(t('date'), input('to', 'date', dayKey(7), 'required'))}
        <button class="primary" type="submit">${esc(t('search'))}</button>
      </form>
      <div id="cal-list"><p class="muted">${esc(t('loading'))}</p></div>
    </section>
    <section class="card">
      <h2>${esc(t('bookAppointment'))}</h2>
      <form id="cal-book" class="grid-form">
        ${field(t('name'), input('patientName', 'text', '', 'required'))}
        ${field(t('phone'), input('patientPhone', 'tel', '', 'required'))}
        ${field(t('pickDay'), input('dayPick', 'date', dayKey(0), 'required'))}
        ${field(t('dateTime'), input('startsAt', 'datetime-local', '', 'required'))}
        <button class="primary" type="submit">${esc(t('book'))}</button>
      </form>
      <div id="cal-day"><p class="muted">${esc(t('pickFreeTime'))}</p></div>
    </section>
    <div id="cal-requests"></div>`;

  const list = document.getElementById('cal-list') as HTMLElement;

  // Firebase mode: patient booking requests land here for manual accept.
  void isFirebaseMode()
    .then((fbMode) => {
      if (fbMode) loadRequests();
    })
    .catch(() => undefined);

  const loadRequests = (): void => {
    const host = document.getElementById('cal-requests');
    if (!host) return;
    Promise.all([fbListBookingRequests().catch(() => []), fbListDirectBookings().catch(() => [])])
      .then(([items, direct]) => {
        const live = direct.filter((d) => d.status === 'confirmed' && new Date(d.startsAt).getTime() >= Date.now() - 86_400_000);
        const directHtml =
          live.length > 0
            ? `<section class="card wide"><h2>${esc(t('directBookingsTitle'))} (${live.length})</h2>
              <ul class="list">${live
                .map(
                  (r) => `<li>
                    <div><strong>${esc(r.patientName)}</strong> <span dir="ltr">${esc(r.phone)}</span>
                      <span class="pill spec" dir="ltr">${esc(fmtDateTime(r.startsAt))} → ${esc(fmtDateTime(r.endsAt))}</span>
                      <span class="pill">${esc(r.visitType)}</span></div>
                    <div class="row"><button type="button" data-canceldirect="${esc(r.id)}">${esc(t('cancelBooking'))}</button></div>
                  </li>`,
                )
                .join('')}</ul></section>`
            : '';
        if (items.length === 0) {
          host.innerHTML = directHtml;
          wireDirect(host);
          return;
        }
        host.innerHTML = directHtml + `<section class="card wide"><h2>${esc(t('bookingRequests'))} (${items.length})</h2>
          <ul class="list">${items
            .map(
              (r) => `<li>
                <div><strong>${esc(r.patientName)}</strong> <span dir="ltr">${esc(r.phone)}</span>
                  <span class="pill">${esc(r.preferredDate)}</span>
                  ${r.startsAt ? `<span class="pill spec" dir="ltr">${esc(fmtDateTime(r.startsAt))}</span>` : ''}</div>
                ${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}
                <form data-accept="${esc(r.id)}" class="row">
                  ${field(t('dateTime'), input('when', 'datetime-local', r.startsAt ? toLocalInput(r.startsAt) : '', 'required'))}
                  <button class="primary" type="submit">${esc(t('acceptBooking'))}</button>
                  <button type="button" data-decline="${esc(r.id)}">${esc(t('declineBooking'))}</button>
                </form>
              </li>`,
            )
            .join('')}</ul></section>`;
        wireDirect(host);
        host.querySelectorAll<HTMLFormElement>('form[data-accept]').forEach((form) => {
          form.addEventListener('submit', (event) => {
            event.preventDefault();
            const when = String(new FormData(form).get('when') ?? '');
            const startsAt = new Date(when).toISOString();
            const button = form.querySelector('button[type="submit"]') as HTMLButtonElement;
            button.disabled = true;
            fbAcceptBookingRequest(form.dataset.accept ?? '', startsAt)
              .then((name) => {
                toast(`${t('bookedOk')} · ${name}`);
                loadRequests();
                load(dayKey(0), dayKey(7));
                refreshBadge();
              })              .catch((error: unknown) => {
                button.disabled = false;
                toast(errorText(error), 'error');
              });
          });
        });
        host.querySelectorAll<HTMLButtonElement>('button[data-decline]').forEach((button) => {
          button.addEventListener('click', () => {
            button.disabled = true;
            fbDeclineBookingRequest(button.dataset.decline ?? '')
              .then(() => {
                loadRequests();
                void fbPublishAvailability();
              })
              .catch((error: unknown) => {
                button.disabled = false;
                toast(errorText(error), 'error');
              });
          });
        });
      })
      .catch((error: unknown) => {
        if (host) host.innerHTML = `<section class="card"><p class="muted">${esc(errorText(error))}</p></section>`;
      });
  };

  const wireDirect = (host: HTMLElement): void => {
    host.querySelectorAll<HTMLButtonElement>('button[data-canceldirect]').forEach((button) => {
      button.addEventListener('click', () => {
        button.disabled = true;
        fbCancelDirectBooking(button.dataset.canceldirect ?? '')
          .then(() => {
            toast(t('bookingCancelled'));
            loadRequests();
            load(dayKey(0), dayKey(7));
          })
          .catch((error: unknown) => {
            button.disabled = false;
            toast(errorText(error), 'error');
          });
      });
    });
  };

  const load = (from: string, to: string): void => {
    apptsRange(from, to)
      .then((items) => {
        // Keep published slots fresh while staff work (Firebase mode only).
        void isFirebaseMode().then((fbMode) => {
          if (fbMode) void fbPublishAvailability();
        });
        const rows = items
          .map((a) => {
            const status = a.status ?? '';
            // Actions follow the appointment lifecycle: a cancelled or completed
            // appointment offers nothing (hence no reschedule button there).
            const canCheckIn = status === 'scheduled' || status === 'confirmed';
            const canComplete = status === 'checked_in' || status === 'in_progress';
            const canReschedule = status === 'scheduled' || status === 'confirmed' || status === 'no_show';
            const canCancel = status === 'scheduled' || status === 'confirmed' || status === 'checked_in' || status === 'in_progress' || status === 'no_show';
            return `<tr>
              <td>${esc(fmtDateTime(a.startsAt))}</td>
              <td>${esc(a.patientName ?? '—')}</td>
              <td><span class="pill">${esc(statusLabel(status))}</span></td>
              <td class="row-actions">
                ${canCheckIn ? `<button data-act="in" data-id="${esc(a.id)}">${esc(t('checkIn'))}</button>` : ''}
                ${canComplete ? `<button data-act="done" data-id="${esc(a.id)}">${esc(t('complete'))}</button>` : ''}
                ${canReschedule ? `<button data-resched="${esc(a.id)}" data-when="${esc(a.startsAt)}" data-who="${esc(a.patientName ?? '')}">${esc(t('reschedule'))}</button>` : ''}
                ${canCancel ? `<button data-cancel="${esc(a.id)}">${esc(t('cancel'))}</button>` : ''}
              </td>
            </tr>`;
          })
          .join('');
        list.innerHTML = rows
          ? `<table class="table"><thead><tr><th>${esc(t('time'))}</th><th>${esc(t('name'))}</th><th>${esc(t('status'))}</th><th>${esc(t('actions'))}</th></tr></thead><tbody>${rows}</tbody></table>`
          : `<p class="muted">${esc(t('noResults'))}</p>`;
        list.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((button) => {
          button.addEventListener('click', () => {
            const id = button.dataset.id ?? '';
            const act = button.dataset.act ?? '';
            apptTransition(id, act === 'in' ? 'in' : 'done')
              .then(() => load(from, to))
              .catch((error: unknown) => {
                if (error instanceof OfflineQueuedError) toast(t('queued'));
                else toast(errorText(error), 'error');
              });
          });
        });
        list.querySelectorAll<HTMLButtonElement>('button[data-resched]').forEach((button) => {
          button.addEventListener('click', () => {
            openRescheduleModal(root, button.dataset.resched ?? '', button.dataset.when ?? '', button.dataset.who ?? '', () =>
              load(from, to),
            );
          });
        });
        list.querySelectorAll<HTMLButtonElement>('button[data-cancel]').forEach((button) => {
          button.addEventListener('click', () => {
            openCancelModal(root, button.dataset.cancel ?? '', () => load(from, to));
          });
        });
      })
      .catch((error: unknown) => {
        list.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };

  const range = document.getElementById('cal-range') as HTMLFormElement;
  range.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(range);
    load(String(data.get('from') ?? dayKey(0)), String(data.get('to') ?? dayKey(7)));
  });
  load(dayKey(0), dayKey(7));

  const book = document.getElementById('cal-book') as HTMLFormElement;
  const bookName = book.querySelector('input[name="patientName"]') as HTMLInputElement;
  const bookPhone = book.querySelector('input[name="patientPhone"]') as HTMLInputElement;
  const bookDay = book.querySelector('input[name="dayPick"]') as HTMLInputElement;
  const bookWhen = book.querySelector('input[name="startsAt"]') as HTMLInputElement;
  const dayHost = document.getElementById('cal-day') as HTMLElement;
  // No past bookings from this form: the server revalidates anyway.
  bookWhen.min = toLocalInput(new Date().toISOString());
  let booked: PickedPatient | null = null;
  attachPatientPicker(bookName, (p) => {
    booked = p;
    // Picking a registered patient fills the phone automatically and links
    // the appointment to their chart. Typing freely still books a walk-in.
    if (p) {
      bookName.value = p.fullName;
      bookPhone.value = p.phone;
    }
  });
  // Day view for the doctor: booked times (who) vs free times (tap to fill).
  const paintDay = (day: string): void => {
    dayHost.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;
    void isFirebaseMode().then((fbMode) => {
      if (!fbMode) {
        dayHost.innerHTML = '';
        return;
      }
      void import('../data.js')
        .then((d) => d.fbDaySchedule(day))
        .then(({ closed, busy, free }) => {
          if (!dayHost.isConnected) return;
          if (closed && busy.length === 0) {
            dayHost.innerHTML = `<p class="muted">${esc(t('closedDay'))}</p>`;
            return;
          }
          dayHost.innerHTML =
            (busy.length > 0
              ? `<h4>${esc(t('busyTimes'))}</h4><div class="slot-chips">` +
                busy
                  .map(
                    (b) =>
                      `<span class="hour-chip" title="${esc(b.patientName)}">🔒 ${esc(fmtDateTime(b.startsAt))} · ${esc(b.patientName)}</span>`,
                  )
                  .join('') +
                `</div>`
              : '') +
            (free.length > 0
              ? `<h4>${esc(t('freeTimes'))}</h4><div class="slot-chips">` +
                free
                  .map((s) => `<button type="button" data-free="${esc(s.startsAt)}">${esc(s.localStart)}</button>`)
                  .join('') +
                `</div>`
              : `<p class="muted">${esc(t('noSlotsDay'))}</p>`);
          dayHost.querySelectorAll<HTMLButtonElement>('button[data-free]').forEach((chip) => {
            chip.addEventListener('click', () => {
              bookWhen.value = toLocalInput(chip.dataset.free ?? '');
              dayHost.querySelectorAll('button').forEach((b) => b.classList.remove('chip-active'));
              chip.classList.add('chip-active');
            });
          });
        })
        .catch((error: unknown) => {
          if (dayHost.isConnected) dayHost.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
        });
    });
  };
  bookDay.addEventListener('change', () => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(bookDay.value)) paintDay(bookDay.value);
  });
  paintDay(bookDay.value);
  book.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(book);
    const startsAt = new Date(String(data.get('startsAt') ?? ''));
    apptBook({
      patientId: booked?.id ?? null,
      patientName: String(data.get('patientName') ?? ''),
      patientPhone: String(data.get('patientPhone') ?? ''),
      startsAt: startsAt.toISOString(),
    })
      .then(() => {
        toast(t('book'));
        booked = null;
        load(dayKey(0), dayKey(7));
        paintDay(bookDay.value);
      })
      .catch((error: unknown) => {
        if (error instanceof OfflineQueuedError) toast(t('queued'));
        else if (error instanceof ApiRequestError) toast(`${error.code}: ${error.message}`, 'error');
        else toast(errorText(error), 'error');
      });
  });
}

function refreshBadge(): void {
  void import('./whatsapp.js')
    .then((m) => m.refreshWhatsappBadge())
    .catch(() => undefined);
}

/** ISO instant -> datetime-local value (browser-local, no seconds). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Raw API conflicts are for logs - the doctor sees a friendly Arabic line. */
function friendlyRescheduleError(error: ApiRequestError): string {
  const message = error.message.toLowerCase();
  if (message.includes('already booked')) return t('slotTaken');
  if (
    message.includes('cannot reschedule') ||
    message.includes('cancelled') ||
    message.includes('completed')
  ) {
    return t('cannotReschedule');
  }
  return error.message;
}

function initiatedByField(): string {
  return field(
    t('initiatedBy'),
    `<select name="initiatedBy"><option value="clinic">${esc(t('initiatedByClinic'))}</option><option value="patient">${esc(t('initiatedByPatient'))}</option></select>`,
  );
}

/**
 * Postpone modal: day picker -> ONLY free slots as chips (server-computed),
 * plus a mandatory reason and who asked. Confirming revalidates server-side,
 * rebuilds reminders, and queues the Arabic WhatsApp task.
 */
function openRescheduleModal(
  root: HTMLElement,
  id: string,
  currentStartsAt: string,
  patientName: string,
  onDone: () => void,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-label="${esc(t('rescheduleTitle'))}">
      <div class="modal-top"><h3>${esc(t('rescheduleTitle'))} — ${esc(patientName)}</h3><button id="modal-close">✕</button></div>
      <p class="muted">${esc(fmtDateTime(currentStartsAt))}</p>
      <div class="grid-form">
        ${field(t('pickDay'), input('rsDay', 'date', dayKey(1), 'required'))}
        ${field(t('rescheduleReason'), input('rsReason', 'text', '', `required placeholder="${esc(t('rescheduleReasonPh'))}"`))}
        ${initiatedByField()}
      </div>
      <h4>${esc(t('availableTimes'))}</h4>
      <div id="rs-slots"><p class="muted">${esc(t('loading'))}</p></div>
      <div class="row"><button id="rs-confirm" class="primary" disabled>${esc(t('confirmReschedule'))}</button></div>
    </div>`;
  root.appendChild(overlay);
  const close = (): void => overlay.remove();
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  (overlay.querySelector('#modal-close') as HTMLButtonElement).addEventListener('click', close);

  const dayInput = overlay.querySelector('input[name="rsDay"]') as HTMLInputElement;
  const slotsHost = overlay.querySelector('#rs-slots') as HTMLElement;
  const confirm = overlay.querySelector('#rs-confirm') as HTMLButtonElement;
  let chosen: string | null = null;

  const loadSlots = (day: string): void => {
    chosen = null;
    confirm.disabled = true;
    slotsHost.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;
    scheduleAvailability(day, day)
      .then((days) => {
        const slots = days.flatMap((d) => d.slots);
        if (slots.length === 0) {
          slotsHost.innerHTML = `<p class="muted">${esc(t('noSlotsDay'))}</p>`;
          return;
        }
        slotsHost.innerHTML = `<div class="slot-chips">` + slots.map((s) => `<button data-slot="${esc(s.startsAt)}">${esc(s.localStart)}</button>`).join('') + `</div>`;
        slotsHost.querySelectorAll<HTMLButtonElement>('button[data-slot]').forEach((chip) => {
          chip.addEventListener('click', () => {
            slotsHost.querySelectorAll('button').forEach((b) => b.classList.remove('chip-active'));
            chip.classList.add('chip-active');
            chosen = chip.dataset.slot ?? null;
            confirm.disabled = false;
          });
        });
      })
      .catch(() => {
        // No availability backend (Firestore dev mode): free datetime entry.
        slotsHost.innerHTML = field(t('dateTime'), input('rsWhen', 'datetime-local', '', 'required'));
      });
  };
  dayInput.addEventListener('change', () => loadSlots(dayInput.value));
  loadSlots(dayInput.value);

  confirm.addEventListener('click', () => {
    const reason = (overlay.querySelector('input[name="rsReason"]') as HTMLInputElement).value.trim();
    if (!reason) {
      toast(t('rescheduleReason'), 'error');
      return;
    }
    const manualWhen = overlay.querySelector('input[name="rsWhen"]') as HTMLInputElement | null;
    const startsAt = chosen ?? (manualWhen?.value ? new Date(manualWhen.value).toISOString() : null);
    if (!startsAt) return;
    const initiatedBy = (overlay.querySelector('select[name="initiatedBy"]') as HTMLSelectElement).value as InitiatedBy;
    confirm.disabled = true;
    apptReschedule(id, { startsAt, reason, initiatedBy })
      .then(({ whatsappQueued }) => {
        toast(whatsappQueued ? t('rescheduledWhatsapp') : t('rescheduledOk'));
        close();
        onDone();
        refreshBadge();
      })
      .catch((error: unknown) => {
        confirm.disabled = false;
        if (error instanceof OfflineQueuedError) toast(t('queued'));
        else if (error instanceof ApiRequestError) toast(friendlyRescheduleError(error), 'error');
        else toast(errorText(error), 'error');
      });
  });
}

/** Cancel modal: reason + who asked, so the WhatsApp task gets the right tone. */
function openCancelModal(root: HTMLElement, id: string, onDone: () => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-label="${esc(t('cancelTitle'))}">
      <div class="modal-top"><h3>${esc(t('cancelTitle'))}</h3><button id="modal-close">✕</button></div>
      <div class="grid-form">
        ${field(t('cancelReason'), input('cxReason', 'text', ''))}
        ${initiatedByField()}
      </div>
      <div class="row"><button id="cx-confirm" class="primary">${esc(t('confirmCancel'))}</button></div>
    </div>`;
  root.appendChild(overlay);
  const close = (): void => overlay.remove();
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  (overlay.querySelector('#modal-close') as HTMLButtonElement).addEventListener('click', close);
  (overlay.querySelector('#cx-confirm') as HTMLButtonElement).addEventListener('click', (event) => {
    const button = event.target as HTMLButtonElement;
    const reason = (overlay.querySelector('input[name="cxReason"]') as HTMLInputElement).value.trim() || null;
    const initiatedBy = (overlay.querySelector('select[name="initiatedBy"]') as HTMLSelectElement).value as InitiatedBy;
    button.disabled = true;
    apptCancel(id, { reason, initiatedBy })
      .then(({ whatsappQueued }) => {
        toast(whatsappQueued ? t('cancelledWhatsapp') : t('cancel'));
        close();
        onDone();
        refreshBadge();
      })
      .catch((error: unknown) => {
        button.disabled = false;
        if (error instanceof OfflineQueuedError) toast(t('queued'));
        else toast(errorText(error), 'error');
      });
  });
}
