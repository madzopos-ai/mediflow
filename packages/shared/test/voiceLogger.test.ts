/**
 * P2 voice summarizer + P1 structured logger: bilingual structuring and
 * secret redaction. The safety property under test: nothing clinical is ever
 * dropped silently into the wrong bucket, and no token-like value is logged.
 */

import { describe, expect, it, vi } from 'vitest';

import { summarizeDictation } from '../src/clinical/voiceSummary.js';
import { createLogger, redact, setErrorReporter } from '../src/core/logger.js';

describe('summarizeDictation', () => {
  it('extracts an Arabic diagnosis line', () => {
    const summary = summarizeDictation('المريض يشكو من صداع\nالتشخيص: صداع نصفي');
    expect(summary.diagnosis).toBe('صداع نصفي');
  });

  it('extracts an English diagnosis line', () => {
    const summary = summarizeDictation('fever 3 days\nDiagnosis: viral pharyngitis');
    expect(summary.diagnosis).toBe('viral pharyngitis');
  });

  it('classifies dose lines as medications (ar + en)', () => {
    const summary = summarizeDictation('ميتفورمين 500 ملغ مرتين يوميا\nparacetamol 500mg twice daily');
    expect(summary.medications).toHaveLength(2);
    expect(summary.labOrders).toHaveLength(0);
  });

  it('classifies test names as lab orders', () => {
    const summary = summarizeDictation('اطلب تحليل سكري تراكمي\nHbA1c and creatinine test');
    expect(summary.labOrders.length).toBeGreaterThan(0);
    expect(summary.medications).toHaveLength(0);
  });

  it('returns empty buckets for unstructured chatter', () => {
    const summary = summarizeDictation('المريض بحالة جيدة والحمد لله');
    expect(summary).toEqual({
      diagnosis: null,
      medications: [],
      prescriptions: [],
      vitals: [],
      labOrders: [],
    });
  });
});

describe('logger', () => {
  it('redacts token-like keys at any depth', () => {
    const out = redact({ user: 'ali', token: 'abc', nested: { password: 'x', ok: 1 } }) as Record<string, unknown>;
    expect(out['user']).toBe('ali');
    expect(out['token']).toBe('[redacted]');
    expect((out['nested'] as Record<string, unknown>)['password']).toBe('[redacted]');
    expect((out['nested'] as Record<string, unknown>)['ok']).toBe(1);
  });

  it('forwards error() to the reporter without throwing', () => {
    const seen: string[] = [];
    setErrorReporter((report) => {
      seen.push(report.message);
    });
    const log = createLogger('test');
    expect(() => log.error('boom', { token: 'secret-value' })).not.toThrow();
    expect(seen).toEqual(['boom']);
    setErrorReporter(null);
  });

  it('does not call the reporter for info()', () => {
    const spy = vi.fn();
    setErrorReporter(spy);
    createLogger('test').info('hello');
    expect(spy).not.toHaveBeenCalled();
    setErrorReporter(null);
  });
});
