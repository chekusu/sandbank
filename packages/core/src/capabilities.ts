import type {
  Capability,
  PortExposeSandbox,
  Sandbox,
  SandboxProvider,
  ServiceProvider,
  SleepableSandbox,
  SnapshotSandbox,
  StreamableSandbox,
  TerminalSandbox,
  VolumeProvider,
} from './types.js'

/** 检查 provider 是否支持某个能力 */
export function hasCapability(
  provider: SandboxProvider,
  capability: Capability,
): boolean {
  return provider.capabilities.has(capability)
}

/** 向下转型为支持流式执行的 Sandbox，不支持则返回 null */
export function withStreaming(sandbox: Sandbox): StreamableSandbox | null {
  if ('execStream' in sandbox && typeof sandbox.execStream === 'function') {
    return sandbox as StreamableSandbox
  }
  return null
}

/** 向下转型为支持终端的 Sandbox，不支持则返回 null */
export function withTerminal(sandbox: Sandbox): TerminalSandbox | null {
  if ('startTerminal' in sandbox && typeof sandbox.startTerminal === 'function') {
    return sandbox as TerminalSandbox
  }
  return null
}

/** 向下转型为支持休眠的 Sandbox，不支持则返回 null */
export function withSleep(sandbox: Sandbox): SleepableSandbox | null {
  if ('sleep' in sandbox && typeof sandbox.sleep === 'function') {
    return sandbox as SleepableSandbox
  }
  return null
}

/** 向下转型为支持端口暴露的 Sandbox，不支持则返回 null */
export function withPortExpose(sandbox: Sandbox): PortExposeSandbox | null {
  if ('exposePort' in sandbox && typeof sandbox.exposePort === 'function') {
    return sandbox as PortExposeSandbox
  }
  return null
}

/** 向下转型为支持快照的 Sandbox，不支持则返回 null */
export function withSnapshot(sandbox: Sandbox): SnapshotSandbox | null {
  if ('createSnapshot' in sandbox && typeof sandbox.createSnapshot === 'function') {
    return sandbox as SnapshotSandbox
  }
  return null
}

/** 向下转型为支持卷管理的 Provider，不支持则返回 null */
export function withVolumes(provider: SandboxProvider): VolumeProvider | null {
  if (
    'createVolume' in provider && typeof provider.createVolume === 'function' &&
    'deleteVolume' in provider && typeof provider.deleteVolume === 'function' &&
    'listVolumes' in provider && typeof provider.listVolumes === 'function'
  ) {
    return provider as VolumeProvider
  }
  return null
}

/** 向下转型为支持服务管理的 Provider，不支持则返回 null */
export function withServices(provider: SandboxProvider): ServiceProvider | null {
  if (
    'createService' in provider && typeof provider.createService === 'function' &&
    'getService' in provider && typeof provider.getService === 'function' &&
    'listServices' in provider && typeof provider.listServices === 'function' &&
    'destroyService' in provider && typeof provider.destroyService === 'function'
  ) {
    return provider as ServiceProvider
  }
  return null
}
