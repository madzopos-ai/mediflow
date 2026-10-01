/**
 * WhatsApp device linking for a clinic.
 *
 * Pairing used to mean reading a code out of the gateway's logs on Render, which
 * is a bad loop for a clinic: the person who can see the logs is never the
 * person holding the clinic's phone. This panel does the whole thing in the app
 * the staff already have open.
 *
 * Two behaviours are load-bearing:
 *
 * - Polling stops on a clean state. Once a device is paired the gateway clears
 *   the QR, so a still-running poll would just re-fetch `null` forever and burn
 *   the user's data. The panel then says "linked" and stops.
 * - A QR is only valid for about half a minute. The code is re-rendered when
 *   `qrUpdatedAt` changes, and a QR older than that is shown as expired rather
 *   than left on screen looking scannable.
 *
 * The gateway's admin token never reaches this code: the API proxies the call
 * and scopes it to the caller's clinic, so the browser can only ever ask for
 * its own.
 */

import QRCode from 'qrcode';

import { whatsappDevice, whatsappPairingCode, type UiDeviceLink } from '../data.js';
import { t } from '../i18n.js';
import { errorText, esc } from '../ui.js';

/** Baileys rotates the pairing QR roughly every 30s. */
const QR_TTL_MS = 45_000;
/** Only poll while there is a reason to. Paired and errored states are settled. */
const POLL_MS = 6_000;

/**
 * Maps a gateway state to a label.
 *
 * An explicit table rather than a computed key: `t()` is typed on the literal
 * string keys, and a new gateway state should fail to compile here rather than
 * render raw camelCase to a clinician at the point of care.
 */
const STATE_LABELS: Record<string, () => string> = {
  pending: () => t('deviceStatePending'),
  connecting: () => t('deviceStateConnecting'),
  pairing: () => t('deviceStatePairing'),
  connected: () => t('deviceStateConnected'),
  disconnected: () => t('deviceStateDisconnected'),
  'logged-out': () => t('deviceStateLoggedOut'),
  error: () => t('deviceStateError'),
};

function stateLabel(state: string): string {
  return (STATE_LABELS[state] ?? (() => t('deviceStateUnknown')))();
}

function isSettled(state: string): boolean {
  return state === 'connected' || state === 'error' || state === 'logged-out';
}

export function renderDeviceLink(root: HTMLElement): void {
  const host = root.querySelector('#wa-device') as HTMLElement | null;
  if (!host) return;

  let current: UiDeviceLink | null = null;
  let timer: number | null = null;
  /** Guards against a slow response landing after the user left the page. */
  let alive = true;

  const stopPolling = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const paint = (link: UiDeviceLink): void => {
    current = link;
    const paired = link.paired;
    const expired =
      link.qr !== null &&
      link.qrUpdatedAt !== null &&
      Date.now() - Date.parse(link.qrUpdatedAt) > QR_TTL_MS;

    let body: string;
    if (paired) {
      body = `
        <p><span class="pill ok">${esc(t('devicePaired'))}</span></p>
        ${link.connectedAt ? `<p class="muted">${esc(t('devicePairedAt'))}: ${esc(link.connectedAt.slice(0, 19).replace('T', ' '))}</p>` : ''}
        <p class="muted">${esc(t('deviceUnlinkHint'))}</p>`;
    } else if (link.state === 'error' && link.lastError) {
      body = `
        <p><span class="pill danger">${esc(stateLabel(link.state))}</span></p>
        <p class="muted" dir="ltr">${esc(link.lastError)}</p>
        <p class="row"><button type="button" id="wa-device-retry">${esc(t('deviceRetry'))}</button></p>`;
    } else if (link.qr && !expired) {
      body = `
        <div id="wa-device-qr" class="qr-frame"></div>
        <p class="muted">${esc(t('deviceScanSteps'))}</p>
        <p class="row"><button type="button" id="wa-device-code">${esc(t('deviceRequestCode'))}</button></p>
        <div id="wa-device-codeout"></div>`;
    } else if (expired) {
      body = `
        <p><span class="pill">${esc(t('deviceQrExpired'))}</span></p>
        <p class="row"><button type="button" id="wa-device-code">${esc(t('deviceRequestCode'))}</button></p>`;
    } else {
      body = `<p class="muted">${esc(t('deviceQrWait'))}</p>`;
    }

    host.innerHTML = `
      ${
        link.state === 'connected'
          ? ''
          : `<p><span class="pill">${esc(stateLabel(link.state))}</span></p>`
      }
      ${body}`;

    // Render the QR locally; nothing about the code leaves the browser.
    const qrHost = host.querySelector('#wa-device-qr') as HTMLElement | null;
    if (qrHost && link.qr) {
      void QRCode.toCanvas(qrHost, link.qr, {
        width: 240,
        margin: 1,
        errorCorrectionLevel: 'L',
        color: { dark: '#101418', light: '#ffffff' },
      }).catch(() => {
        qrHost.innerHTML = `<p class="muted">${esc(t('deviceQrExpired'))}</p>`;
      });
    }

    const codeBtn = host.querySelector('#wa-device-code') as HTMLButtonElement | null;
    codeBtn?.addEventListener('click', () => {
      codeBtn.disabled = true;
      void whatsappPairingCode()
        .then((code) => {
          const out = host.querySelector('#wa-device-codeout') as HTMLElement | null;
          if (out) {
            out.innerHTML = `
              <p>${esc(t('devicePairingCodeLabel'))}: <strong class="pairing-code" dir="ltr">${esc(code)}</strong></p>
              <p class="muted">${esc(t('deviceCodeRequested'))}</p>`;
          }
        })
        .catch((error: unknown) => {
          const out = host.querySelector('#wa-device-codeout') as HTMLElement | null;
          if (out) out.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
        })
        .finally(() => {
          codeBtn.disabled = false;
        });
    });

    host.querySelector('#wa-device-retry')?.addEventListener('click', () => {
      void refresh();
    });
  };

  const poll = async (): Promise<void> => {
    // Only keep polling while there is something to poll for. `current` is
    // compared against the settled set so a paired device stops immediately.
    if (!alive || (current !== null && isSettled(current.state))) return;
    try {
      const next = await whatsappDevice();
      if (!alive) return;
      // Re-render only on a real change: replacing the DOM every 6s would
      // restart the canvas and make a QR the user is aiming at flicker.
      if (current === null || next.qr !== current.qr || next.state !== current.state) {
        paint(next);
      }
    } catch (error) {
      if (!alive) return;
      host.innerHTML = `
        <p><span class="pill danger">${esc(t('deviceGatewayDown'))}</span></p>
        <p class="row"><button type="button" id="wa-device-retry">${esc(t('deviceRetry'))}</button></p>`;
      host.querySelector('#wa-device-retry')?.addEventListener('click', () => {
        void refresh();
      });
      stopPolling();
      return;
    }
    if (alive) timer = window.setTimeout(() => void poll(), POLL_MS);
  };

  const refresh = async (): Promise<void> => {
    stopPolling();
    current = null;
    await poll();
  };

  // Stop when the view is torn down, otherwise a backgrounded tab keeps polling
  // a gateway for a page the user has left.
  const observer = new MutationObserver(() => {
    if (host.isConnected) return;
    alive = false;
    stopPolling();
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  host.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;
  void refresh();
}
