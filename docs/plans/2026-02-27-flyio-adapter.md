# @sandbank/flyio Adapter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a Fly.io Machines API adapter for the sandbank SDK, matching the same interface pattern as `@sandbank/daytona`.

**Architecture:** Pure REST client (`fetch`) wrapping Fly.io Machines API (`https://api.machines.dev/v1`). `FlyioAdapter` implements `SandboxAdapter`, `FlyioSandbox` wraps per-machine state into `AdapterSandbox`. Capabilities: `volumes` + `port.expose`. No external dependencies — only `@sandbank/core`.

**Tech Stack:** TypeScript 5.7, ESM, pnpm workspace, Vitest 4

---

### Task 1: Scaffold the package

**Files:**
- Create: `packages/flyio/package.json`
- Create: `packages/flyio/tsconfig.json`
- Create: `packages/flyio/src/index.ts` (empty placeholder)

**Step 1: Create package.json**

```json
{
  "name": "@sandbank/flyio",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@sandbank/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.3"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "noEmit": false
  },
  "include": ["src"]
}
```

**Step 3: Create src/index.ts placeholder**

```typescript
// @sandbank/flyio — Fly.io Machines adapter
```

**Step 4: Install dependencies**

Run: `cd /Users/turing/Codes/sandbank.dev && pnpm install`
Expected: lockfile updated, packages linked

**Step 5: Verify typecheck**

Run: `cd /Users/turing/Codes/sandbank.dev && pnpm --filter @sandbank/flyio typecheck`
Expected: PASS (empty file, no errors)

**Step 6: Commit**

```bash
git add packages/flyio/
git commit -m "chore: scaffold @sandbank/flyio package"
```

---

### Task 2: Fly.io API types

**Files:**
- Create: `packages/flyio/src/types.ts`

**Step 1: Write Fly.io API type definitions**

These types model the Fly.io Machines REST API responses. Derived from the Fly.io Machines API docs.

```typescript
/** Fly.io Machines API response types */

export interface FlyioMachine {
  id: string
  name: string
  state: string
  region: string
  instance_id: string
  private_ip: string
  image_ref: {
    registry: string
    repository: string
    tag: string
    digest: string
  }
  created_at: string
  config: FlyioMachineConfig
}

export interface FlyioMachineConfig {
  image: string
  env?: Record<string, string>
  guest?: {
    cpu_kind?: string
    cpus?: number
    memory_mb?: number
  }
  services?: FlyioService[]
  mounts?: Array<{ volume: string; path: string }>
  auto_destroy?: boolean
  restart?: { policy: string }
}

export interface FlyioService {
  internal_port: number
  protocol?: string
  ports: Array<{
    port: number
    handlers: string[]
    tls_options?: { alpn: string[] }
  }>
  autostop?: string
  autostart?: boolean
}

export interface FlyioVolume {
  id: string
  name: string
  region: string
  size_gb: number
  state: string
  attached_machine_id: string | null
  created_at: string
}

export interface FlyioExecResult {
  stdout: string
  stderr: string
  exit_code: number
}

/** Adapter configuration */
export interface FlyioAdapterConfig {
  /** Fly.io API token (from `fly tokens create`) */
  apiToken: string
  /** Fly.io app name (the machine pool's app) */
  appName: string
  /** Default region for machine/volume creation (e.g. 'nrt', 'iad') */
  region?: string
}
```

**Step 2: Typecheck**

Run: `pnpm --filter @sandbank/flyio typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/flyio/src/types.ts
git commit -m "feat(flyio): add Fly.io API type definitions"
```

---

### Task 3: Fly.io REST client

**Files:**
- Create: `packages/flyio/src/client.ts`

**Step 1: Write the failing test**

