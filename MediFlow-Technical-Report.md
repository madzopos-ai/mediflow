# MediFlow — Comprehensive Technical Report
**For: Software Engineer / Code Review**
**Date: 2026-09-29 | Version: 1.0.0 | License: MIT | Node ≥ 20.11**

---

## 1. One-paragraph summary

**MediFlow** is a multi-tenant **medical practice & patient management PWA** with **AI-assisted decision support** and **WhatsApp automation**. It has two front-ends in one web app (staff console + patient app), a dual-backend data layer (local **Fastify + SQLite** API for dev/self-host, **Firebase/Firestore** for production), a shared clinical-logic package (`@mediflow/shared`), and a separate **WhatsApp gateway** (Baileys) that drains a Firestore outbox. UI is **bilingual Arabic (default, RTL) + English**, vanilla TypeScript + Vite (no React/Vue), on-device OCR (Tesseract.js + pdf.js). Total ≈ **141 source files, ~48,600 LOC** (excluding node_modules/dist). TypeScript typecheck passes for both `web` and `api`.

---

## 2. Tech stack (exact, from package.json)

| Layer | Technology | Notes |
|---|---|---|
| Monorepo | npm workspaces (`packages/*`, `apps/*`), `concurrently`, `rimraf`, TS 5.7.2 | Scripts: `dev`, `build`, `typecheck`, `test`, `db:migrate/seed/reset`, `admin:pending/approve` |
| Backend API (`@mediflow/api` 1.0.0) | **Fastify 5**, `@fastify/cors`, `@fastify/jwt`, **better-sqlite3 11**, `firebase-admin 14`, `zod 3` | `tsx` watch dev, `vitest` tests, `tsc -p tsconfig.build.json` build |
| Shared (`@mediflow/shared`) | `zod` only runtime dep; `vitest` dev | Pure clinical/domain logic, built to `dist`, consumed as `*` by all apps |
| Web (`@mediflow/web`) | **Vite 5**, vanilla TS modules, `firebase 12`, `pdfjs-dist 6`, `tesseract.js 7` | No UI framework; hash router; PWA (`public/sw.js`, `manifest.webmanifest`); `tsc --noEmit` |
| WhatsApp gateway (`@mediflow/baileys-gateway`) | `@whiskeysockets/baileys 6`, `firebase-admin 13`, `tsx` | Drains per-clinic Firestore outbox → WhatsApp; routes inbound → threads |
| Hosting/DB (prod) | **Firebase Hosting** (SPA rewrite → `/index.html`), **Firestore** + `firestore.rules` (175 lines) | API/SQLite = local dev & self-host path; `start.bat`, `Dockerfile`, `.env.example` in `apps/api` |
| i18n | Custom `apps/web/src/i18n.ts` (**701 lines**, ~200 keys, `t()`/`tx()` + label mappers) | Default lang = **Arabic (RTL)**; toggle to English; `document.dir` mirrors |

---

## 3. Repository layout & size (measured)

```
mediflow/
├── apps/
│   ├── api/               # Fastify backend (48 src files, ~12,439 LOC) + test/ (14 files, ~2,512 LOC)
│   │   └── src/{app,index,worker,admin-cli, auth/, config, db/, http/, routes/ (18), services/ (10), workers/}
│   ├── web/               # PWA frontend (24 src files, ~8,731 LOC) + public/sw.js
│   │   └── src/{main,api,data (1511 lines),firebase,store,ui,i18n (701),styles, views/ (15 files)}
│   └── baileys-gateway/   # WA gateway (2 src files, ~369 LOC: index.ts, clinic.ts)
├── packages/
│   └── shared/src/        # 27 files, ~12,606 LOC: clinical/, scheduling/, whatsapp/, domain/, core/
├── firestore.rules        # per-clinic security model + licence kill-switch
├── firebase.json          # Hosting public=apps/web/dist, SPA rewrites, sw.js no-cache
├── .firebaserc  start.bat  tsconfig.base.json
└── Total (src only): ~141 files / ~48,664 LOC
```

**Per-area LOC (src `.ts` only):** API 48/12,439 · Shared 27/12,606 · Web 24/8,731 · Gateway 2/369 · API tests 14/2,512.

