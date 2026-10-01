import { fbClinicLocation, fbCreateDoctorInvite, fbGetBookingSettings, fbListMyInvites, fbMyDirectoryEntry, fbMyWorkingHours, fbPublishAvailability, fbRevokeDoctorInvite, fbSaveBookingSettings, fbSaveClinicLocation, fbSaveMyDirectoryDetails, fbSaveMyWorkingHours, fbUploadDirectoryPhoto, isFirebaseMode } from '../data.js';
import { SPECIALTY_LABELS } from '@mediflow/shared';
import { errorText, esc, field, input, toast } from '../ui.js';
import { specialtyLabel, t, weekdayLabel } from '../i18n.js';

/**
 * "My public card" (Firebase staff): directory photo + clinic map pin.
 * The photo shows on the patient's doctor cards; the pin opens the phone's
 * maps app from the patient directory. Only meaningful in Firebase mode.
 */

interface LeafletLatLng {
  lat: number;
  lng: number;
}

interface LeafletMap {
  setView(center: [number, number], zoom: number): LeafletMap;
  on(event: 'click', handler: (e: { latlng: LeafletLatLng }) => void): void;
  remove(): void;
}

interface LeafletMarker {
  setLatLng(center: [number, number]): LeafletMarker;
}

interface LeafletStatic {
  map(id: string): LeafletMap;
  tileLayer(url: string, options: Record<string, unknown>): { addTo(map: LeafletMap): void };
  marker(center: [number, number]): LeafletMarker & { addTo(map: LeafletMap): LeafletMarker };
}

declare global {
  interface Window {
    L?: LeafletStatic;
  }
}

const BEIRUT: [number, number] = [33.8938, 35.5018];

let leafletPromise: Promise<LeafletStatic> | null = null;

function loadLeaflet(): Promise<LeafletStatic> {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => {
      if (window.L) resolve(window.L);
      else reject(new Error('Map library failed to load.'));
    };
    script.onerror = () => reject(new Error('Map library failed to load.'));
    document.head.appendChild(script);
  });
  return leafletPromise;
}

