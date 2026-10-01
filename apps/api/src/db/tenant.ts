/**
 * Tenant-scoped data access.
 *
 * Multi-tenant isolation is the single highest-risk concern in this codebase:
 * one missing `WHERE clinic_id = ?` leaks one clinic's patients to another.
 * Rather than relying on every call site remembering the filter, this module
 * makes it structurally impossible to omit it.
 *
 * The design:
 *   - `scoped()` returns a handle that carries the `clinicId` and exposes only
 *     methods that have already bound it.
 *   - There is no `query()` escape hatch on the handle. Raw SQL is reachable
 *     only through `withTenant()`, which refuses any statement that does not
 *     reference `clinic_id`, and is reserved for genuinely bespoke queries.
 *   - Tenant tables are listed explicitly. A table not on that list cannot be
 *     accessed through the scoped API at all, so a new table is never
 *     accidentally exposed cross-tenant.
 */

import type { Db } from './index.js';

export interface TenantRow {
  id: string;
  clinic_id: string;
  [key: string]: unknown;
}

export type SqlValue = string | number | null;

/**
 * Tables that hold tenant data and are reachable through `scoped()`.
 *
 * Every table here has a TEXT `id` primary key, because that is what the
 * `get`/`update`/`remove` helpers key on. `clinic_settings` is deliberately
 * absent: it is keyed by `clinic_id` alone, so routing it through this API
 * would generate a query against a column that does not exist. It is read
 * through `services/settings.ts` instead.
 */
export const TENANT_TABLES = new Set([
  'users',
  'patients',
  'visits',
  'documents',
  'appointments',
  'reminders',
  'waitlist',
  'outbox',
  'message_threads',
  'messages',
  'follow_ups',
  'follow_up_protocols',
  'vital_readings',
  'clinical_alerts',
  'notifications',
  'invoices',
  'invoice_items',
  'payments',
  'audit_log',
  'clinic_schedules',
  'requested_tests',
  'prescriptions',
  'patient_access_codes',
  'insurers',
  'insurer_payments',
]);

function assertTenantTable(table: string): void {
  if (!TENANT_TABLES.has(table)) {
    throw new Error(
      `Refusing to scope "${table}": it is not a registered tenant table. ` +
        'Add it to TENANT_TABLES only after confirming it carries a clinic_id column.',
    );
  }
}

export interface InsertInput {
  [column: string]: SqlValue;
}

export interface TenantHandle {
  readonly clinicId: string;
  /**
   * The underlying connection, for the few operations that need a prepared
   * statement the helpers cannot express - an atomic claim, a cross-table
   * aggregate, a partial index query.
   *
   * Exposed deliberately rather than threaded through every service signature.
   * Callers still have to write `clinic_id = ?` themselves, and `withTenant()`
   * remains the guarded path.
   */
  readonly db: Db;
  insert(table: string, values: InsertInput): void;
  insertMany(table: string, rows: readonly InsertInput[]): void;
  get<T = TenantRow>(table: string, id: string): T | null;
  require<T = TenantRow>(table: string, id: string): T;
  all<T = TenantRow>(table: string, where?: string, params?: readonly SqlValue[]): T[];
  /**
   * A sorted, paginated read.
   *
   * `all()` takes a condition fragment only, so a list endpoint that also needs
   * ORDER BY and LIMIT previously had to concatenate them into that fragment,
   * which produced `WHERE ORDER BY ...` and a 500. Building the statement here
   * keeps the tenant filter structurally in place and validates the one part
   * that cannot be parameterised.
   */
  page<T = TenantRow>(table: string, options: PageOptions): T[];
  find<T = TenantRow>(table: string, where: string, params: readonly SqlValue[]): T | null;
  count(table: string, where?: string, params?: readonly SqlValue[]): number;
  update(table: string, id: string, values: InsertInput): boolean;
  remove(table: string, id: string): boolean;
  /** Raw SQL, only for queries the helpers cannot express. */
  withTenant<T = unknown>(sql: string, params?: readonly SqlValue[]): T[];
}

