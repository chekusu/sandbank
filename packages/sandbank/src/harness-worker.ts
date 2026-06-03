import { WorkerEntrypoint } from 'cloudflare:workers'
import {
  createDbNativeAgentHarnessHandler,
  type DbNativeAgentHarnessDeps,
  type DbNativeAgentHarnessEnv,
  type HarnessExecutionCapsule,
  type HarnessExecutionEvent,
} from './harness-api.js'
import {
  DynamicWorkerExecutionCapsule,
  createDynamicWorkerRuntimeBinding,
  createDynamicWorkerWorkspaceBinding,
  type DynamicWorkerLoader,
} from '@sandbank.dev/cloudflare/dynamic-worker-capsule'
import type {
  ListOptions,
  QueryResult,
  ReadOptions,
  WorkspaceAdapter,
  WorkspaceData,
  WorkspaceEntry,
  WorkspaceQuery,
  WriteOptions,
} from '@sandbank.dev/workspace'

export interface DbNativeAgentHarnessWorkerEnv extends DbNativeAgentHarnessEnv {
  LOADER?: DynamicWorkerLoader
  SANDBANK_DYNAMIC_WORKER_LOADER?: DynamicWorkerLoader
}

type CapsuleWorkspaceScope = {
  readablePaths: string[]
  writablePaths: string[]
  allowList: boolean
  allowQuery: boolean
  artifactRoot: string
}

type CapsuleBindingProps = {
  invocationId: string
}

type CapsuleBindingEntry = {
  workspace: WorkspaceAdapter
  workspaceScope: CapsuleWorkspaceScope
  events: HarnessExecutionEvent[]
}

type CloudflareExecutionContextWithExports = ExecutionContext & {
  exports?: Record<string, (options?: { props?: CapsuleBindingProps }) => unknown>
}

const bindingRegistry = new Map<string, CapsuleBindingEntry>()
const fallbackExecutionContext: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
}

function bindingEntry(invocationId: string): CapsuleBindingEntry {
  const entry = bindingRegistry.get(invocationId)
  if (!entry) throw new Error(`Dynamic Worker binding context not found: ${invocationId}`)
  return entry
}

export class SandbankWorkspaceBinding extends WorkerEntrypoint<DbNativeAgentHarnessWorkerEnv, CapsuleBindingProps> {
  async list(path: string, opts?: ListOptions): Promise<WorkspaceEntry[]> {
    const entry = bindingEntry(this.ctx.props.invocationId)
    return createDynamicWorkerWorkspaceBinding(entry.workspace, entry.workspaceScope).list(path, opts)
  }

  async read(path: string, opts?: ReadOptions): Promise<WorkspaceData> {
    const entry = bindingEntry(this.ctx.props.invocationId)
    return createDynamicWorkerWorkspaceBinding(entry.workspace, entry.workspaceScope).read(path, opts)
  }

  async write(path: string, data: WorkspaceData, opts?: WriteOptions): Promise<WorkspaceEntry> {
    const entry = bindingEntry(this.ctx.props.invocationId)
    return createDynamicWorkerWorkspaceBinding(entry.workspace, entry.workspaceScope).write(path, data, opts)
  }

  async append(path: string, data: WorkspaceData): Promise<WorkspaceEntry> {
    const entry = bindingEntry(this.ctx.props.invocationId)
    return createDynamicWorkerWorkspaceBinding(entry.workspace, entry.workspaceScope).append(path, data)
  }

  async query(query: WorkspaceQuery): Promise<QueryResult> {
    const entry = bindingEntry(this.ctx.props.invocationId)
    return createDynamicWorkerWorkspaceBinding(entry.workspace, entry.workspaceScope).query(query)
  }
}

export class SandbankRuntimeBinding extends WorkerEntrypoint<DbNativeAgentHarnessWorkerEnv, CapsuleBindingProps> {
  async log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const entry = bindingEntry(this.ctx.props.invocationId)
    entry.events.push({ type: 'log', level, message, metadata })
  }

  async artifact(
    name: string,
    data: WorkspaceData,
    metadata?: { mediaType?: string; [key: string]: unknown },
  ): Promise<{ path: string }> {
    const entry = bindingEntry(this.ctx.props.invocationId)
    const artifact = await createDynamicWorkerRuntimeBinding(entry.workspace, entry.workspaceScope).artifact(name, data, metadata)
    entry.events.push({
      type: 'artifact',
      name: artifact.name,
      path: artifact.path,
      mediaType: artifact.mediaType,
      size: artifact.size,
      metadata,
    })
    return artifact
  }
}

function createCloudflareExecutionCapsule(
  loader: DynamicWorkerLoader,
  ctx: ExecutionContext,
): HarnessExecutionCapsule {
  const loopback = (ctx as CloudflareExecutionContextWithExports).exports
  const createWorkspaceBinding = loopback?.SandbankWorkspaceBinding
  const createRuntimeBinding = loopback?.SandbankRuntimeBinding
  if (!createWorkspaceBinding || !createRuntimeBinding) {
    return new DynamicWorkerExecutionCapsule({
      loader,
      bindingAllowlist: ['SANDBANK_WORKSPACE', 'SANDBANK_RUNTIME'],
    })
  }

  return {
    async invoke(options) {
      const invocationId = `dw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
      const events: HarnessExecutionEvent[] = []
      bindingRegistry.set(invocationId, {
        workspace: options.workspace,
        workspaceScope: options.workspaceScope,
        events,
      })
      try {
        const result = await new DynamicWorkerExecutionCapsule({
          loader,
          bindingAllowlist: ['SANDBANK_WORKSPACE', 'SANDBANK_RUNTIME'],
        }).invoke({
          id: options.id,
          code: options.code,
          request: options.request,
          bindings: {
            SANDBANK_WORKSPACE: createWorkspaceBinding({ props: { invocationId } }),
            SANDBANK_RUNTIME: createRuntimeBinding({ props: { invocationId } }),
          },
          bindingAllowlist: ['SANDBANK_WORKSPACE', 'SANDBANK_RUNTIME'],
          timeoutMs: options.timeoutMs,
          limits: options.limits,
          onEvent: event => {
            events.push(event as HarnessExecutionEvent)
          },
        })
        for (const event of events) await options.onEvent?.(event)
        return result
      } catch (err) {
        for (const event of events) await options.onEvent?.(event)
        throw err
      } finally {
        bindingRegistry.delete(invocationId)
      }
    },
  }
}

export default {
  fetch(
    request: Request,
    env: DbNativeAgentHarnessWorkerEnv,
    ctx: ExecutionContext = fallbackExecutionContext,
    deps: DbNativeAgentHarnessDeps = {},
  ): Promise<Response> {
    const loader = env.SANDBANK_DYNAMIC_WORKER_LOADER ?? env.LOADER
    return createDbNativeAgentHarnessHandler(env, loader
      ? {
        ...deps,
        createExecutionCapsule: () => createCloudflareExecutionCapsule(loader, ctx),
      }
      : deps).fetch(request)
  },
}
