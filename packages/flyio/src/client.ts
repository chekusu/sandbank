import type { FlyioAdapterConfig, FlyioExecResult, FlyioMachine, FlyioVolume } from './types.js'

const BASE_URL = 'https://api.machines.dev/v1'

export function createFlyioClient(config: FlyioAdapterConfig) {
  const { apiToken, appName } = config

  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${BASE_URL}/apps/${appName}${path}`
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Fly.io API error ${response.status}: ${body}`)
    }

    // DELETE responses may have empty body
    const text = await response.text()
    if (!text) return {} as T
    return JSON.parse(text) as T
  }

  return {
    async createMachine(params: {
      image: string
      region?: string
      env?: Record<string, string>
      guest?: { cpu_kind?: string; cpus?: number; memory_mb?: number }
      services?: FlyioMachine['config']['services']
      mounts?: Array<{ volume: string; path: string }>
      autoDestroy?: boolean
      restart?: { policy: string }
    }): Promise<FlyioMachine> {
      return request<FlyioMachine>('/machines', {
        method: 'POST',
        body: JSON.stringify({
          region: params.region ?? config.region,
          config: {
            image: params.image,
            env: params.env,
            guest: params.guest,
            services: params.services,
            mounts: params.mounts,
            auto_destroy: params.autoDestroy,
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

    async waitForState(machineId: string, state: string, timeoutSeconds = 60): Promise<void> {
      await request(`/machines/${machineId}/wait?state=${state}&timeout=${timeoutSeconds}`)
    },

    async exec(machineId: string, command: string): Promise<FlyioExecResult> {
      return request<FlyioExecResult>(`/machines/${machineId}/exec`, {
        method: 'POST',
        body: JSON.stringify({ cmd: `bash -c ${JSON.stringify(command)}` }),
      })
    },

    async createVolume(params: {
      name: string
      region?: string
      sizeGB?: number
    }): Promise<FlyioVolume> {
      return request<FlyioVolume>('/volumes', {
        method: 'POST',
        body: JSON.stringify({
          name: params.name,
          region: params.region ?? config.region,
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
