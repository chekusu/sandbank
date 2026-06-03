import { describe, expect, it } from 'vitest'
import type {
  Capability,
  CreateConfig,
  ExecOptions,
  ExecResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
} from '@sandbank.dev/core'
import {
  MemoryWorkspaceAdapter,
  materializeWorkspaceToSandbox,
  type WorkspaceData,
} from '@sandbank.dev/workspace'
import {
  runWorkspaceSandboxTask,
  type SandboxSchedulerCapability,
} from './provider-scheduler.js'

class FakeSandbox implements Sandbox {
  readonly state = 'running' as const
  readonly createdAt = '2026-06-03T00:00:00.000Z'
  commands: string[] = []
  files = new Map<string, WorkspaceData>()
  uploadedArchive?: Uint8Array
  uploadDest?: string
  archiveToDownload?: Uint8Array
  downloadSource?: string
  onExec?: (command: string, options?: ExecOptions) => Promise<ExecResult>

  constructor(readonly id: string) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.commands.push(command)
    return this.onExec?.(command, options) ?? { stdout: '', stderr: '', exitCode: 0 }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    this.files.set(path, content)
  }

  async readFile(path: string): Promise<Uint8Array> {
    const value = this.files.get(path)
    if (value === undefined) throw new Error(`missing fake file: ${path}`)
    return typeof value === 'string' ? new TextEncoder().encode(value) : value
  }

  async uploadArchive(archive: Uint8Array | ReadableStream, destDir?: string): Promise<void> {
    this.uploadedArchive = archive instanceof Uint8Array ? archive : await streamToBytes(archive)
    this.uploadDest = destDir
  }

  async downloadArchive(srcDir?: string): Promise<ReadableStream<Uint8Array>> {
    this.downloadSource = srcDir
    const archive = this.archiveToDownload
    if (!archive) throw new Error('missing fake archive')
    return streamFromBytes(archive)
  }
}

class FakeProvider implements SandboxProvider {
  readonly capabilities: ReadonlySet<Capability>
  createConfigs: CreateConfig[] = []
  destroyed: string[] = []

  constructor(
    readonly name: string,
    readonly sandbox: FakeSandbox,
    capabilities: Capability[] = [],
  ) {
    this.capabilities = new Set(capabilities)
  }

  async create(config: CreateConfig): Promise<Sandbox> {
    this.createConfigs.push(config)
    return this.sandbox
  }

  async get(): Promise<Sandbox> {
    return this.sandbox
  }

  async list(): Promise<SandboxInfo[]> {
    return []
  }

  async destroy(id: string): Promise<void> {
    this.destroyed.push(id)
  }
}