Create `packages/flyio/test/client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFlyioClient } from '../src/client.js'

// We test the client by mocking global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const client = createFlyioClient({
  apiToken: 'test-token',
  appName: 'test-app',
})

beforeEach(() => {
  mockFetch.mockReset()
})

describe('createFlyioClient', () => {
  it('sends correct auth header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'm1', state: 'started' }),
    })

    await client.getMachine('m1')

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.machines.dev/v1/apps/test-app/machines/m1')
    expect(opts.headers['Authorization']).toBe('Bearer test-token')
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'not found',
    })

    await expect(client.getMachine('bad')).rejects.toThrow('Fly.io API error 404')
  })

  it('createMachine sends correct body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'new-m',
        name: 'test',
        state: 'created',
        region: 'nrt',
        instance_id: 'i1',
        private_ip: '10.0.0.1',
        image_ref: {},
        created_at: '2026-01-01T00:00:00Z',
        config: {},
      }),
    })

    const machine = await client.createMachine({
      image: 'ubuntu:24.04',
      region: 'nrt',
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 },
    })

    expect(machine.id).toBe('new-m')
    const [, opts] = mockFetch.mock.calls[0]!
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body.config.image).toBe('ubuntu:24.04')
    expect(body.region).toBe('nrt')
  })

  it('exec wraps command in bash -c', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ stdout: 'hello\n', stderr: '', exit_code: 0 }),
    })

    const result = await client.exec('m1', 'echo hello')

    expect(result.stdout).toBe('hello\n')
    expect(result.exit_code).toBe(0)
    const [, opts] = mockFetch.mock.calls[0]!
    const body = JSON.parse(opts.body)
    expect(body.cmd).toContain('bash -c')
    expect(body.cmd).toContain('echo hello')
  })

  it('waitForState calls correct URL', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) })

    await client.waitForState('m1', 'started', 60)

    const [url] = mockFetch.mock.calls[0]!
    expect(url).toContain('/machines/m1/wait')
    expect(url).toContain('state=started')
    expect(url).toContain('timeout=60')
  })

  it('destroyMachine uses force=true', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) })

    await client.destroyMachine('m1')

    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toContain('force=true')
    expect(opts.method).toBe('DELETE')
  })

  it('createVolume sends correct body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'vol_123',
        name: 'test-vol',
        region: 'nrt',
        size_gb: 1,
        state: 'created',
        attached_machine_id: null,
        created_at: '2026-01-01T00:00:00Z',
      }),
    })

    const vol = await client.createVolume({ name: 'test-vol', region: 'nrt', sizeGB: 1 })

    expect(vol.id).toBe('vol_123')
    const [, opts] = mockFetch.mock.calls[0]!
    const body = JSON.parse(opts.body)
    expect(body.name).toBe('test-vol')
    expect(body.region).toBe('nrt')
    expect(body.size_gb).toBe(1)
  })

  it('stopMachine sends POST', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    await client.stopMachine('m1')
    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toContain('/machines/m1/stop')
    expect(opts.method).toBe('POST')
  })
})
```

**Step 2: Run test — verify it fails**

Run: `cd /Users/turing/Codes/sandbank.dev && pnpm vitest run packages/flyio/test/client.test.ts`
Expected: FAIL — `cannot find module '../src/client.js'`

**Step 3: Implement the client**

