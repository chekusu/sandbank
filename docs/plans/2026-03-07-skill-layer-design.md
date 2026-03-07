# Skill Layer 设计文档

> 日期: 2026-03-07
> 范围: P0 (Skill 注入) + P1 (@sandbank/skills 注册表)

---

## 一、背景

开发者使用 sandbank 创建沙箱后，常需要注入 `.md` skill 文件来指导沙箱内的 LLM CLI（Claude Code、Cursor 等）执行特定任务。目前这一流程完全需要开发者自行管理：手动调用 `writeFile` 写入、处理路径、管理多个 skill 文件。

sandbank 应提供一等公民级别的 skill 注入能力，让开发者在 `CreateConfig` 中声明 skill，SDK 自动完成注入。

---

## 二、设计原则

1. **LLM CLI 无关** — sandbank 只负责把 `.md` 文件放到正确位置，不关心哪个 CLI 消费它
2. **单文件即 skill** — 一个 `.md` 文件就是一个完整的 skill，不需要目录结构
3. **本地优先** — 先支持本地文件系统作为 skill 来源，后续扩展远程注册表
4. **零破坏性** — 新增字段均为可选，现有代码无需任何改动

---

## 三、P0: Skill 注入

### 3.1 类型变更

在 `CreateConfig` 中新增 `skills` 字段：

```typescript
// packages/core/src/types.ts

export interface SkillDefinition {
  /** Skill 名称，用作文件名（不含 .md 后缀） */
  name: string
  /** Skill 内容（markdown 文本） */
  content: string
}

export interface CreateConfig {
  // ...现有字段...

  /**
   * 注入到沙箱的 skill 文件列表。
   * 每个 skill 会被写入沙箱的 `~/.claude/skills/` 目录。
   */
  skills?: SkillDefinition[]
}
```

### 3.2 注入逻辑

在 `provider.ts` 的 `create()` 方法中，沙箱创建成功后自动注入 skill 文件：

```typescript
// packages/core/src/skill-inject.ts

const DEFAULT_SKILL_DIR = '/root/.claude/skills'

export async function injectSkills(
  sandbox: Sandbox,
  skills: SkillDefinition[],
  skillDir?: string,
): Promise<void> {
  const dir = skillDir ?? DEFAULT_SKILL_DIR
  for (const skill of skills) {
    const path = `${dir}/${skill.name}.md`
    await sandbox.writeFile(path, skill.content)
  }
}
```

在 `provider.ts` 中调用：

```typescript
async create(config: CreateConfig): Promise<Sandbox> {
  const raw = await adapter.createSandbox(config)
  const sandbox = wrapSandbox(raw, adapter.name)

  // 注入 skills
  if (config.skills?.length) {
    await injectSkills(sandbox, config.skills)
  }

  return sandbox
}
```

### 3.3 使用示例

```typescript
import { createProvider } from '@sandbank/core'

const provider = createProvider(adapter)
const sandbox = await provider.create({
  image: 'node:22-slim',
  skills: [
    { name: 'code-review', content: '# Code Review\n\n审查代码时关注...' },
    { name: 'test-writing', content: '# Test Writing\n\n编写测试时...' },
  ],
})
```

### 3.4 涉及文件

| 文件 | 改动 |
|------|------|
| `packages/core/src/types.ts` | 新增 `SkillDefinition` 接口，`CreateConfig` 加 `skills` 字段 |
| `packages/core/src/skill-inject.ts` | 新建，`injectSkills()` 函数 |
| `packages/core/src/provider.ts` | `create()` 中调用 `injectSkills` |
| `packages/core/src/index.ts` | 导出 `SkillDefinition` 类型和 `injectSkills` |
| `packages/core/test/skill-inject.test.ts` | 新建，单元测试 |
| `packages/core/test/provider.test.ts` | 新增 skill 注入集成测试 |

---

## 四、P1: @sandbank/skills 注册表

### 4.1 概述

新建 `packages/skills` 包，提供 skill 的加载和管理能力。初期只支持本地文件系统作为来源。

### 4.2 包结构

```
packages/skills/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          # 导出
│   ├── types.ts          # SkillSource, SkillRegistry 接口
│   ├── registry.ts       # createSkillRegistry() 工厂
│   └── sources/
│       └── local.ts      # 本地文件系统 source
└── test/
    ├── registry.test.ts
    └── sources/
        └── local.test.ts
```

