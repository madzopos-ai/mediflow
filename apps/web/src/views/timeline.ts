/**
 * Per-patient clinical timeline.
 *
 * Merges the five things that already exist in the chart into one chronological
 * feed - visits, vitals, prescriptions, requested tests and documents - so the
 * doctor can answer "what happened, and in what order" without opening five
 * tabs. Read-only by design: it aggregates what other screens wrote, so it
 * cannot drift from the chart and needs no new collections.
 *
 * Trend charts are inline SVG rather than a charting library: the shapes are
 * simple polylines, and a dependency would be far larger than the code it
 * replaces.
 */

import { evaluateVital, vitalLabel, type VitalKind } from '@mediflow/shared';

import {
  docsForPatient,
  patientOverview,
  rxList,
  testsList,
  vitalsAll,
  visitsAll,
  type UiDocument,
  type UiPrescription,
  type UiRequestedTest,
  type UiVisit,
} from '../data.js';
import { errorText, esc, fmtDateTime, toast } from '../ui.js';
import { docKindLabel, getLang, severityLabel, statusLabel, t, vitalLabelAr } from '../i18n.js';

type FeedKind = 'visit' | 'vital' | 'prescription' | 'test' | 'document';

interface VitalReading {
  kind: string;
  value: number;
  unit: string;
  measuredAt: string;
}

interface FeedEntry {
  at: string;
  kind: FeedKind;
  title: string;
  body: string;
  /** Feeds the "filter" chips; empty means it shows under every filter. */
  tags: string[];
}

/** Chart types worth a trend line. Labs and scalars read fine as plain rows. */
const TREND_KINDS: readonly string[] = [
  'systolic_bp', 'diastolic_bp', 'pulse', 'temperature',
  'fasting_glucose', 'hba1c', 'ldl', 'creatinine', 'weight', 'spo2',
];

const FILTER_ORDER: readonly FeedKind[] = ['visit', 'vital', 'prescription', 'test', 'document'];

function vitalName(kind: string): string {
  return getLang() === 'ar' ? vitalLabelAr(kind, vitalLabel(kind as VitalKind)) : vitalLabel(kind as VitalKind);
}

