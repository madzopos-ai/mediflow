import { SPECIALTY_LABELS } from '@mediflow/shared';

import { getLang, specialtyLabel, t } from '../i18n.js';
import { errorText, esc, field, input, toast } from '../ui.js';

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';

const TYPES = [
  { id: 'doctor', titleEn: 'Doctor', titleAr: 'طبيب', textEn: 'Your own practice, scoped to your specialty.', textAr: 'عيادتك الخاصة ضمن تخصصك.' },
  { id: 'clinic', titleEn: 'Clinic', titleAr: 'عيادة', textEn: 'A practice with staff, schedules, and billing.', textAr: 'منشأة بكادر ودوام وفوترة.' },
  { id: 'lab', titleEn: 'Laboratory', titleAr: 'مختبر', textEn: 'Receive test orders and publish results.', textAr: 'استلام طلبات التحاليل ونشر النتائج.' },
  { id: 'pharmacy', titleEn: 'Pharmacy', titleAr: 'صيدلية', textEn: 'Dispense prescriptions written on the app.', textAr: 'صرف الوصفات المحررة في التطبيق.' },
] as const;

type AccountType = (typeof TYPES)[number]['id'];

async function postJson(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    // Keep the generic error below.
  }
  return { status: response.status, json };
}

function errorMessage(json: Record<string, unknown>, fallback: string): string {
  const error = json['error'] as { message?: string } | undefined;
  return error?.message ?? fallback;
}

export function renderJoin(root: HTMLElement): void {
  const ar = getLang() === 'ar';
  root.innerHTML = `
    <section class="card auth" style="max-width: 560px; margin-inline: auto;">
      <div class="auth-hero"><h1>${esc(t('joinTitle'))}</h1><p class="muted">${esc(t('joinSubtitle'))}</p></div>
      <div id="join-types" class="cards-grid">
        ${TYPES.map(
          (ty) => `<div class="pcard" data-type="${ty.id}" role="button" tabindex="0">
            <h3>${esc(ar ? ty.titleAr : ty.titleEn)}</h3><p class="muted small">${esc(ar ? ty.textAr : ty.textEn)}</p>
          </div>`,
        ).join('')}
      </div>
      <div id="join-form-host"></div>
    </section>`;

  root.querySelectorAll<HTMLElement>('.pcard[data-type]').forEach((card) => {
    const open = (): void => renderJoinForm(root, card.dataset.type as AccountType);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  });
}

function renderJoinForm(root: HTMLElement, accountType: AccountType): void {
  const host = document.getElementById('join-form-host') as HTMLElement;
  const specialties = Object.entries(SPECIALTY_LABELS as Record<string, string>);
  const title =
    accountType === 'doctor' ? t('doctorSignup') : accountType === 'clinic' ? t('clinicSignup') : accountType === 'lab' ? t('labSignup') : t('pharmacySignup');
  host.innerHTML = `
    <h3>${esc(title)}</h3>
    <form id="join-details" class="grid-form">
      ${field(t('fullName'), input('fullName', 'text', '', 'required autocomplete="name"'))}
      ${field(t('email'), input('email', 'email', '', 'required autocomplete="email"'))}
      ${field(t('password10'), input('password', 'password', '', 'required minlength="10" autocomplete="new-password"'))}
      ${field(t('phone'), input('phone', 'tel', '', 'placeholder="+961…"'))}
      ${
        accountType === 'doctor'
          ? field(
              t('specialtyRequired'),
              `<select name="specialty" required>${specialties
                .map(([key, label]) => `<option value="${esc(key)}">${esc(specialtyLabel(key, label))}</option>`)
                .join('')}</select>`,
            )
          : field(t('practiceName'), input('practiceName', 'text', '', 'required'))
      }
      <button class="primary" type="submit">${esc(t('sendVerificationCode'))}</button>
      <p class="form-error" id="join-error" hidden></p>
    </form>
    <div id="join-verify-host"></div>`;

  (document.getElementById('join-details') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const email = String(data.get('email') ?? '');
    const errorEl = document.getElementById('join-error') as HTMLElement;
    postJson('/auth/signup/code', { accountType, email })
      .then(({ status, json }) => {
        if (status !== 200) {
          errorEl.hidden = false;
          errorEl.textContent = errorMessage(json, 'Could not send the code.');
          return;
        }
        renderVerifyStep(root, {
          accountType,
          email,
          fullName: String(data.get('fullName') ?? ''),
          password: String(data.get('password') ?? ''),
          phone: String(data.get('phone') ?? '') || null,
          specialty: String(data.get('specialty') ?? '') || null,
          practiceName: String(data.get('practiceName') ?? '') || null,
          devCode: typeof json['devCode'] === 'string' ? (json['devCode'] as string) : null,
        });
      })
      .catch((error: unknown) => {
        errorEl.hidden = false;
        errorEl.textContent = errorText(error);
      });
  });
}

