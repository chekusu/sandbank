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
  createSearchCodeRunTool,
  createSandboxPythonTool,
  type SandboxProviderToolCandidate,
  type ToolUseCodeExecutionCapsule,
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

  it('runs search code through an authorized Dynamic Worker capsule with a scoped search binding', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'workspace-search-code' })
    const search = vi.fn(async (query: string) => ({
      provider: 'perplexity',
      query,
      results: [
        { title: 'Lature', url: 'https://example.com/lature' },
        { title: 'GINZA Le Signe', url: 'https://example.com/le-signe' },
      ],
    }))
    const invocations: Parameters<ToolUseCodeExecutionCapsule['invoke']>[0][] = []
    const dynamicWorker: ToolUseCodeExecutionCapsule = {
      invoke: vi.fn(async options => {
        invocations.push(options)
        const payload = await options.request.json() as {
          queries: string[]
          artifactRoot: string
          resultArtifactName: string
        }
        const searchBinding = options.bindings?.['SANDBANK_SEARCH'] as {
          search(query: string): Promise<{ results: unknown[] }>
        }
        const searchResult = await searchBinding.search(payload.queries[0]!)
        const output = { count: searchResult.results.length }
        const artifactPath = `${payload.artifactRoot}/${payload.resultArtifactName}`
        await options.workspace.write(artifactPath, JSON.stringify(output))
        await options.onEvent?.({
          type: 'artifact',
          name: payload.resultArtifactName,
          path: artifactPath,
          mediaType: 'application/json',
          size: 11,
        })
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ok: true, result: output }),
        }
      }),
    }
    const registry = new ToolUseRegistry()
      .register(createSearchCodeRunTool({
        search: { provider: 'perplexity', search },
      }))
    const supervisor = new AgentSupervisor({
      agentId: 'agent-tools',
      workspace,
      modelId: 'deepseek-v4-pro',
      id: () => 'run_search_code',
      now: () => new Date('2026-06-03T00:00:00.000Z'),
      checkpointBeforeRun: false,
      policy: { allowedOps: ['tool.use'] },
      toolUse: {
        registry,
        dynamicWorker,
        policy: {
          allowedTools: ['search.code.run'],
          resources: [
            { kind: 'dynamic_worker.execution', actions: ['execute'] },
            { kind: 'runtime.javascript', actions: ['execute'] },
            { kind: 'external.search', id: 'perplexity', actions: ['query'] },
            { kind: 'http.egress', id: 'api.example.com', actions: ['fetch'] },
            { kind: 'workspace.path', scope: '/runs/run_search_code/artifacts', actions: ['write'] },
          ],
        },
      },
    })

    let toolResult: unknown
    await supervisor.run({
      input: { message: 'find Tokyo French restaurants as code' },
      modelLoop: async context => {
        toolResult = await context.executeOp({
          action: 'tool.use',
          request: {
            tool: 'search.code.run',
            input: {
              code: [
                'const result = await ctx.search.search(ctx.input.queries[0]);',
                'await ctx.runtime.artifact("restaurants.json", result, { mediaType: "application/json" });',
                'return { count: result.results.length };',
              ].join('\n'),
              queries: ['tokyo french restaurants'],
              allowedHosts: ['https://api.example.com/search'],
              artifactRoot: '/runs/run_search_code/artifacts',
              resultArtifactName: 'summary.json',
            },
          },
        })
        return { text: 'search code complete' }
      },
    })

    expect(search).toHaveBeenCalledWith('tokyo french restaurants', expect.objectContaining({
      agentId: 'agent-tools',
      runId: 'run_search_code',
    }))
    expect(dynamicWorker.invoke).toHaveBeenCalledTimes(1)
    expect(invocations[0]?.code).toContain('async function __sandbankSearchCodeRun(ctx)')
    expect(invocations[0]?.bindings).toHaveProperty('SANDBANK_SEARCH')
    expect(invocations[0]?.bindingAllowlist).toContain('SANDBANK_SEARCH')
    expect(invocations[0]?.workspaceScope).toMatchObject({
      readablePaths: ['/runs/run_search_code/artifacts'],
      writablePaths: ['/runs/run_search_code/artifacts'],
      allowList: false,
      allowQuery: false,
      artifactRoot: '/runs/run_search_code/artifacts',
    })
    expect(toolResult).toMatchObject({
      status: 200,
      result: { count: 2 },
      artifacts: [
        expect.objectContaining({ path: '/runs/run_search_code/artifacts/summary.json' }),
      ],
    })
    await expect(workspace.read('/runs/run_search_code/artifacts/summary.json')).resolves.toBe('{"count":2}')
  })

  it('denies search code before execution when the requested egress host is outside policy', async () => {
    const workspace = new MemoryWorkspaceAdapter(undefined, { id: 'workspace-search-code-deny' })
    const dynamicWorker: ToolUseCodeExecutionCapsule = {
      invoke: vi.fn(async () => ({ status: 200, headers: {}, body: '{}' })),
    }
    const registry = new ToolUseRegistry()
      .register(createSearchCodeRunTool({
        search: { provider: 'perplexity', search: vi.fn() },
      }))
    const supervisor = new AgentSupervisor({
      agentId: 'agent-tools',
      workspace,
      modelId: 'deepseek-v4-pro',
      id: () => 'run_search_code_denied',
      now: () => new Date('2026-06-03T00:00:00.000Z'),
      checkpointBeforeRun: false,
      policy: { allowedOps: ['tool.use'] },
      toolUse: {
        registry,
        dynamicWorker,
        policy: {
          allowedTools: ['search.code.run'],
          resources: [
            { kind: 'dynamic_worker.execution', actions: ['execute'] },
            { kind: 'runtime.javascript', actions: ['execute'] },
            { kind: 'external.search', id: 'perplexity', actions: ['query'] },
            { kind: 'workspace.path', scope: '/runs/run_search_code_denied/artifacts', actions: ['write'] },
          ],
        },
      },
    })

    await expect(supervisor.run({
      input: { message: 'run generated search code' },
      modelLoop: async context => {
        await context.executeOp({
          action: 'tool.use',
          request: {
            tool: 'search.code.run',
            input: {
              code: 'return await ctx.search.fetchJson("https://api.example.com/search?q=tokyo");',
              queries: ['tokyo french restaurants'],
              allowedHosts: ['api.example.com'],
              artifactRoot: '/runs/run_search_code_denied/artifacts',
            },
          },
        })
        return { text: 'should not run' }
      },
    })).rejects.toThrow(/does not allow http\.egress:api\.example\.com fetch/)

    expect(dynamicWorker.invoke).not.toHaveBeenCalled()
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