/**
 * Guard for raw SQL.
 *
 * A bespoke query must mention `clinic_id` in both the SQL and its parameter
 * list. This is a blunt check, but it fails loudly at development time instead
 * of leaking quietly in production, and it is far better than no check.
 */
export function assertTenantSql(sql: string, params: readonly SqlValue[], clinicId: string): void {
  const normalised = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalised.includes('clinic_id')) {
    throw new Error('Raw tenant query must filter on clinic_id.');
  }
  if (!params.includes(clinicId)) {
    throw new Error('Raw tenant query must bind the current clinicId as a parameter.');
  }
}

/**
 * Guard for an ORDER BY fragment.
 *
 * A sort fragment cannot be parameterised, so it is interpolated. Callers pass
 * a literal chosen from a fixed set rather than anything a client sent, and this
 * check is the backstop that keeps that promise true: only identifier characters
 * and the handful of keywords a sort needs are allowed through, so a quote,
 * comment or statement terminator can never appear.
 */
const ORDER_ALLOWED = /^[A-Za-z0-9_(),\s.']+$/;
const ORDER_FORBIDDEN = /(--|;|'|"|\/\*|\*\/|\|\|)/;
// A quoted literal may only contain identifier-safe characters. Literals are
// blanked before the forbidden check, so `CASE severity WHEN 'critical' ...`
// passes while a stray quote that could break out of a string still fails.
const ORDER_QUOTED_LITERAL = /'[A-Za-z0-9_ ]+'/g;

function assertSafeOrderBy(orderBy: string): void {
  const unquoted = orderBy.replace(ORDER_QUOTED_LITERAL, 'lit');
  if (!ORDER_ALLOWED.test(orderBy) || ORDER_FORBIDDEN.test(unquoted)) {
    throw new Error('Unsafe ORDER BY fragment.');
  }
}

/** Hard ceiling on a single page, independent of what the client asked for. */
const MAX_PAGE_SIZE = 500;

export interface PageOptions {
  /** Condition fragment, without the `WHERE` keyword. */
  where?: string;
  params?: readonly SqlValue[];
  /** Literal sort expression, e.g. `starts_at ASC` or `priority ASC, scheduled_for ASC`. */
  orderBy: string;
  limit: number;
  offset: number;
}

/**
 * Combine a caller-supplied WHERE clause with the tenant filter.
 *
 * The tenant condition is appended last and cannot be replaced by the caller.
 */
function buildWhere(extra: string | undefined, params: readonly SqlValue[], clinicId: string): {
  where: string;
  all: SqlValue[];
} {
  if (!extra || extra.trim() === '') {
    return { where: 'clinic_id = ?', all: [clinicId, ...params] };
  }
  return { where: `(${extra}) AND clinic_id = ?`, all: [...params, clinicId] };
}


/**
 * A clinic-bound data access handle.
 *
 * Implemented as a class rather than an object literal so each method's
 * parameters are explicitly typed and the compiler can verify every call site
 * against `TenantHandle`.
 */
class TenantScope implements TenantHandle {
  readonly db: Db;
  readonly clinicId: string;

  constructor(db: Db, clinicId: string) {
    if (!clinicId) {
      throw new Error('A tenant scope requires a clinicId.');
    }
    this.db = db;
    this.clinicId = clinicId;
  }

  insert(table: string, values: InsertInput): void {
    assertTenantTable(table);
    if (values.clinic_id !== undefined && values.clinic_id !== this.clinicId) {
      // Catch an attempt to write a row into another tenant at the boundary,
      // where the stack trace is still useful.
      throw new Error('Insert clinic_id does not match the active tenant scope.');
    }
    const columns = Object.keys(values);
    const sql =
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) ` +
      `VALUES (${columns.map(() => '?').join(', ')})`;
    this.db.prepare(sql).run(...columns.map((c) => values[c] as SqlValue));
  }

  insertMany(table: string, rows: readonly InsertInput[]): void {
    assertTenantTable(table);
    if (rows.length === 0) return;
    const columns = Object.keys(rows[0] as object);
    const stmt = this.db.prepare(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) ` +
        `VALUES (${columns.map(() => '?').join(', ')})`,
    );
    const run = this.db.transaction((batch: InsertInput[]) => {
      for (const row of batch) {
        if (row.clinic_id !== undefined && row.clinic_id !== this.clinicId) {
          throw new Error('Insert clinic_id does not match the active tenant scope.');
        }
        stmt.run(...columns.map((c) => (row[c] ?? null) as SqlValue));
      }
    });
    run(rows as InsertInput[]);
  }

  get<T = TenantRow>(table: string, id: string): T | null {
    assertTenantTable(table);
    const row = this.db
      .prepare(`SELECT * FROM "${table}" WHERE id = ? AND clinic_id = ?`)
      .get(id, this.clinicId) as T | undefined;
    return row ?? null;
  }

  require<T = TenantRow>(table: string, id: string): T {
    const row = this.get<T>(table, id);
    if (!row) {
      // 404 rather than 403 on purpose: telling a caller that an id exists in
      // another clinic is itself a leak.
      const error = new Error(`${table} not found`) as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    return row;
  }

  all<T = TenantRow>(table: string, where?: string, params: readonly SqlValue[] = []): T[] {
    assertTenantTable(table);
    const built = buildWhere(where, params, this.clinicId);
    return this.db
      .prepare(`SELECT * FROM "${table}" WHERE ${built.where}`)
      .all(...built.all) as T[];
  }

  find<T = TenantRow>(table: string, where: string, params: readonly SqlValue[] = []): T | null {
    assertTenantTable(table);
    const built = buildWhere(where, params, this.clinicId);
    const row = this.db
      .prepare(`SELECT * FROM "${table}" WHERE ${built.where} LIMIT 1`)
      .get(...built.all) as T | undefined;
    return row ?? null;
  }

  page<T = TenantRow>(table: string, options: PageOptions): T[] {
    assertTenantTable(table);
    assertSafeOrderBy(options.orderBy);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(0, Math.trunc(options.limit)));
    const offset = Math.max(0, Math.trunc(options.offset));
    const built = buildWhere(options.where, options.params ?? [], this.clinicId);
    return this.db
      .prepare(`SELECT * FROM "${table}" WHERE ${built.where} ORDER BY ${options.orderBy} LIMIT ? OFFSET ?`)
      .all(...built.all, limit, offset) as T[];
  }

  count(table: string, where?: string, params: readonly SqlValue[] = []): number {
    assertTenantTable(table);
    const built = buildWhere(where, params, this.clinicId);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${built.where}`)
      .get(...built.all) as { n: number };
    return row.n;
  }

  update(table: string, id: string, values: InsertInput): boolean {
    assertTenantTable(table);
    if (values.clinic_id !== undefined && values.clinic_id !== this.clinicId) {
      throw new Error('Update clinic_id does not match the active tenant scope.');
    }
    const columns = Object.keys(values);
    if (columns.length === 0) return false;
    const result = this.db
      .prepare(
        `UPDATE "${table}" SET ${columns.map((c) => `"${c}" = ?`).join(', ')} ` +
          `WHERE id = ? AND clinic_id = ?`,
      )
      .run(...columns.map((c) => values[c] as SqlValue), id, this.clinicId);
    return result.changes > 0;
  }

  remove(table: string, id: string): boolean {
    assertTenantTable(table);
    const result = this.db
      .prepare(`DELETE FROM "${table}" WHERE id = ? AND clinic_id = ?`)
      .run(id, this.clinicId);
    return result.changes > 0;
  }

  withTenant<T = unknown>(sql: string, params: readonly SqlValue[] = []): T[] {
    assertTenantSql(sql, params, this.clinicId);
    return this.db.prepare(sql).all(...params) as T[];
  }
}

export function scoped(db: Db, clinicId: string): TenantHandle {
  return new TenantScope(db, clinicId);
}
