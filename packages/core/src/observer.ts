// --- Sandbox Observer ---

export type SandboxEventType =
  | 'sandbox:exec'
  | 'sandbox:writeFile'
  | 'sandbox:readFile'
  | 'sandbox:uploadArchive'
  | 'sandbox:downloadArchive'

export interface SandboxEvent {
  /** 事件类型 */
  type: SandboxEventType
  /** 沙箱 ID */
  sandboxId: string
  /** 关联的任务 ID（可选） */
  taskId?: string
  /** 事件时间戳（Unix ms） */
  timestamp: number
  /** 事件数据（命令、路径、退出码等） */
  data: Record<string, unknown>
}

export interface SandboxObserver {
  /** 接收一个沙箱事件。可以返回 Promise，但调用方不会等待。 */
  onEvent(event: SandboxEvent): void | Promise<void>
}

export interface ProviderOptions {
  /** 可选的事件观察者。设置后，所有沙箱操作都会自动记录。 */
  observer?: SandboxObserver
  /** 默认任务 ID，会附加到所有事件上 */
  taskId?: string
}

/** 安全地发射事件：不阻塞、不抛错 */
export function emitEvent(observer: SandboxObserver, event: SandboxEvent): void {
  try {
    const result = observer.onEvent(event)
    if (result && typeof (result as Promise<void>).catch === 'function') {
      ;(result as Promise<void>).catch(() => {})
    }
  } catch {
    // observer 报错不影响沙箱操作
  }
}

/** 空观察者，不做任何操作 */
export function createNoopObserver(): SandboxObserver {
  return { onEvent() {} }
}

/** Webhook 观察者，将事件 POST 到指定 URL */
export function createWebhookObserver(
  url: string,
  options?: { headers?: Record<string, string> },
): SandboxObserver {
  return {
    onEvent(event: SandboxEvent): Promise<void> {
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
        body: JSON.stringify(event),
      }).then(() => {})
    },
  }
}
