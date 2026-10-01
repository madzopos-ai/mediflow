import {
  OfflineQueuedError,
  msgSend,
  outboxList,
  outboxManualSend,
  outboxPending,
  threadMessages,
  threadRead,
  threadsList,
  waLink,
} from '../data.js';
import { getUser } from '../api.js';
import { getLang, statusLabel, t } from '../i18n.js';
import { errorText, esc, field, fmtDateTime, input, toast } from '../ui.js';
import { attachPatientPicker, requirePicked, type PickedPatient } from './patientPicker.js';
import { renderDeviceLink } from './deviceLink.js';

/**
 * Whether this user may link a device.
 *
 * Mirrors the API's `settings:write` gate, which only an owner holds. The
 * server is the real check; this only avoids showing a panel that could only
 * ever return 403.
 */
function canLinkDevice(): boolean {
  return getUser<{ role?: string }>()?.role === 'owner';
}

/**
 * Manual click-to-send: the app auto-composes every message (confirmations,
 * reminders), the doctor presses one button per task, the chat opens in the
 * WhatsApp app with the text prefilled, and the press is logged. No Meta API,
 * no gateway server, no session to babysit.
 */
export function renderWhatsapp(root: HTMLElement): void {
  const ar = getLang() === 'ar';
  root.innerHTML = `
    <section class="grid">
      <div class="card wide">
        <h2>${esc(t('pendingSends'))} <span id="wa-pending-count"></span></h2>
        <p class="muted">${esc(t('pendingSendsHint'))}</p>
        <div id="wa-pending"><p class="muted">${esc(t('loading'))}</p></div>
      </div>
      <div class="card">
        <h2>${esc(t('threads'))}</h2>
        <div id="wa-threads"><p class="muted">${esc(t('loading'))}</p></div>
      </div>
      <div class="card">
        <h2>${esc(t('sendMessage'))}</h2>
        <form id="wa-send" class="grid-form">
          ${field(t('patientTypeSearch'), input('patientId', 'text', '', ar ? 'required placeholder="اسم المريض…"' : 'required placeholder="patient name…"'))}
          ${field(t('message'), `<textarea name="body" rows="3" required></textarea>`)}
          <button class="primary" type="submit">${esc(t('send'))}</button>
          <button type="button" id="wa-direct">${esc(t('openDirect'))}</button>
        </form>
        <p class="muted">${esc(t('directHint'))}</p>
        <div id="wa-history"></div>
      </div>
      <div class="card wide">
        <h2>${esc(t('outbox'))}</h2>
        <div id="wa-outbox"><p class="muted">${esc(t('loading'))}</p></div>
      </div>
      ${
        // Owner-only, mirroring the API's `settings:write` gate. Hiding it is
        // not just tidiness: a nurse or doctor would see a panel whose only
        // possible outcome is a 403, which reads as a broken app rather than a
        // permission they do not have.
        canLinkDevice()
          ? `<div class="card wide">
        <h2>${esc(t('linkDevice'))}</h2>
        <p class="muted">${esc(t('linkDeviceHint'))}</p>
        <div id="wa-device"></div>
      </div>`
          : ''
      }
    </section>`;

  if (canLinkDevice()) renderDeviceLink(root);

  const loadPending = (): void => {
    outboxPending()
      .then((items) => {
        const host = document.getElementById('wa-pending') as HTMLElement;
        const count = document.getElementById('wa-pending-count');
        if (count) count.innerHTML = items.length > 0 ? `<span class="pill danger">${items.length}</span>` : '';
        host.innerHTML =
          items.length > 0
            ? `<ul class="list">${items
                .map(
                  (o) => `<li>
                    <div><strong dir="ltr">${esc(o.to)}</strong> <span class="pill">${esc(o.template)}</span></div>
                    <div class="muted">${esc(o.body.slice(0, 160))}${o.body.length > 160 ? '…' : ''}</div>
                    <div class="row"><button class="primary" data-send="${esc(o.id)}" data-to="${esc(o.to)}" data-body="${esc(o.body)}">${esc(t('sendViaApp'))}</button></div>
                  </li>`,
                )
                .join('')}</ul>`
            : `<p class="muted">${esc(t('noPendingSends'))}</p>`;
        host.querySelectorAll<HTMLButtonElement>('button[data-send]').forEach((button) => {
          button.addEventListener('click', () => {
            // Open first (synchronously in the click = never popup-blocked),
            // then log the human press.
            window.open(waLink(button.dataset.to ?? '', button.dataset.body ?? ''), '_blank', 'noopener');
            button.disabled = true;
            outboxManualSend(button.dataset.send ?? '')
              .then(() => {
                toast(t('sentLogged'));
                loadPending();
                void refreshWhatsappBadge();
              })
              .catch((error: unknown) => {
                button.disabled = false;
                if (error instanceof OfflineQueuedError) toast(t('queued'));
                else toast(errorText(error), 'error');
              });
          });
        });
      })
      .catch((error: unknown) => {
        (document.getElementById('wa-pending') as HTMLElement).innerHTML =
          `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };
  loadPending();

  threadsList()
    .then((items) => {
      const rows = items
        .map(
          (th) => `<li><button class="linklike" data-thread="${esc(th.id)}">${esc(th.id.slice(0, 8))}…</button>
            <span class="muted">${esc(fmtDateTime(th.lastMessageAt))}</span>
            ${Number(th.unreadCount ?? 0) > 0 ? `<span class="pill danger">${esc(String(th.unreadCount))}</span>` : ''}</li>`,
        )
        .join('');
      (document.getElementById('wa-threads') as HTMLElement).innerHTML = rows
        ? `<ul class="list">${rows}</ul>`
        : `<p class="muted">${esc(t('noResults'))}</p>`;
      document.querySelectorAll<HTMLButtonElement>('button[data-thread]').forEach((button) => {
        button.addEventListener('click', () => openThread(button.dataset.thread ?? ''));
      });
    })
    .catch((error: unknown) => {
      (document.getElementById('wa-threads') as HTMLElement).innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
    });

  outboxList()
    .then((items) => {
      const rows = items
        .map(
          (o) => `<tr><td dir="ltr">${esc(o.to ?? '')}</td><td>${esc(o.template ?? '')}</td><td><span class="pill">${esc(statusLabel(o.status ?? ''))}</span></td></tr>`,
        )
        .join('');
      (document.getElementById('wa-outbox') as HTMLElement).innerHTML = rows
        ? `<table class="table"><tbody>${rows}</tbody></table>`
        : `<p class="muted">${esc(t('noResults'))}</p>`;
    })
    .catch((error: unknown) => {
      (document.getElementById('wa-outbox') as HTMLElement).innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
    });

  const sendForm = document.getElementById('wa-send') as HTMLFormElement;
  let waPicked: PickedPatient | null = null;
  attachPatientPicker(sendForm.querySelector('input[name="patientId"]') as HTMLInputElement, (p) => {
    waPicked = p;
  });

  sendForm.addEventListener('submit', (event) => {
    event.preventDefault();
    let patientId = '';
    try {
      patientId = requirePicked(
        sendForm.querySelector('input[name="patientId"]') as HTMLInputElement,
        waPicked,
      );
    } catch (error) {
      toast(errorText(error), 'error');
      return;
    }
    const data = new FormData(sendForm);
    msgSend(patientId, String(data.get('body') ?? ''))
      .then(() => {
        sendForm.reset();
        toast(t('send'));
        loadPending();
        void refreshWhatsappBadge();
      })
      .catch((error: unknown) => {
        if (error instanceof OfflineQueuedError) toast(t('queued'));
        else toast(errorText(error), 'error');
      });
  });

  // Ad-hoc direct open: no task is created, nothing is logged - the doctor
  // just wants the chat open with the text ready.
  (document.getElementById('wa-direct') as HTMLButtonElement).addEventListener('click', () => {
    if (!waPicked) {
      toast(t('pickPatientError'), 'error');
      return;
    }
    const body = String(new FormData(sendForm).get('body') ?? '');
    window.open(waLink(waPicked.phone, body), '_blank', 'noopener');
  });

  void refreshWhatsappBadge();
}

/**
 * Nav badge: the WhatsApp tab shows how many sends are waiting, so a reminder
 * due is visible before the doctor even opens the tab. Best-effort: badge
 * failures never break navigation.
 */
export async function refreshWhatsappBadge(): Promise<void> {
  try {
    const pending = await outboxPending();
    const link = document.querySelector('nav a[href="#/whatsapp"]');
    if (!link) return;
    const base = t('whatsapp');
    link.innerHTML =
      pending.length > 0 ? `${esc(base)} <span class="pill danger">${pending.length}</span>` : esc(base);
  } catch {
    // Badge is advisory; the tab itself shows the real state.
  }
}

function openThread(id: string): void {
  const host = document.getElementById('wa-history');
  if (!host) return;
  host.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;
  threadMessages(id)
    .then((items) => {
      const rows = items
        .map(
          (m) => `<li class="${m.direction === 'outbound' ? 'out' : 'in'}"><span class="bubble">${esc(m.body ?? '')}</span><span class="muted">${esc(fmtDateTime(m.createdAt))} · ${esc(statusLabel(m.status ?? ''))}</span></li>`,
        )
        .join('');
      host.innerHTML = rows ? `<ul class="chat">${rows}</ul>` : `<p class="muted">${esc(t('noResults'))}</p>`;
      void threadRead(id);
    })
    .catch((error: unknown) => {
      host.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
    });
}
