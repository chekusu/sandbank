import type { SkillDefinition } from '@sandbank.dev/core'

export const BRAIN_SKILL = `# brain — 共享记忆系统

你正在一个多 Agent 协作环境中工作。你有一个共享数据库用于记忆和任务协调。

## 环境变量
- \$DATABASE_URL — PostgreSQL 连接串

## 写入记忆
在发现重要信息时，写入 memory 表：
\`\`\`sql
INSERT INTO memory (agent, scope, kind, content)
VALUES ('你的角色', 'task:当前任务ID', 'fact|decision|question|blocker', '内容');
\`\`\`

## 查询记忆
开始工作前，先查看其他 Agent 的发现：
\`\`\`sql
SELECT agent, kind, content FROM memory
WHERE scope = 'task:当前任务ID' AND superseded_by IS NULL
ORDER BY created_at;
\`\`\`

## 语义搜索记忆
\`\`\`sql
SELECT content, agent, kind FROM memory
WHERE superseded_by IS NULL
ORDER BY embedding <=> $query_embedding
LIMIT 10;
\`\`\`

## 认领任务
\`\`\`sql
UPDATE tasks SET status = 'claimed', claimed_by = '你的角色', claimed_at = now()
WHERE id = (
  SELECT id FROM tasks
  WHERE status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(depends_on) dep JOIN tasks t ON t.id = dep WHERE t.status != 'done'
    )
  ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
) RETURNING *;
\`\`\`

## 完成任务
\`\`\`sql
UPDATE tasks SET status = 'done', result = '{"summary":"..."}' WHERE id = 当前任务ID;
\`\`\`

## 注册产出物
\`\`\`sql
INSERT INTO artifacts (task_id, agent, kind, path, content)
VALUES (当前任务ID, '你的角色', 'code|analysis|config', '/path/to/file', '内容摘要');
\`\`\`
`

export function brainSkillDefinition(): SkillDefinition {
  return { name: 'brain', content: BRAIN_SKILL }
}