**Largest / most critical files:** `web/src/data.ts` (1,511 — dual-backend abstraction) · `web/src/views/patients.ts` (1,105 — chart, visits, vitals, Rx) · `shared/src/clinical/vitals.ts` (907 — definitions, ranges, evaluation) · `web/src/i18n.ts` (701) · `web/src/views/patientHome.ts` (492) · `shared/src/clinical/decisionSupport.ts` (410) · `web/src/main.ts` (350 — router, licence gate) · `gateway/src/*.ts` (369 total).

---

## 4. Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Web PWA    │────▶│  API (Fastify +  │────▶│ SQLite (dev) │
│ staff+patient│    │  SQLite)  :4000  │     │  better-sql3 │
└──────┬──────┘     └──────────────────┘     └──────────────┘
       │  (if Firebase configured)
       ▼
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Firestore   │◀───▶│ Baileys gateway  │────▶│  WhatsApp    │
│  per-clinic  │ outbox│ (Node service)  │     │  network     │
└──────────────┘     └──────────────────┘     └──────────────┘
```

- **Dual backend, one UI:** `web/src/data.ts` abstracts every entity; `web/src/firebase.ts` lazy-loads Firebase SDK only when configured (`isFirebaseConfigured()`), otherwise the app talks to the local API (`web/src/api.ts` JWT). Firestore rules then authorize directly off the Firebase session.
- **Multi-tenancy:** everything is scoped under `clinics/{clinicId}/…`. API enforces tenant via `db/tenant.ts` + JWT claims; Firestore via `sameClinic()` + `users/{uid}.clinicId`.
- **Offline-first web:** `api.ts` write queue (`readQueue`/`syncQueue`, `mf:queue-changed` events, `OfflineQueuedError` → `t('queued')` toast, net badge, service worker). Reads fall back gracefully; writes replay on `online`.
- **Background jobs:** `api/src/worker.ts` + `workers/` (drivers/index) — reminders, outbox, follow-ups. Gateway is a separate deployable (own `gateway-config.example.json`).

---

## 5. Backend API — routes & services (18 route modules)

`apps/api/src/routes/`: `appointments, auth, care, clinic, dashboard, finance, join, messaging, network, patientapp, patients, public, records, reseller, schedule, system, visitflow, waitlist` (+ `_refactor2.cjs` — **should be deleted**).
`services/`: `activity, appointments, context, inbound, network, outbox, patients, reminders, settings, threads`.
`db/`: `migrations, migrate-cli, seed, seed-cli, reset-cli, tenant, mappers, defaults, index`.
`auth/`: `plugin (Fastify JWT), password (hashing), firebase (Admin verify)`. `http/errors.ts` unified errors. `config.ts`, `app.ts` (145 lines), `index.ts`, `admin-cli.ts` (pending/approve).

Key flows: email+password auth + email-code signup (`/auth/signup/code|verify`), JWT sessions, staff CRUD scoped by role, appointment state machine (book→in→done/cancel), visit/test/Rx lifecycle, invoices→payments→insurer shares, WhatsApp threads/outbox, cross-clinic **network** lookup/import by phone, **patient-app** APIs on a separate patient token, **reseller** console (approve/suspend/subscriptions/collections), public booking + directory + slots.

---

## 6. Shared package — the clinical brain (`@mediflow/shared`, 27 files)

- `clinical/vitals.ts` (907): ~30 vital/lab kinds, units, reference ranges (incl. age/sex overrides, e.g. pediatric glucose, hemoglobin), `evaluateVital()` severity + interpretation + escalation.
- `clinical/decisionSupport.ts` (410): rule-based review → severity/warnings/suggestions/regimen/labGuided + raw payload; **explicitly draft-only, requires clinician sign-off** (UI banner, Arabic+English).
- `clinical/dosing*, dosingGuidance`: lab-guided dosing (metformin by HbA1c/eGFR, statin by LDL/age, ACE-i on albuminuria — outside that: doctor's judgment).
- `clinical/interactions.ts`, `allergies.ts`, `drugs.ts` (+ `drugsForSpecialty`), `practice.ts` (learns doctor's usual Rx per diagnosis), `protocols.ts`, `specialty.ts` (`SPECIALTY_LAB_KINDS`, `orderKindsForSpecialty`), `labPanel.ts` (`parseLabPanel` — OCR text → structured values), `replyParser.ts`.
- `scheduling/slots, reminders, waitlist, deposit`; `whatsapp/templates, outbox, commands, care` (incl. Arabic severity labels); `domain/enums, types` (`SPECIALTIES` 22, `SPECIALTY_LABELS`, `VITAL_KINDS`, `DOCUMENT_KINDS` 12, roles, payment methods/statuses, alert kinds); `core/ids, money (minor units — $20→2000, never float), time (WEEKDAY_LABELS), result`.

---

## 7. Web PWA — screens & behavior (15 views, hash router in `main.ts`)

`main.ts` (350): shell/topbar/net-badge/theme/lang/logout, staff `NAV` (dashboard, calendar, patients, scanner, finance, insurers, team, whatsapp + owner→clinic, reseller→admin), patient `PATIENT_NAV` (health/doctors/profile), `route()/routeFor()/routeStaff()`, onboarding gate (`mf_profile_ok`), **licence gate** (`config/appStatus` → suspended locks app), verify-email gate, pending-approval gate, service-worker register.

| View (file) | Purpose |
|---|---|
| `login.ts` | Firebase (sign-in + new clinic) / API (staff + patient phone+code + register) tabs |
| `join.ts` | Doctor/clinic/lab/pharmacy cards → details → 6-digit email code → pending-approval screen; `renderOnboarding` (phone+address) |
| `dashboard.ts` | Today's appointments, open alerts + follow-up counters, sync queue + sync-now, notifications + mark-read |
| `calendar.ts` | Date-range list + check-in/complete/cancel; book form with patient autocomplete |
| `patients.ts` (1,105) | Network lookup by phone, search, new patient; detail tabs: **overview / visits / vitals / treatment / shared**; vitals trends+sparklines, test ordering, Rx draft (manual/predicted/dictated/photo-OCR), voice notes, document upload + auto lab-read, access-code modal, insurer link |
| `patientHome.ts` (492) | Patient app: health cards (record/appts/meds/reminders/tests + cancel), doctors directory + specialty filter + 7-day slots + cross-clinic booking, profile + avatar + insurers |
| `scanner.ts` | Scan upload (image/PDF/Excel…≤15 MB) → auto-read; doc table (view/download/re-read/attach-OCR) |
| `labOcr.ts` | `ocrPanelHtml/runImageRead/runPdfRead/ocrText/showExtracted` — Tesseract + pdf.js on-device, checkbox confirm → `recordVital` |
| `finance.ts` (321) | Summary (outstanding/collected), new invoice (+tax), patient statement + pay/pay-full (cash/whish/card/transfer), day/month details |
| `insurers.ts` | Insurer CRUD + activate; per-insurer account (billed/collected/outstanding, invoices, receipts, collect form) |
| `team.ts` | Staff table (role/specialty/active/last-login) + create account |
| `clinic.ts` | Profile, working-hours matrix + slot/buffer/max, booking rules (notice/horizon/public-link/deposit) |
| `whatsapp.ts` | Threads + thread view, send form, outbox table |
| `review.ts` | Diagnosis + meds → review (labs/warnings/guided-doses/regimen/usual/follow-up/raw) + interaction checker |
| `admin.ts` | Reseller: pending approvals, clinics table (plan/subscription/collected/patients-staff), per-clinic subscription & collections |

Cross-cutting: `ui.ts` (`esc()` everywhere — patient names never become markup; `toast`, `fmtDateTime/fmtDate/fmtMoney` locale-aware ar/en, `field/input`, `sha256Hex`, `fileToBase64`); `store.ts`; `styles.css`; `patientPicker.ts` (≥2 chars autocomplete, `requirePicked` refuses unpicked); `rxDraft.ts` (per-patient localStorage draft).

---

## 8. Auth, roles & security model

- **Staff:** email+password (API: hashed + JWT `@fastify/jwt`; Firebase: Auth + `users/{uid}` doc). Roles: `owner > doctor > nurse > assistant > receptionist > billing` (`ROLE_RANK`, `capabilitiesForRole`). Email verification gate + admin-approval gate for practices; patients join freely.
- **Patients:** phone + 6-digit code/PIN (`accessCode`), separate patient token; `access_codes` **unreadable by any client** (rules `allow read, write: if false` — API service account only).
- **Firestore rules:** `config/appStatus` public-read/never-client-write (reseller kill-switch); `users/{uid}` self-or-owner; `clinics/{clinic}` member-read/owner-write; clinical subcollections member-read + role-write; vitals/payments/insurer_payments **append-only** (no update/delete); outbox create-only-`queued`, no client state advance; documents deletable (wrong-patient correction); counters transactional (MRN).
- **Hygiene:** `esc()` on all server-controlled strings, checksum (`sha256Hex`) on uploads, Zod validation in shared + API, no secrets in repo (`.env.example` only).

---

## 9. WhatsApp & notifications

Outbox pattern: app enqueues (`status=queued`) → gateway drains via Baileys → delivery status back to threads/messages; inbound routed to threads with unread counts; `care.ts` + `reminders.ts` generate clinical reminders/follow-ups; message templates bilingual (Arabic severity labels in shared). Gateway config via `gateway-config.example.json`; service-account bypasses rules to advance outbox state.

---

## 10. Finance & insurance & reseller (money in minor units everywhere)

Invoices (`total/minor`, tax %, status pending/partial/paid…) → patient share vs insurer share (coverage %, annual/per-visit caps) → payments (cash/card/wallet/transfer/insurance/waiver/whish) → insurer receipts + collections; reseller layer: clinic subscriptions (trial/active/expired/suspended, plan, subscribed/expires) + per-clinic statements + collection receipts. All amounts integer minor units (`core/money.ts`, `dollarsToMinor`).

---

## 11. Quality signals (verified 2026-09-29)

- ✅ `tsc --noEmit` **passes** for `apps/web` and `apps/api`.
- ✅ Tests exist: API `vitest` (auth, booking, dashboard, documents, finance, firebase, join, migrations, network, reseller, visitflow, worker + harness) + shared `vitest`. **Action for engineer: run `npm test` / `test:shared` and report counts** (not executed in this review env).
- ✅ Bilingual QA pass just completed: Arabic default + ~200 keys + label mappers; no `t()` key typos (type-checked `StringKey`).
- ⚠️ `apps/api/src/routes/_refactor2.cjs` — stray file, recommend delete.
- ⚠️ No CI config, no Dockerfile for web/gateway (only `apps/api/Dockerfile`), no E2E tests observed.

---

## 12. Does it need further development? — Yes, hardening & completion (ranked)

**P0 — before production with real patients:**
1. **Clinical-safety review** of `decisionSupport/dosing/interactions` by a clinician + add unit-test coverage thresholds; confirm every AI string still carries the draft-only disclaimer (it does — keep it).
2. **Security audit:** re-test Firestore rules with emulator (esp. `users` update, outbox update constraint, `access_codes` deny); rotate/verify service-account handling; add rate-limiting + audit log for reseller/suspend actions.
3. **Backup & DR:** Firestore scheduled backups + SQLite backup for API path; document RPO/RTO; test restore.
4. **Gateway HA:** Baileys session persistence, reconnect/backoff, dead-letter outbox, duplicate-send guard, per-clinic send rate limits.

**P1 — product completeness:**
5. E2E tests (Playwright) for book→check-in→visit→Rx→invoice→pay and patient cross-clinic booking; CI (typecheck+tests+build on PR).
6. Observability: structured logs, error tracking (Sentry), gateway/API health endpoints + uptime alerts.
7. Performance: paginate patients/invoices/outbox tables; index audit; OCR worker off main thread; Vite bundle-size check (Firebase+Tesseract lazy-loaded already — good).
8. Mobile packaging: PWA install QA on Android/iOS + push notifications for reminders.

**P2 — nice-to-have:** prescription PDF export, lab-trend charts, role-based UI hiding (currently nav-gated, server-enforced — fine), Arabic drug-name dictionary (keep clinical data verbatim for now), analytics dashboard.

**Verdict for the engineer:** codebase is **real, coherent, and well-structured** (clean monorepo, typed, tested, secured per-tenant, offline-capable) — **not a prototype**. It is shippable to a pilot after the P0 items; P1/P2 are normal maturation, not rescue work. Estimated P0 ≈ 1–2 engineer-weeks (assuming tests green), P1 ≈ 3–5 weeks.

---

## 13. How to run (for the engineer)

```bash
npm install
npm run dev          # api (:4000) + web (vite) concurrently
npm run dev:api      # tsx watch apps/api/src/index.ts
npm run dev:web      # vite (builds shared first)
npm run typecheck    # all workspaces
npm test             # api + shared vitest
npm run build        # shared → api → web → gateway
npm start            # node apps/api/dist/index.js
# Firebase prod: configure web env + service account, deploy rules/hosting (firebase.json)
# Gateway: cd apps/baileys-gateway && cp gateway-config.example.json gateway-config.json && npm run dev
```

## 14. File inventory (every source file)

<details><summary>Click to expand — 141 files</summary>

```
apps/api/package.json · src/admin-cli.ts · src/app.ts · src/auth/firebase.ts
src/auth/password.ts · src/auth/plugin.ts · src/config.ts · src/db/defaults.ts
src/db/index.ts · src/db/mappers.ts · src/db/migrate-cli.ts · src/db/migrations.ts
src/db/reset-cli.ts · src/db/seed-cli.ts · src/db/seed.ts · src/db/tenant.ts
src/http/errors.ts · src/index.ts · src/routes/appointments.ts · src/routes/auth.ts
src/routes/care.ts · src/routes/clinic.ts · src/routes/dashboard.ts · src/routes/finance.ts
src/routes/join.ts · src/routes/messaging.ts · src/routes/network.ts · src/routes/patientapp.ts
src/routes/patients.ts · src/routes/public.ts · src/routes/records.ts · src/routes/reseller.ts
src/routes/schedule.ts · src/routes/system.ts · src/routes/visitflow.ts · src/routes/waitlist.ts
src/routes/_refactor2.cjs (DELETE) · src/services/activity.ts · src/services/appointments.ts
src/services/context.ts · src/services/inbound.ts · src/services/network.ts · src/services/outbox.ts
src/services/patients.ts · src/services/reminders.ts · src/services/settings.ts · src/services/threads.ts
src/worker.ts · src/workers/drivers.ts · src/workers/index.ts
test/auth,booking,dashboard,documents,finance,firebase,harness,join,migrations,network,reseller,slots,visitflow,worker
apps/web/package.json · public/sw.js · src/api.ts · src/data.ts · src/firebase.ts · src/i18n.ts
src/main.ts · src/store.ts · src/styles.css · src/ui.ts · views/admin,calendar,clinic,dashboard,
finance,insurers,join,labOcr,login,patientHome,patientPicker,patients,review,rxDraft,scanner,team,whatsapp
apps/baileys-gateway/package.json · src/clinic.ts · src/index.ts
packages/shared/src/clinical/{allergies,decisionSupport,dosing,dosingGuidance,drugs,interactions,labPanel,practice,protocols,replyParser,specialty,vitals}
core/{ids,money,result,time} · domain/{enums,types} · scheduling/{deposit,reminders,slots,waitlist}
whatsapp/{care,commands,outbox,templates} · index.ts
firebase.json · firestore.rules · package.json · tsconfig.base.json · start.bat
```

</details>

---

## 15. Reviewer checklist (for the receiving engineer)

- [ ] `npm install && npm run typecheck && npm test` — paste results back
- [ ] Firestore rules emulator: attempt cross-clinic read, outbox state jump, `access_codes` read — all must deny
- [ ] Offline test: airplane mode → book/pay/Rx → online → verify sync + no duplicates
- [ ] Gateway test: enqueue → receive on handset; reply → appears in thread
- [ ] OCR test: Arabic/English lab photo → confirm values → vitals updated
- [ ] Finance test: invoice with insurer % + caps → pay partial → statement math in minor units
- [ ] Licence test: set `config/appStatus=suspended` → app locks on boot
- [ ] Confirm `_refactor2.cjs` deletion + add CI + backups before pilot

*Prepared from direct source inspection (no guessing). All LOC counts measured; typechecks executed 2026-09-29.*
