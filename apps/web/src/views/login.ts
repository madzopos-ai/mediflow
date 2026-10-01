import { loginRequest, setSession } from '../api.js';
import { getLang, t } from '../i18n.js';
import { errorText, esc, field, input, toast } from '../ui.js';
import { networkPatientLogin, networkRegister, patientLogin } from '../data.js';

/** Glowing pulse-cross emblem shared by every login card. */
function authHero(): string {
  return `<div class="auth-hero">
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <defs><linearGradient id="mfg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#0e5f6b"/><stop offset="1" stop-color="#1e7a3c"/>
      </linearGradient></defs>
      <rect x="4" y="4" width="56" height="56" rx="16" fill="url(#mfg)"/>
      <path d="M32 16v32M16 32h32" stroke="#fff" stroke-width="7" stroke-linecap="round"/>
      <path d="M10 44l5-6 4 4 5-9 4 6 3-3 5 5 4-4 6 7" stroke="#7fd1c0" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <h1>${esc(t('appName'))}</h1>
    <p class="muted">${esc(t('tagline'))}</p>
  </div>`;
}

/**
 * Login entry point. Firebase is lazy-loaded so the default bundle stays
 * small: most first visits just need the API login, and the Firebase SDK
 * (~500 KB) only downloads for builds that actually carry a Firebase config.
 */
export function renderLogin(root: HTMLElement): void {
  root.innerHTML = `<section class="card auth"><p class="muted">${esc(t('loading'))}</p></section>`;
  import('../firebase.js')
    .then((fb) => {
      if (fb.isFirebaseConfigured()) renderFirebaseLogin(root, fb);
      else renderApiLogin(root);
    })
    .catch((error: unknown) => {
      root.innerHTML = `<section class="card auth"><p class="muted">${esc(errorText(error))}</p></section>`;
    });
}

type FirebaseModule = typeof import('../firebase.js');

