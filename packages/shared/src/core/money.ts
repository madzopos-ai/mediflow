/**
 * Money handling.
 * All persisted amounts are integer minor units (e.g. piastres, cents) to avoid
 * floating point drift. `Money` is a value object used at the edges.
 */

export const MINOR_UNITS_PER_MAJOR = 100;

export interface Money {
  /** Integer minor units. */
  minor: number;
  currency: string;
}

export function money(minor: number, currency = 'USD'): Money {
  if (!Number.isFinite(minor)) {
    throw new TypeError('money() requires a finite amount');
  }
  if (!Number.isInteger(minor)) {
    throw new TypeError('money() requires integer minor units');
  }
  return { minor, currency: currency.toUpperCase() };
}

export function fromMajor(amount: number, currency = 'USD'): Money {
  return money(Math.round(amount * MINOR_UNITS_PER_MAJOR), currency);
}

export function toMajor(m: Money): number {
  return m.minor / MINOR_UNITS_PER_MAJOR;
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function sumMoney(items: readonly Money[], currency = 'USD'): Money {
  return money(items.reduce((acc, m) => acc + m.minor, 0), currency);
}

export function multiplyMoney(m: Money, factor: number): Money {
  return money(Math.round(m.minor * factor), m.currency);
}

export function applyPercent(m: Money, percent: number): Money {
  return money(Math.round((m.minor * percent) / 100), m.currency);
}

export function clampMoney(m: Money, min: Money, max: Money): Money {
  assertSameCurrency(m, min);
  assertSameCurrency(m, max);
  return money(Math.min(Math.max(m.minor, min.minor), max.minor), m.currency);
}

export function isZeroMoney(m: Money): boolean {
  return m.minor === 0;
}

export function isNegativeMoney(m: Money): boolean {
  return m.minor < 0;
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  EGP: 'E£',
  SAR: 'SAR',
  AED: 'AED',
  KWD: 'KD',
  QAR: 'QR',
  BHD: 'BD',
  OMR: 'OMR',
  JOD: 'JD',
  EUR2: '€',
  INR: '₹',
  PKR: '₨',
  LYD: 'LD',
  TND: 'DT',
  DZD: 'DA',
  MAD: 'MAD',
};

export function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency.toUpperCase()] ?? currency.toUpperCase();
}

const CURRENCY_DECIMALS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
};

export function currencyDecimals(currency: string): number {
  return CURRENCY_DECIMALS[currency.toUpperCase()] ?? 2;
}

/**
 * Format minor units for display. Uses `Intl` when the runtime supports the
 * currency, and falls back to a manual format otherwise (important for
 * zero-decimal currencies and unusual codes).
 */
export function formatMoney(minor: number, currency = 'USD', locale = 'en-US'): string {
  const decimals = currencyDecimals(currency);
  const value = minor / 10 ** decimals;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    return `${currencySymbol(currency)}${value.toFixed(decimals)}`;
  }
}

export function formatSignedMoney(minor: number, currency = 'USD', locale = 'en-US'): string {
  const sign = minor < 0 ? '-' : '+';
  return `${sign}${formatMoney(Math.abs(minor), currency, locale)}`;
}

/** Parse user input like "150", "150.50", "1,500 EGP" into minor units. */
export function parseMoneyInput(input: string, currency = 'USD'): number | null {
  const cleaned = input.replace(/[^\d.,-]/g, '').trim();
  if (!cleaned) return null;
  const normalized = normalizeDecimalSeparator(cleaned);
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return null;
  const decimals = currencyDecimals(currency);
  return Math.round(parsed * 10 ** decimals);
}

/** Handles both "1,234.56" (en) and "1.234,56" (eu) conventions. */
function normalizeDecimalSeparator(input: string): string {
  const lastComma = input.lastIndexOf(',');
  const lastDot = input.lastIndexOf('.');
  if (lastComma === -1 && lastDot === -1) return input;
  if (lastComma > lastDot) {
    return input.replace(/\./g, '').replace(',', '.');
  }
  return input.replace(/,/g, '');
}
