import type {
  DaytonaClient,
  DaytonaCreateParams,
  DaytonaExecResult,
  DaytonaSandboxData,
  DaytonaVolumeData,
} from './types.js'

/**
 * Create a DaytonaClient backed by @daytonaio/sdk.
 * The SDK is loaded lazily via dynamic import.
 */
export async function createDaytonaSDKClient(
  apiKey: string,
  apiUrl?: string,
  target?: string,
): Promise<DaytonaClient> {
  const { Daytona } = await import('@daytonaio/sdk')
  const daytona = new Daytona({ apiKey, apiUrl, target: target as never })

  // Cache SDK sandbox objects to avoid redundant get() calls
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cache = new Map<string, any>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function resolve(id: string): Promise<any> {
    let sb = cache.get(id)
    if (!sb) {
      sb = await daytona.get(id)
      cache.set(id, sb)
    }
    return sb
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function toData(sandbox: any): DaytonaSandboxData {
    return {
      id: sandbox.id as string,
      state: sandbox.state as string,
      createdAt: (sandbox.createdAt ?? new Date().toISOString()) as string,
      image: (sandbox.image ?? '') as string,
      volumes: sandbox.volumes,
    }
  }

  return {
    async createSandbox(config: DaytonaCreateParams): Promise<DaytonaSandboxData> {
      const params: Record<string, unknown> = {
        envVars: config.envVars,
        resources: config.resources,
        volumes: config.volumes,
        autoDeleteInterval: config.autoDeleteInterval,
      }
      if (config.image) params.image = config.image
      const sandbox = await daytona.create(
        params as never,
        config.timeout ? { timeout: config.timeout } : undefined,
      )
      cache.set(sandbox.id as string, sandbox)
      return toData(sandbox)
    },

    async getSandbox(id: string): Promise<DaytonaSandboxData> {
      // Always fetch fresh for explicit get
      const sandbox = await daytona.get(id)
      cache.set(id, sandbox)
      return toData(sandbox)
    },

    async listSandboxes(limit?: number): Promise<DaytonaSandboxData[]> {
      const result = await daytona.list(undefined, undefined, limit)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (result.items as any[]).map(toData)
    },

    async deleteSandbox(id: string): Promise<void> {
      const sandbox = await daytona.get(id)
      cache.delete(id)
      await daytona.delete(sandbox)
    },

    async exec(sandboxId: string, command: string, cwd?: string, timeout?: number): Promise<DaytonaExecResult> {
      const sandbox = await resolve(sandboxId)
      const response = await sandbox.process.executeCommand(command, cwd, undefined, timeout)
      return {
        exitCode: response.exitCode as number,
        stdout: (response.artifacts?.stdout ?? response.result ?? '') as string,
      }
    },

    async writeFile(sandboxId: string, path: string, content: string | Uint8Array): Promise<void> {
      const sandbox = await resolve(sandboxId)
      const buffer = typeof content === 'string'
        ? Buffer.from(content, 'utf-8')
        : Buffer.from(content)
      await sandbox.fs.uploadFile(buffer, path)
    },

    async readFile(sandboxId: string, path: string): Promise<Uint8Array> {
      const sandbox = await resolve(sandboxId)
      const buffer: Buffer = await sandbox.fs.downloadFile(path)
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    },

    async getPreviewUrl(sandboxId: string, port: number): Promise<string> {
      const sandbox = await resolve(sandboxId)
      const preview = await sandbox.getPreviewLink(port)
      return preview.url as string
    },

    async createVolume(name: string): Promise<DaytonaVolumeData> {
      const vol = await daytona.volume.create(name)
      return {
        id: vol.id as string,
        name: vol.name as string,
        state: (vol as unknown as Record<string, unknown>).state as string | undefined,
      }
    },

    async deleteVolume(id: string): Promise<void> {
      const volumes = await daytona.volume.list()
      const vol = volumes.find((v: { id: string }) => v.id === id)
      if (vol) await daytona.volume.delete(vol)
    },

    async listVolumes(): Promise<DaytonaVolumeData[]> {
      const volumes = await daytona.volume.list()
      return (volumes as Array<{ id: string; name: string; state?: string }>).map(v => ({
        id: v.id,
        name: v.name,
        state: v.state,
      }))
    },
  }
}
