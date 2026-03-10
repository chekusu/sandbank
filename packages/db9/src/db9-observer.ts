import type { SandboxObserver, SandboxEvent } from '@sandbank.dev/core'
import type { Db9Client } from './client.js'

export const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS sandbox_events (
  id serial PRIMARY KEY,
  type text NOT NULL,
  sandbox_id text NOT NULL,
  task_id text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sandbox_events_sandbox ON sandbox_events (sandbox_id);
CREATE INDEX IF NOT EXISTS idx_sandbox_events_type ON sandbox_events (type);
`

function escapeSql(str: string): string {
  return str.replace(/'/g, "''")
}

/**
 * 创建 DB9 观察者，将沙箱事件写入 sandbox_events 表。
 * 首次调用时自动初始化表结构。
 */
export function createDb9Observer(client: Db9Client, dbId: string): SandboxObserver {
  let schemaReady: Promise<void> | null = null

  function ensureSchema(): Promise<void> {
    if (!schemaReady) {
      schemaReady = client.executeSQL(dbId, EVENTS_SCHEMA).then(() => {})
    }
    return schemaReady
  }

  return {
    async onEvent(event: SandboxEvent): Promise<void> {
      await ensureSchema()
      const taskIdVal = event.taskId ? `'${escapeSql(event.taskId)}'` : 'NULL'
      const sql = `INSERT INTO sandbox_events (type, sandbox_id, task_id, data, created_at) VALUES ('${escapeSql(event.type)}', '${escapeSql(event.sandboxId)}', ${taskIdVal}, '${escapeSql(JSON.stringify(event.data))}'::jsonb, to_timestamp(${event.timestamp / 1000}))`
      await client.executeSQL(dbId, sql)
    },
  }
}
