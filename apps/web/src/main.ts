import { clearSession, getToken, getUser, readQueue, syncQueue } from './api.js';
import { staffMe } from './data.js';
import { clearPatientToken, getPatientToken } from './data.js';
import { renderPatientHome } from './views/patientHome.js';
import { applyLang, getLang, setLang, t, tx, type StringKey } from './i18n.js';
import { esc, errorText, toast } from './ui.js';
import { installClientLogging } from './log.js';
import { renderLogin } from './views/login.js';
import { renderForgotPassword, renderResetPassword } from './views/passwordReset.js';
import { renderJoin, renderOnboarding } from './views/join.js';
import { renderDashboard } from './views/dashboard.js';
import { renderCalendar } from './views/calendar.js';
import { renderPatientDetail, renderPatients } from './views/patients.js';
import { renderScanner } from './views/scanner.js';
import { checkinHtml } from './views/qrCheckin.js';
import { renderRecall } from './views/recall.js';
import { renderFinance } from './views/finance.js';
import { renderInsurers } from './views/insurers.js';
import { renderTeam } from './views/team.js';
import { renderClinic } from './views/clinic.js';
import { renderAdmin } from './views/admin.js';
import { renderMyCard } from './views/mycard.js';
import { renderWhatsapp } from './views/whatsapp.js';
import { renderReview } from './views/review.js';
import './styles.css';

interface NavItem {
  hash: string;
  label: StringKey;
}

const NAV: NavItem[] = [
  { hash: '#/', label: 'dashboard' },
  { hash: '#/calendar', label: 'calendar' },
  { hash: '#/patients', label: 'patients' },
  { hash: '#/scanner', label: 'scanner' },
  { hash: '#/checkin', label: 'patientQr' },
  { hash: '#/finance', label: 'finance' },
  { hash: '#/insurers', label: 'insurers' },
  { hash: '#/team', label: 'team' },
  { hash: '#/whatsapp', label: 'whatsapp' },
  { hash: '#/recall', label: 'recall' },
];

/** The patient app is a different world: its own tabs, none of the staff's. */
const PATIENT_NAV: NavItem[] = [
  { hash: '#/my', label: 'myHealth' },
  { hash: '#/my/doctors', label: 'doctors' },
  { hash: '#/my/appointments', label: 'myAppointmentsTab' },
  { hash: '#/my/meds', label: 'myMedsTab' },
  { hash: '#/my/profile', label: 'myProfile' },
];

/** Firebase patient app: file, health, doctors, appointments, meds - each on its own hash. */
const FB_PATIENT_NAV: NavItem[] = [
  { hash: '#/my/profile', label: 'myProfile' },
  { hash: '#/my/health', label: 'myHealth' },
  { hash: '#/my/doctors', label: 'doctors' },
  { hash: '#/my/appointments', label: 'myAppointmentsTab' },
  { hash: '#/my/meds', label: 'myMedsTab' },
];

export function isPatientMode(): boolean {
  if (getToken()) return false;
  if (getPatientToken() !== null) return true;
  // Firebase-native patient session (no API token involved).
  try {
    return localStorage.getItem('mf_patient_fb') !== null;
  } catch {
    return false;
  }
}

/** Firebase patient app: health + profile only (no cross-clinic directory yet). */
export function isFirebasePatientMode(): boolean {
  if (getToken() || getPatientToken() !== null) return false;
  try {
    return localStorage.getItem('mf_patient_fb') !== null;
  } catch {
    return false;
  }
}

export type Theme = 'dark' | 'light';

export function getTheme(): Theme {
  return localStorage.getItem('mf_theme') === 'light' ? 'light' : 'dark';
}

export function applyTheme(): void {
  document.body.dataset.theme = getTheme();
  const button = document.getElementById('theme-toggle');
  if (button) button.textContent = getTheme() === 'dark' ? '☀️' : '🌙';
}