function timeOf(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Renders one line chart with a readable y-range.
 *
 * The y-range is padded around the data rather than pinned to zero: a glucose
 * series running 130-160 would collapse into a flat line against a 0-160 axis,
 * hiding exactly the variation the doctor is looking for.
 */
function trendSvg(points: { value: number; at: string }[], kind: string): string {
  if (points.length < 2) return '';
  const W = 320;
  const H = 72;
  const PAD = 6;

  const values = points.map((p) => p.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    // A flat series still deserves a line, so give it a nominal band.
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  } else {
    const pad = (max - min) * 0.12;
    min -= pad;
    max += pad;
  }

  const x = (i: number): number => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number): number => H - PAD - ((v - min) / (max - min)) * (H - PAD * 2);
  const coords = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);

  // Shade every out-of-range reading: the chart shows the same severity colour
  // the vitals cards use, so a spike reads as a problem and not just a shape.
  const flagged = points
    .map((p, i) => {
      // Only the abnormal severities get a dot; a normal reading is the line.
      const severity = evaluateVital({ kind: kind as VitalKind, value: p.value }).severity;
      if (severity !== 'critical' && severity !== 'warning') return '';
      const cx = x(i);
      const cy = y(p.value);
      return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="2.6" class="tl-flag tl-${severity}"></circle>`;
    })
    .join('');

  const last = points[points.length - 1] as { value: number };
  return `<svg class="tl-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(vitalName(kind))}">
    <polyline points="${coords.join(' ')}" fill="none" class="tl-line"></polyline>
    ${flagged}
    <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="3" class="tl-last"></circle>
  </svg>`;
}

function feedRow(entry: FeedEntry): string {
  return `<li class="tl-row tl-${entry.kind}">
    <div class="tl-when muted small">${esc(fmtDateTime(entry.at))}</div>
    <div class="tl-what">
      <div class="tl-title"><span class="pill tl-badge">${esc(entry.title)}</span></div>
      ${entry.body ? `<div class="tl-body">${entry.body}</div>` : ''}
    </div>
  </li>`;
}

function buildFeed(input: {
  visits: UiVisit[];
  vitals: VitalReading[];
  prescriptions: UiPrescription[];
  tests: UiRequestedTest[];
  documents: UiDocument[];
}): FeedEntry[] {
  const entries: FeedEntry[] = [];

  for (const visit of input.visits) {
    const parts = [visit.diagnosis, visit.plan, visit.notes].filter((p): p is string => Boolean(p));
    entries.push({
      at: visit.createdAt,
      kind: 'visit',
      title: visit.visitType || t('visit'),
      body: parts.map((p) => esc(p)).join('<br>'),
      tags: [],
    });
  }

  for (const vital of input.vitals) {
    entries.push({
      at: vital.measuredAt,
      kind: 'vital',
      title: vitalName(vital.kind),
      body: `<strong>${esc(String(vital.value))}</strong> ${esc(vital.unit)}`,
      tags: [vital.kind],
    });
  }

  for (const rx of input.prescriptions) {
    const items = rx.items
      .map((i) => `<strong>${esc(i.drug)}</strong> ${esc(i.dose ?? '')} ${esc(i.frequency ?? '')}`.trim())
      .join('<br>');
    const extras = [rx.notes, ...rx.diet, ...rx.exercise].filter((p): p is string => Boolean(p));
    entries.push({
      at: rx.createdAt,
      kind: 'prescription',
      title: t('prescription'),
      body: items + (extras.length > 0 ? `<br><span class="muted small">${esc(extras.join(' · '))}</span>` : ''),
      tags: [],
    });
  }

  for (const test of input.tests) {
    entries.push({
      at: test.createdAt,
      kind: 'test',
      title: test.name,
      body: `<span class="pill tl-badge">${esc(statusLabel(test.status))}</span>`,
      tags: [],
    });
  }

  for (const doc of input.documents) {
    entries.push({
      at: doc.createdAt,
      kind: 'document',
      title: docKindLabel(doc.kind) || doc.kind,
      body: esc(doc.title ?? doc.fileName),
      tags: [],
    });
  }

  // Newest first, and a stable tiebreak so equal timestamps do not reshuffle
  // the feed on every render.
  const rank = (kind: FeedKind): number => FILTER_ORDER.indexOf(kind);
  return entries
    .filter((e) => Number.isFinite(timeOf(e.at)) && e.at.length > 0)
    .sort((a, b) => {
      const diff = timeOf(b.at) - timeOf(a.at);
      if (diff !== 0) return diff;
      return rank(a.kind) - rank(b.kind);
    });
}

function trendsPanel(vitals: VitalReading[]): string {
  const groups = new Map<string, VitalReading[]>();
  for (const vital of vitals) {
    if (!TREND_KINDS.includes(vital.kind)) continue;
    const list = groups.get(vital.kind) ?? [];
    list.push(vital);
    groups.set(vital.kind, list);
  }
  if (groups.size === 0) return '';

  const cards = [...groups.entries()].map(([kind, readings]) => {
    // Oldest first so the line reads left-to-right in time.
    const points = readings
      .slice()
      .sort((a, b) => timeOf(a.measuredAt) - timeOf(b.measuredAt))
      .map((r) => ({ value: r.value, at: r.measuredAt }));
    const latest = points[points.length - 1] as { value: number; at: string };
    const first = points[0] as { value: number };
    const change = latest.value - first.value;
    const severity = evaluateVital({ kind: kind as VitalKind, value: latest.value }).severity;
    const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '=';
    return `<div class="vital-card">
      <div class="vital-top">
        <strong>${esc(vitalName(kind))}</strong>
        <span class="pill ${severity === 'critical' ? 'danger' : severity === 'warning' ? 'warn' : 'ok'}">${esc(severityLabel(severity))}</span>
      </div>
      <div class="vital-value">${esc(String(latest.value))} <small>${esc(readings[0]?.unit ?? '')}</small></div>
      <div class="muted small">${esc(arrow)} ${esc(String(change))} ${esc(getLang() === 'ar' ? 'من أول قراءة' : 'since first')}</div>
      <div class="tl-chart-wrap">${trendSvg(points, kind)}</div>
      <div class="muted small">${esc(fmtDateTime(latest.at))} · ${esc(String(points.length))} ${esc(getLang() === 'ar' ? 'قراءة' : 'readings')}</div>
    </div>`;
  });

  return `<section class="card"><h3>${esc(getLang() === 'ar' ? 'اتجاه القراءات' : 'Reading trends')}</h3>
    <div class="cards-grid">${cards.join('')}</div></section>`;
}

export function timelineHtml(root: HTMLElement, patientId: string): void {
  const ar = getLang() === 'ar';
  root.innerHTML = `<section class="card"><p class="muted">${esc(t('loading'))}</p></section>`;

  const [visits, vitals, prescriptions, tests, documents] = readAll(patientId);

  void Promise.all([visits, vitals, prescriptions, tests, documents])
    .then(([visitRows, vitalRows, rxRows, testRows, docRows]) => {
      const entries = buildFeed({
        visits: visitRows,
        vitals: vitalRows,
        prescriptions: rxRows,
        tests: testRows,
        documents: docRows,
      });
      root.innerHTML =
        `<section class="card">
          <h3>${esc(ar ? 'الخط الزمني السريري' : 'Clinical timeline')}</h3>
          <p class="muted">${esc(
            ar
              ? 'ملخّص زمني للزيارات والقراءات والروشتات والتحاليل والمستندات.'
              : 'One chronological view of visits, readings, prescriptions, tests and documents.',
          )}</p>
          <div class="row tl-filters" id="tl-filters">
            <button data-filter="all" class="primary">${esc(ar ? 'الكل' : 'All')}</button>
            ${FILTER_ORDER.map(
              (kind) => `<button data-filter="${kind}">${esc(feedLabel(kind))}</button>`,
            ).join('')}
          </div>
          <ul class="list tl-feed" id="tl-feed">${entries.map(feedRow).join('')}</ul>
        </section>` +
        trendsPanel(vitalRows);

      const feed = root.querySelector('#tl-feed') as HTMLElement | null;
      root.querySelectorAll<HTMLButtonElement>('#tl-filters button').forEach((button) => {
        button.addEventListener('click', () => {
          root.querySelectorAll('#tl-filters button').forEach((b) => b.classList.remove('primary'));
          button.classList.add('primary');
          const filter = button.dataset.filter ?? 'all';
          const rows = entries.map((entry) => ({ entry, row: feedRow(entry) }));
          if (!feed) return;
          feed.innerHTML =
            filter === 'all'
              ? rows.map((r) => r.row).join('')
              : rows.filter((r) => r.entry.kind === filter).map((r) => r.row).join('');
        });
      });
    })
    .catch((error: unknown) => {
      root.innerHTML = `<section class="card"><p class="muted">${esc(errorText(error))}</p></section>`;
      toast(errorText(error), 'error');
    });
}

/** Kick every read off together so the feed renders on the slowest one. */
function readAll(patientId: string): [Promise<UiVisit[]>, Promise<VitalReading[]>, Promise<UiPrescription[]>, Promise<UiRequestedTest[]>, Promise<UiDocument[]>] {
  return [
    visitsAll(patientId),
    vitalsAll(patientId),
    // All statuses, not just active: the point is the whole history, and a
    // completed course is part of it.
    rxList(patientId).catch(() => [] as UiPrescription[]),
    testsList(patientId).catch(() => [] as UiRequestedTest[]),
    docsForPatient(patientId).catch(() => [] as UiDocument[]),
  ];
}

function feedLabel(kind: FeedKind): string {
  const ar = getLang() === 'ar';
  switch (kind) {
    case 'visit':
      return ar ? 'الزيارات' : 'Visits';
    case 'vital':
      return ar ? 'القراءات' : 'Readings';
    case 'prescription':
      return ar ? 'الروشتات' : 'Prescriptions';
    case 'test':
      return ar ? 'التحاليل' : 'Tests';
    case 'document':
      return ar ? 'المستندات' : 'Documents';
  }
}
