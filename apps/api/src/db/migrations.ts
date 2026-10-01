/**
 * Database schema and migrations.
 *
 * Written as explicit SQL rather than an ORM for two reasons: the migration
 * order is auditable in a clinical system, and SQLite cannot ALTER a column
 * cheaply, so forward-only migrations are the honest model.
 *
 * The single most important rule in this file: **every tenant-scoped table has
 * a `clinic_id` column and a leading index on it.** There are no global
 * clinical tables. A repository that forgets the clinic filter is a
 * cross-tenant data leak, and the indexes exist so that the filter is also the
 * fast path.
 */

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'core_identity',
    sql: `
      CREATE TABLE clinics (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_ar TEXT,
        slug TEXT NOT NULL UNIQUE,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        country TEXT,
        currency TEXT NOT NULL DEFAULT 'USD',
        phone TEXT,
        email TEXT,
        address TEXT,
        logo_url TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        full_name_ar TEXT,
        role TEXT NOT NULL,
        phone TEXT,
        locale TEXT NOT NULL DEFAULT 'en',
        is_active INTEGER NOT NULL DEFAULT 1,
        last_login_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (clinic_id, email)
      );
      CREATE INDEX idx_users_clinic ON users(clinic_id);

      CREATE TABLE clinic_settings (
        clinic_id TEXT PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
        json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE clinic_schedules (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_schedules_clinic ON clinic_schedules(clinic_id);
    `,
  },
  {
    id: 2,
    name: 'patients_and_records',
    sql: `
      CREATE TABLE patients (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        mrn TEXT NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        full_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        whatsapp_number TEXT,
        email TEXT,
        national_id TEXT,
        date_of_birth TEXT,
        age_years INTEGER,
        sex TEXT NOT NULL DEFAULT 'unknown',
        blood_group TEXT,
        height_cm REAL,
        weight_kg REAL,
        bmi REAL,
        address TEXT,
        city TEXT,
        country TEXT,
        emergency_contact_name TEXT,
        emergency_contact_phone TEXT,
        preferred_language TEXT NOT NULL DEFAULT 'en',
        whatsapp_opt_in INTEGER NOT NULL DEFAULT 1,
        whatsapp_opt_in_at TEXT,
        whatsapp_verified_at TEXT,
        marketing_opt_in INTEGER NOT NULL DEFAULT 0,
        chronic_conditions TEXT NOT NULL DEFAULT '[]',
        allergies TEXT NOT NULL DEFAULT '[]',
        current_medications TEXT NOT NULL DEFAULT '[]',
        past_surgeries TEXT NOT NULL DEFAULT '[]',
        family_history TEXT NOT NULL DEFAULT '[]',
        notes TEXT,
        -- Denormalised for fast lookup; rebuilt whenever a name or phone changes.
        search_blob TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'staff',
        is_active INTEGER NOT NULL DEFAULT 1,
        archived_at TEXT,
        last_visit_at TEXT,
        next_appointment_at TEXT,
        balance_minor INTEGER NOT NULL DEFAULT 0,
        last_vitals_at TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (clinic_id, mrn)
      );
      CREATE INDEX idx_patients_clinic ON patients(clinic_id);
      CREATE INDEX idx_patients_phone ON patients(clinic_id, phone);

      CREATE TABLE visits (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_id TEXT NOT NULL,
        appointment_id TEXT,
        doctor_id TEXT,
        visit_type TEXT NOT NULL,
        chief_complaint TEXT,
        diagnosis TEXT,
        icd_code TEXT,
        plan TEXT,
        notes TEXT,
        vitals_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_visits_clinic ON visits(clinic_id);
      CREATE INDEX idx_visits_patient ON visits(clinic_id, patient_id);

      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_id TEXT NOT NULL,
        visit_id TEXT,
        kind TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        checksum TEXT,
        storage_path TEXT,
        ocr_text TEXT,
        ocr_confidence REAL,
        status TEXT NOT NULL DEFAULT 'pending',
        uploaded_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_documents_clinic ON documents(clinic_id);
      CREATE INDEX idx_documents_patient ON documents(clinic_id, patient_id);
    `,
  },
  {
    id: 3,
    name: 'scheduling',
    sql: `
      CREATE TABLE appointments (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_id TEXT NOT NULL,
        doctor_id TEXT,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        notes TEXT,
        visit_type TEXT NOT NULL DEFAULT 'consultation',
        source TEXT NOT NULL DEFAULT 'staff',
        is_public_booking INTEGER NOT NULL DEFAULT 0,
        hold_expires_at TEXT,
        deposit_required_minor INTEGER NOT NULL DEFAULT 0,
        deposit_paid_minor INTEGER NOT NULL DEFAULT 0,
        fee_minor INTEGER NOT NULL DEFAULT 0,
        paid_minor INTEGER NOT NULL DEFAULT 0,
        cancelled_at TEXT,
        cancelled_by TEXT,
        cancellation_reason TEXT,
        checked_in_at TEXT,
        completed_at TEXT,
        rescheduled_from_id TEXT,
        confirmation_token TEXT NOT NULL,
        created_by TEXT,
        patient_name TEXT NOT NULL,
        patient_phone TEXT NOT NULL,
        specialty TEXT NOT NULL DEFAULT 'general_medicine',
        doctor_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_appt_clinic_start ON appointments(clinic_id, starts_at);
      CREATE INDEX idx_appt_patient ON appointments(clinic_id, patient_id);
      CREATE INDEX idx_appt_doctor ON appointments(clinic_id, doctor_id, starts_at);
      CREATE INDEX idx_appt_token ON appointments(confirmation_token);

      CREATE TABLE reminders (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        appointment_id TEXT NOT NULL,
        patient_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        template TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        sent_at TEXT,
        status TEXT NOT NULL,
        offset_minutes INTEGER NOT NULL,
        origin TEXT NOT NULL DEFAULT 'global',
        payload TEXT NOT NULL DEFAULT '{}',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_reminders_due ON reminders(clinic_id, status, scheduled_for);

      CREATE TABLE waitlist (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_id TEXT NOT NULL,
        specialty TEXT NOT NULL,
        doctor_id TEXT,
        preferred_date_from TEXT,
        preferred_date_to TEXT,
        preferred_time_windows TEXT NOT NULL DEFAULT '[]',
        note TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'waiting',
        offered_appointment_id TEXT,
        offered_slot_start TEXT,
        offered_slot_end TEXT,
        offer_expires_at TEXT,
        offers INTEGER NOT NULL DEFAULT 0,
        last_offered_at TEXT,
        -- Denormalised so an offer can be rendered without a patient join.
        patient_name TEXT NOT NULL DEFAULT '',
        patient_phone TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_waitlist_clinic ON waitlist(clinic_id, status);
      CREATE INDEX idx_waitlist_patient ON waitlist(clinic_id, patient_id);
    `,
  },
  {
    id: 4,
    name: 'messaging_and_care',
    sql: `
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        to_phone TEXT NOT NULL,
        body TEXT NOT NULL,
        template TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        last_attempt_at TEXT,
        sent_at TEXT,
        last_error TEXT,
        provider_message_id TEXT,
        appointment_id TEXT,
        patient_id TEXT,
        dedupe_key TEXT,
        locked_by TEXT,
        locked_at TEXT,
        correlation_id TEXT,
        priority INTEGER NOT NULL DEFAULT 100,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_outbox_dedupe ON outbox(clinic_id, dedupe_key);
      CREATE INDEX idx_outbox_due ON outbox(clinic_id, status, scheduled_for, priority);

      CREATE TABLE message_threads (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        external_key TEXT NOT NULL,
        last_message_at TEXT,
        last_preview TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (clinic_id, external_key)
      );
      CREATE INDEX idx_threads_clinic ON message_threads(clinic_id);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        patient_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        body TEXT NOT NULL,
        template TEXT,
        provider_message_id TEXT,
        external_message_id TEXT,
        parsed_intent TEXT,
        parsed_payload TEXT,
        media_url TEXT,
        error TEXT,
        sent_at TEXT,
        delivered_at TEXT,
        read_at TEXT,
        appointment_id TEXT,
        sent_by TEXT,
        reply_to_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_messages_thread ON messages(clinic_id, thread_id, created_at);
      CREATE INDEX idx_messages_patient ON messages(clinic_id, patient_id);

      CREATE TABLE follow_ups (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_id TEXT NOT NULL,
        protocol_id TEXT,
        diagnosis_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'interval',
        interval_days INTEGER NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT,
        next_due_at TEXT NOT NULL,
        last_requested_at TEXT,
        last_response_at TEXT,
        requests_this_week INTEGER NOT NULL DEFAULT 0,
        week_stamp TEXT,
        requests_sent INTEGER NOT NULL DEFAULT 0,
        responses_received INTEGER NOT NULL DEFAULT 0,
        consecutive_misses INTEGER NOT NULL DEFAULT 0,
        adherence_percent INTEGER NOT NULL DEFAULT 0,
        paused_at TEXT,
        pause_reason TEXT,
        notes TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_followups_due ON follow_ups(clinic_id, status, next_due_at);

      CREATE TABLE follow_up_protocols (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_protocols_clinic ON follow_up_protocols(clinic_id);

      CREATE TABLE vital_readings (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        value REAL NOT NULL,
        secondary_value REAL,
        unit TEXT NOT NULL,
        context TEXT,
        measured_at TEXT NOT NULL,
        source TEXT NOT NULL,
        recorded_by TEXT,
        message_id TEXT,
        follow_up_id TEXT,
        severity TEXT,
        is_abnormal INTEGER NOT NULL DEFAULT 0,
        is_critical INTEGER NOT NULL DEFAULT 0,
        interpretation TEXT,
        acknowledged_at TEXT,
        acknowledged_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_vitals_clinic ON vital_readings(clinic_id);
      CREATE INDEX idx_vitals_patient ON vital_readings(clinic_id, patient_id, measured_at);

      CREATE TABLE clinical_alerts (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_id TEXT,
        follow_up_id TEXT,
        reading_id TEXT,
        appointment_id TEXT,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        metric TEXT,
        value REAL,
        threshold TEXT,
        acknowledged_by TEXT,
        acknowledged_at TEXT,
        resolved_at TEXT,
        resolution_note TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_alerts_open ON clinical_alerts(clinic_id, status, severity);

      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        alert_id TEXT,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        href TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_notifications_user ON notifications(clinic_id, user_id, read_at);
    `,
  },
  {
    id: 5,
    name: 'finance',
    sql: `
      CREATE TABLE invoices (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_id TEXT NOT NULL,
        appointment_id TEXT,
        number TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'SAR',
        subtotal_minor INTEGER NOT NULL DEFAULT 0,
        discount_minor INTEGER NOT NULL DEFAULT 0,
        tax_minor INTEGER NOT NULL DEFAULT 0,
        total_minor INTEGER NOT NULL DEFAULT 0,
        paid_minor INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        due_date TEXT,
        issued_by TEXT,
        notes TEXT,
        paid_at TEXT,
        reminder_sent_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (clinic_id, number)
      );
      CREATE INDEX idx_invoices_clinic ON invoices(clinic_id, status);
      CREATE INDEX idx_invoices_patient ON invoices(clinic_id, patient_id);

      CREATE TABLE invoice_items (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        invoice_id TEXT NOT NULL,
        description TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        unit_price_minor INTEGER NOT NULL,
        amount_minor INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_items_invoice ON invoice_items(clinic_id, invoice_id);

      -- A single ledger table for charges, payments, and refunds. Keeping them
      -- together means a balance is a SUM, not a reconciliation between two
      -- tables that can drift apart.
      CREATE TABLE payments (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_id TEXT NOT NULL,
        invoice_id TEXT,
        appointment_id TEXT,
        type TEXT NOT NULL,
        direction TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'SAR',
        method TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        description TEXT NOT NULL DEFAULT '',
        reference TEXT,
        performed_by TEXT,
        performed_at TEXT NOT NULL,
        is_deposit INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_payments_clinic ON payments(clinic_id, performed_at);
      CREATE INDEX idx_payments_patient ON payments(clinic_id, patient_id);
      CREATE INDEX idx_payments_invoice ON payments(clinic_id, invoice_id);

      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL,
        user_id TEXT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        detail TEXT NOT NULL DEFAULT '{}',
        ip TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_clinic ON audit_log(clinic_id, created_at);
    `,
  },
  {
    id: 6,
    name: 'outbox_safety_critical',
    sql: `
      -- The consent sweep used to decide "is this a patient-safety message?" by
      -- matching template names, which meant a critical alert sent through any
      -- other template was silently dropped as opted-out. The flag is now a
      -- column set at enqueue time, where the caller already knows.
      ALTER TABLE outbox ADD COLUMN safety_critical INTEGER NOT NULL DEFAULT 0;

      -- Status callbacks look a row up by the provider's message id.
      CREATE INDEX idx_outbox_provider ON outbox(provider_message_id);
    `,
  },
  {
    id: 7,
    name: 'appointments_walk_in_patient',
    sql: `
      -- A walk-in booked at the desk has a name and a phone but no chart yet, so
      -- appointments.patient_id has to allow NULL. The domain type already said
      -- string | null; the column contradicted it and turned every walk-in into
      -- a 500. SQLite cannot drop a NOT NULL constraint in place, so the table is
      -- rebuilt and the data copied across. No other table has a foreign key to
      -- appointments, which is what makes the rebuild safe.
      CREATE TABLE appointments_rebuilt (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_id TEXT,
        doctor_id TEXT,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        notes TEXT,
        visit_type TEXT NOT NULL DEFAULT 'consultation',
        source TEXT NOT NULL DEFAULT 'staff',
        is_public_booking INTEGER NOT NULL DEFAULT 0,
        hold_expires_at TEXT,
        deposit_required_minor INTEGER NOT NULL DEFAULT 0,
        deposit_paid_minor INTEGER NOT NULL DEFAULT 0,
        fee_minor INTEGER NOT NULL DEFAULT 0,
        paid_minor INTEGER NOT NULL DEFAULT 0,
        cancelled_at TEXT,
        cancelled_by TEXT,
        cancellation_reason TEXT,
        checked_in_at TEXT,
        completed_at TEXT,
        rescheduled_from_id TEXT,
        confirmation_token TEXT NOT NULL,
        created_by TEXT,
        patient_name TEXT NOT NULL,
        patient_phone TEXT NOT NULL,
        specialty TEXT NOT NULL DEFAULT 'general_medicine',
        doctor_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO appointments_rebuilt (
        id, clinic_id, patient_id, doctor_id, starts_at, ends_at, timezone, status,
        reason, notes, visit_type, source, is_public_booking, hold_expires_at,
        deposit_required_minor, deposit_paid_minor, fee_minor, paid_minor,
        cancelled_at, cancelled_by, cancellation_reason, checked_in_at, completed_at,
        rescheduled_from_id, confirmation_token, created_by, patient_name,
        patient_phone, specialty, doctor_name, created_at, updated_at
      )
      SELECT
        id, clinic_id, patient_id, doctor_id, starts_at, ends_at, timezone, status,
        reason, notes, visit_type, source, is_public_booking, hold_expires_at,
        deposit_required_minor, deposit_paid_minor, fee_minor, paid_minor,
        cancelled_at, cancelled_by, cancellation_reason, checked_in_at, completed_at,
        rescheduled_from_id, confirmation_token, created_by, patient_name,
        patient_phone, specialty, doctor_name, created_at, updated_at
      FROM appointments;

      DROP TABLE appointments;
      ALTER TABLE appointments_rebuilt RENAME TO appointments;

      CREATE INDEX idx_appt_clinic_start ON appointments(clinic_id, starts_at);
      CREATE INDEX idx_appt_patient ON appointments(clinic_id, patient_id);
      CREATE INDEX idx_appt_doctor ON appointments(clinic_id, doctor_id, starts_at);
      CREATE INDEX idx_appt_token ON appointments(confirmation_token);
    `,
  },
  {
    id: 8,
    name: 'users_firebase_uid',
    sql: `
      -- Firebase is the identity plane: a doctor signs up on Firebase Auth and
      -- the API links its own user row to that identity instead of a second
      -- password. NULL means "local password account", exactly one row per
      -- Firebase uid otherwise.
      ALTER TABLE users ADD COLUMN firebase_uid TEXT;
      CREATE UNIQUE INDEX idx_users_firebase_uid ON users(firebase_uid);
    `,
  },
  {
    id: 9,
    name: 'documents_title',
    sql: `
      -- A document is often a new lab panel the enum never heard of.
      -- kind='other' stays for grouping while title carries the human name
      -- ("HbA1c Q3", ...). File bytes uploaded through POST /documents/upload
      -- live under apps/api/uploads with storage_path pointing at them;
      -- metadata-only rows keep storage_path NULL.
      ALTER TABLE documents ADD COLUMN title TEXT;
    `,
  },
  {
    id: 10,
    name: 'visit_flow_and_patient_app',
    sql: `
      -- Requested tests: the doctor orders panels at visit 1, results land
      -- (by scan, PDF, or file) and link back via document_id at visit 2.
      CREATE TABLE requested_tests (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_id TEXT NOT NULL,
        visit_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'requested',
        document_id TEXT,
        notes TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_reqtests_patient ON requested_tests(clinic_id, patient_id);

      -- Prescriptions: structured items plus diet and exercise, so the patient
      -- app can render a medication schedule without parsing free text.
      CREATE TABLE prescriptions (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_id TEXT NOT NULL,
        visit_id TEXT,
        items_json TEXT NOT NULL DEFAULT '[]',
        diet_json TEXT NOT NULL DEFAULT '[]',
        exercise_json TEXT NOT NULL DEFAULT '[]',
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_rx_patient ON prescriptions(clinic_id, patient_id);

      -- Patient app access: one PIN code per patient, shown once at creation.
      -- Only the hash is stored; verification is constant-time.
      CREATE TABLE patient_access_codes (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE (clinic_id, patient_id)
      );
      CREATE INDEX idx_access_codes_patient ON patient_access_codes(clinic_id, patient_id);
    `,
  },
  {
    id: 11,
    name: 'prescriptions_labs_snapshot',
    sql: `
      -- What the doctor saw when they wrote it: the lab values and biometrics
      -- behind each prescription. This is what lets the practice learner say
      -- "your usual at HbA1c 9" instead of just "your usual".
      ALTER TABLE prescriptions ADD COLUMN labs_json TEXT NOT NULL DEFAULT '{}';
    `,
  },
  {
    id: 12,
    name: 'insurers',
    sql: `
      -- Contracted insurers (الجهات الضامنة): coverage percent plus optional
      -- annual and per-visit caps, so billing knows the patient/insurer split.
      -- Patients link to one insurer with their policy number.
      CREATE TABLE insurers (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        name_ar TEXT,
        coverage_percent REAL NOT NULL DEFAULT 0,
        annual_limit_minor INTEGER,
        per_visit_limit_minor INTEGER,
        phone TEXT,
        email TEXT,
        notes TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_insurers_clinic ON insurers(clinic_id);
      ALTER TABLE patients ADD COLUMN insurer_id TEXT;
      ALTER TABLE patients ADD COLUMN insurer_policy_no TEXT;
    `,
  },
  {
    id: 13,
    name: 'invoice_insurance_split',
    sql: `
      -- The split is snapshotted per invoice: coverage percent and caps can
      -- change later, but what was billed stays put. Old rows keep the full
      -- amount on the patient.
      ALTER TABLE invoices ADD COLUMN insurer_id TEXT;
      ALTER TABLE invoices ADD COLUMN insurer_share_minor INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE invoices ADD COLUMN patient_share_minor INTEGER NOT NULL DEFAULT 0;
      UPDATE invoices SET patient_share_minor = total_minor WHERE patient_share_minor = 0;
    `,
  },
  {
    id: 14,
    name: 'insurer_collections',
    sql: `
      -- The other side of the insurance split: what the clinic billed to each
      -- insurer versus what it actually collected. Outstanding per insurer is
      -- always billed minus collected, never a stored balance that can drift.
      CREATE TABLE insurer_payments (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        insurer_id TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        reference TEXT,
        note TEXT,
        received_by TEXT,
        received_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_insurer_payments ON insurer_payments(clinic_id, insurer_id);
    `,
  },
  {
    id: 15,
    name: 'patient_network',
    sql: `
      -- Network identity: one patient, one phone, across every clinic on the
      -- app. These tables are deliberately OUTSIDE tenant scoping - no
      -- clinic_id column - and are only reachable through governed functions
      -- that require either the patient's own session or a clinic link.
      -- A link is created when the patient books, visits, or is imported by
      -- a clinic they attend; opening the shared record writes an audit row,
      -- so every cross-clinic read is attributable.
      CREATE TABLE network_patients (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        full_name TEXT NOT NULL,
        date_of_birth TEXT,
        sex TEXT NOT NULL DEFAULT 'unknown',
        blood_group TEXT,
        address TEXT,
        city TEXT,
        country TEXT,
        emergency_contact_name TEXT,
        emergency_contact_phone TEXT,
        chronic_conditions TEXT NOT NULL DEFAULT '[]',
        allergies TEXT NOT NULL DEFAULT '[]',
        current_medications TEXT NOT NULL DEFAULT '[]',
        code_hash TEXT,
        verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE clinic_links (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        network_patient_id TEXT NOT NULL REFERENCES network_patients(id) ON DELETE CASCADE,
        local_patient_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (clinic_id, network_patient_id)
      );
      CREATE INDEX idx_links_clinic ON clinic_links(clinic_id);
      CREATE INDEX idx_links_network ON clinic_links(network_patient_id);
    `,
  },
  {
    id: 16,
    name: 'staff_specialty',
    sql: `
      -- Doctor specialty for the patient-facing directory and its filter.
      -- NULL reads as general medicine; only doctors use it.
      ALTER TABLE users ADD COLUMN specialty TEXT;
    `,
  },
  {
    id: 17,
    name: 'network_avatar',
    sql: `
      -- Patient profile photo, stored as a file under uploads/avatars and
      -- referenced by name. Shown in the patient app and to treating doctors.
      ALTER TABLE network_patients ADD COLUMN avatar_path TEXT;
    `,
  },
  {
    id: 18,
    name: 'join_flow',
    sql: `
      -- Public join: facility kind (clinic, lab, pharmacy), staff address,
      -- and one-time email verification codes. Codes are hashed; the payload
      -- waits in the row until verified, so nothing half-made can sign in.
      ALTER TABLE clinics ADD COLUMN kind TEXT NOT NULL DEFAULT 'clinic';
      ALTER TABLE users ADD COLUMN address TEXT;
      CREATE TABLE signup_codes (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_signup_codes_email ON signup_codes(email);
    `,
  },
  {
    id: 19,
    name: 'reseller_console',    sql: `
      -- The reseller sells the app: new practices wait inactive until
      -- accepted, subscriptions track plan and expiry per clinic, and every
      -- collected subscription payment lands in subscription_payments so the
      -- books always reconcile billed versus received.
      ALTER TABLE users ADD COLUMN is_reseller INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE clinics ADD COLUMN plan TEXT NOT NULL DEFAULT 'trial';
      ALTER TABLE clinics ADD COLUMN subscribed_at TEXT;
      ALTER TABLE clinics ADD COLUMN expires_at TEXT;
      ALTER TABLE clinics ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'trial';
      CREATE TABLE subscription_payments (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        amount_minor INTEGER NOT NULL,
        period_start TEXT,
        period_end TEXT,
        reference TEXT,
        note TEXT,
        received_by TEXT,
        received_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_subscription_payments ON subscription_payments(clinic_id);
    `,
  },
  {
    id: 20,
    name: 'pharmacy_lab_inert',
    sql: `
      -- Pharmacy & Lab modules (INERT): tables exist so activation is a flag
      -- flip, but no current code path reads or writes them yet.
      CREATE TABLE pharmacy_inventory (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL,
        drug_name TEXT NOT NULL,
        generic_name TEXT,
        strength TEXT,
        form TEXT,
        batch_number TEXT,
        quantity REAL NOT NULL DEFAULT 0,
        unit TEXT NOT NULL DEFAULT 'box',
        unit_price_minor INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        expires_at TEXT,
        supplier TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_pharmacy_inventory ON pharmacy_inventory(clinic_id, drug_name);
      CREATE TABLE prescription_dispenses (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL,
        prescription_id TEXT NOT NULL,
        patient_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        items_json TEXT NOT NULL DEFAULT '[]',
        dispensed_by TEXT,
        dispensed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_prescription_dispenses ON prescription_dispenses(clinic_id, patient_id);
      CREATE TABLE lab_test_catalog (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT,
        prep_notes TEXT,
        routine_price_minor INTEGER,
        currency TEXT NOT NULL DEFAULT 'USD'
      );
      CREATE TABLE lab_orders (
        id TEXT PRIMARY KEY,
        clinic_id TEXT NOT NULL,
        patient_id TEXT NOT NULL,
        test_code TEXT NOT NULL,
        test_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result_json TEXT,
        technician_notes TEXT,
        ordered_by TEXT,
        ordered_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX idx_lab_orders ON lab_orders(clinic_id, patient_id, status);
    `,
  },
  {
    id: 21,
    name: 'password_reset_tokens',
    sql: `
      -- Staff password resets. One row per issued token.
      --
      -- Only the token's SHA-256 is stored, never the token itself, so a
      -- database leak cannot be replayed against /auth/password/reset. Single
      -- use is enforced by clearing used_at, and expiry is checked on read, so
      -- an old link in someone's inbox is inert rather than a standing key.
      CREATE TABLE password_reset_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      -- The lookup path is "newest live token for this user"; the index keeps
      -- that from scanning, and the partial index skips spent rows.
      CREATE INDEX idx_password_reset_live
        ON password_reset_tokens(user_id, created_at DESC)
        WHERE used_at IS NULL;
    `,
  },
];
