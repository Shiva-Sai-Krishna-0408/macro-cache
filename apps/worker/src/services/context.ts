import { desc, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { auditLog, tables, type TableName } from "../db/schema";

export type Via = "claude" | "dashboard";

export interface Ctx {
  db: DB;
  via: Via;
  /** Outbound fetch (only used for Open Food Facts). Injected for tests. */
  fetch?: typeof fetch;
  now?: () => Date;
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found.`);
    this.name = "NotFoundError";
  }
}

/** Thrown when an action is not permitted for the caller (e.g. below-floor override via Claude). */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export const nowIso = (ctx: Ctx) => (ctx.now ? ctx.now() : new Date()).toISOString();

// Drizzle's generic table typing is impractical for a dynamic writer; rows are plain objects.
type Row = Record<string, any>;

/**
 * Every write goes through a Writer, which records before/after snapshots in
 * audit_log under one batch id. undo_last reverts the most recent batch.
 */
export class Writer {
  readonly batchId: string;
  constructor(
    private ctx: Ctx,
    private tool: string,
    private args: unknown,
  ) {
    this.batchId = crypto.randomUUID();
  }

  private async log(table: TableName, rowId: number, action: "create" | "update" | "delete", before: Row | null, after: Row | null) {
    await this.ctx.db.insert(auditLog).values({
      batchId: this.batchId,
      tool: this.tool,
      args: this.args as object,
      via: this.ctx.via,
      tableName: table,
      rowId,
      action,
      before,
      after,
      ts: nowIso(this.ctx),
    });
  }

  async insert<R extends Row = Row>(table: TableName, values: Row): Promise<R> {
    const t = tables[table] as any;
    const [row] = await (this.ctx.db.insert(t).values(values) as any).returning();
    await this.log(table, row.id, "create", null, row);
    return row as R;
  }

  async update<R extends Row = Row>(table: TableName, id: number, patch: Row, action: "update" | "delete" = "update"): Promise<R> {
    const t = tables[table] as any;
    const before = await (this.ctx.db.select().from(t).where(eq(t.id, id)) as any).get();
    if (!before) throw new NotFoundError(`${table} ${id}`);
    const [after] = await (this.ctx.db.update(t).set({ ...patch, updatedAt: nowIso(this.ctx) }).where(eq(t.id, id)) as any).returning();
    await this.log(table, id, action, before, after);
    return after as R;
  }

  softDelete<R extends Row = Row>(table: TableName, id: number): Promise<R> {
    return this.update<R>(table, id, { deletedAt: nowIso(this.ctx) }, "delete");
  }
}

/** Revert the most recent not-yet-undone write batch. */
export async function undoLast(ctx: Ctx, opts: { dryRun?: boolean } = {}) {
  const last = await ctx.db.select().from(auditLog).where(eq(auditLog.undone, false)).orderBy(desc(auditLog.id)).limit(1).get();
  if (!last) return { undone: false, message: "Nothing to undo." };
  const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.batchId, last.batchId)).orderBy(desc(auditLog.id)).all();
  const summary = { tool: last.tool, at: last.ts, via: last.via, changes: rows.map((r) => ({ table: r.tableName, id: r.rowId, action: r.action })) };
  if (opts.dryRun) return { dry_run: true, would_undo: summary };

  for (const r of rows) {
    const t = tables[r.tableName as TableName] as any;
    if (!t) continue;
    if (r.action === "create") {
      await ctx.db.delete(t).where(eq(t.id, r.rowId));
    } else {
      const { id: _id, ...before } = (r.before ?? {}) as Row;
      await ctx.db.update(t).set(before).where(eq(t.id, r.rowId));
    }
  }
  await ctx.db.update(auditLog).set({ undone: true }).where(eq(auditLog.batchId, last.batchId));
  return { undone: true, ...summary };
}
