/**
 * WhatsApp booking tests: parser tables plus full dialogues.
 *
 * A booking bot that misunderstands "بكرة الساعة ٥" books the wrong day and
 * wastes a patient's trip, so the parser is pinned with tables, not vibes.
 * The dialogue tests pin the properties that matter operationally: yes means
 * the proposal that preceded it, nothing goes out before staff confirms, and
 * a repeated yes never double-books.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createHarness, type Harness } from './harness.js';
import {
  formatDateAr,
  formatTimeAr,
  handleInboundBooking,
  isBookingIntent,
  isCancel,
  isNo,
  isYes,
  normalizeArabic,
  parseDate,
  parseTime,
  withMeridiem,
} from '../src/services/bookingWhats.js';

// Sunday 2026-10-04, 08:00 clinic time. Sunday is a working day in the seed
// schedule (Sun-Fri 09:00-17:00), and 08:00 clears the 2h min-notice for any
// afternoon slot used below.
const NOW = '2026-10-04T05:00:00.000Z';
const TODAY = '2026-10-04';
const MONDAY = '2026-10-05';
const FRIDAY = '2026-10-09';

describe('normalizeArabic', () => {
  it('unifies digits, hamzas and stretched words', () => {
    expect(normalizeArabic('بكرة الساعة ٥')).toBe('بكره الساعه 5');
    expect(normalizeArabic('أريد')).toBe('اريد');
    expect(normalizeArabic('لاااا')).toBe('لا');
    expect(normalizeArabic('۰۱۲۳')).toBe('0123');
  });
});

describe('intent and answers', () => {
  it.each([
    ['بدي احجز بكرة', true],
    ['في موعد بكرة؟', true],
    ['احجزلي عند الدكتور', true],
    ['مرحبا', false],
    ['شكرا كتير', false],
    ['وين العيادة؟', false],
  ])('isBookingIntent(%s) = %s', (text, expected) => {
    expect(isBookingIntent(normalizeArabic(text))).toBe(expected);
  });

  it.each([
    ['نعم', true],
    ['اي', true],
    ['اه', true],
    ['تمام!', true],
    ['لا', false],
    ['نعملا', false],
  ])('isYes(%s) = %s', (text, expected) => {
    expect(isYes(normalizeArabic(text))).toBe(expected);
  });

  it.each([
    ['لا', true],
    ['لأ', true],
    ['ما بدي', true],
    ['نعم', false],
    ['بلا', true],
  ])('isNo(%s) = %s', (text, expected) => {
    expect(isNo(normalizeArabic(text))).toBe(expected);
  });

  it('detects cancellation', () => {
    expect(isCancel(normalizeArabic('الغي الحجز'))).toBe(true);
    expect(isCancel(normalizeArabic('بطلت'))).toBe(true);
    expect(isCancel(normalizeArabic('بدي احجز'))).toBe(false);
  });
});

describe('parseDate', () => {
  it.each([
    ['اليوم', TODAY],
    ['بكرة', MONDAY],
    ['بكرا', MONDAY],
    ['غدا', MONDAY],
    ['بعد بكرة', '2026-10-06'],
    ['الجمعة', FRIDAY],
    ['الاثنين', MONDAY],
    ['التنين', MONDAY],
    ['السبت', '2026-10-10'],
    ['مرحبا', null],
    ['الساعة خمسة', null],
  ])('parseDate(%s) = %s', (text, expected) => {
    expect(parseDate(normalizeArabic(text), TODAY)).toBe(expected);
  });
});

describe('parseTime', () => {
  it.each([
    ['الساعة ٥ المسا', { kind: 'time', minutes: 1020 }],
    ['بكرة 17:30', { kind: 'time', minutes: 1050 }],
    ['الساعة ٥ ونص المسا', { kind: 'time', minutes: 1020 + 30 }],
    ['٩ الصبح', { kind: 'time', minutes: 540 }],
    ['١٢ الظهر', { kind: 'time', minutes: 720 }],
    ['الساعة ٥', { kind: 'ambiguous', hour: 5 }],
    ['بكرة ٥', { kind: 'ambiguous', hour: 5 }],
    ['مرحبا', { kind: 'none' }],
  ])('parseTime(%s) = %j', (text, expected) => {
    expect(parseTime(normalizeArabic(text))).toEqual(expected);
  });

  it('combines a bare meridiem with the stored hour', () => {
    expect(withMeridiem(5, normalizeArabic('المسا'))).toBe(1020);
    expect(withMeridiem(5, normalizeArabic('الصبح'))).toBe(300);
    expect(withMeridiem(5, normalizeArabic('مرحبا'))).toBeNull();
  });
});

describe('formatting', () => {
  it('formats times and dates the way the bot speaks', () => {
    expect(formatTimeAr(1020)).toBe('الساعة 5 بعد الظهر');
    expect(formatTimeAr(1050)).toBe('الساعة 5:30 بعد الظهر');
    expect(formatTimeAr(540)).toBe('الساعة 9 الصبح');
    expect(formatDateAr(MONDAY)).toBe('الاثنين 5/10');
  });
});

describe('booking dialogue', () => {
  let h: Harness;
  let clinicId: string;

  // A different sender per dialogue: conversation state is keyed by phone, so
  // sharing one number would leak proposals between tests.
  const P1 = '+96170123456';
  const P2 = '+96170222222';
  const P3 = '+96170333333';
  const P4 = '+96170444444';
  const P5 = '+96170555555';

  const say = (text: string, phone = P1, at = NOW, cid = clinicId) =>
    handleInboundBooking(h.db, h.app.tenantFor(cid), cid, phone, text, at);

  const outboxTemplates = (): string[] =>
    (h.db.prepare('SELECT template FROM outbox').all() as { template: string }[]).map((r) => r.template);

  const appointments = (): { status: string; starts_at: string }[] =>
    h.db.prepare('SELECT status, starts_at FROM appointments').all() as { status: string; starts_at: string }[];

  beforeAll(async () => {
    h = await createHarness();
    clinicId = h.clinic.clinicId;
    // Deterministic slate: the seed may carry sample appointments.
    h.db.prepare("DELETE FROM appointments").run();
    h.db.prepare('DELETE FROM outbox').run();
    h.db.prepare('DELETE FROM reminders').run();
  });

  afterAll(async () => {
    await h.close();
  });

  it('walks intent -> proposal -> yes -> pending draft, quietly', () => {
    const ask = say('بدي احجز بكرة الساعة ٣ المسا');
    expect(ask.action).toBe('asked_confirm');
    expect(ask.reply).toContain('تأكيد الحجز');
    expect(ask.reply).toContain('نعم أو لا');

    const done = say('نعم');
    expect(done.action).toBe('booked_pending');
    expect(done.reply).toContain('الموظفة بتأكدلك');

    // One pending appointment, blocking the slot but announcing nothing.
    const booked = appointments();
    expect(booked).toHaveLength(1);
    expect(booked[0]?.status).toBe('pending');
    expect(booked[0]?.starts_at).toContain('2026-10-05T12:00');
    // Only the bot's own words went out: no confirmation, no reminders yet.
    expect(outboxTemplates()).not.toContain('appointment_confirm');
    expect(outboxTemplates().every((t) => t === 'custom')).toBe(true);
  });

  it('a repeated yes books nothing twice', () => {
    const again = say('نعم');
    expect(again.action).toBe('ignored');
    expect(appointments()).toHaveLength(1);
  });

  it('asks morning-or-evening instead of guessing', () => {
    const ask = say('بدي احجز بكرة الساعة ٤', P2, '2026-10-04T05:00:00.000Z');
    expect(ask.action).toBe('asked_time');
    expect(ask.reply).toContain('الصبح ولا المسا');

    const evening = say('المسا', P2, '2026-10-04T05:01:00.000Z');
    expect(evening.action).toBe('asked_confirm');
    expect(evening.reply).toContain('تأكيد الحجز');
  });

  it('no means no, and clears the proposal', () => {
    const ask = say('بدي احجز الجمعة الساعة ١٠ الصبح', P3, '2026-10-04T05:00:00.000Z');
    expect(ask.action).toBe('asked_confirm');
    const no = say('لا', P3, '2026-10-04T05:01:00.000Z');
    expect(no.action).toBe('cancelled');
    // The Friday slot stays empty: nothing was booked.
    expect(appointments().filter((a) => a.starts_at.startsWith('2026-10-09'))).toHaveLength(0);
    // A yes afterwards has nothing to confirm.
    const stray = say('نعم', P3, '2026-10-04T05:02:00.000Z');
    expect(stray.action).toBe('ignored');
  });

  it('offers the nearest free hour when the requested one is taken', async () => {
    // Occupy Monday 15:00 directly, then ask for it over chat.
    const tenant = h.app.tenantFor(clinicId);
    const { createBooking } = await import('../src/services/appointments.js');
    const { bookingContextFor } = await import('../src/services/appointments.js');
    createBooking(h.db, tenant, clinicId, bookingContextFor(h.db, clinicId), {
      patientId: null,
      patientName: 'Staff Booking',
      patientPhone: '+96170000000',
      startsAt: '2026-10-06T12:00:00.000Z',
      source: 'staff',
    });
    const ask = say('بدي احجز التلاتا الساعة ٣ المسا', P4, '2026-10-04T05:00:00.000Z');
    expect(ask.action).toBe('busy_alt');
    expect(ask.reply).toContain('محجوز');
  });

  it('small talk is ignored, never answered', () => {
    expect(say('مرحبا كيفك', P5).action).toBe('ignored');
    expect(say('شكرا', P5).action).toBe('ignored');
    expect(say('وين العيادة', P5).action).toBe('ignored');
  });

  it('walks day-first: intent -> day -> time -> confirm', () => {
    const P6 = '+96170666666';
    const ask = say('بدي احجز', P6, '2026-10-04T05:00:00.000Z');
    expect(ask.action).toBe('asked_time');
    const day = say('بكرة', P6, '2026-10-04T05:01:00.000Z');
    expect(day.action).toBe('asked_time');
    expect(day.reply).toContain('أي ساعة');
    const time = say('الساعة ١٠ الصبح', P6, '2026-10-04T05:02:00.000Z');
    expect(time.action).toBe('asked_confirm');
    expect(time.reply).toContain('تأكيد الحجز');
    const yes = say('نعم', P6, '2026-10-04T05:03:00.000Z');
    expect(yes.action).toBe('booked_pending');
  });

  it('walks time-first: time -> day -> confirm', () => {
    const P7 = '+96170777777';
    const ask = say('الساعة ١١ الصبح', P7, '2026-10-04T05:00:00.000Z');
    expect(ask.action).toBe('asked_time');
    expect(ask.reply).toContain('أي يوم');
    const day = say('بكرة', P7, '2026-10-04T05:01:00.000Z');
    expect(day.action).toBe('asked_confirm');
    const yes = say('نعم', P7, '2026-10-04T05:02:00.000Z');
    expect(yes.action).toBe('booked_pending');
  });

  it('cancel mid-flow clears everything', () => {
    const P8 = '+96170888888';
    const ask = say('بدي احجز بكرة الساعة ٢ المسا', P8, '2026-10-04T05:00:00.000Z');
    expect(ask.action).toBe('asked_confirm');
    const cancel = say('بطلت', P8, '2026-10-04T05:01:00.000Z');
    expect(cancel.action).toBe('cancelled');
    // A yes afterwards has nothing to confirm: the slot stayed free.
    const stray = say('نعم', P8, '2026-10-04T05:02:00.000Z');
    expect(stray.action).toBe('ignored');
  });

  it('keeps clinics apart: same phone, two clinics, zero crossover', () => {
    const now = '2026-10-04T05:00:00.000Z';
    h.db.prepare(
      `INSERT INTO clinics (id, name, name_ar, slug, timezone, country, currency, is_active, created_at, updated_at)
       VALUES ('clc_B', 'Clinic B', 'عيادة ب', 'clinic-b', 'Asia/Beirut', 'LB', 'USD', 1, ?, ?)`,
    ).run(now, now);
    const phone = '+96170999999';
    const countA = (h.db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE clinic_id = ?').get(clinicId) as { n: number }).n;
    const outboxBefore = (h.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n;

    const ask = say('بدي احجز بكرة الساعة ١٠ الصبح', phone, now, 'clc_B');
    expect(ask.action).toBe('asked_confirm');
    const yes = say('نعم', phone, '2026-10-04T05:01:00.000Z', 'clc_B');
    expect(yes.action).toBe('booked_pending');

    // B gained exactly one pending draft...
    const inB = h.db.prepare("SELECT status FROM appointments WHERE clinic_id = 'clc_B'").all() as { status: string }[];
    expect(inB).toHaveLength(1);
    expect(inB[0]?.status).toBe('pending');
    // ...A is untouched, and every row this dialogue wrote belongs to B.
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE clinic_id = ?').get(clinicId) as { n: number }).n).toBe(countA);
    const fresh = h.db.prepare('SELECT clinic_id FROM outbox LIMIT -1 OFFSET ?').all(outboxBefore) as { clinic_id: string }[];
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((r) => r.clinic_id === 'clc_B')).toBe(true);
  });

  it('staff confirm sends the confirmation and plans reminders', async () => {    const pending = h.db.prepare("SELECT id FROM appointments WHERE status = 'pending' LIMIT 1").get() as
      | { id: string }
      | undefined;
    expect(pending).toBeTruthy();
    const { token, auth } = await h.login();
    void token;
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/appointments/${pending?.id}`,
      headers: { authorization: auth },
      payload: { status: 'confirmed' },
    });
    expect(res.statusCode).toBe(200);
    const templates = outboxTemplates();
    expect(templates).toContain('appointment_confirm');
    const reminders = (h.db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as { n: number }).n;
    expect(reminders).toBeGreaterThan(0);
  });
});