```typescript
import type {
  FlyioMachine,
  FlyioMachineConfig,
  FlyioVolume,
  FlyioExecResult,
} from './types.js'

const MACHINES_API_BASE = 'https://api.machines.dev/v1'

interface CreateMachineParams {
  image: string
  region?: string
  env?: Record<string, string>
  guest?: { cpu_kind?: string; cpus?: number; memory_mb?: number }
  services?: FlyioMachineConfig['services']
  mounts?: Array<{ volume: string; path: string }>
  autoDestroy?: boolean
  restart?: { policy: string }
}

interface CreateVolumeParams {
  name: string
  region?: string
  sizeGB?: number
}

export function createFlyioClient(config: { apiToken: string; appName: string }) {
  const { apiToken, appName } = config

  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${MACHINES_API_BASE}/apps/${appName}${path}`
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string> | undefined),
      },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Fly.io API error ${response.status}: ${body}`)
    }

    // DELETE endpoints may return empty body
    const text = await response.text()
    return (text ? JSON.parse(text) : {}) as T
  }

  return {
    async createMachine(params: CreateMachineParams): Promise<FlyioMachine> {
      return request<FlyioMachine>('/machines', {
        method: 'POST',
        body: JSON.stringify({
          region: params.region,
          config: {
            image: params.image,
            env: params.env,
            guest: params.guest,
            services: params.services,
            mounts: params.mounts,
            auto_destroy: params.autoDestroy ?? false,
            restart: params.restart,
          },
        }),
      })
    },

    async getMachine(machineId: string): Promise<FlyioMachine> {
      return request<FlyioMachine>(`/machines/${machineId}`)
    },

    async listMachines(): Promise<FlyioMachine[]> {
      return request<FlyioMachine[]>('/machines')
    },

    async startMachine(machineId: string): Promise<void> {
      await request(`/machines/${machineId}/start`, { method: 'POST' })
    },

    async stopMachine(machineId: string): Promise<void> {
      await request(`/machines/${machineId}/stop`, { method: 'POST' })
    },

    async destroyMachine(machineId: string): Promise<void> {
      await request(`/machines/${machineId}?force=true`, { method: 'DELETE' })
    },

    async waitForState(machineId: string, state: string, timeoutSeconds = 30): Promise<void> {
      await request(`/machines/${machineId}/wait?state=${state}&timeout=${timeoutSeconds}`)
    },

    async exec(machineId: string, command: string): Promise<FlyioExecResult> {
      const result = await request<FlyioExecResult>(`/machines/${machineId}/exec`, {
        method: 'POST',
        body: JSON.stringify({
          cmd: `bash -c ${JSON.stringify(command)}`,
        }),
      })
      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exit_code: result.exit_code,
      }
    },

    async createVolume(params: CreateVolumeParams): Promise<FlyioVolume> {
      return request<FlyioVolume>('/volumes', {
        method: 'POST',
        body: JSON.stringify({
          name: params.name,
          region: params.region,
          size_gb: params.sizeGB ?? 1,
        }),
      })
    },

    async deleteVolume(volumeId: string): Promise<void> {
      await request(`/volumes/${volumeId}`, { method: 'DELETE' })
    },

    async listVolumes(): Promise<FlyioVolume[]> {
      return request<FlyioVolume[]>('/volumes')
    },
  }
}

export type FlyioClient = ReturnType<typeof createFlyioClient>
```

**Step 4: Run tests — verify they pass**

Run: `cd /Users/turing/Codes/sandbank.dev && pnpm vitest run packages/flyio/test/client.test.ts`
Expected: all 7 tests PASS

**Step 5: Typecheck**

Run: `pnpm --filter @sandbank/flyio typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/flyio/src/client.ts packages/flyio/test/client.test.ts
git commit -m "feat(flyio): Fly.io Machines REST client with unit tests"
```

---

### Task 4: FlyioAdapter — core implementation

**Files:**
- Create: `packages/flyio/src/adapter.ts`
- Modify: `packages/flyio/src/index.ts`

**Step 1: Write the failing test**

