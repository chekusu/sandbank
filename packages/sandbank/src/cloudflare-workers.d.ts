declare module 'cloudflare:workers' {
  export abstract class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected ctx: ExecutionContext<Props>
    protected env: Env
    constructor(ctx: ExecutionContext<Props>, env: Env)
  }
}

interface ExecutionContext<Props = unknown> {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
  readonly props: Props
}