export function renderMyCard(root: HTMLElement): void {
  root.innerHTML = `
    <section class="card collapsible">
      <h2><button class="collapse-toggle" aria-expanded="true"><span class="chev">▾</span> ${esc(t('myPublicCard'))}</button></h2>
      <div class="collapse-body">
      <p class="muted">${esc(t('myPublicCardHint'))}</p>
      <div id="mycard-body"><p class="muted">${esc(t('loading'))}</p></div>
      </div>
    </section>
    <section class="card collapsible" id="invite-section" hidden>
      <h2><button class="collapse-toggle" aria-expanded="true"><span class="chev">▾</span> ${esc(t('inviteDoctor'))}</button></h2>
      <div class="collapse-body">
      <p class="muted">${esc(t('inviteDoctorHint'))}</p>
      <div class="row"><button id="invite-new" class="primary">${esc(t('newInvite'))}</button></div>
      <div id="invite-list"><p class="muted">${esc(t('loading'))}</p></div>
      </div>
    </section>
    <section class="card collapsible">
      <h2><button class="collapse-toggle" aria-expanded="true"><span class="chev">▾</span> ${esc(t('workingHours'))}</button></h2>
      <div class="collapse-body">
      <p class="muted">${esc(t('workingHoursHint'))}</p>
      <div id="hours-body"><p class="muted">${esc(t('loading'))}</p></div>
      </div>
    </section>
    <section class="card collapsible">
      <h2><button class="collapse-toggle" aria-expanded="true"><span class="chev">▾</span> ${esc(t('bookingSettings'))}</button></h2>
      <div class="collapse-body">
      <p class="muted">${esc(t('bookingSettingsHint'))}</p>
      <div id="booking-body"><p class="muted">${esc(t('loading'))}</p></div>
      </div>
    </section>
    <section class="card collapsible">
      <h2><button class="collapse-toggle" aria-expanded="true"><span class="chev">▾</span> ${esc(t('clinicLocation'))}</button></h2>
      <div class="collapse-body">
      <p class="muted">${esc(t('clinicLocationHint'))}</p>
      <div id="map-pick" class="map-pick"><p class="muted">${esc(t('loading'))}</p></div>
      <div class="row">
        <button id="loc-gps">${esc(t('useMyLocation'))}</button>
        <button id="loc-save" class="primary" disabled>${esc(t('saveLocation'))}</button>
        <span id="loc-out" class="muted" dir="ltr"></span>
      </div>
      </div>
    </section>`;

  root.querySelectorAll<HTMLButtonElement>('.collapse-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const section = toggle.closest('section');
      if (!section) return;
      const collapsed = section.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  });

  void isFirebaseMode().then((fbMode) => {
    if (!fbMode) {
      (document.getElementById('mycard-body') as HTMLElement).innerHTML =
        `<p class="muted">${esc(t('firebaseOnly'))}</p>`;
      return;
    }
    loadCard();
    loadMap();
    loadHours();
    loadBookingSettings();
    // Heal old clinics: if hours were saved before auto-publish existed,
    // opening this page republishes slots so patients stop seeing "no times".
    void fbPublishAvailability();
    // Doctor invites are an owner power: anyone else never sees the section.
    void import('../firebase.js').then((fb) => {
      if (fb.cachedRole() !== 'owner') return;
      (document.getElementById('invite-section') as HTMLElement).hidden = false;
      loadInvites();
    });
  });

  function loadInvites(): void {
    fbListMyInvites()
      .then((items) => {
        const host = document.getElementById('invite-list') as HTMLElement;
        host.innerHTML =
          (items.length > 0
            ? `<ul class="list">${items
                .map(
                  (i) => `<li><strong dir="ltr">${esc(i.code)}</strong>
                    ${i.usedBy ? `<span class="pill ok">${esc(t('inviteUsed'))}</span>` : `<span class="pill warn">${esc(t('inviteFresh'))}</span>`}
                    <button data-revoke="${esc(i.code)}">${esc(t('revokeInvite'))}</button></li>`,
                )
                .join('')}</ul>`
            : `<p class="muted">${esc(t('noInvites'))}</p>`);
        host.querySelectorAll<HTMLButtonElement>('button[data-revoke]').forEach((button) => {
          button.addEventListener('click', () => {
            button.disabled = true;
            fbRevokeDoctorInvite(button.dataset.revoke ?? '')
              .then(() => loadInvites())
              .catch((error: unknown) => {
                button.disabled = false;
                toast(errorText(error), 'error');
              });
          });
        });
      })
      .catch((error: unknown) => {
        (document.getElementById('invite-list') as HTMLElement).innerHTML =
          `<p class="muted">${esc(errorText(error))}</p>`;
      });
    (document.getElementById('invite-new') as HTMLButtonElement).addEventListener('click', (event) => {
      const button = event.target as HTMLButtonElement;
      button.disabled = true;
      fbCreateDoctorInvite()
        .then(() => {
          button.disabled = false;
          loadInvites();
        })
        .catch((error: unknown) => {
          button.disabled = false;
          toast(errorText(error), 'error');
        });
    });
  }

  function loadCard(): void {
    fbMyDirectoryEntry()
      .then((entry) => {
        const specs = Object.entries(SPECIALTY_LABELS as Record<string, string>);
        (document.getElementById('mycard-body') as HTMLElement).innerHTML = `
          <div class="photo-row">
            ${entry?.avatarUrl ? `<img class="avatar xl" src="${esc(entry.avatarUrl)}" alt="" />` : `<span class="avatar xl">•</span>`}
            <label class="button">${esc(t('changePhoto'))}<input id="mycard-photo" type="file" accept="image/*" hidden /></label>
          </div>
          <p><strong>${esc(entry?.name ?? '')}</strong> <span class="muted">${esc(entry?.clinicName ?? '')}</span></p>
          <form id="mycard-details" class="grid-form">
            ${field(t('specialtyDoctors'), `<select name="specialty"><option value="">—</option>${specs.map(([key, label]) => `<option value="${esc(key)}" ${entry?.specialty === key ? 'selected' : ''}>${esc(specialtyLabel(key, label))}</option>`).join('')}</select>`)}
            ${field(t('doctorPhone'), `<input name="phone" type="tel" value="${esc(entry?.phone ?? '')}" dir="ltr" placeholder="+961…" />`)}
            <button class="primary" type="submit">${esc(t('save'))}</button>
          </form>`;
        (document.getElementById('mycard-photo') as HTMLInputElement).addEventListener('change', (event) => {
          const file = (event.target as HTMLInputElement).files?.[0];
          if (!file) return;
          toast(t('uploadingPhoto'));
          fbUploadDirectoryPhoto(file)
            .then(() => {
              toast(t('photoUpdated'));
              loadCard();
            })
            .catch((error: unknown) => toast(errorText(error), 'error'));
        });
        (document.getElementById('mycard-details') as HTMLFormElement).addEventListener('submit', (event) => {
          event.preventDefault();
          const data = new FormData(event.target as HTMLFormElement);
          const specialty = String(data.get('specialty') ?? '').trim() || null;
          const phone = String(data.get('phone') ?? '').trim() || null;
          fbSaveMyDirectoryDetails({ specialty, phone })
            .then(() => {
              toast(t('saved'));
              loadCard();
            })
            .catch((error: unknown) => toast(errorText(error), 'error'));
        });
      })
      .catch((error: unknown) => {
        (document.getElementById('mycard-body') as HTMLElement).innerHTML =
          `<p class="muted">${esc(errorText(error))}</p>`;
      });
  }

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

  function loadHours(): void {
    fbMyWorkingHours()
      .then((saved) => {
        const byDay = new Map((saved ?? []).map((d) => [d.weekday, d]));
        const host = document.getElementById('hours-body') as HTMLElement;
        host.innerHTML = `
          <table class="table"><thead><tr><th>${esc(t('day'))}</th><th>${esc(t('open'))}</th><th>${esc(t('morningShift'))}</th><th>${esc(t('eveningShift'))}</th></tr></thead><tbody>
          ${WEEK_ORDER.map(
            (w) => {
              const d = byDay.get(w) as { enabled?: boolean; start?: string; end?: string; start2?: string | null; end2?: string | null } | undefined;
              const enabled = d ? !!d.enabled : w !== 0;
              const start = d?.start || '09:00';
              const end = d?.end || (w === 6 ? '13:00' : '17:00');
              const start2 = d?.start2 || '';
              const end2 = d?.end2 || '';
              return `<tr>
                <td>${esc(weekdayLabel(DAY_NAMES[w] ?? String(w)))}</td>
                <td><input type="checkbox" name="open_${w}" ${enabled ? 'checked' : ''} /></td>
                <td dir="ltr"><input type="time" name="start_${w}" value="${esc(start)}" />–<input type="time" name="end_${w}" value="${esc(end)}" /></td>
                <td dir="ltr"><input type="time" name="start2_${w}" value="${esc(start2)}" />–<input type="time" name="end2_${w}" value="${esc(end2)}" /></td>
              </tr>`;
            },
          ).join('')}
          </tbody></table>
          <p class="muted small">${esc(t('eveningShiftHint'))}</p>
          <div class="row"><button id="hours-save" class="primary">${esc(t('saveSchedule'))}</button></div>`;
        (document.getElementById('hours-save') as HTMLButtonElement).addEventListener('click', (event) => {
          const button = event.target as HTMLButtonElement;
          const days = WEEK_ORDER.map((w) => {
            const open = (host.querySelector(`input[name="open_${w}"]`) as HTMLInputElement).checked;
            const s2 = (host.querySelector(`input[name="start2_${w}"]`) as HTMLInputElement).value.trim();
            const e2 = (host.querySelector(`input[name="end2_${w}"]`) as HTMLInputElement).value.trim();
            return {
              weekday: w,
              enabled: open,
              start: (host.querySelector(`input[name="start_${w}"]`) as HTMLInputElement).value || '09:00',
              end: (host.querySelector(`input[name="end_${w}"]`) as HTMLInputElement).value || '17:00',
              start2: s2 || null,
              end2: e2 || null,
            };
          });
          button.disabled = true;
          fbSaveMyWorkingHours(days)
            .then(() => fbPublishAvailability())
            .then(() => {
              toast(t('scheduleSaved'));
              button.disabled = false;
            })
            .catch((error: unknown) => {
              button.disabled = false;
              toast(errorText(error), 'error');
            });
        });
      })
      .catch((error: unknown) => {
        (document.getElementById('hours-body') as HTMLElement).innerHTML =
          `<p class="muted">${esc(errorText(error))}</p>`;
      });
  }

  function loadBookingSettings(): void {
    fbGetBookingSettings()
      .then((s) => {
        const host = document.getElementById('booking-body') as HTMLElement;
        host.innerHTML = `
          <form id="booking-form" class="grid-form">
            ${field(t('slotMinutes'), `<input name="slot" type="number" min="5" max="480" step="5" value="${s.slotDurationMinutes}" required />`)}
            ${field(t('visitConsultation'), `<input name="v_consultation" type="number" min="5" max="480" step="5" value="${s.visitDurations.consultation}" required />`)}
            ${field(t('visitFollowUp'), `<input name="v_follow_up" type="number" min="5" max="480" step="5" value="${s.visitDurations.follow_up}" required />`)}
            ${field(t('visitProcedure'), `<input name="v_procedure" type="number" min="5" max="480" step="5" value="${s.visitDurations.procedure}" required />`)}
            ${field(t('visitTele'), `<input name="v_tele" type="number" min="5" max="480" step="5" value="${s.visitDurations.teleconsult}" required />`)}
          </form>
          <div class="row" style="margin-top:.5rem">
            <label class="check"><input type="checkbox" name="r24" ${s.reminderSettings.remind24h ? 'checked' : ''} /> ${esc(t('remind24h'))}</label>
            <label class="check"><input type="checkbox" name="r3d" ${s.reminderSettings.remind3d ? 'checked' : ''} /> ${esc(t('remind3d'))}</label>
            <label class="check"><input type="checkbox" name="rMeds" ${s.reminderSettings.medsReminders ? 'checked' : ''} /> ${esc(t('remindMeds'))}</label>
            <label class="check"><input type="checkbox" name="rConfirm" ${s.reminderSettings.bookingConfirm ? 'checked' : ''} /> ${esc(t('remindConfirm'))}</label>
          </div>
          <div class="row" style="margin-top:.5rem"><button id="booking-save" class="primary">${esc(t('save'))}</button></div>`;
        (document.getElementById('booking-save') as HTMLButtonElement).addEventListener('click', () => {
          const btn = document.getElementById('booking-save') as HTMLButtonElement;
          const form = document.getElementById('booking-form') as HTMLFormElement;
          const data = new FormData(form);
          const num = (k: string, fallback: number): number => {
            const n = Number(data.get(k));
            return Number.isFinite(n) ? Math.round(n) : fallback;
          };
          const payload = {
            slotDurationMinutes: num('slot', 30),
            visitDurations: {
              consultation: num('v_consultation', 30),
              follow_up: num('v_follow_up', 15),
              procedure: num('v_procedure', 60),
              teleconsult: num('v_tele', 20),
            },
            reminderSettings: {
              remind24h: (host.querySelector('input[name="r24"]') as HTMLInputElement).checked,
              remind3d: (host.querySelector('input[name="r3d"]') as HTMLInputElement).checked,
              medsReminders: (host.querySelector('input[name="rMeds"]') as HTMLInputElement).checked,
              bookingConfirm: (host.querySelector('input[name="rConfirm"]') as HTMLInputElement).checked,
            },
          };
          btn.disabled = true;
          fbSaveBookingSettings(payload)
            .then(() => {
              toast(t('saved'));
              btn.disabled = false;
            })
            .catch((error: unknown) => {
              btn.disabled = false;
              toast(errorText(error), 'error');
            });
        });
      })
      .catch((error: unknown) => {
        (document.getElementById('booking-body') as HTMLElement).innerHTML =
          `<p class="muted">${esc(errorText(error))}</p>`;
      });
  }

  function loadMap(): void {    const host = document.getElementById('map-pick') as HTMLElement;
    Promise.all([loadLeaflet().catch(() => null), fbClinicLocation().catch(() => null)])
      .then(([leaflet, saved]) => {
        if (!leaflet) {
          host.innerHTML = `<p class="muted">${esc(t('mapOffline'))}</p>`;
          (document.getElementById('loc-gps') as HTMLButtonElement).disabled = true;
          return;
        }
        host.innerHTML = '';
        const center: [number, number] = saved ? [saved.lat, saved.lng] : BEIRUT;
        const map = leaflet.map('map-pick').setView(center, saved ? 16 : 12);
        leaflet
          .tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap',
          })
          .addTo(map);
        let marker = leaflet.marker(center).addTo(map);
        let picked: [number, number] | null = saved ? [saved.lat, saved.lng] : null;
        const save = document.getElementById('loc-save') as HTMLButtonElement;
        const gps = document.getElementById('loc-gps') as HTMLButtonElement;
        const out = document.getElementById('loc-out') as HTMLElement;
        const paintPicked = (): void => {
          if (!picked) return;
          save.disabled = false;
          out.textContent = `${picked[0].toFixed(5)}, ${picked[1].toFixed(5)}`;
        };
        if (picked) paintPicked();
        map.on('click', (e) => {
          picked = [e.latlng.lat, e.latlng.lng];
          marker.setLatLng(picked);
          paintPicked();
        });
        gps.addEventListener('click', () => {
          if (!('geolocation' in navigator)) {
            toast(t('gpsUnavailable'), 'error');
            return;
          }
          gps.disabled = true;
          gps.textContent = t('locating');
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              picked = [pos.coords.latitude, pos.coords.longitude];
              map.setView(picked, 16);
              marker.setLatLng(picked);
              paintPicked();
              gps.disabled = false;
              gps.textContent = t('useMyLocation');
            },
            () => {
              gps.disabled = false;
              gps.textContent = t('useMyLocation');
              toast(t('gpsDenied'), 'error');
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
          );
        });
        save.addEventListener('click', () => {
          if (!picked) return;
          save.disabled = true;
          fbSaveClinicLocation(picked[0], picked[1])
            .then(() => {
              toast(t('saved'));
              save.disabled = false;
            })
            .catch((error: unknown) => {
              save.disabled = false;
              toast(errorText(error), 'error');
            });
        });
      })
      .catch((error: unknown) => {
        host.innerHTML = `<p class="muted">${esc(errorText(error))}</p>`;
      });
  }
}
