/**
 * Database abstractions для validation modules.
 *
 * Defines minimal interfaces для query execution, без direct dependency
 * на pg/postgres library у source code. Production wires real pg.Pool
 * через ці interfaces; tests provide mock objects з vi.fn().
 *
 * Why minimal local types instead of importing з pg:
 *   1. Validation modules не залежать від specific pg library —
 *      легше swap drivers (postgres-js, pg, etc.) якщо знадобиться
 *   2. Tests не потребують pg installed — mock objects fulfill interface
 *   3. Швидший compile time, менший test bundle
 *
 * Real pg.Pool satisfies QueryablePool automatically через structural typing
 * — тобто у production main.ts просто передаємо pg.Pool у constructor,
 * без casts і без adapters.
 */

export interface QueryResultRow {
  [column: string]: unknown;
}

export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
  rows: R[];
  rowCount?: number | null;
}

export interface QueryablePool {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}
