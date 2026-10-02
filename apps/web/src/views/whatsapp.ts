import { t } from '../i18n.js';
import { esc } from '../ui.js';
import { renderDeviceLink } from './deviceLink.js';

/**
 * Device linking, and nothing else.
 *
 * The doctor never sees WhatsApp here: no threads, no outbox, no send form.
 * This page is the equivalent of WhatsApp Web's "linked devices" screen - it
 * exists so the clinic's phone can be paired once, after which the card reads
 * "linked" and the page has no further use. All patient messaging happens
 * automatically in the background.
 */
export function renderWhatsapp(root: HTMLElement): void {
  root.innerHTML = `
    <section class="grid">
      <div class="card wide">
        <h2>${esc(t('linkDevice'))}</h2>
        <p class="muted">${esc(t('linkDeviceHint'))}</p>
        <div id="wa-device"><p class="muted">${esc(t('loading'))}</p></div>
      </div>
    </section>`;

  renderDeviceLink(root);
}