function shell(): void {
  const app = document.getElementById('app') as HTMLElement;
  app.innerHTML = `
    <header class="topbar">
      <span class="brand">${esc(t('appName'))}</span>
      <span id="net-badge" class="pill"></span>
      <span class="spacer"></span>
      <button id="theme-toggle" class="ghost" title="theme">🌙</button>
      <button id="lang-toggle" class="ghost">${esc(t('language'))}</button>
      <button id="logout" class="ghost">${esc(t('logout'))}</button>
    </header>
    <nav class="nav" id="nav"></nav>
    <div id="sync-banner" class="sync-banner" hidden></div>
    <main id="view"></main>
    <div id="credit" class="credit no-print"><span class="credit-mark">✦</span><span class="credit-by">Designed &amp; crafted by</span> <strong class="credit-name">Mohammad Ballouk</strong><span class="credit-mark">✦</span></div>
    <div id="toasts" aria-live="polite"></div>`;
  applyTheme();

  const paintNet = (): void => {
    const badge = document.getElementById('net-badge') as HTMLElement;
    const queue = readQueue();
    const pending = queue.length;
    badge.textContent = navigator.onLine ? `${t('online')}${pending > 0 ? ` (${pending})` : ''}` : t('offline');
    badge.classList.toggle('danger', !navigator.onLine || pending > 0);
    // Offline / pending-sync banner: cross-clinic bookings queued while
    // offline are the ones staff worry about missing, so call them out.
    const banner = document.getElementById('sync-banner') as HTMLElement;
    if (!navigator.onLine || pending > 0) {
      const crossClinic = queue.filter((q) => q.path.includes('appointments') || q.path.includes('network') || q.path.includes('patient')).length;
      banner.hidden = false;
      banner.innerHTML =
        `<strong>${esc(tx('offlineBanner', { n: pending }))}</strong>` +
        (crossClinic > 0 || !navigator.onLine ? `<span class="muted"> ${esc(t('offlineBookingsHint'))}</span>` : '');
    } else {
      banner.hidden = true;
      banner.innerHTML = '';
    }
  };
  paintNet();
  window.addEventListener('online', () => {
    paintNet();
    syncQueue()
      .then(({ done }) => {
        if (done > 0) toast(tx('syncedOk', { n: done }));
        paintNet();
      })
      .catch(() => undefined);
  });
  window.addEventListener('offline', paintNet);
  window.addEventListener('mf:queue-changed', paintNet);

  (document.getElementById('lang-toggle') as HTMLButtonElement).addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'ar' : 'en');
    shell();
    route();
  });
  (document.getElementById('theme-toggle') as HTMLButtonElement).addEventListener('click', () => {
    localStorage.setItem('mf_theme', getTheme() === 'dark' ? 'light' : 'dark');
    applyTheme();
  });
  (document.getElementById('logout') as HTMLButtonElement).addEventListener('click', () => {
    // Local sessions die first so routing never sees a stale login.
    clearSession();
    clearPatientToken();
    try {
      localStorage.removeItem('mf_patient_fb');
      localStorage.removeItem('mf_reseller');
    } catch {
      // Never block sign-out on storage.
    }
    // Firebase mode signs out of Firebase Auth; API mode already dropped JWT.
    void import('./firebase.js').then((fb) => {
      if (fb.isFirebaseConfigured()) {
        fb.signOutDoctor().catch(() => undefined);
        fb.clearResellerFlag();
      }
      window.location.hash = '#/login';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
  });
}

function paintNav(): void {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const current = window.location.hash || '#/';
  // The login and reset screens stand alone: no tabs for a visitor without a
  // session.
  if (current.startsWith('#/login') || current.startsWith('#/password-reset')) {
    nav.innerHTML = '';
    nav.style.display = 'none';
    return;
  }
  nav.style.display = '';
  // Patients never see staff tabs: different app, different nav.
  if (isPatientMode()) {
    const tabs = isFirebasePatientMode() ? FB_PATIENT_NAV : PATIENT_NAV;
    nav.innerHTML = tabs.map((item) => navLink(item, current)).join('');
    return;
  }
  // Owners configure their practice; the reseller additionally runs the
  // whole marketplace from the Admin console (API session, or the cached
  // Firebase flag - the SDK stays lazy-loaded, so this reads localStorage).
  const me = getUser<{ role?: string; isReseller?: boolean }>();
  let firebaseReseller = false;
  try {
    firebaseReseller = localStorage.getItem('mf_reseller') === '1';
  } catch {
    firebaseReseller = false;
  }
  const items = [...NAV];
  if (me?.role === 'owner') {
    items.push({ hash: '#/clinic', label: 'clinic' });
  }
  if (me?.isReseller === true || firebaseReseller) {
    items.push({ hash: '#/admin', label: 'admin' });
  }
  // "My card" (photo + map pin) exists only in Firebase staff mode.
  try {
    if (localStorage.getItem('mf_fbmode') === '1') items.push({ hash: '#/mycard', label: 'myCard' });
  } catch {
    // Ignore storage failures; the tab just stays hidden.
  }
  nav.innerHTML = items.map((item) => navLink(item, current)).join('');
}

function navLink(item: NavItem, current: string): string {
  // Exact match or a real sub-path ('#/my' must not light up on '#/mycard').
  const active = current === item.hash || (item.hash !== '#/' && current.startsWith(`${item.hash}/`));
  return `<a href="${item.hash}" class="${active ? 'active' : ''}">${esc(t(item.label))}</a>`;
}

function route(): void {
  const root = document.getElementById('view') as HTMLElement;
  const hash = window.location.hash || '#/';
  paintNav();
  document.body.dataset.page =
    hash.startsWith('#/login') || hash.startsWith('#/password-reset') ? 'login' : 'app';

  // Session check is backend-aware: a Firebase build trusts the Firebase
  // session (Firestore rules authorise from it), a local build the API JWT.
  // The patient app is a separate fenced area on its own token.
  void import('./firebase.js').then((fb) => {
    try {
      localStorage.setItem('mf_fbmode', fb.isFirebaseConfigured() ? '1' : '0');
    } catch {
      // Ignore storage failures.
    }
    // The mode flag is fresh only now - repaint so mode-gated tabs
    // ("My card", reseller console) appear on first load, not second click.
    paintNav();
    if (fb.isFirebaseConfigured()) {
      // Firebase patient app first: anonymous Auth + PIN-derived account.
      // Staff (email Auth) always take the staff flow below.
      // NOTE: '#/mycard' starts with '#/my' as a string - match the patient
      // area only on exact '#/my' or '#/my/...' so staff pages never fall in.
      if (hash === '#/my' || hash.startsWith('#/my/')) {
        if (!isFirebasePatientMode()) {
          window.location.hash = '#/login';
          return;
        }
        document.body.dataset.mode = 'patient';
        // Each tab owns its hash: profile (file), health (records), doctors.
        // Bare #/my lands on the file first, once, via redirect.
        if (hash === '#/my' || hash === '#/my/') {
          window.location.hash = '#/my/profile';
          return;
        }
        if (hash.startsWith('#/my/doctors')) renderPatientHome(root, 'doctors');
        else if (hash.startsWith('#/my/health')) renderPatientHome(root, 'health');
        else if (hash.startsWith('#/my/appointments')) renderPatientHome(root, 'appointments');
        else if (hash.startsWith('#/my/meds')) renderPatientHome(root, 'meds');
        else if (hash.startsWith('#/my/profile')) renderPatientHome(root, 'profile');
        else renderPatientHome(root, 'profile');
        return;
      }
      void fb.firebaseUser().then((user) => {
        if (isFirebasePatientMode() && (!user || user.isAnonymous)) {
          window.location.hash = '#/my';
          return;
        }
        routeFor(hash, root, user !== null && !user.isAnonymous);
      });
      return;
    }
    if (hash === '#/my' || hash.startsWith('#/my/')) {
      if (!getPatientToken()) {
        window.location.hash = '#/login';
        return;
      }
      document.body.dataset.mode = 'patient';
      if (hash.startsWith('#/my/doctors')) renderPatientHome(root, 'doctors');
      else if (hash.startsWith('#/my/appointments')) renderPatientHome(root, 'appointments');
      else if (hash.startsWith('#/my/meds')) renderPatientHome(root, 'meds');
      else if (hash.startsWith('#/my/profile')) renderPatientHome(root, 'profile');
      else renderPatientHome(root, 'health');
      return;
    }
    if (getPatientToken() && !getToken()) {
      // A signed-in patient landing anywhere else belongs at home.
      window.location.hash = '#/my';
      return;
    }
    routeFor(hash, root, getToken() !== null);
  });
}

function routeFor(hash: string, root: HTMLElement, signedIn: boolean): void {
  document.body.dataset.mode = 'staff';
  if (!signedIn) {
    if (hash === '#/join') {
      renderJoin(root);
      return;
    }
    // Public by necessity: a locked-out owner is not signed in, which is the
    // whole reason the reset link exists. Checked before the login redirect
    // below, or the token would be thrown away on arrival.
    if (hash === '#/password-reset') {
      renderForgotPassword(root);
      return;
    }
    if (hash.startsWith('#/password-reset?')) {
      const token = new URLSearchParams(hash.split('?')[1] ?? '').get('token') ?? '';
      renderResetPassword(root, token);
      return;
    }
    if (hash !== '#/login') window.location.hash = '#/login';
    renderLogin(root);
    return;
  }
  if (hash === '#/login') {
    window.location.hash = '#/';
    return;
  }
  // First login finishes the profile before anything else. The flag caches
  // the check for the session; saving clears it.
  if (hash !== '#/onboarding' && localStorage.getItem('mf_profile_ok') !== '1') {
    staffMe()
      .then((me) => {
        if (me.profileComplete) {
          localStorage.setItem('mf_profile_ok', '1');
          routeFor(window.location.hash || '#/', root, true);
        } else if ((window.location.hash || '#/') !== '#/onboarding') {
          window.location.hash = '#/onboarding';
        } else {
          renderOnboarding(root);
        }
      })
      .catch(() => routeStaff(hash, root));
    return;
  }
  if (hash === '#/onboarding') {
    renderOnboarding(root);
    return;
  }
  // Pending-send badge on the WhatsApp tab (best-effort, advisory only).
  void import('./views/whatsapp.js')
    .then((m) => m.refreshWhatsappBadge())
    .catch(() => undefined);
  routeStaff(hash, root);
}

function routeStaff(hash: string, root: HTMLElement): void {

  const user = getUser();
  void user;

  // The Admin console is reseller-only in both modes: typing the URL must
  // not bypass the hidden nav tab.
  if (hash.startsWith('#/admin')) {
    const apiReseller = (getUser<{ isReseller?: boolean }>()?.isReseller ?? false) === true;
    let firebaseReseller = false;
    try {
      firebaseReseller = localStorage.getItem('mf_reseller') === '1';
    } catch {
      firebaseReseller = false;
    }
    if (!apiReseller && !firebaseReseller) {
      window.location.hash = '#/';
      renderDashboard(root);
      return;
    }
  }

  if (hash === '#/' || hash === '') renderDashboard(root);
  else if (hash.startsWith('#/calendar')) renderCalendar(root);
  else if (hash.startsWith('#/patients/')) {
    const rest = decodeURIComponent(hash.slice('#/patients/'.length));
    const [id = '', tab = ''] = rest.split('/');
    renderPatientDetail(
      root,
      id,
      tab === 'visits'
        ? 'visits'
        : tab === 'vitals'
          ? 'vitals'
          : tab === 'treatment'
            ? 'treatment'
            : tab === 'shared'
              ? 'shared'
              : tab === 'timeline'
                ? 'timeline'
                : 'overview',
    );
  } else if (hash.startsWith('#/patients')) renderPatients(root, (h) => (window.location.hash = h));
  else if (hash.startsWith('#/scanner')) renderScanner(root);
  else if (hash.startsWith('#/checkin')) checkinHtml(root);
  else if (hash.startsWith('#/recall')) renderRecall(root);
  else if (hash.startsWith('#/finance')) renderFinance(root);
  else if (hash.startsWith('#/insurers')) renderInsurers(root);
  else if (hash.startsWith('#/team')) renderTeam(root);
  else if (hash.startsWith('#/clinic')) renderClinic(root);
  else if (hash.startsWith('#/admin')) renderAdmin(root);
  else if (hash.startsWith('#/mycard')) renderMyCard(root);
  else if (hash.startsWith('#/whatsapp')) renderWhatsapp(root);
  else if (hash.startsWith('#/review/')) renderReview(root, decodeURIComponent(hash.slice('#/review/'.length)));
  else renderDashboard(root);
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

applyLang();
installClientLogging();
shell();
window.addEventListener('hashchange', route);

/** Post-gate entry: cache flags, republish directory, then route. */
function enterApp(fb: typeof import('./firebase.js')): void {
  void fb
    .refreshResellerFlag()
    .catch(() => undefined)
    .finally(() => {
      // Keep my directory card published (best-effort).
      void import('./data.js')
        .then((d) => d.fbSyncDirectory().catch(() => undefined))
        .catch(() => undefined);
    })
    .finally(() => route());
}

// Licence gate, same pattern as the POS fleet: the reseller writes
// config/appStatus in the customer's Firebase project, and a suspended
// licence locks the whole app on its next online boot. Firebase is
// lazy-loaded so unconfigured builds never download the SDK.
import('./firebase.js')
  .then((fb) => {
    if (!fb.isFirebaseConfigured()) {
      route();
      return;
    }
    fb.readAppStatus()
      .then((status) => {
        if (status.status === 'suspended') {
          const root = document.getElementById('view') as HTMLElement;
          root.innerHTML = `<section class="card auth"><h1>${esc(t('appName'))}</h1><p class="warning">${esc(status.message || 'This licence is suspended. Contact support.')}</p></section>`;
          window.addEventListener('hashchange', (event) => event.stopImmediatePropagation(), true);
        } else {
          // Unverified emails wait here: nothing inside trusts the address yet.
          fb.firebaseUser()
            .then((user) => {
              if (!user) {
                route();
                return;
              }
              // Anonymous sessions belong to the patient app, never to the
              // staff email gate: let the patient router decide.
              if (user.isAnonymous) {
                route();
                return;
              }
              // Staff doc first: status/disabled gates apply to everyone, and
              // trial accounts skip the email-verification gate entirely.
              fb.readStaffDoc(user.uid)
                .then((staff) => {
                  if (staff && (staff.status ?? 'active') !== 'active') {
                    renderPendingGate();
                    return;
                  }
                  if (staff?.disabled === true) {
                    renderDisabledGate();
                    return;
                  }
                  const enterIfClinicOk = (): void => {
                    if (!staff) {
                      enterApp(fb);
                      return;
                    }
                    fb.readClinicDoc(staff.clinicId)
                      .then((clinic) => {
                        if (clinic?.disabled === true) {
                          renderDisabledGate();
                          return;
                        }
                        enterApp(fb);
                      })
                      .catch(() => enterApp(fb));
                  };
                  if (staff?.trial === true) {
                    enterIfClinicOk();
                    return;
                  }
                  void fb.isEmailVerified().then((verified) => {
                    if (!verified) {
                      renderVerifyGate();
                      return;
                    }
                    enterIfClinicOk();
                  });
                })
                .catch(() => route());
            })
            .catch(() => route());
        }
      })
      .catch(() => route());
  })
  .catch(() => route());
registerServiceWorker();

function renderVerifyGate(): void {
  const root = document.getElementById('view') as HTMLElement;
  root.innerHTML = `<section class="card auth">
    <h1>${esc(t('checkInbox'))}</h1>
    <p class="muted">${esc(t('verifyEmailHint'))}</p>
    <div class="row"><button id="verify-done" class="primary">${esc(t('verifiedContinue'))}</button><button id="verify-resend">${esc(t('resendEmail'))}</button></div>
  </section>`;
  void import('./firebase.js').then((fb) => {
    (document.getElementById('verify-done') as HTMLButtonElement).addEventListener('click', () => {
      fb.isEmailVerified()
        .then((verified) => {
          if (verified) {
            window.location.hash = '#/';
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          } else {
            toast(t('notVerifiedYet'));
          }
        })
        .catch((error: unknown) => toast(errorText(error), 'error'));
    });
    (document.getElementById('verify-resend') as HTMLButtonElement).addEventListener('click', () => {
      fb.resendVerification()
        .then(() => toast(t('verificationResent')))
        .catch((error: unknown) => toast(errorText(error), 'error'));
    });
  });
}

function renderPendingGate(): void {
  const root = document.getElementById('view') as HTMLElement;
  root.innerHTML = `<section class="card auth">
    <h1>${esc(t('pendingApproval'))}</h1>
    <p class="muted">${esc(t('pendingApprovalHint'))}</p>
    <p><a class="button" href="#/login">${esc(t('backToSignIn'))}</a></p>
  </section>`;
  window.addEventListener('hashchange', (event) => event.stopImmediatePropagation(), true);
}

/** Reseller-disabled account or clinic: locked out everywhere, no data. */
function renderDisabledGate(): void {
  const root = document.getElementById('view') as HTMLElement;
  root.innerHTML = `<section class="card auth">
    <h1>${esc(t('disabledWord'))}</h1>
    <p class="warning">${esc(t('disabledGate'))}</p>
    <p><a class="button" href="#/login">${esc(t('backToSignIn'))}</a></p>
  </section>`;
  window.addEventListener('hashchange', (event) => event.stopImmediatePropagation(), true);
}