Create `packages/flyio/test/adapter.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createProvider, hasCapability, withPortExpose, withVolumes } from '@sandbank/core'
import type { SandboxProvider } from '@sandbank/core'
import { FlyioAdapter } from '../src/adapter.js'

// Mock the client module
vi.mock('../src/client.js', () => ({
  createFlyioClient: vi.fn(() => mockClient),
}))

const mockClient = {
  createMachine: vi.fn(),
  getMachine: vi.fn(),
  listMachines: vi.fn(),
  startMachine: vi.fn(),
  stopMachine: vi.fn(),
  destroyMachine: vi.fn(),
  waitForState: vi.fn(),
  exec: vi.fn(),
  createVolume: vi.fn(),
  deleteVolume: vi.fn(),
  listVolumes: vi.fn(),
}

let adapter: FlyioAdapter
let provider: SandboxProvider

beforeEach(() => {
  vi.clearAllMocks()
  adapter = new FlyioAdapter({ apiToken: 'tok', appName: 'my-app', region: 'nrt' })
  provider = createProvider(adapter)
})

describe('FlyioAdapter', () => {
  // --- Identity ---

  it('has correct name', () => {
    expect(adapter.name).toBe('flyio')
  })

  it('declares volumes + port.expose capabilities', () => {
    expect(hasCapability(provider, 'volumes')).toBe(true)
    expect(hasCapability(provider, 'port.expose')).toBe(true)
    expect(hasCapability(provider, 'exec.stream')).toBe(false)
    expect(hasCapability(provider, 'snapshot')).toBe(false)
    expect(hasCapability(provider, 'terminal')).toBe(false)
    expect(hasCapability(provider, 'sleep')).toBe(false)
  })

  // --- createSandbox ---

  it('create calls createMachine + waitForState and returns running sandbox', async () => {
    mockClient.createMachine.mockResolvedValueOnce({
      id: 'fly-m1',
      name: 'test',
      state: 'created',
      region: 'nrt',
      instance_id: 'i1',
      private_ip: '10.0.0.1',
      image_ref: { registry: '', repository: 'ubuntu', tag: '24.04', digest: '' },
      created_at: '2026-01-01T00:00:00Z',
      config: { image: 'ubuntu:24.04' },
    })
    mockClient.waitForState.mockResolvedValueOnce(undefined)
    mockClient.getMachine.mockResolvedValueOnce({
      id: 'fly-m1',
      state: 'started',
      region: 'nrt',
      created_at: '2026-01-01T00:00:00Z',
      config: { image: 'ubuntu:24.04' },
    })

    const sandbox = await provider.create({ image: 'ubuntu:24.04' })

    expect(sandbox.id).toBe('fly-m1')
    expect(sandbox.state).toBe('running')
    expect(mockClient.createMachine).toHaveBeenCalledOnce()
    expect(mockClient.waitForState).toHaveBeenCalledWith('fly-m1', 'started', expect.any(Number))
  })

  it('create maps resources to guest config', async () => {
    mockClient.createMachine.mockResolvedValueOnce({
      id: 'm2', state: 'created', region: 'nrt', created_at: '2026-01-01T00:00:00Z', config: {},
    })
    mockClient.waitForState.mockResolvedValueOnce(undefined)
    mockClient.getMachine.mockResolvedValueOnce({
      id: 'm2', state: 'started', region: 'nrt', created_at: '2026-01-01T00:00:00Z', config: {},
    })

    await provider.create({ image: 'node:22', resources: { cpu: 2, memory: 2048 } })

    const params = mockClient.createMachine.mock.calls[0]![0]
    expect(params.guest.cpus).toBe(2)
    expect(params.guest.memory_mb).toBe(2048)
  })

  it('create maps volume mounts', async () => {
    mockClient.createMachine.mockResolvedValueOnce({
      id: 'm3', state: 'created', region: 'nrt', created_at: '2026-01-01T00:00:00Z', config: {},
    })
    mockClient.waitForState.mockResolvedValueOnce(undefined)
    mockClient.getMachine.mockResolvedValueOnce({
      id: 'm3', state: 'started', region: 'nrt', created_at: '2026-01-01T00:00:00Z', config: {},
    })

    await provider.create({
      image: 'ubuntu:24.04',
      volumes: [{ id: 'vol_abc', mountPath: '/data' }],
    })

    const params = mockClient.createMachine.mock.calls[0]![0]
    expect(params.mounts).toEqual([{ volume: 'vol_abc', path: '/data' }])
  })

  // --- exec ---

  it('exec maps fly result to ExecResult', async () => {
    mockClient.getMachine.mockResolvedValueOnce({
      id: 'm1', state: 'started', created_at: '2026-01-01T00:00:00Z', config: {},
    })
    mockClient.exec.mockResolvedValueOnce({
      stdout: 'hello\n', stderr: '', exit_code: 0,
    })

    const sandbox = await provider.get('m1')
    const result = await sandbox.exec('echo hello')

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello\n')
    expect(result.stderr).toBe('')
  })

  it('exec passes cwd via cd prefix', async () => {
    mockClient.getMachine.mockResolvedValueOnce({
      id: 'm1', state: 'started', created_at: '2026-01-01T00:00:00Z', config: {},
    })
    mockClient.exec.mockResolvedValueOnce({ stdout: '/tmp\n', stderr: '', exit_code: 0 })

    const sandbox = await provider.get('m1')
    await sandbox.exec('pwd', { cwd: '/tmp' })

    const command = mockClient.exec.mock.calls[0]![1]
    expect(command).toContain('cd')
    expect(command).toContain('/tmp')
  })

  // --- exposePort ---

  it('exposePort returns app URL', async () => {
    mockClient.getMachine.mockResolvedValueOnce({
      id: 'm1', state: 'started', created_at: '2026-01-01T00:00:00Z', config: {},
    })

    const sandbox = await provider.get('m1')
    const exposable = withPortExpose(sandbox)
    expect(exposable).not.toBeNull()

    const { url } = await exposable!.exposePort(8080)
    expect(url).toContain('my-app.fly.dev')
  })

  // --- destroySandbox ---

  it('destroy calls destroyMachine', async () => {
    mockClient.destroyMachine.mockResolvedValueOnce(undefined)
    await provider.destroy('m1')
    expect(mockClient.destroyMachine).toHaveBeenCalledWith('m1')
  })

  it('destroy is idempotent — 404 does not throw', async () => {
    mockClient.destroyMachine.mockRejectedValueOnce(new Error('Fly.io API error 404: not found'))
    await expect(provider.destroy('gone')).resolves.toBeUndefined()
  })

  // --- State mapping ---

  it('maps fly machine states to sandbank states', async () => {
    const cases: Array<[string, string]> = [
      ['created', 'creating'],
      ['starting', 'creating'],
      ['started', 'running'],
      ['stopped', 'stopped'],
      ['stopping', 'stopped'],
      ['suspended', 'stopped'],
      ['destroyed', 'terminated'],
      ['destroying', 'terminated'],
      ['failed', 'error'],
    ]

    for (const [flyState, expected] of cases) {
      mockClient.getMachine.mockResolvedValueOnce({
        id: `m-${flyState}`, state: flyState, created_at: '2026-01-01T00:00:00Z', config: {},
      })
      const sandbox = await provider.get(`m-${flyState}`)
      expect(sandbox.state).toBe(expected)
    }
  })

  // --- listSandboxes ---

  it('list returns mapped SandboxInfo[]', async () => {
    mockClient.listMachines.mockResolvedValueOnce([
      {
        id: 'm1', state: 'started', region: 'nrt',
        created_at: '2026-01-01T00:00:00Z',
        config: { image: 'ubuntu:24.04' },
        image_ref: { repository: 'ubuntu', tag: '24.04' },
      },
      {
        id: 'm2', state: 'stopped', region: 'iad',
        created_at: '2026-01-02T00:00:00Z',
        config: { image: 'node:22' },
        image_ref: { repository: 'node', tag: '22' },
      },
    ])

    const list = await provider.list()
    expect(list).toHaveLength(2)
    expect(list[0]!.id).toBe('m1')
    expect(list[0]!.state).toBe('running')
    expect(list[1]!.state).toBe('stopped')
  })

  it('list with state filter', async () => {
    mockClient.listMachines.mockResolvedValueOnce([
      { id: 'm1', state: 'started', region: 'nrt', created_at: '2026-01-01T00:00:00Z', config: { image: 'ubuntu:24.04' }, image_ref: {} },
      { id: 'm2', state: 'stopped', region: 'nrt', created_at: '2026-01-02T00:00:00Z', config: { image: 'node:22' }, image_ref: {} },
    ])

    const running = await provider.list({ state: 'running' })
    expect(running).toHaveLength(1)
    expect(running[0]!.id).toBe('m1')
  })

  // --- Volumes ---

  it('createVolume calls client and returns VolumeInfo', async () => {
    mockClient.createVolume.mockResolvedValueOnce({
      id: 'vol_abc', name: 'test-vol', region: 'nrt', size_gb: 3,
      state: 'created', attached_machine_id: null, created_at: '2026-01-01T00:00:00Z',
    })

    const vp = withVolumes(provider)!
    const vol = await vp.createVolume({ name: 'test-vol', region: 'nrt', sizeGB: 3 })

    expect(vol.id).toBe('vol_abc')
    expect(vol.name).toBe('test-vol')
    expect(vol.sizeGB).toBe(3)
    expect(vol.attachedTo).toBeNull()
  })

  it('listVolumes maps attached_machine_id to attachedTo', async () => {
    mockClient.listVolumes.mockResolvedValueOnce([
      { id: 'vol_1', name: 'v1', region: 'nrt', size_gb: 1, state: 'created', attached_machine_id: 'm1' },
      { id: 'vol_2', name: 'v2', region: 'nrt', size_gb: 5, state: 'created', attached_machine_id: null },
    ])

    const vp = withVolumes(provider)!
    const volumes = await vp.listVolumes()
    expect(volumes).toHaveLength(2)
    expect(volumes[0]!.attachedTo).toBe('m1')
    expect(volumes[1]!.attachedTo).toBeNull()
    expect(volumes[1]!.sizeGB).toBe(5)
  })

  it('deleteVolume is idempotent — 404 does not throw', async () => {
    mockClient.deleteVolume.mockRejectedValueOnce(new Error('Fly.io API error 404: not found'))
    const vp = withVolumes(provider)!
    await expect(vp.deleteVolume('gone')).resolves.toBeUndefined()
  })
})
```