describe('provider scheduler', () => {
  it('dispatches Dynamic Worker generated Python files to a provider with the python runtime', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'workspace-python' })
    await workspace.write('/workspace/generated/task.py', 'open("output.txt", "w").write("ok")')

    const nodeProvider = new FakeProvider('cloudflare', new FakeSandbox('node-sandbox'))
    const pythonSandbox = new FakeSandbox('python-sandbox')
    const pythonProvider = new FakeProvider('e2b', pythonSandbox)
    pythonSandbox.onExec = async () => {
      pythonSandbox.archiveToDownload = await archiveFromFiles({
        '/workspace/generated/task.py': 'open("output.txt", "w").write("ok")',
        '/workspace/output.txt': 'ok',
      })
      return { stdout: 'ok\n', stderr: '', exitCode: 0 }
    }

    const result = await runWorkspaceSandboxTask({
      runId: 'run_python',
      workspace,
      providers: [
        candidate(nodeProvider, ['runtime.node']),
        candidate(pythonProvider, ['runtime.python']),
      ],
      imageCatalog: {
        'python-agent': {
          providers: {
            e2b: 'e2b-python-template',
          },
        },
      },
      task: {
        kind: 'python',
        path: '/workspace/generated/task.py',
        image: 'python-agent',
      },
    })

    expect(result.providerName).toBe('e2b')
    expect(result.exec?.exitCode).toBe(0)
    expect(pythonProvider.createConfigs).toEqual([{ image: 'e2b-python-template' }])
    expect(nodeProvider.createConfigs).toEqual([])
    expect(pythonSandbox.commands).toEqual(['python /workspace/generated/task.py'])
    expect(pythonSandbox.uploadDest).toBe('/workspace')
    expect(pythonSandbox.downloadSource).toBe('/workspace')
    expect(result.checkpoints.before?.label).toBe('sandbox:run_python:before')
    expect(result.checkpoints.after?.label).toBe('sandbox:run_python:after')
    await expect(workspace.read('/workspace/output.txt')).resolves.toBe('ok')
  })

  it('merges sandbox branches and keeps both sides when the same path conflicts', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'workspace-merge' })
    await workspace.write('/workspace/shared.txt', 'base')
    await workspace.write('/workspace/unchanged.txt', 'same')

    const sandbox = new FakeSandbox('merge-sandbox')
    const provider = new FakeProvider('daytona', sandbox)
    sandbox.onExec = async () => {
      await workspace.write('/workspace/shared.txt', 'host')
      sandbox.archiveToDownload = await archiveFromFiles({
        '/workspace/shared.txt': 'sandbox',
        '/workspace/unchanged.txt': 'same',
        '/workspace/new.txt': 'new',
      })
      return { stdout: '', stderr: '', exitCode: 0 }
    }

    const result = await runWorkspaceSandboxTask({
      runId: 'run_conflict',
      workspace,
      providers: [candidate(provider, ['runtime.python'])],
      task: {
        kind: 'command',
        command: 'python /workspace/generated/task.py',
        image: 'python-agent',
      },
      consistency: {
        mode: 'branch-merge',
        conflictResolution: 'keep-both',
      },
    })

    expect(result.merge).toMatchObject({
      applied: 1,
      conflicts: [{ path: '/workspace/shared.txt', resolution: 'keep-both' }],
    })
    await expect(workspace.read('/workspace/shared.txt')).resolves.toBe('host')
    await expect(workspace.read('/workspace/new.txt')).resolves.toBe('new')
    await expect(workspace.read('/.sandbank/conflicts/run_conflict/shared.txt')).resolves.toBe('sandbox')
  })

  it('requires a live workspace mount capable provider when the task asks for live mode', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'workspace-live' })
    const provider = new FakeProvider('e2b', new FakeSandbox('snapshot-only'))

    await expect(runWorkspaceSandboxTask({
      runId: 'run_live',
      workspace,
      providers: [candidate(provider, ['runtime.python'])],
      task: {
        kind: 'python',
        path: '/workspace/generated/task.py',
        image: 'python-agent',
        mount: { mode: 'live' },
      },
    })).rejects.toThrow('workspace.live')
  })

  it('runs Codex exec in a sandbox image with codex capability', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'workspace-codex-exec' })
    const sandbox = new FakeSandbox('codex-exec-sandbox')
    const provider = new FakeProvider('boxlite', sandbox)
    sandbox.onExec = async () => {
      sandbox.archiveToDownload = await archiveFromFiles({
        '/workspace/notes.md': 'codex wrote this',
      })
      return { stdout: '{"type":"result"}\n', stderr: '', exitCode: 0 }
    }

    const result = await runWorkspaceSandboxTask({
      runId: 'run_codex_exec',
      workspace,
      providers: [candidate(provider, ['runtime.codex', 'codex.exec'])],
      task: {
        kind: 'codex.exec',
        prompt: 'Write notes.',
        image: 'codex-agent',
      },
    })

    expect(result.codex).toMatchObject({ mode: 'exec', promptPath: '/workspace/.sandbank/codex/run_codex_exec.prompt.md' })
    expect(sandbox.files.get('/workspace/.sandbank/codex/run_codex_exec.prompt.md')).toBe('Write notes.')
    expect(sandbox.commands[0]).toContain('codex exec --json --skip-git-repo-check')
    expect(sandbox.commands[0]).toContain('/workspace/.sandbank/codex/run_codex_exec.prompt.md')
    await expect(workspace.read('/workspace/notes.md')).resolves.toBe('codex wrote this')
  })

  it('starts a vas-style Codex goal tmux session and leaves the sandbox alive', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'workspace-codex-goal' })
    const sandbox = new FakeSandbox('codex-goal-sandbox')
    const provider = new FakeProvider('boxlite', sandbox)

    const result = await runWorkspaceSandboxTask({
      runId: 'run_goal',
      workspace,
      providers: [candidate(provider, ['runtime.codex', 'codex.goal'])],
      task: {
        kind: 'codex.goal',
        goal: 'Classify provider scheduler commits.',
        image: 'codex-agent',
        sessionName: 'goal_sandbank_provider_scheduler',
      },
    })

    expect(result.codex).toMatchObject({
      mode: 'goal',
      goalPath: '/workspace/.sandbank/codex-goals/run_goal.goal.md',
      sessionName: 'goal_sandbank_provider_scheduler',
    })
    expect(sandbox.files.get('/workspace/.sandbank/codex-goals/run_goal.goal.md')).toContain('Classify provider scheduler commits.')
    expect(sandbox.commands[0]).toContain('tmux new-session -d -s goal_sandbank_provider_scheduler')
    expect(sandbox.commands[0]).toContain('codex --cd /workspace --no-alt-screen')
    expect(sandbox.commands[0]).toContain('/goal Read and follow this sandbox goal file exactly:')
    expect(provider.destroyed).toEqual([])
  })
})

function candidate(provider: SandboxProvider, capabilities: SandboxSchedulerCapability[]) {
  return { provider, capabilities }
}

async function archiveFromFiles(files: Record<string, WorkspaceData>): Promise<Uint8Array> {
  const source = new MemoryWorkspaceAdapter(undefined, { emitEnabled: false })
  for (const [path, data] of Object.entries(files)) {
    await source.write(path, data)
  }
  const sink = new FakeSandbox('archive-sink')
  await materializeWorkspaceToSandbox(source, sink, {
    workspacePath: '/workspace',
    sandboxPath: '/workspace',
  })
  if (!sink.uploadedArchive) throw new Error('archive was not created')
  return sink.uploadedArchive
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function streamToBytes(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value as Uint8Array)
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
