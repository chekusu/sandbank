export abstract class WorkerEntrypoint<Env = unknown, Props = unknown> {
  protected ctx: ExecutionContext & { props: Props }
  protected env: Env

  constructor(ctx: ExecutionContext & { props: Props }, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}
