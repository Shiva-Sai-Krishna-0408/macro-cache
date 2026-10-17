import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
const timestamps = {
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
};

/** Per-100g nutrient columns shared by foods and recipes. */
const per100 = {
  kcal: real("kcal").notNull(),
  protein: real("protein").notNull(),
  carbs: real("carbs").notNull(),
  fat: real("fat").notNull(),
  fiber: real("fiber"),
  sugar: real("sugar"),
  sodiumMg: real("sodium_mg"),
};

export interface CalcHistoryItem {
  at: string;
  reason: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  maintenance: number;
}

export interface TargetsJson {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

/** Single-row table (id = 1). All measurements stored metric. */
export const profile = sqliteTable("profile", {
  id: integer("id").primaryKey(),
  heightCm: real("height_cm"),
  weightKg: real("weight_kg"),
  age: integer("age"),
  sex: text("sex", { enum: ["male", "female"] }),
  activity: text("activity", { enum: ["sedentary", "light", "moderate", "active", "very_active"] }),
  goal: text("goal", { enum: ["lose", "maintain", "gain"] }).default("maintain"),
  paceLbPerWeek: real("pace_lb_per_week").default(0.5),
  goalWeightKg: real("goal_weight_kg"),
  units: text("units", { enum: ["metric", "imperial"] }).notNull().default("metric"),
  timezone: text("timezone").default("UTC"),
  proteinGPerKg: real("protein_g_per_kg").notNull().default(1.6),
  targets: text("targets", { mode: "json" }).$type<TargetsJson>(),
  /** Manual kcal override (set from the dashboard only). */
  targetOverrideKcal: integer("target_override_kcal"),
  /** Accepted adaptive maintenance estimate. */
  maintenanceOverride: integer("maintenance_override"),
  adaptive: text("adaptive", { mode: "json" }).$type<Record<string, unknown>>(),
  weeklyBudget: integer("weekly_budget", { mode: "boolean" }).notNull().default(false),
  tradeoffCards: integer("tradeoff_cards", { mode: "boolean" }).notNull().default(true),
  calcHistory: text("calc_history", { mode: "json" }).$type<CalcHistoryItem[]>().notNull().default(sql`'[]'`),
  onboarded: integer("onboarded", { mode: "boolean" }).notNull().default(false),
  ...timestamps,
});

export const weightEntry = sqliteTable(
  "weight_entry",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    weightKg: real("weight_kg").notNull(),
    bodyFatPct: real("body_fat_pct"),
    deletedAt: text("deleted_at"),
    ...timestamps,
  },
  (t) => [index("weight_entry_date_idx").on(t.date)],
);

export const FOOD_SOURCES = ["barcode", "label-photo", "manual", "restaurant", "ai-estimate"] as const;

export const food = sqliteTable(
  "food",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    brand: text("brand"),
    aliases: text("aliases", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    barcode: text("barcode"),
    servingSizeG: real("serving_size_g"),
    ...per100,
    source: text("source", { enum: FOOD_SOURCES }).notNull().default("manual"),
    confidence: real("confidence"),
    sourceUrls: text("source_urls", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    deletedAt: text("deleted_at"),
    ...timestamps,
  },
  (t) => [uniqueIndex("food_barcode_idx").on(t.barcode), index("food_name_idx").on(t.name)],
);

export interface IngredientJson {
  foodId: number;
  grams: number;
  name?: string;
}

/** Versioned: each update inserts a new row with the same rootId and version+1. */
export const recipe = sqliteTable(
  "recipe",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    rootId: integer("root_id"),
    version: integer("version").notNull().default(1),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(true),
    name: text("name").notNull(),
    ingredients: text("ingredients", { mode: "json" }).$type<IngredientJson[]>().notNull(),
    totalRawG: real("total_raw_g").notNull(),
    totalCookedWeightG: real("total_cooked_weight_g").notNull(),
    portionG: real("portion_g"),
    ...per100,
    notes: text("notes"),
    deletedAt: text("deleted_at"),
    ...timestamps,
  },
  (t) => [index("recipe_root_idx").on(t.rootId)],
);

export const container = sqliteTable("container", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  recipeId: integer("recipe_id").notNull(),
  label: text("label"),
  portionsTotal: real("portions_total").notNull(),
  portionsLeft: real("portions_left").notNull(),
  portionG: real("portion_g").notNull(),
  startedOn: text("started_on").notNull(),
  finishedAt: text("finished_at"),
  deletedAt: text("deleted_at"),
  ...timestamps,
});

export const restaurantOrder = sqliteTable("restaurant_order", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  restaurant: text("restaurant").notNull(),
  item: text("item").notNull(),
  kcal: real("kcal").notNull(),
  protein: real("protein").notNull(),
  carbs: real("carbs").notNull(),
  fat: real("fat").notNull(),
  fiber: real("fiber"),
  sugar: real("sugar"),
  sodiumMg: real("sodium_mg"),
  source: text("source", { enum: ["official", "estimate"] }).notNull().default("estimate"),
  confidence: real("confidence"),
  sourceUrls: text("source_urls", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  notes: text("notes"),
  deletedAt: text("deleted_at"),
  ...timestamps,
});

export const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
export const REF_TYPES = ["food", "recipe", "container", "restaurant_order", "adhoc"] as const;

export const logEntry = sqliteTable(
  "log_entry",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    meal: text("meal", { enum: MEALS }).notNull(),
    refType: text("ref_type", { enum: REF_TYPES }).notNull(),
    refId: integer("ref_id"),
    name: text("name").notNull(),
    amount: real("amount").notNull(),
    unit: text("unit", { enum: ["g", "serving", "portion"] }).notNull(),
    grams: real("grams"),
    // Snapshot of macros at log time.
    kcal: real("kcal").notNull(),
    protein: real("protein").notNull(),
    carbs: real("carbs").notNull(),
    fat: real("fat").notNull(),
    fiber: real("fiber"),
    sugar: real("sugar"),
    sodiumMg: real("sodium_mg"),
    createdVia: text("created_via", { enum: ["claude", "dashboard"] }).notNull(),
    deletedAt: text("deleted_at"),
    ...timestamps,
  },
  (t) => [index("log_entry_date_idx").on(t.date)],
);

export interface TemplateItemJson {
  refType: "food" | "recipe" | "restaurant_order" | "adhoc";
  refId?: number | null;
  amount: number;
  unit: "g" | "serving" | "portion";
  meal?: (typeof MEALS)[number];
  name?: string;
  adhoc?: { kcal: number; protein: number; carbs: number; fat: number };
}

export const template = sqliteTable("template", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  items: text("items", { mode: "json" }).$type<TemplateItemJson[]>().notNull(),
  deletedAt: text("deleted_at"),
  ...timestamps,
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: text("ts").notNull().default(now),
    batchId: text("batch_id").notNull(),
    tool: text("tool").notNull(),
    args: text("args", { mode: "json" }),
    via: text("via", { enum: ["claude", "dashboard"] }).notNull(),
    tableName: text("table_name").notNull(),
    rowId: integer("row_id").notNull(),
    action: text("action", { enum: ["create", "update", "delete"] }).notNull(),
    before: text("before", { mode: "json" }),
    after: text("after", { mode: "json" }),
    undone: integer("undone", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("audit_batch_idx").on(t.batchId)],
);

export const tables = { profile, weightEntry, food, recipe, container, restaurantOrder, logEntry, template } as const;
export type TableName = keyof typeof tables;
