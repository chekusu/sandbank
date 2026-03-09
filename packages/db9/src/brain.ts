import type { Db9Client } from './client.js'

export const BRAIN_SCHEMA = `
-- 共享记忆
CREATE TABLE IF NOT EXISTS memory (
  id serial PRIMARY KEY,
  agent text NOT NULL,
  scope text NOT NULL DEFAULT 'global',
  kind text NOT NULL CHECK (kind IN ('fact','decision','question','blocker')),
  content text NOT NULL,
  embedding vector(1536),
  created_at timestamptz DEFAULT now(),
  superseded_by int REFERENCES memory(id)
);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory (scope, kind);
CREATE INDEX IF NOT EXISTS idx_memory_embedding ON memory USING hnsw (embedding vector_cosine_ops);

-- 任务协调
CREATE TABLE IF NOT EXISTS tasks (
  id serial PRIMARY KEY,
  title text NOT NULL,
  status text DEFAULT 'pending' CHECK (status IN ('pending','claimed','done','failed')),
  claimed_by text,
  claimed_at timestamptz,
  depends_on int[] DEFAULT '{}',
  result jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);

-- 产出物注册
CREATE TABLE IF NOT EXISTS artifacts (
  id serial PRIMARY KEY,
  task_id int REFERENCES tasks(id),
  agent text NOT NULL,
  kind text NOT NULL,
  path text,
  content text,
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);
`

/** 初始化 brain schema（含 pgvector 扩展） */
export async function initBrainSchema(client: Db9Client, dbId: string): Promise<void> {
  await client.executeSQL(dbId, 'CREATE EXTENSION IF NOT EXISTS vector')
  await client.executeSQL(dbId, BRAIN_SCHEMA)
}