function renderFirebaseLogin(root: HTMLElement, fb: FirebaseModule): void {
  root.innerHTML = `
    <section class="card auth">
      ${authHero()}
      <form id="fb-smart">
        ${field(t('loginIdentifier'), input('identifier', 'text', '', 'required autocomplete="username" placeholder="email@example.com / +961…" dir="ltr"'))}
        ${field(t('loginSecret'), input('secret', 'password', '', 'required autocomplete="current-password"'))}
        <button class="primary" type="submit">${esc(t('login'))}</button>
        <p class="muted small">${esc(t('smartLoginHint'))}</p>
      </form>
      <form id="fb-up" hidden>
        <h3>${esc(t('clinicSignup'))}</h3>
        <div class="clinic-showcase">
          <div class="showcase-item"><strong>${esc(t('docFeat1'))}</strong><span>${esc(t('docFeat1d'))}</span></div>
          <div class="showcase-item"><strong>${esc(t('docFeat2'))}</strong><span>${esc(t('docFeat2d'))}</span></div>
          <div class="showcase-item"><strong>${esc(t('docFeat3'))}</strong><span>${esc(t('docFeat3d'))}</span></div>
        </div>
        ${field(t('yourName'), input('name', 'text', '', 'required autocomplete="name"'))}
        ${field(t('clinicName'), input('clinicName', 'text', '', 'required'))}
        ${field(t('email'), input('email', 'email', '', 'required autocomplete="username"'))}
        ${field(t('password'), input('password', 'password', '', 'required minlength="10" autocomplete="new-password"'))}
        ${field(t('activationCode'), input('activationCode', 'text', '', 'required maxlength="16" style="text-transform:uppercase" placeholder="XXXX-XXXX"'))}
        <p class="muted">${esc(t('activationCodeHint'))}</p>
        <button class="primary" type="submit">${esc(t('createClinicAccount'))}</button>
        <p class="muted">${esc(t('oneAccountPerClinic'))}</p>
        <p><button type="button" class="linklike" id="back-login-1">← ${esc(t('backToLogin'))}</button></p>
      </form>
      <form id="fb-doctor" hidden>
        <h3>${esc(t('joinDoctorTitle'))}</h3>
        <p class="muted">${esc(t('doctorInviteHint'))}</p>
        ${field(t('yourName'), input('dName', 'text', '', 'required autocomplete="name"'))}
        ${field(t('email'), input('dEmail', 'email', '', 'required autocomplete="username"'))}
        ${field(t('password'), input('dPassword', 'password', '', 'required minlength="10" autocomplete="new-password"'))}
        ${field(t('inviteCode'), input('inviteCode', 'text', '', 'required maxlength="16" style="text-transform:uppercase"'))}
        <button class="primary" type="submit">${esc(t('joinDoctorSubmit'))}</button>
        <p><button type="button" class="linklike" id="back-login-3">← ${esc(t('backToLogin'))}</button></p>
      </form>
      <form id="fb-patient" hidden>
        <div class="patient-hero">
          <h3>${esc(t('patientHeroTitle'))}</h3>
          <p class="muted">${esc(t('patientHeroSub'))}</p>
          <ul class="hero-list">
            <li><strong>${esc(t('patientFeat1'))}</strong><span>${esc(t('patientFeat1d'))}</span></li>
            <li><strong>${esc(t('patientFeat2'))}</strong><span>${esc(t('patientFeat2d'))}</span></li>
            <li><strong>${esc(t('patientFeat3'))}</strong><span>${esc(t('patientFeat3d'))}</span></li>
            <li><strong>${esc(t('patientFeat4'))}</strong><span>${esc(t('patientFeat4d'))}</span></li>
          </ul>
          <button type="button" class="linklike" id="learn-more">${esc(t('learnMore'))} ▾</button>
        </div>
        <div class="patient-learn" id="patient-learn" hidden>
          <ol class="learn-list">
            <li><strong>${esc(t('learnStep1'))}</strong><span>${esc(t('learnStep1d'))}</span></li>
            <li><strong>${esc(t('learnStep2'))}</strong><span>${esc(t('learnStep2d'))}</span></li>
            <li><strong>${esc(t('learnStep3'))}</strong><span>${esc(t('learnStep3d'))}</span></li>
            <li><strong>${esc(t('learnStep4'))}</strong><span>${esc(t('learnStep4d'))}</span></li>
            <li><strong>${esc(t('learnStep5'))}</strong><span>${esc(t('learnStep5d'))}</span></li>
          </ol>
        </div>
        <h3>${esc(t('register'))}</h3>
        ${field(t('firstName'), input('pFirstName', 'text', '', 'required autocomplete="given-name"'))}
        ${field(t('lastName'), input('pLastName', 'text', '', 'required autocomplete="family-name"'))}
        ${field(t('phone'), input('pRegPhone', 'tel', '', 'required autocomplete="tel" placeholder="+961…"'))}
        ${field(t('pin6'), input('pRegPin', 'password', '', 'required inputmode="numeric" minlength="6" maxlength="12" autocomplete="new-password"'))}
        ${field(t('dateOfBirth'), input('pDob', 'date', ''))}
        <button class="primary" type="submit">${esc(t('createHealthAccount'))}</button>
        <p class="form-error" id="patient-error" hidden></p>
        <p><button type="button" class="linklike" id="back-login-2">← ${esc(t('backToLogin'))}</button></p>
      </form>
      <div id="auth-links" class="auth-links">
        <button type="button" class="linklike" id="link-clinic">${esc(t('registerClinicCta'))}</button>
        <span class="muted">·</span>
        <button type="button" class="linklike" id="link-doctor">${esc(t('joinDoctorCta'))}</button>
        <span class="muted">·</span>
        <button type="button" class="linklike" id="link-patient">${esc(t('registerPatientCta'))}</button>
      </div>
      <p class="form-error" id="login-error" hidden></p>
    </section>`;

  const showView = (name: 'smart' | 'clinic' | 'doctor' | 'patient'): void => {
    (document.getElementById('fb-smart') as HTMLFormElement).hidden = name !== 'smart';
    (document.getElementById('fb-up') as HTMLFormElement).hidden = name !== 'clinic';
    (document.getElementById('fb-doctor') as HTMLFormElement).hidden = name !== 'doctor';
    (document.getElementById('fb-patient') as HTMLFormElement).hidden = name !== 'patient';
    (document.getElementById('auth-links') as HTMLElement).hidden = name !== 'smart';
  };

  const showError = (error: unknown): void => {
    const errorEl = document.getElementById('login-error') as HTMLElement;
    errorEl.hidden = false;
    errorEl.textContent = t('loginFailed');
    toast(errorText(error), 'error');
  };

  // Firebase mode is self-sufficient: Firestore rules authorise directly off
  // the Firebase session, so there is no second login and no second account.
  const goHome = (): void => {
    // Cache the reseller flag before routing so the Admin tab paints
    // on first load, then go home regardless of the outcome.
    // A staff sign-in also drops any patient session on this device so the
    // router never mistakes the doctor for a patient afterwards.
    void import('../patientAuth.js')
      .then((pa) => pa.clearFbPatientSession())
      .catch(() => undefined)
      .finally(() => fb.refreshResellerFlag().catch(() => undefined))
      .finally(() => {
        // Publish my directory card (Firebase mode, best-effort).
        if (fb.isFirebaseConfigured()) {
          void import('../data.js')
            .then((d) => d.fbSyncDirectory().catch(() => undefined))
            .catch(() => undefined);
        }
      })
      .finally(() => {
        window.location.hash = '#/';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
  };

  (document.getElementById('link-clinic') as HTMLButtonElement).addEventListener('click', () => showView('clinic'));
  (document.getElementById('link-doctor') as HTMLButtonElement).addEventListener('click', () => showView('doctor'));
  (document.getElementById('link-patient') as HTMLButtonElement).addEventListener('click', () => showView('patient'));
  (document.getElementById('back-login-1') as HTMLButtonElement).addEventListener('click', () => showView('smart'));
  (document.getElementById('back-login-2') as HTMLButtonElement).addEventListener('click', () => showView('smart'));
  (document.getElementById('back-login-3') as HTMLButtonElement).addEventListener('click', () => showView('smart'));
  (document.getElementById('learn-more') as HTMLButtonElement).addEventListener('click', (event) => {
    const details = document.getElementById('patient-learn') as HTMLElement;
    details.hidden = !details.hidden;
    (event.target as HTMLButtonElement).innerHTML = `${esc(t('learnMore'))} ${details.hidden ? '▾' : '▴'}`;
  });

  const showPatientError = (message: string): void => {
    const errorEl = document.getElementById('patient-error') as HTMLElement;
    errorEl.hidden = false;
    errorEl.textContent = message;
  };

  const goPatientHome = (): void => {
    window.location.hash = '#/my';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  // Smart login: an email signs in as staff, a phone number as a patient.
  (document.getElementById('fb-smart') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const identifier = String(data.get('identifier') ?? '').trim();
    const secret = String(data.get('secret') ?? '');
    if (identifier.includes('@')) {
      fb.signInDoctor(identifier, secret)
        .then(() => goHome())
        .catch(showError);
      return;
    }
    // patientAuth is lazy so the Firebase SDK never loads for staff-only use.
    void import('../patientAuth.js')
      .then((pa) => pa.signInFbPatient(identifier, secret))
      .then(() => goPatientHome())
      .catch(showError);
  });

  (document.getElementById('fb-patient') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    // patientAuth is lazy so the Firebase SDK never loads for staff-only use.
    void import('../patientAuth.js')
      .then((pa) =>
        pa.registerFbPatient({
          firstName: String(data.get('pFirstName') ?? ''),
          lastName: String(data.get('pLastName') ?? ''),
          phone: String(data.get('pRegPhone') ?? ''),
          pin: String(data.get('pRegPin') ?? ''),
          dateOfBirth: String(data.get('pDob') ?? '').trim() || null,
        }),
      )
      .then(() => goPatientHome())
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : '';
        if (message === 'registered') showPatientError(t('patientExistsHint'));
        else showPatientError(errorText(error));
      });
  });

  (document.getElementById('fb-up') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    fb.signUpDoctor({
      name: String(data.get('name') ?? ''),
      clinicName: String(data.get('clinicName') ?? ''),
      email: String(data.get('email') ?? ''),
      password: String(data.get('password') ?? ''),
      activationCode: String(data.get('activationCode') ?? ''),
    })
      .then(() => goHome())
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === 'activation') {
          const errorEl = document.getElementById('login-error') as HTMLElement;
          errorEl.hidden = false;
          errorEl.textContent = t('badActivationCode');
          toast(t('badActivationCode'), 'error');
          return;
        }
        showError(error);
      });
  });

  (document.getElementById('fb-doctor') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    fb.signUpDoctorWithInvite({
      name: String(data.get('dName') ?? ''),
      email: String(data.get('dEmail') ?? ''),
      password: String(data.get('dPassword') ?? ''),
      inviteCode: String(data.get('inviteCode') ?? ''),
    })
      .then(() => goHome())
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === 'invite') {
          const errorEl = document.getElementById('login-error') as HTMLElement;
          errorEl.hidden = false;
          errorEl.textContent = t('badInviteCode');
          toast(t('badInviteCode'), 'error');
          return;
        }
        showError(error);
      });
  });
}

