/**
 * Who may use the cloud devices. The product decides; Sandbank Cloud only checks the tenant key.
 *
 * Modes (one env value, e.g. CLOUD_COMPUTER_ACCESS):
 * - "all": every user (stage).
 * - "allowlist" (default): only users the product's list names.
 * - "off": nobody.
 * Tools should stay hidden from everyone else, and their calls be refused.
 */

export type AccessMode = 'all' | 'allowlist' | 'off'

export function accessMode(value: string | undefined | null): AccessMode {
  const mode = (value ?? '').trim().toLowerCase()
  return mode === 'all' || mode === 'off' ? mode : 'allowlist'
}

/** Whether `owner` may use the devices under `mode`; `listed` is asked only in allowlist mode. */
export async function deviceAccessAllowed(
  mode: AccessMode,
  owner: string,
  listed: (owner: string) => Promise<boolean>,
): Promise<boolean> {
  if (mode !== 'allowlist') return mode === 'all'
  if (!owner) return false
  return listed(owner)
}

/** The few D1 methods the allowlist uses (structurally compatible with Cloudflare's D1Database). */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>
      run(): Promise<{ meta?: { changes?: number } }>
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>
    }
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * An allowlist in a D1 table with columns (user_id TEXT PRIMARY KEY, note TEXT, granted_at TEXT, revoked_at TEXT).
 * `createTableSql` is the migration for it.
 */
export function d1Allowlist(db: D1Like, table = 'cloud_computer_access') {
  if (!IDENTIFIER.test(table)) throw new Error(`bad table name ${table}`)
  return {
    createTableSql: `CREATE TABLE IF NOT EXISTS ${table} (
  user_id TEXT PRIMARY KEY,
  note TEXT,
  granted_at TEXT NOT NULL,
  revoked_at TEXT
);`,
    async has(owner: string): Promise<boolean> {
      if (!owner) return false
      const row = await db.prepare(`SELECT 1 AS ok FROM ${table} WHERE user_id = ? AND revoked_at IS NULL`).bind(owner).first<{ ok: number }>()
      return Boolean(row)
    },
    async grant(owner: string, note: string | null = null): Promise<void> {
      await db.prepare(
        `INSERT INTO ${table} (user_id, note, granted_at, revoked_at) VALUES (?, ?, ?, NULL)
         ON CONFLICT(user_id) DO UPDATE SET note = COALESCE(excluded.note, ${table}.note), revoked_at = NULL`,
      ).bind(owner, note, new Date().toISOString()).run()
    },
    async revoke(owner: string): Promise<boolean> {
      const result = await db.prepare(`UPDATE ${table} SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
        .bind(new Date().toISOString(), owner).run()
      return (result.meta?.changes ?? 0) > 0
    },
    async list(): Promise<Array<{ userId: string; note: string | null; grantedAt: string; revokedAt: string | null }>> {
      const { results } = await db.prepare(`SELECT user_id, note, granted_at, revoked_at FROM ${table} ORDER BY granted_at`).bind()
        .all<{ user_id: string; note: string | null; granted_at: string; revoked_at: string | null }>()
      return (results ?? []).map((row) => ({ userId: row.user_id, note: row.note, grantedAt: row.granted_at, revokedAt: row.revoked_at }))
    },
  }
}