interface PendingSignup {
  accountType: AccountType;
  email: string;
  fullName: string;
  password: string;
  phone: string | null;
  specialty: string | null;
  practiceName: string | null;
  devCode: string | null;
}

function renderVerifyStep(root: HTMLElement, pending: PendingSignup): void {
  const host = document.getElementById('join-verify-host') as HTMLElement;
  const ar = getLang() === 'ar';
  host.innerHTML = `
    <h3>${esc(t('checkYourEmail'))}</h3>
    <p class="muted">${esc(t('codeSentHint'))} <span dir="ltr">${esc(pending.email)}</span>. ${esc(t('codeExpires30'))}</p>
    ${pending.devCode ? `<p class="warning">${ar ? 'وضع التطوير: رمزك هو' : 'Development mode: your code is'} <strong dir="ltr">${esc(pending.devCode)}</strong></p>` : ''}
    <form id="join-verify" class="row">
      ${field(t('code'), input('code', 'text', '', 'required inputmode="numeric" minlength="6" maxlength="6"'))}
      <button class="primary" type="submit">${esc(t('verifyCreateAccount'))}</button>
      <p class="form-error" id="verify-error" hidden></p>
    </form>`;
  host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  (document.getElementById('join-verify') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const code = String(new FormData(event.target as HTMLFormElement).get('code') ?? '');
    const errorEl = document.getElementById('verify-error') as HTMLElement;
    postJson('/auth/signup/verify', {
      email: pending.email,
      code,
      accountType: pending.accountType,
      fullName: pending.fullName,
      password: pending.password,
      ...(pending.specialty ? { specialty: pending.specialty } : {}),
      ...(pending.practiceName ? { practiceName: pending.practiceName } : {}),
      ...(pending.phone ? { phone: pending.phone } : {}),
    })
      .then(({ status, json }) => {
        if (status !== 201) {
          errorEl.hidden = false;
          errorEl.textContent = errorMessage(json, 'Verification failed.');
          return;
        }
        // Approved practices sign in; until the administrator accepts, the
        // account exists but no token is issued - this screen says so.
        host.innerHTML = `
          <h3>${esc(t('requestReceived'))}</h3>
          <p>${ar ? 'تم إنشاء حساب' : 'Your'} ${esc(pending.accountType)} ${ar ? 'وهو' : 'account was created and is'} <strong>${ar ? 'بانتظار موافقة الإدارة' : 'pending administrator approval'}</strong>.</p>
          <p class="muted">${esc(t('pendingAdminHint'))}</p>
          <p><a class="button" href="#/login">${esc(t('backToSignIn'))}</a></p>`;
        host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      })
      .catch((error: unknown) => {
        errorEl.hidden = false;
        errorEl.textContent = errorText(error);
      });
  });
}

export function renderOnboarding(root: HTMLElement): void {
  root.innerHTML = `
    <section class="card auth" style="max-width: 560px; margin-inline: auto;">
      <div class="auth-hero"><h1>${esc(t('almostDone'))}</h1><p class="muted">${esc(t('onboardingHint'))}</p></div>
      <form id="onboard-form" class="grid-form">
        ${field(t('phone'), input('phone', 'tel', '', 'required'))}
        ${field(t('address'), input('address', 'text', '', 'required'))}
        <button class="primary" type="submit">${esc(t('saveAndEnter'))}</button>
        <p class="form-error" id="onboard-error" hidden></p>
      </form>
    </section>`;

  (document.getElementById('onboard-form') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const errorEl = document.getElementById('onboard-error') as HTMLElement;
    const token = localStorage.getItem('mf_token');
    if (!token) {
      window.location.hash = '#/login';
      return;
    }
    fetch(`${BASE}/auth/profile`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ phone: String(data.get('phone') ?? ''), address: String(data.get('address') ?? '') }),
    })
      .then(async (response) => {
        if (!response.ok) {
          errorEl.hidden = false;
          errorEl.textContent = 'Could not save. Check the fields.';
          return;
        }
        localStorage.setItem('mf_profile_ok', '1');
        window.location.hash = '#/';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      })
      .catch((error: unknown) => {
        errorEl.hidden = false;
        errorEl.textContent = errorText(error);
        toast(errorText(error), 'error');
      });
  });
}
