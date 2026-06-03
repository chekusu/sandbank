import { describe, expect, it, vi } from 'vitest'
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
import { AgentSupervisor } from './agent-supervisor.js'
import {
  ToolUseRegistry,
  createCloudflareResourceTool,
  createSandboxPythonTool,
  type SandboxProviderToolCandidate,
} from './tool-use.js'

describe('Tool Use', () => {
  it('denies Cloudflare resource mutation outside the agent resource whitelist before invoking the tool handler', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'workspace-tool-deny' })
    const handler = vi.fn(async () => ({ ok: true }))
    const registry = new ToolUseRegistry()
      .register(createCloudflareResourceTool('write', handler))
    const supervisor = new AgentSupervisor({
      agentId: 'agent-tools',
      workspace,
      modelId: 'deepseek-v4-pro',
      id: () => 'run_tool_denied',
      now: () => new Date('2026-06-03T00:00:00.000Z'),
      checkpointBeforeRun: false,
      policy: { allowedOps: ['tool.use'] },
      toolUse: {
        registry,
        policy: {
          allowedTools: ['cloudflare.resource.write'],
          resources: [
            { kind: 'cloudflare.d1', id: 'analytics', actions: ['read'] },
          ],
        },
      },
    })

    await expect(supervisor.run({
      input: { message: 'modify users db' },
      modelLoop: async context => {
        await context.executeOp({
          action: 'tool.use',
          request: {
            tool: 'cloudflare.resource.write',
            input: {
              resource: { kind: 'cloudflare.d1', id: 'users' },
              operation: 'update-row',
              payload: { id: 'user_1', role: 'admin' },
            },
          },
        })
        return { text: 'mutated' }
      },
    })).rejects.toThrow(/does not allow cloudflare\.d1:users write/)

    expect(handler).not.toHaveBeenCalled()
  })

  it('requires explicit approval for mutating an allowed Cloudflare resource', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'workspace-tool-approval' })
    const handler = vi.fn(async input => ({ ok: true, input }))
    const approvals: string[] = []
    const registry = new ToolUseRegistry()
      .register(createCloudflareResourceTool('write', handler))
    const supervisor = new AgentSupervisor({
      agentId: 'agent-tools',
      workspace,
      modelId: 'deepseek-v4-pro',
      id: () => 'run_tool_approved',
      now: () => new Date('2026-06-03T00:00:00.000Z'),
      checkpointBeforeRun: false,
      policy: { allowedOps: ['tool.use'] },
      toolUse: {
        registry,
        policy: {
          allowedTools: ['cloudflare.resource.write'],
          resources: [
            { kind: 'cloudflare.d1', id: 'users', actions: ['write'] },
          ],
          requireApproval: [
            { kind: 'cloudflare.d1', action: 'write' },
          ],
        },
      },
      approvalHook: async request => {
        approvals.push(request.reason)
        return 'approved'
      },
    })

    await supervisor.run({
      input: { message: 'modify users db with approval' },
      modelLoop: async context => {
        const result = await context.executeOp({
          action: 'tool.use',
          request: {
            tool: 'cloudflare.resource.write',
            input: {
              resource: { kind: 'cloudflare.d1', id: 'users' },
              operation: 'update-row',
              payload: { id: 'user_1', role: 'admin' },
            },
          },
        })
        expect(result).toMatchObject({ ok: true })
        return { text: 'mutated after approval' }
      },
    })

    expect(approvals).toEqual(['tool.use requires approval for cloudflare.d1:users write'])
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('runs generated Python through an allowed sandbox provider instead of the Dynamic Worker provider', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'workspace-python-tool' })
    await workspace.write('/workspace/generated/task.py', 'print("ok")')

    const dynamicWorkerProvider = new FakeProvider('cloudflare', new FakeSandbox('dynamic-worker-sandbox'))
    const e2bSandbox = new FakeSandbox('e2b-python-sandbox')
    const e2bProvider = new FakeProvider('e2b', e2bSandbox)
    e2bSandbox.onExec = async () => {
      e2bSandbox.archiveToDownload = await archiveFromFiles({
        '/workspace/generated/task.py': 'print("ok")',
      })
      return { stdout: 'ok\n', stderr: '', exitCode: 0 }
    }

    const registry = new ToolUseRegistry()
      .register(createSandboxPythonTool())
    const supervisor = new AgentSupervisor({
      agentId: 'agent-tools',
      workspace,
      modelId: 'deepseek-v4-pro',
      id: () => 'run_python_tool',
      now: () => new Date('2026-06-03T00:00:00.000Z'),
      checkpointBeforeRun: false,
      policy: { allowedOps: ['tool.use'] },
      toolUse: {
        registry,
        sandboxProviders: [
          candidate(dynamicWorkerProvider, ['runtime.node']),
          candidate(e2bProvider, ['runtime.python']),
        ],
        imageCatalog: {
          'python-agent': {
            providers: {
              e2b: 'e2b-python-template',
            },
          },
        },
        policy: {
          allowedTools: ['sandbox.python'],
          resources: [
            { kind: 'sandbox.provider', id: 'e2b', actions: ['execute'] },
            { kind: 'runtime.python', actions: ['execute'] },
          ],
        },
      },
    })

    let toolResult: unknown
    await supervisor.run({
      input: { message: 'run generated python' },
      modelLoop: async context => {
        toolResult = await context.executeOp({
          action: 'tool.use',
          request: {
            tool: 'sandbox.python',
            input: {
              path: '/workspace/generated/task.py',
              image: 'python-agent',
            },
          },
        })
        return { text: 'python complete' }
      },
    })

    expect(toolResult).toMatchObject({
      providerName: 'e2b',
      sandboxId: 'e2b-python-sandbox',
      exec: { stdout: 'ok\n', stderr: '', exitCode: 0 },
    })
    expect(e2bProvider.createConfigs).toEqual([{ image: 'e2b-python-template' }])
    expect(dynamicWorkerProvider.createConfigs).toEqual([])
    expect(e2bSandbox.commands).toEqual(['python /workspace/generated/task.py'])
  })
})

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

function candidate(provider: SandboxProvider, capabilities: string[]): SandboxProviderToolCandidate {
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