**Step 2: Run test — verify it fails**

Run: `pnpm vitest run packages/flyio/test/adapter.test.ts`
Expected: FAIL — `cannot find module '../src/adapter.js'`

**Step 3: Implement the adapter**

```typescript
import type {
  AdapterSandbox,
  Capability,
  CreateConfig,
  ExecOptions,
  ExecResult,
  ListFilter,
  SandboxAdapter,
  SandboxInfo,
  SandboxState,
  VolumeConfig,
  VolumeInfo,
} from '@sandbank/core'
import { SandboxNotFoundError, ProviderError } from '@sandbank/core'
import { createFlyioClient, type FlyioClient } from './client.js'
import type { FlyioAdapterConfig, FlyioMachine } from './types.js'

function mapState(flyState: string): SandboxState {
  switch (flyState) {
    case 'created':
    case 'starting':
      return 'creating'
    case 'started':
      return 'running'
    case 'stopped':
    case 'stopping':
    case 'suspended':
      return 'stopped'
    case 'failed':
      return 'error'
    case 'destroyed':
    case 'destroying':
      return 'terminated'
    default:
      return 'error'
  }
}

function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('404') || msg.includes('not found') || msg.includes('Not Found')
}

function wrapMachine(machine: FlyioMachine, client: FlyioClient, appName: string): AdapterSandbox {
  return {
    get id() { return machine.id },
    get state() { return mapState(machine.state) },
    get createdAt() { return machine.created_at },

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      const cmd = options?.cwd
        ? `cd ${JSON.stringify(options.cwd)} && ${command}`
        : command
      const result = await client.exec(machine.id, cmd)
      return {
        exitCode: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    },

    async exposePort(_port: number): Promise<{ url: string }> {
      return { url: `https://${appName}.fly.dev` }
    },
  }
}

