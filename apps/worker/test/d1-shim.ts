import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * Minimal D1Database implementation over Node's built-in SQLite, covering the
 * surface drizzle-orm/d1 uses (prepare/bind/all/run/raw/first/batch). Lets the
 * tests exercise the real Drizzle D1 code path without workerd.
 */
class Stmt {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: SQLInputValue[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : (p as SQLInputValue))));
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params), success: true, meta: {} };
  }
  async first(col?: string) {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    return row ? (col ? row[col] : row) : null;
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }
  async raw() {
    const s = this.db.prepare(this.sql);
    s.setReturnArrays(true);
    return s.all(...this.params);
  }
}

export function createTestD1() {
  const db = new DatabaseSync(":memory:");
  const dir = join(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) db.exec(stmt);
    }
  }
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => Promise.all(stmts.map((s) => s.all())),
    exec: async (sql: string) => db.exec(sql),
    dump: async () => new ArrayBuffer(0),
  };
  return { d1: d1 as unknown as D1Database, raw: db };
}
