/**
 * Staff password reset screens.
 *
 * Two views live here: asking for a link, and choosing a new password with one.
 * Both are staff-only. Patients have no password to reset - they sign in with a
 * phone number and an access code - so neither screen is reachable from the
 * patient form, and the forgot screen says so explicitly to stop a patient
 * burning ten minutes on a form that can never help them.
 *
 * Both are public routes. No session, no clinic context: a locked-out owner is
 * by definition not signed in, which is the entire point.
 */

import { t, getLang } from '../i18n.js';
import { errorText, esc } from '../ui.js';
import {
  requestPasswordReset,
  checkPasswordResetToken,
  redeemPasswordResetToken,
} from '../api.js';

/** Wraps the page in the same shell the login screen uses. */
function shell(title: string, body: string): string {
  return `
    <section class="card auth">
      <h2>${esc(title)}</h2>
      ${body}
    </section>`;
}

function notice(id: string, text: string, kind: 'error' | 'ok'): string {
  return `<p class="${kind === 'error' ? 'form-error' : 'muted'}" id="${id}"${
    kind === 'error' ? '' : ' hidden'
  }>${esc(text)}</p>`;
}

/** `#/password-reset` - ask for a link by email. */
export function renderForgotPassword(root: HTMLElement): void {
  root.innerHTML = shell(
    t('forgotPasswordTitle'),
    `
      <p class="muted">${esc(t('forgotPasswordIntro'))}</p>
      <form id="forgot-form">
        <label>${esc(t('email'))}
          <input id="forgot-email" type="email" required autocomplete="username" dir="ltr">
        </label>
        <button class="primary" type="submit">${esc(t('forgotPassword'))}</button>
        ${notice('forgot-error', '', 'error')}
        <div id="forgot-sent" hidden>
          <p class="muted">${esc(t('forgotPasswordSent'))}</p>
        </div>
      </form>
      <p class="muted small">${esc(t('forgotPasswordStaffOnly'))}</p>
      <p><a href="#/login">← ${esc(t('forgotPasswordBack'))}</a></p>`,
  );

  const form = document.getElementById('forgot-form') as HTMLFormElement;
  const errorEl = document.getElementById('forgot-error') as HTMLElement;
  const sentEl = document.getElementById('forgot-sent') as HTMLElement;
  const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const email = (document.getElementById('forgot-email') as HTMLInputElement).value.trim();
    errorEl.hidden = true;
    submit.disabled = true;

    requestPasswordReset(email)
      .then(() => {
        // The same confirmation for every address, on purpose. See api.ts.
        form.hidden = true;
        sentEl.hidden = false;
      })
      .catch((error: unknown) => {
        errorEl.textContent = errorText(error);
        errorEl.hidden = false;
        submit.disabled = false;
      });
  });
}

/** `#/password-reset?token=…` - set a new password. */
export function renderResetPassword(root: HTMLElement, token: string): void {
  const ar = getLang() === 'ar';

  if (!token) {
    root.innerHTML = shell(
      t('resetPasswordTitle'),
      `${notice('reset-msg', t('resetPasswordInvalid'), 'error')}
       <p><a href="#/password-reset">${esc(t('requestNewLink'))}</a></p>`,
    );
    return;
  }

  root.innerHTML = shell(
    t('resetPasswordTitle'),
    `
      <p class="muted">${esc(t('resetPasswordIntro'))}</p>
      <form id="reset-form">
        <label>${esc(t('password'))}
          <input id="reset-password" type="password" required minlength="10"
                 autocomplete="new-password" dir="ltr">
        </label>
        <label>${esc(t('confirmPassword'))}
          <input id="reset-confirm" type="password" required minlength="10"
                 autocomplete="new-password" dir="ltr">
        </label>
        <button class="primary" type="submit">${esc(t('save'))}</button>
        ${notice('reset-msg', '', 'error')}
        <p class="muted" id="reset-ok" hidden>${esc(t('resetPasswordDone'))}</p>
      </form>
      <p><a href="#/password-reset">${esc(t('requestNewLink'))}</a></p>`,
  );

  const form = document.getElementById('reset-form') as HTMLFormElement;
  const msgEl = document.getElementById('reset-msg') as HTMLElement;
  const okEl = document.getElementById('reset-ok') as HTMLElement;
  const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;

  // Tell a dead link apart from a live one before anyone types a new password
  // into a form that is going to reject it at the end.
  checkPasswordResetToken(token)
    .catch(() => {
      msgEl.textContent = t('resetPasswordInvalid');
      msgEl.hidden = false;
      form.hidden = true;
    });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    msgEl.hidden = true;

    const password = (document.getElementById('reset-password') as HTMLInputElement).value;
    const confirm = (document.getElementById('reset-confirm') as HTMLInputElement).value;
    if (password !== confirm) {
      msgEl.textContent = t('resetPasswordMismatch');
      msgEl.hidden = false;
      return;
    }
    if (password.length < 10) {
      msgEl.textContent = ar
        ? 'كلمة المرور يجب أن تكون 10 أحرف على الأقل.'
        : 'Password must be at least 10 characters.';
      msgEl.hidden = false;
      return;
    }

    submit.disabled = true;
    redeemPasswordResetToken(token, password)
      .then(() => {
        form.hidden = true;
        okEl.hidden = false;
        // The token is spent; leaving it in the URL would let a refresh look
        // like a failed attempt and strand the person on a dead page.
        window.history.replaceState(null, '', '#/login');
      })
      .catch((error: unknown) => {
        msgEl.textContent = errorText(error);
        msgEl.hidden = false;
        submit.disabled = false;
      });
  });
}
