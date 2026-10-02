import {
  OfflineQueuedError,
  msgBroadcast,
  msgSend,
  outboxList,
  outboxManualSend,
  outboxPending,
  patientsList,
  waLink,
} from '../data.js';
import { getLang, statusLabel, t } from '../i18n.js';
import { errorText, esc, field, input, toast } from '../ui.js';
import { attachPatientPicker, requirePicked, type PickedPatient } from './patientPicker.js';
import { renderDeviceLink } from './deviceLink.js';

/**
 * Staff WhatsApp workspace: link the clinic's device, send one message to
 * one patient, or broadcast one message to many. There is deliberately NO
 * chat view here - inbound conversation belongs to the phone, not the desk.
 * Everything on this page funnels into the outbox, which the gateway drains.
 */
export function renderWhatsapp(root: HTMLElement): void {
  const ar = getLang() === 'ar';
  root.innerHTML = `
    <section class="grid">
      <div class="card wide">
        <h2>${esc(t('linkDevice'))}</h2>
        <p class="muted">${esc(t('linkDeviceHint'))}</p>
        <div id="wa-device"><p class="muted">${esc(t('loading'))}</p></div>
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
      </div>
      <div class="card">
        <h2>${esc(t('broadcast'))}</h2>
        <p class="muted">${esc(t('broadcastHint'))}</p>
        <form id="wa-broadcast" class="grid-form">
          ${field(t('searchPatients'), input('bSearch', 'search', '', ar ? 'placeholder="بحث بالاسم…" dir="auto"' : 'placeholder="search by name…"'))}
          <div id="wa-bcast-list"><p class="muted">${esc(t('broadcastTypeToList'))}</p></div>
          ${field(t('message'), `<textarea name="bBody" rows="3" required></textarea>`)}
          <button class="primary" type="submit">${esc(t('broadcastSend'))}</button>
          <p class="form-error" id="broadcast-error" hidden></p>
        </form>
      </div>
      <div class="card wide">
        <h2>${esc(t('pendingSends'))} <span id="wa-pending-count"></span></h2>
        <p class="muted">${esc(t('pendingSendsHint'))}</p>
        <div id="wa-pending"><p class="muted">${esc(t('loading'))}</p></div>
      </div>
      <div class="card wide">
        <h2>${esc(t('outbox'))}</h2>
        <div id="wa-outbox"><p class="muted">${esc(t('loading'))}</p></div>
      </div>
    </section>`;

  renderDeviceLink(root);

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

  // Broadcast: one message to many patients. Opted-out patients are listed
  // disabled up front (the server would skip them anyway); the result toast
  // reports exactly what queued and what did not.
  const bSearch = document.getElementById('bSearch') as HTMLInputElement;
  const bList = document.getElementById('wa-bcast-list') as HTMLElement;
  const bForm = document.getElementById('wa-broadcast') as HTMLFormElement;
  const bError = document.getElementById('broadcast-error') as HTMLElement;
  let bTimer: ReturnType<typeof setTimeout> | null = null;
  const paintBroadcastList = (): void => {
    const q = bSearch.value.trim();
    if (!q) {
      bList.innerHTML = `<p class="muted">${esc(t('broadcastTypeToList'))}</p>`;
      return;
    }
    patientsList(q)
      .then((items) => {
        bList.innerHTML = items.length
          ? `<ul class="list">${items
              .map(
                (p) => `<li><label><input type="checkbox" name="bPatient" value="${esc(p.id)}"${
                  p.whatsappOptIn ? '' : ' disabled'
                }> ${esc(p.fullName)} <span class="muted" dir="ltr">${esc(p.phone)}</span>${
                  p.whatsappOptIn ? '' : ` <span class="pill">${esc(t('optedOut'))}</span>`
                }</label></li>`,
              )
              .join('')}</ul>`
          : `<p class="muted">${esc(t('noResults'))}</p>`;
      })
      .catch((error: unknown) => {
        bList.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
      });
  };
  bSearch.addEventListener('input', () => {
    if (bTimer) clearTimeout(bTimer);
    bTimer = setTimeout(paintBroadcastList, 250);
  });
  bForm.addEventListener('submit', (event) => {
    event.preventDefault();
    bError.hidden = true;
    const ids = [...bForm.querySelectorAll<HTMLInputElement>('input[name="bPatient"]:checked')].map((c) => c.value);
    const data = new FormData(bForm);
    const body = String(data.get('bBody') ?? '').trim();
    if (ids.length === 0 || !body) {
      bError.textContent = t('broadcastPickSomeone');
      bError.hidden = false;
      return;
    }
    const submit = bForm.querySelector('button[type="submit"]') as HTMLButtonElement;
    submit.disabled = true;
    msgBroadcast(ids, body)
      .then(({ queued, skipped }) => {
        submit.disabled = false;
        toast(t('broadcastDone').replace('{n}', String(queued.length)).replace('{m}', String(skipped.length)));
        loadPending();
        void refreshWhatsappBadge();
      })
      .catch((error: unknown) => {
        submit.disabled = false;
        if (error instanceof OfflineQueuedError) toast(t('queued'));
        else {
          bError.textContent = errorText(error);
          bError.hidden = false;
        }
      });
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