### 4.3 类型定义

```typescript
// packages/skills/src/types.ts

import type { SkillDefinition } from '@sandbank/core'

export interface SkillSource {
  /** Source 标识 */
  readonly name: string

  /** 按名称加载单个 skill */
  load(name: string): Promise<SkillDefinition | undefined>

  /** 列出所有可用 skill 名称 */
  list(): Promise<string[]>
}

export interface SkillRegistry {
  /** 注册一个 skill source */
  addSource(source: SkillSource): void

  /** 按名称加载 skill（按 source 注册顺序查找，首个匹配返回） */
  load(name: string): Promise<SkillDefinition | undefined>

  /** 批量加载 */
  loadMany(names: string[]): Promise<SkillDefinition[]>

  /** 列出所有可用 skill */
  list(): Promise<string[]>
}
```

### 4.4 本地文件系统 Source

```typescript
// packages/skills/src/sources/local.ts

import { readFile, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { SkillDefinition } from '@sandbank/core'
import type { SkillSource } from '../types.js'

export function createLocalSource(dir: string): SkillSource {
  return {
    name: 'local',

    async load(name: string): Promise<SkillDefinition | undefined> {
      const filePath = join(dir, `${name}.md`)
      try {
        const content = await readFile(filePath, 'utf-8')
        return { name, content }
      } catch {
        return undefined
      }
    },

    async list(): Promise<string[]> {
      try {
        const files = await readdir(dir)
        return files
          .filter(f => f.endsWith('.md'))
          .map(f => basename(f, '.md'))
      } catch {
        return []
      }
    },
  }
}
```

### 4.5 Registry 工厂

```typescript
// packages/skills/src/registry.ts

import type { SkillDefinition } from '@sandbank/core'
import type { SkillSource, SkillRegistry } from './types.js'

export function createSkillRegistry(): SkillRegistry {
  const sources: SkillSource[] = []

  return {
    addSource(source: SkillSource): void {
      sources.push(source)
    },

    async load(name: string): Promise<SkillDefinition | undefined> {
      for (const source of sources) {
        const skill = await source.load(name)
        if (skill) return skill
      }
      return undefined
    },

    async loadMany(names: string[]): Promise<SkillDefinition[]> {
      const results: SkillDefinition[] = []
      for (const name of names) {
        const skill = await this.load(name)
        if (skill) results.push(skill)
      }
      return results
    },

    async list(): Promise<string[]> {
      const all = new Set<string>()
      for (const source of sources) {
        const names = await source.list()
        for (const n of names) all.add(n)
      }
      return [...all]
    },
  }
}
```

### 4.6 使用示例

```typescript
import { createProvider } from '@sandbank/core'
import { createSkillRegistry, createLocalSource } from '@sandbank/skills'

// 创建 registry 并注册本地目录
const registry = createSkillRegistry()
registry.addSource(createLocalSource('./my-skills'))

// 从 registry 加载 skill 并注入沙箱
const skills = await registry.loadMany(['code-review', 'test-writing'])
const sandbox = await provider.create({
  image: 'node:22-slim',
  skills,
})
```

### 4.7 package.json

```json
{
  "name": "@sandbank/skills",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@sandbank/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
```

### 4.8 涉及文件

| 文件 | 改动 |
|------|------|
| `packages/skills/` | 新建整个包 |
| `pnpm-workspace.yaml` | 确认已包含 `packages/*` |

---

## 五、不做的事情

以下内容在讨论中明确排除，留待有真实使用反馈后再考虑：

- **Eval 框架** — 不做 skill 测试/度量
- **运行时同步** — 不做沙箱运行中的 skill 热更新
- **版本控制 / Canary** — 不做 skill 版本管理和灰度发布
- **远程注册表** — 初期不做 HTTP/npm 来源，仅本地文件

---

## 六、实施计划

| 步骤 | 内容 | 预计改动量 |
|------|------|-----------|
| 1 | P0: 类型 + 注入逻辑 + 测试 | ~100 行 |
| 2 | P1: skills 包 + 测试 | ~200 行 |
| 3 | 文档更新 (README) | 按需 |