export class FlyioAdapter implements SandboxAdapter {
  readonly name = 'flyio'
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'volumes',
    'port.expose',
  ])

  private readonly client: FlyioClient
  private readonly config: FlyioAdapterConfig

  constructor(config: FlyioAdapterConfig) {
    this.config = config
    this.client = createFlyioClient({
      apiToken: config.apiToken,
      appName: config.appName,
    })
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    try {
      const machine = await this.client.createMachine({
        image: config.image,
        region: config.region ?? this.config.region,
        env: config.env,
        guest: {
          cpu_kind: 'shared',
          cpus: config.resources?.cpu ?? 1,
          memory_mb: config.resources?.memory ?? 256,
        },
        services: [{
          internal_port: 8080,
          protocol: 'tcp',
          ports: [
            { port: 443, handlers: ['tls', 'http'], tls_options: { alpn: ['h2', 'http/1.1'] } },
            { port: 80, handlers: ['http'] },
          ],
          autostop: 'off',
          autostart: false,
        }],
        mounts: config.volumes?.map(v => ({ volume: v.id, path: v.mountPath })),
        autoDestroy: (config.autoDestroyMinutes ?? 0) > 0,
        restart: { policy: 'no' },
      })

      const timeout = config.timeout ?? 60
      await this.client.waitForState(machine.id, 'started', timeout)

      // Re-fetch to get up-to-date state
      const updated = await this.client.getMachine(machine.id)
      return wrapMachine(updated, this.client, this.config.appName)
    } catch (err) {
      throw new ProviderError('flyio', err)
    }
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    try {
      const machine = await this.client.getMachine(id)
      return wrapMachine(machine, this.client, this.config.appName)
    } catch (err) {
      if (isNotFound(err)) throw new SandboxNotFoundError('flyio', id)
      throw new ProviderError('flyio', err, id)
    }
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    try {
      const machines = await this.client.listMachines()

      let infos: SandboxInfo[] = machines.map(m => ({
        id: m.id,
        state: mapState(m.state),
        createdAt: m.created_at,
        image: m.config?.image ?? '',
        region: m.region,
      }))

      if (filter?.state) {
        const states = Array.isArray(filter.state) ? filter.state : [filter.state]
        infos = infos.filter(s => states.includes(s.state))
      }
      if (filter?.limit) {
        infos = infos.slice(0, filter.limit)
      }

      return infos
    } catch (err) {
      throw new ProviderError('flyio', err)
    }
  }

  async destroySandbox(id: string): Promise<void> {
    try {
      await this.client.destroyMachine(id)
    } catch (err) {
      if (isNotFound(err)) return
      throw new ProviderError('flyio', err, id)
    }
  }

  // --- Volume operations ---

  async createVolume(config: VolumeConfig): Promise<VolumeInfo> {
    try {
      const vol = await this.client.createVolume({
        name: config.name,
        region: config.region ?? this.config.region,
        sizeGB: config.sizeGB,
      })
      return {
        id: vol.id,
        name: vol.name,
        sizeGB: vol.size_gb,
        attachedTo: vol.attached_machine_id,
      }
    } catch (err) {
      throw new ProviderError('flyio', err)
    }
  }

  async deleteVolume(id: string): Promise<void> {
    try {
      await this.client.deleteVolume(id)
    } catch (err) {
      if (isNotFound(err)) return
      throw new ProviderError('flyio', err)
    }
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    try {
      const volumes = await this.client.listVolumes()
      return volumes.map(v => ({
        id: v.id,
        name: v.name,
        sizeGB: v.size_gb,
        attachedTo: v.attached_machine_id,
      }))
    } catch (err) {
      throw new ProviderError('flyio', err)
    }
  }
}
```

**Step 4: Update index.ts**

```typescript
export { FlyioAdapter } from './adapter.js'
export type { FlyioAdapterConfig } from './types.js'
```

**Step 5: Run tests — verify they pass**

Run: `pnpm vitest run packages/flyio/test/adapter.test.ts`
Expected: all tests PASS

**Step 6: Run all project tests**

Run: `pnpm vitest run`
Expected: existing tests still PASS, new tests PASS

**Step 7: Typecheck entire project**

Run: `pnpm typecheck`
Expected: PASS

**Step 8: Commit**

```bash
git add packages/flyio/src/adapter.ts packages/flyio/src/index.ts packages/flyio/test/adapter.test.ts
git commit -m "feat(flyio): FlyioAdapter implementing SandboxAdapter with volumes + port.expose"
```

---

### Task 5: Wire into conformance tests

**Files:**
- Modify: `vitest.conformance.config.ts`
- Modify: `test/conformance/conformance.test.ts`

**Step 1: Add flyio alias to conformance config**

In `vitest.conformance.config.ts`, add alias:

```typescript
'@sandbank/flyio': path.resolve(__dirname, 'packages/flyio/src/index.ts'),
```

**Step 2: Add Fly.io provider to conformance test**

In `test/conformance/conformance.test.ts`, after the Cloudflare block (~line 46), add:

```typescript
if (process.env.FLY_API_TOKEN && process.env.FLY_APP_NAME) {
  const { FlyioAdapter } = await import('@sandbank/flyio')
  const adapter = new FlyioAdapter({
    apiToken: process.env.FLY_API_TOKEN,
    appName: process.env.FLY_APP_NAME,
    region: process.env.FLY_REGION,
  })
  providers.push({ name: 'flyio', provider: createProvider(adapter) })
}
```

Update the skip message at bottom (~line 292) to mention `FLY_API_TOKEN`:

```typescript
it('no providers configured — set DAYTONA_API_KEY, E2E_WORKER_URL, and/or FLY_API_TOKEN + FLY_APP_NAME', () => {
```

**Step 3: Run conformance tests (without env vars — should skip gracefully)**

Run: `pnpm test:conformance`
Expected: Fly.io tests skipped (no FLY_API_TOKEN), existing behavior unchanged

**Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add vitest.conformance.config.ts test/conformance/conformance.test.ts
git commit -m "test(flyio): wire FlyioAdapter into conformance test suite"
```

---

### Task 6: Final verification

**Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS across all packages

**Step 2: Full unit test suite**

Run: `pnpm test`
Expected: all existing + new tests PASS

**Step 3: Build all packages**

Run: `pnpm build`
Expected: PASS, `packages/flyio/dist/` generated

**Step 4: Verify dist exports**

Run: `ls packages/flyio/dist/`
Expected: `index.js`, `index.d.ts`, `adapter.js`, `adapter.d.ts`, `client.js`, `client.d.ts`, `types.js`, `types.d.ts`

**Step 5: Commit if any final fixups**

Only if needed — otherwise skip.
