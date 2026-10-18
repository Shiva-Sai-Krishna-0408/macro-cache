/** Node stand-in for the `cloudflare:workers` module so the real Worker can run under Vitest. */
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}
