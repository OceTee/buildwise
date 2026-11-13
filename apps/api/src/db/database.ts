import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

/**
 * Database access. Every request runs in one transaction; signed-in requests switch to the restricted `app_user`
 * role and set `app.user_id`, so row-level security protects private data (chats, quote requests, reveals,
 * saved items, notifications, sessions) as a second layer behind the handlers (spec §7.5).
 */
export interface Sql {
  query<R = Record<string, any>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export type TxContext = { kind: 'system' } | { kind: 'user'; userId: string };

export interface Database {
  driver: 'pglite' | 'pg';
  tx<T>(ctx: TxContext, fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function one<R = Record<string, any>>(sql: Sql, text: string, params: unknown[] = []): Promise<R | null> {
  return ((await sql.query<R>(text, params)).rows[0] as R | undefined) ?? null;
}

export async function many<R = Record<string, any>>(sql: Sql, text: string, params: unknown[] = []): Promise<R[]> {
  return (await sql.query<R>(text, params)).rows;
}

export const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
export const str = (v: unknown): string | null => (v == null ? null : String(v));

async function begin(sql: Sql, ctx: TxContext) {
  if (ctx.kind === 'user') {
    await sql.query(`set local role app_user`);
    await sql.query(`select set_config('app.user_id', $1, true)`, [ctx.userId]);
  }
}

export async function createPgliteDatabase(dir: string | null): Promise<Database> {
  if (dir) mkdirSync(dirname(dir), { recursive: true });
  const db = new PGlite(dir ?? undefined);
  await db.waitReady;
  let chain = Promise.resolve();
  return {
    driver: 'pglite',
    // PGlite is single-connection: serialize transactions.
    tx<T>(ctx: TxContext, fn: (sql: Sql) => Promise<T>) {
      const run = chain.then(() => db.transaction(async (t) => {
        const sql: Sql = { query: (text, params) => t.query(text, params as any[]) as any };
        await begin(sql, ctx);
        return fn(sql);
      }));
      chain = run.then(() => undefined, () => undefined);
      return run as Promise<T>;
    },
    close: () => db.close(),
  };
}

export async function createPgDatabase(url: string): Promise<Database> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    driver: 'pg',
    async tx<T>(ctx: TxContext, fn: (sql: Sql) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const sql: Sql = { query: (text, params) => client.query(text, params as any[]) as any };
        await begin(sql, ctx);
        const out = await fn(sql);
        await client.query('commit');
        return out;
      } catch (e) {
        await client.query('rollback').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Fuzzy title matching uses pg_trgm's similarity() where the extension exists (managed Postgres). Embedded
 * PGlite builds cannot always load contrib extensions, so an equivalent pure-SQL similarity() is installed
 * instead: same trigram rules (lower-case words padded with two leading and one trailing space), no index.
 */
async function ensureTrigram(db: Database): Promise<'pg_trgm' | 'sql-fallback'> {
  try {
    await db.tx({ kind: 'system' }, (sql) => sql.query(`create extension if not exists pg_trgm`));
    await db.tx({ kind: 'system' }, (sql) => sql.query(`create index if not exists listings_title_trgm on listings using gin (title gin_trgm_ops)`).catch(() => undefined));
    return 'pg_trgm';
  } catch {
    await db.tx({ kind: 'system' }, async (sql) => {
      await sql.query(`create or replace function bw_trigrams(s text) returns setof text language sql immutable as $$
        select distinct substr(w, i, 3)
          from (select '  ' || word || ' ' as w from regexp_split_to_table(lower(coalesce(s, '')), '[^[:alnum:]]+') as word where word <> '') x,
               generate_series(1, greatest(length(w) - 2, 0)) as i
      $$`);
      await sql.query(`create or replace function similarity(a text, b text) returns real language sql immutable as $$
        select case when u.n = 0 then 0::real else (i.n::real / u.n::real) end
          from (select count(*) as n from (select bw_trigrams(a) union select bw_trigrams(b)) x) u,
               (select count(*) as n from (select bw_trigrams(a) intersect select bw_trigrams(b)) y) i
      $$`);
    });
    return 'sql-fallback';
  }
}

/** Forward-only SQL migrations, each in its own transaction, recorded in schema_migrations. */
export async function migrate(db: Database): Promise<string[]> {
  await db.tx({ kind: 'system' }, (sql) => sql.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`));
  const done = new Set((await db.tx({ kind: 'system' }, (sql) => many<{ name: string }>(sql, 'select name from schema_migrations'))).map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const text = readFileSync(join(MIGRATIONS, f), 'utf8');
    await db.tx({ kind: 'system' }, async (sql) => {
      for (const stmt of splitSql(text)) await sql.query(stmt);
      await sql.query('insert into schema_migrations (name) values ($1)', [f]);
    });
    applied.push(f);
  }
  await ensureTrigram(db);
  return applied;
}

/** Splits on semicolons outside $$-quoted bodies and strings. */
function splitSql(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let dollar = false;
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!quote && text.startsWith('$$', i)) { dollar = !dollar; cur += '$$'; i++; continue; }
    if (!dollar && c === "'") quote = !quote;
    if (!dollar && !quote && c === '-' && text[i + 1] === '-') { while (i < text.length && text[i] !== '\n') i++; cur += '\n'; continue; }
    if (c === ';' && !dollar && !quote) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