/** Local-development login against the API directly (no Firebase project). */
function renderApiLogin(root: HTMLElement): void {
  const ar = getLang() === 'ar';
  root.innerHTML = `
    <section class="card auth">
      ${authHero()}
      <div class="row" role="tablist">
        <button id="tab-staff" class="primary">${esc(t('staff'))}</button>
        <button id="tab-patient">${esc(t('patient'))}</button>
        <button id="tab-register">${esc(t('register'))}</button>
      </div>
      <form id="login-form">
        ${field(t('email'), input('email', 'email', '', 'required autocomplete="username"'))}
        ${field(t('password'), input('password', 'password', '', 'required autocomplete="current-password"'))}
        <button class="primary" type="submit">${esc(t('login'))}</button>
        <p class="form-error" id="login-error" hidden></p>
      </form>
      <p class="muted">${esc(t('newPractice'))} <a href="#/join">${esc(t('joinAs'))}</a></p>
      <form id="patient-form" hidden>
        <p class="muted">${esc(t('patientLoginHint'))}</p>
        ${field(t('phone'), input('phone', 'tel', '', 'required autocomplete="tel" placeholder="+961…"'))}
        ${field(t('code'), input('code', 'text', '', 'required inputmode="numeric" minlength="6" maxlength="6"'))}
        <button class="primary" type="submit">${esc(t('signInAsPatient'))}</button>
        <p class="form-error" id="patient-error" hidden></p>
      </form>
      <form id="register-form" hidden>
        <p class="muted">${esc(t('registerHint'))}</p>
        ${field(t('firstName'), input('firstName', 'text', '', 'required autocomplete="given-name"'))}
        ${field(t('lastName'), input('lastName', 'text', '', 'required autocomplete="family-name"'))}
        ${field(t('phone'), input('regPhone', 'tel', '', 'required autocomplete="tel" placeholder="+961…"'))}
        ${field(t('pin6'), input('regCode', 'text', '', 'required inputmode="numeric" minlength="6" maxlength="6"'))}
        ${field(t('dateOfBirth'), input('dateOfBirth', 'date', ''))}
        ${field(t('address'), input('address', 'text', ''))}
        ${field(t('bloodGroup'), input('bloodGroup', 'text', '', ar ? 'placeholder="مثال: +A"' : 'placeholder="A+"'))}
        <button class="primary" type="submit">${esc(t('createHealthAccount'))}</button>
        <p class="form-error" id="register-error" hidden></p>
      </form>
    </section>`;

  const showTab = (name: 'staff' | 'patient' | 'register'): void => {
    (document.getElementById('login-form') as HTMLFormElement).hidden = name !== 'staff';
    (document.getElementById('patient-form') as HTMLFormElement).hidden = name !== 'patient';
    (document.getElementById('register-form') as HTMLFormElement).hidden = name !== 'register';
  };
  (document.getElementById('tab-staff') as HTMLButtonElement).addEventListener('click', () => showTab('staff'));
  (document.getElementById('tab-patient') as HTMLButtonElement).addEventListener('click', () => showTab('patient'));
  (document.getElementById('tab-register') as HTMLButtonElement).addEventListener('click', () => showTab('register'));

  const form = document.getElementById('login-form') as HTMLFormElement;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const email = String(data.get('email') ?? '');
    const password = String(data.get('password') ?? '');
    const errorEl = document.getElementById('login-error') as HTMLElement;
    loginRequest(email, password)
      .then(({ token, user }) => {
        setSession(token, user);
        window.location.hash = '#/';
      })
      .catch((error: unknown) => {
        errorEl.hidden = false;
        errorEl.textContent = t('loginFailed');
        toast(errorText(error), 'error');
      });
  });

  (document.getElementById('patient-form') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const errorEl = document.getElementById('patient-error') as HTMLElement;
    const phone = String(data.get('phone') ?? '');
    const code = String(data.get('code') ?? '');
    // Network PIN first (one identity everywhere), clinic code as fallback.
    networkPatientLogin(phone, code)
      .catch(() => patientLogin(phone, code))
      .then(() => {
        window.location.hash = '#/my';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      })
      .catch((error: unknown) => {
        errorEl.hidden = false;
        errorEl.textContent = errorText(error);
      });
  });

  (document.getElementById('register-form') as HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const errorEl = document.getElementById('register-error') as HTMLElement;
    const text = (k: string): string | null => {
      const v = String(data.get(k) ?? '').trim();
      return v ? v : null;
    };
    networkRegister({
      phone: String(data.get('regPhone') ?? ''),
      firstName: String(data.get('firstName') ?? ''),
      lastName: String(data.get('lastName') ?? ''),
      code: String(data.get('regCode') ?? ''),
      dateOfBirth: text('dateOfBirth'),
      address: text('address'),
      bloodGroup: text('bloodGroup'),
    })
      .then(() =>
        networkPatientLogin(String(data.get('regPhone') ?? ''), String(data.get('regCode') ?? '')),
      )
      .then(() => {
        window.location.hash = '#/my';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      })
      .catch((error: unknown) => {
        errorEl.hidden = false;
        errorEl.textContent = errorText(error);
      });
  });
}
