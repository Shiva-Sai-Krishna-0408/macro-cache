import { describe, expect, it } from "vitest";
import { CHICKEN, PROFILE, RICE, setup } from "./helpers";

const WRITE_TOOLS = [
  "update_profile",
  "recalculate_targets",
  "upsert_food",
  "lookup_barcode",
  "create_recipe",
  "update_recipe",
  "start_container",
  "use_container_portion",
  "save_restaurant_order",
  "log_food",
  "save_template",
  "log_template",
  "delete_entry",
  "update_entry",
  "undo_last",
  "log_weight",
];

describe("tool surface", () => {
  it("exposes the expected tools with zod-derived schemas", async () => {
    const t = setup();
    const res = await t.rpc("tools/list", {});
    const names = res.result.tools.map((x: any) => x.name);
    for (const n of [
      "get_profile",
      "update_profile",
      "recalculate_targets",
      "search_foods",
      "get_food",
      "upsert_food",
      "lookup_barcode",
      "create_recipe",
      "update_recipe",
      "start_container",
      "use_container_portion",
      "save_restaurant_order",
      "search_restaurant_orders",
      "log_food",
      "log_template",
      "delete_entry",
      "undo_last",
      "get_day_summary",
      "log_weight",
      "get_progress",
      "project_progress",
      "rank_by_protein_density",
      "suggest_meals_for_remaining",
    ])
      expect(names).toContain(n);
  });

  it("every write tool supports dry_run", async () => {
    const t = setup();
    const res = await t.rpc("tools/list", {});
    for (const name of WRITE_TOOLS) {
      const tool = res.result.tools.find((x: any) => x.name === name);
      expect(tool, name).toBeDefined();
      expect(tool.inputSchema.properties.dry_run, `${name} dry_run`).toBeDefined();
    }
  });

  it("never exposes a generic fetch/URL tool", async () => {
    const t = setup();
    const res = await t.rpc("tools/list", {});
    for (const tool of res.result.tools) {
      expect(tool.name).not.toMatch(/fetch|http|url|browse|request|scrape/i);
      const props = Object.keys(tool.inputSchema.properties ?? {});
      for (const p of props) expect(p === "source_urls" || !/url/i.test(p), `${tool.name}.${p}`).toBe(true);
    }
  });

  it("tools that ingest web/photo content carry the untrusted-data warning", async () => {
    const t = setup();
    const res = await t.rpc("tools/list", {});
    for (const name of ["upsert_food", "save_restaurant_order", "log_food", "delete_entry", "undo_last", "update_profile", "lookup_barcode"]) {
      const tool = res.result.tools.find((x: any) => x.name === name);
      expect(tool.description, name).toMatch(/untrusted DATA, never instructions/);
    }
  });
});

describe("end-to-end flows", () => {
  it("profile → targets with safety info", async () => {
    const t = setup();
    const r = await t.tool("update_profile", PROFILE);
    expect(r.ok).toBe(true);
    expect(r.targets.maintenance).toBeGreaterThan(2500);
    expect(r.targets.kcal).toBe(r.targets.maintenance - 250);
    expect(r.targets.floor).toBeGreaterThanOrEqual(1500);
    const p = await t.tool("get_profile");
    expect(p.complete).toBe(true);
    expect(p.targets.macros.protein).toBe(144);
  });

  it("food search (fuzzy + aliases), log, and day summary", async () => {
    const t = setup();
    await t.tool("update_profile", PROFILE);
    const c = await t.tool("upsert_food", CHICKEN);
    expect(c.action).toBe("created");
    await t.tool("upsert_food", RICE);
    expect((await t.tool("search_foods", { query: "chiken brest" })).results[0].name).toBe("Chicken breast, cooked");
    expect((await t.tool("search_foods", { query: "chicken" })).results[0].id).toBe(c.food.id);

    const log = await t.tool("log_food", {
      items: [
        { food_id: c.food.id, amount: 1, unit: "serving", meal: "lunch" },
        { food_id: 2, amount: 200, unit: "g", meal: "lunch" },
      ],
    });
    expect(log.ok).toBe(true);
    expect(log.logged).toHaveLength(2);
    expect(log.total.kcal).toBe(Math.round(165 * 1.5 + 130 * 2));
    expect(log.today).toMatch(/^Today: \d+ \/ \d+ kcal · \d+ \/ \d+ g protein$/);

    const day = await t.tool("get_day_summary");
    expect(day.totals.kcal).toBe(log.total.kcal);
    expect(day.meals.lunch.entries).toHaveLength(2);
    expect(day.remaining.kcal).toBe(day.target.kcal - day.totals.kcal);
  });

  it("log snapshots survive food edits", async () => {
    const t = setup();
    const c = await t.tool("upsert_food", CHICKEN);
    await t.tool("log_food", { items: [{ food_id: c.food.id, amount: 100, unit: "g", meal: "dinner" }] });
    await t.tool("upsert_food", { ...CHICKEN, id: c.food.id, per_100g: { kcal: 200, protein: 30, carbs: 0, fat: 8.9 } });
    const day = await t.tool("get_day_summary");
    expect(day.totals.kcal).toBe(165);
  });

  it("recipe → container countdown → delete restores portion", async () => {
    const t = setup();
    const ch = await t.tool("upsert_food", CHICKEN);
    const ri = await t.tool("upsert_food", RICE);
    const recipe = await t.tool("create_recipe", { name: "Chicken & rice", ingredients: [{ food_id: ch.food.id, grams: 600 }, { food_id: ri.food.id, grams: 400 }], total_cooked_weight_g: 1200 });
    expect(recipe.ok).toBe(true);
    const total = 165 * 6 + 130 * 4;
    expect(recipe.recipe.per_100g.kcal).toBe(Math.round(total / 12));
    const cont = await t.tool("start_container", { recipe_id: recipe.recipe.id, portions: 4 });
    expect(cont.container.portion_g).toBe(300);
    expect(cont.container.portions_left).toBe(4);

    const eat = await t.tool("use_container_portion", { container_id: cont.container.id, meal: "lunch" });
    expect(eat.logged[0].nutrients.kcal).toBe(Math.round(total / 4));
    let list = await t.tool("list_containers");
    expect(list.containers[0].portions_left).toBe(3);

    await t.tool("log_food", { items: [{ container_id: cont.container.id, amount: 2, unit: "portion", meal: "dinner" }] });
    list = await t.tool("list_containers");
    expect(list.containers[0].portions_left).toBe(1);

    await t.tool("delete_entry", { id: eat.logged[0].id });
    list = await t.tool("list_containers");
    expect(list.containers[0].portions_left).toBe(2);
  });

  it("recipe versions keep past numbers", async () => {
    const t = setup();
    const ch = await t.tool("upsert_food", CHICKEN);
    const r1 = await t.tool("create_recipe", { name: "Chicken", ingredients: [{ food_id: ch.food.id, grams: 500 }], total_cooked_weight_g: 500, portion_g: 250 });
    await t.tool("log_food", { items: [{ recipe_id: r1.recipe.id, meal: "lunch" }] });
    const r2 = await t.tool("update_recipe", { id: r1.recipe.id, total_cooked_weight_g: 400 });
    expect(r2.recipe.version).toBe(2);
    expect(r2.recipe.root_id).toBe(r1.recipe.id);
    expect(r2.recipe.per_100g.kcal).toBeGreaterThan(r1.recipe.per_100g.kcal);
    const day = await t.tool("get_day_summary");
    expect(day.totals.kcal).toBe(Math.round(165 * 2.5));
    const search = await t.tool("search_recipes", { query: "chicken" });
    expect(search.recipes).toHaveLength(1);
    expect(search.recipes[0].version).toBe(2);
  });

  it("restaurant orders: save, search, log", async () => {
    const t = setup();
    const o = await t.tool("save_restaurant_order", {
      restaurant: "Chipotle",
      item: "Chicken bowl, no rice, extra chicken",
      nutrients: { kcal: 600, protein: 64, carbs: 25, fat: 26 },
      source: "official",
      source_urls: ["https://www.chipotle.com/nutrition-calculator"],
    });
    expect(o.ok).toBe(true);
    expect((await t.tool("search_restaurant_orders", { query: "chipotle bowl" })).orders[0].id).toBe(o.order.id);
    const l = await t.tool("log_food", { items: [{ restaurant_order_id: o.order.id, meal: "dinner" }] });
    expect(l.total.kcal).toBe(600);
  });

  it("templates: save from a meal and log in one call", async () => {
    const t = setup();
    const ch = await t.tool("upsert_food", CHICKEN);
    await t.tool("log_food", { items: [{ food_id: ch.food.id, meal: "breakfast" }, { adhoc: { name: "Coffee w/ milk", kcal: 40, protein: 2, carbs: 4, fat: 1.5 }, meal: "breakfast" }] });
    const tpl = await t.tool("save_template", { name: "Usual breakfast", from_date: "2026-10-17", from_meal: "breakfast" });
    expect(tpl.template.items).toHaveLength(2);
    const r = await t.tool("log_template", { template_id: tpl.template.id, date: "2026-10-18" });
    expect(r.logged).toHaveLength(2);
    expect((await t.tool("get_day_summary", { date: "2026-10-18" })).totals.kcal).toBe(Math.round(165 * 1.5 + 40));
  });

  it("daily and weekly totals (weekly budget mode)", async () => {
    const t = setup();
    await t.tool("update_profile", { ...PROFILE, weekly_budget: true });
    for (const d of ["2026-10-12", "2026-10-13", "2026-10-17"]) await t.tool("log_food", { date: d, items: [{ adhoc: { name: "Meal", kcal: 1000, protein: 50, carbs: 100, fat: 44 }, meal: "lunch" }] });
    await t.tool("log_food", { date: "2026-10-11", items: [{ adhoc: { name: "Last week", kcal: 1000, protein: 50, carbs: 100, fat: 44 }, meal: "lunch" }] });
    const day = await t.tool("get_day_summary", { date: "2026-10-17" });
    expect(day.weekly.week_start).toBe("2026-10-12");
    expect(day.weekly.consumed_kcal).toBe(3000);
    expect(day.weekly.budget_kcal).toBe(day.target.kcal * 7);
  });

  it("weight, progress and projection use the shared engine", async () => {
    const t = setup();
    await t.tool("update_profile", PROFILE);
    await t.tool("log_weight", { weight_kg: 90, date: "2026-10-01" });
    await t.tool("log_weight", { weight_lb: 196, date: "2026-10-15" });
    const p = await t.tool("get_progress");
    expect(p.startWeightKg).toBe(90);
    expect(p.currentTrendKg).toBeLessThan(90);
    const proj = await t.tool("project_progress", { months: 6, compare_intake_kcal: 2600 });
    expect(proj.ok).toBe(true);
    expect(proj.primary.totalChangeKg).toBeLessThan(0);
    expect(proj.comparison.totalChangeKg).toBeGreaterThan(proj.primary.totalChangeKg);
    expect(proj.disclaimer).toMatch(/Estimates/);
  });

  it("suggestions rank by protein density and fit remaining", async () => {
    const t = setup();
    await t.tool("update_profile", PROFILE);
    await t.tool("upsert_food", CHICKEN);
    await t.tool("upsert_food", RICE);
    const rank = await t.tool("rank_by_protein_density");
    expect(rank.ranked[0].name).toMatch(/Chicken/);
    const s = await t.tool("suggest_meals_for_remaining");
    expect(s.ok).toBe(true);
    for (const x of s.suggestions) expect(x.nutrients.kcal).toBeLessThanOrEqual(s.remaining.kcal);
  });
});

describe("dry_run never writes", () => {
  it("leaves every table byte-identical for every write tool", async () => {
    const t = setup({ fetch: async () => new Response(JSON.stringify({ product: { product_name: "Test bar", nutriments: { "energy-kcal_100g": 400, proteins_100g: 30, carbohydrates_100g: 40, fat_100g: 13.3 } } }), { status: 200 }) });
    // Seed real data so updates/deletes have targets.
    await t.tool("update_profile", PROFILE);
    const ch = await t.tool("upsert_food", CHICKEN);
    const recipe = await t.tool("create_recipe", { name: "R", ingredients: [{ food_id: ch.food.id, grams: 500 }], total_cooked_weight_g: 500, portion_g: 250 });
    const cont = await t.tool("start_container", { recipe_id: recipe.recipe.id, portions: 2 });
    const order = await t.tool("save_restaurant_order", { restaurant: "X", item: "Y", nutrients: { kcal: 500, protein: 30, carbs: 50, fat: 20 } });
    const log = await t.tool("log_food", { items: [{ food_id: ch.food.id, meal: "lunch" }] });
    const tpl = await t.tool("save_template", { name: "T", from_date: "2026-10-17" });
    await t.tool("log_weight", { weight_kg: 89 });

    const before = t.snapshot();
    const calls: [string, Record<string, unknown>][] = [
      ["update_profile", { goal: "gain", dry_run: true }],
      ["recalculate_targets", { dry_run: true }],
      ["upsert_food", { ...RICE, dry_run: true }],
      ["upsert_food", { ...CHICKEN, id: ch.food.id, name: "renamed", dry_run: true }],
      ["lookup_barcode", { barcode: "1234567890123", dry_run: true }],
      ["create_recipe", { name: "R2", ingredients: [{ food_id: ch.food.id, grams: 100 }], dry_run: true }],
      ["update_recipe", { id: recipe.recipe.id, total_cooked_weight_g: 300, dry_run: true }],
      ["start_container", { recipe_id: recipe.recipe.id, portions: 3, dry_run: true }],
      ["use_container_portion", { container_id: cont.container.id, dry_run: true }],
      ["use_container_portion", { container_id: cont.container.id, log: false, dry_run: true }],
      ["save_restaurant_order", { restaurant: "A", item: "B", nutrients: { kcal: 100, protein: 10, carbs: 10, fat: 2 }, dry_run: true }],
      ["log_food", { items: [{ restaurant_order_id: order.order.id, meal: "dinner" }], dry_run: true }],
      ["save_template", { name: "T2", from_date: "2026-10-17", dry_run: true }],
      ["log_template", { template_id: tpl.template.id, dry_run: true }],
      ["delete_entry", { id: log.logged[0].id, dry_run: true }],
      ["update_entry", { id: log.logged[0].id, amount: 300, unit: "g", meal: "dinner", dry_run: true }],
      ["update_entry", { id: log.logged[0].id, container_id: cont.container.id, dry_run: true }],
      ["undo_last", { dry_run: true }],
      ["log_weight", { weight_kg: 88, dry_run: true }],
    ];
    for (const [name, args] of calls) {
      const r = await t.tool(name, args);
      expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true);
      expect(r.dry_run, name).toBe(true);
      expect(t.snapshot(), `${name} wrote data`).toBe(before);
    }
  });

  it("dry_run returns the computed preview", async () => {
    const t = setup();
    await t.tool("update_profile", PROFILE);
    const ch = await t.tool("upsert_food", CHICKEN);
    const r = await t.tool("log_food", { items: [{ food_id: ch.food.id, amount: 200, unit: "g", meal: "lunch" }], dry_run: true });
    expect(r.total.kcal).toBe(330);
    expect(r.day_after.kcal).toBe(330);
    expect(r.day_after.target_kcal).toBeGreaterThan(0);
  });
});

describe("audit log and undo", () => {
  it("records every write and undo_last reverts one batch at a time", async () => {
    const t = setup();
    const ch = await t.tool("upsert_food", CHICKEN);
    await t.tool("log_food", { items: [{ food_id: ch.food.id, meal: "lunch" }, { food_id: ch.food.id, meal: "lunch" }] });
    const audit = t.raw.prepare("select tool, action, table_name, via from audit_log order by id").all() as any[];
    expect(audit.map((a) => a.tool)).toEqual(["upsert_food", "log_food", "log_food"]);
    expect(audit.every((a) => a.via === "claude")).toBe(true);

    expect(t.counts().log_entry).toBe(2);
    const u = await t.tool("undo_last");
    expect(u.undone).toBe(true);
    expect(u.tool).toBe("log_food");
    expect(t.counts().log_entry).toBe(0); // both items of the meal reverted together
    expect(t.counts().food).toBe(1);
  });

  it("undo restores updates, deletes and container counts", async () => {
    const t = setup();
    const ch = await t.tool("upsert_food", CHICKEN);
    await t.tool("upsert_food", { ...CHICKEN, id: ch.food.id, name: "Renamed" });
    await t.tool("undo_last");
    expect((await t.tool("get_food", { id: ch.food.id })).name).toBe(CHICKEN.name);

    const recipe = await t.tool("create_recipe", { name: "R", ingredients: [{ food_id: ch.food.id, grams: 400 }], total_cooked_weight_g: 400 });
    const cont = await t.tool("start_container", { recipe_id: recipe.recipe.id, portions: 4 });
    const eat = await t.tool("use_container_portion", { container_id: cont.container.id });
    expect((await t.tool("list_containers")).containers[0].portions_left).toBe(3);
    await t.tool("delete_entry", { id: eat.logged[0].id });
    expect(t.counts().log_entry).toBe(1); // soft-deleted row remains
    expect((await t.tool("get_day_summary")).totals.kcal).toBe(0);
    await t.tool("undo_last"); // undo delete
    expect((await t.tool("get_day_summary")).totals.kcal).toBeGreaterThan(0);
    expect((await t.tool("list_containers")).containers[0].portions_left).toBe(3);
    await t.tool("undo_last"); // undo the eat
    expect((await t.tool("list_containers")).containers[0].portions_left).toBe(4);
  });

  it("reports when there is nothing to undo", async () => {
    const t = setup();
    expect((await t.tool("undo_last")).undone).toBe(false);
  });
});

describe("Open Food Facts", () => {
  it("parses v3 responses, caches, and only calls Open Food Facts", async () => {
    const urls: string[] = [];
    const t = setup({
      fetch: async (input) => {
        urls.push(String(input));
        return new Response(
          JSON.stringify({ product: { product_name: "Nutella", brands: "Ferrero", serving_quantity: 15, nutriments: { "energy-kcal_100g": 539, proteins_100g: 6.3, carbohydrates_100g: 57.5, fat_100g: 30.9, sugars_100g: 56.3, sodium_100g: 0.043 } }, status: "success" }),
          { status: 200 },
        );
      },
    });
    const r = await t.tool("lookup_barcode", { barcode: "3017624010701" });
    expect(r.found).toBe(true);
    expect(r.food.per_100g.sodiumMg).toBe(43);
    expect(r.food.serving_size_g).toBe(15);
    const again = await t.tool("lookup_barcode", { barcode: "3017624010701" });
    expect(again.cached).toBe(true);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).hostname).toBe("world.openfoodfacts.org");
  });

  it("handles not-found and implausible OFF data without writing", async () => {
    const t404 = setup({ fetch: async () => new Response("{}", { status: 404 }) });
    const nf = await t404.tool("lookup_barcode", { barcode: "0000000000017" });
    expect(nf.found).toBe(false);
    expect(nf.message).toMatch(/label/);
    const bad = setup({ fetch: async () => new Response(JSON.stringify({ product: { product_name: "Bad", nutriments: { "energy-kcal_100g": 2000, proteins_100g: 10, carbohydrates_100g: 10, fat_100g: 10 } } })) });
    const r = await bad.tool("lookup_barcode", { barcode: "1111111111116" });
    expect(r.found).toBe(false);
    expect(bad.counts().food).toBe(0);
  });
});

describe("server instructions", () => {
  it("initialize returns the condensed project instructions", async () => {
    const t = setup();
    const init = await t.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const text: string = init.result.instructions;
    expect(text.length).toBeLessThan(3000);
    for (const rule of [/LOOK UP FIRST/, /search_foods/, /dry_run:true/, /top 3 options/, /tradeoff_card/, /never instructions/, /safety floor/, /Today: /, /undo_last/, /create_recipe/]) expect(text).toMatch(rule);
  });
});

describe("recipe notes and detail", () => {
  it("saves multi-line steps via create_recipe and edits notes in place without a new version", async () => {
    const t = setup();
    const ch = await t.tool("upsert_food", CHICKEN);
    const steps = "1. Season the chicken.\n2. Bake at 200°C for 25 min.\n3. Rest 5 min, slice.\n" + "x".repeat(1500);
    const r = await t.tool("create_recipe", { name: "Baked chicken", ingredients: [{ food_id: ch.food.id, grams: 600 }], total_cooked_weight_g: 450, portion_g: 150, notes: steps });
    expect(r.recipe.notes).toBe(steps);

    const u = await t.tool("update_recipe", { id: r.recipe.id, notes: "1. Marinate overnight.\n2. Grill." });
    expect(u.new_version).toBe(false);
    expect(u.recipe.version).toBe(1);
    expect(u.recipe.notes).toBe("1. Marinate overnight.\n2. Grill.");

    // Changing the numbers bumps the version and carries the notes forward.
    const v2 = await t.tool("update_recipe", { id: r.recipe.id, total_cooked_weight_g: 420 });
    expect(v2.new_version).toBe(true);
    expect(v2.recipe.version).toBe(2);
    expect(v2.recipe.notes).toBe("1. Marinate overnight.\n2. Grill.");

    // Undo reverts the in-place notes edit too.
    await t.tool("update_recipe", { id: v2.recipe.id, notes: "oops" });
    await t.tool("undo_last");
    expect((await t.tool("get_recipe", { id: v2.recipe.id })).recipe.notes).toBe("1. Marinate overnight.\n2. Grill.");
  });

  it("rejects notes over 5000 characters", async () => {
    const t = setup();
    const ch = await t.tool("upsert_food", CHICKEN);
    const r = await t.tool("create_recipe", { name: "Long", ingredients: [{ food_id: ch.food.id, grams: 100 }], notes: "y".repeat(5001) });
    expect(r.ok).toBe(false);
  });

  it("get_recipe returns ingredients with raw weights, per-100 g/per-portion macros, versions and batch history", async () => {
    const t = setup();
    const ch = await t.tool("upsert_food", CHICKEN);
    const ri = await t.tool("upsert_food", RICE);
    const r = await t.tool("create_recipe", { name: "Chicken & rice", ingredients: [{ food_id: ch.food.id, grams: 600 }, { food_id: ri.food.id, grams: 400 }], total_cooked_weight_g: 1200, portion_g: 300 });
    await t.tool("start_container", { recipe_id: r.recipe.id, portions: 4 });
    const v2 = await t.tool("update_recipe", { id: r.recipe.id, total_cooked_weight_g: 1000 });
    const c2 = await t.tool("start_container", { recipe_id: v2.recipe.id, portions: 4 });
    await t.tool("use_container_portion", { container_id: c2.container.id });

    const d = await t.tool("get_recipe", { id: r.recipe.id }); // old id resolves to the current version
    expect(d.recipe.version).toBe(2);
    expect(d.ingredients.map((i: any) => [i.name, i.raw_g])).toEqual([[CHICKEN.name, 600], [RICE.name, 400]]);
    expect(d.ingredients[0].nutrients.kcal).toBe(990);
    expect(d.recipe.per_100g.kcal).toBe(Math.round((165 * 6 + 130 * 4) / 10));
    expect(d.recipe.per_portion.kcal).toBe(Math.round(((165 * 6 + 130 * 4) * 300) / 1000));
    expect(d.versions.map((v: any) => v.total_cooked_weight_g)).toEqual([1200, 1000]);
    expect(d.batches).toHaveLength(2);
    expect(d.batches.map((b: any) => b.cooked_weight_g).sort()).toEqual([1000, 1200]);
    const active = d.batches.find((b: any) => b.version === 2);
    expect(active).toMatchObject({ portions_total: 4, portions_left: 3, active: true });
  });
});

describe("update_entry", () => {
  async function seeded() {
    const t = setup();
    await t.tool("update_profile", PROFILE);
    const ch = await t.tool("upsert_food", CHICKEN); // 165 kcal/100 g, 150 g serving
    const ri = await t.tool("upsert_food", RICE); // 130 kcal/100 g, no serving size
    const log = await t.tool("log_food", { items: [{ food_id: ch.food.id, amount: 1, unit: "serving", meal: "lunch" }] });
    return { t, ch, ri, entryId: log.logged[0].id as number };
  }

  it("recomputes the macro snapshot from the referenced food when the amount changes", async () => {
    const { t, entryId } = await seeded();
    expect((await t.tool("get_day_summary")).totals.kcal).toBe(248); // 150 g
    const r = await t.tool("update_entry", { id: entryId, amount: 250, unit: "g" });
    expect(r.ok).toBe(true);
    expect(r.before.nutrients.kcal).toBe(248);
    expect(r.after).toMatchObject({ id: entryId, amount: 250, unit: "g", grams: 250 });
    expect(r.after.nutrients).toMatchObject({ kcal: 413, protein: 77.5, fat: 9 });
    expect(r.delta.kcal).toBe(413 - 248);
    expect(r.today).toMatch(/^Today: 413 \//);
    const day = await t.tool("get_day_summary");
    expect(day.totals.kcal).toBe(413);
    expect(day.meals.lunch.entries).toHaveLength(1); // edited in place, not delete + re-log
    expect(t.counts().log_entry).toBe(1);
  });

  it("keeps the current unit when only the amount is given, and uses fresh food data on recompute", async () => {
    const { t, ch, entryId } = await seeded();
    await t.tool("upsert_food", { ...CHICKEN, id: ch.food.id, per_100g: { kcal: 120, protein: 23, carbs: 0, fat: 3 } });
    const r = await t.tool("update_entry", { id: entryId, amount: 2 });
    expect(r.after).toMatchObject({ amount: 2, unit: "serving", grams: 300 });
    expect(r.after.nutrients.kcal).toBe(360); // recomputed from the food as it is now
  });

  it("swaps the food, moves meal slot and date, and reports both days' totals", async () => {
    const { t, ri, entryId } = await seeded();
    const r = await t.tool("update_entry", { id: entryId, food_id: ri.food.id, amount: 200, unit: "g", meal: "dinner", date: "2026-10-16" });
    expect(r.after).toMatchObject({ name: RICE.name, ref_type: "food", ref_id: ri.food.id, meal: "dinner", date: "2026-10-16" });
    expect(r.after.nutrients.kcal).toBe(260);
    expect(r.day_after).toMatchObject({ date: "2026-10-16" });
    expect(r.day_after.totals.kcal).toBe(260);
    expect(r.previous_day_after.totals.kcal).toBe(0);
    expect((await t.tool("get_day_summary")).totals.kcal).toBe(0);
    expect((await t.tool("get_day_summary", { date: "2026-10-16" })).meals.dinner.entries[0].name).toBe(RICE.name);
  });

  it("a swap without an amount uses the new item's default", async () => {
    const { t, ri, entryId } = await seeded();
    const r = await t.tool("update_entry", { id: entryId, food_id: ri.food.id });
    expect(r.after).toMatchObject({ amount: 100, unit: "g" }); // rice has no serving size
  });

  describe("container portions", () => {
    async function withContainer() {
      const base = await seeded();
      const { t, ch, ri } = base;
      const rec = await t.tool("create_recipe", { name: "Prep", ingredients: [{ food_id: ch.food.id, grams: 600 }, { food_id: ri.food.id, grams: 400 }], total_cooked_weight_g: 1200, portion_g: 300 });
      const c1 = await t.tool("start_container", { recipe_id: rec.recipe.id, portions: 4 });
      const c2 = await t.tool("start_container", { recipe_id: rec.recipe.id, portions: 2, label: "Second batch" });
      const eat = await t.tool("use_container_portion", { container_id: c1.container.id, meal: "dinner" });
      const left = async (id: number) => (await t.tool("get_recipe", { id: rec.recipe.id })).batches.find((b: any) => b.container_id === id).portions_left;
      return { ...base, c1: c1.container.id as number, c2: c2.container.id as number, eatId: eat.logged[0].id as number, left };
    }

    it("changing the portion count adjusts portions_left by the difference", async () => {
      const { t, c1, eatId, left } = await withContainer();
      expect(await left(c1)).toBe(3);
      const r = await t.tool("update_entry", { id: eatId, amount: 2 });
      expect(r.after).toMatchObject({ amount: 2, unit: "portion", grams: 600 });
      expect(await left(c1)).toBe(2);
      await t.tool("update_entry", { id: eatId, amount: 0.5 });
      expect(await left(c1)).toBe(3.5);
      await t.tool("update_entry", { id: eatId, amount: 150, unit: "g" }); // half a 300 g portion
      expect(await left(c1)).toBe(3.5);
    });

    it("swapping away from a container gives the portion back; swapping onto one takes it", async () => {
      const { t, ch, c1, c2, eatId, entryId, left } = await withContainer();
      await t.tool("update_entry", { id: eatId, food_id: ch.food.id });
      expect(await left(c1)).toBe(4);
      await t.tool("update_entry", { id: entryId, container_id: c2 });
      expect(await left(c2)).toBe(1);
      await t.tool("update_entry", { id: entryId, container_id: c1, amount: 1 }); // move between containers
      expect(await left(c2)).toBe(2);
      expect(await left(c1)).toBe(3);
    });

    it("dry_run previews container changes without writing", async () => {
      const { t, c1, eatId, left } = await withContainer();
      const before = t.snapshot();
      const r = await t.tool("update_entry", { id: eatId, amount: 3, dry_run: true });
      expect(r.dry_run).toBe(true);
      expect(r.containers).toEqual([{ container_id: c1, portions_left: 1 }]);
      expect(t.snapshot()).toBe(before);
      expect(await left(c1)).toBe(3);
    });
  });

  it("rejects implausible or invalid edits and leaves the entry untouched", async () => {
    const { t, entryId } = await seeded();
    const before = t.snapshot();
    for (const args of [
      { id: entryId, amount: 100000, unit: "g" }, // over the per-entry weight limit
      { id: entryId, amount: 60 }, // 60 servings
      { id: entryId, amount: -1 },
      { id: entryId, date: "2026-13-45" },
      { id: entryId, food_id: 99999 },
      { id: entryId, food_id: 1, recipe_id: 1 },
      { id: entryId },
      { id: 424242, amount: 1 },
    ]) {
      const r = await t.tool("update_entry", args);
      expect(r.ok, JSON.stringify(args)).toBe(false);
    }
    const r = await t.tool("update_entry", { id: entryId, amount: 100000, unit: "g" });
    expect(r.error).toMatch(/validation_failed|invalid_input/);
    expect(t.snapshot()).toBe(before);
  });

  it("is audit-logged, and undo_last reverts the edit and the container counts in one step", async () => {
    const base = await seeded();
    const { t } = base;
    const rec = await t.tool("create_recipe", { name: "Prep", ingredients: [{ food_id: base.ch.food.id, grams: 600 }], total_cooked_weight_g: 600, portion_g: 150 });
    const c = await t.tool("start_container", { recipe_id: rec.recipe.id, portions: 4 });
    const eat = await t.tool("use_container_portion", { container_id: c.container.id });
    const eatId = eat.logged[0].id;
    const left = async () => (await t.tool("list_containers")).containers.find((x: any) => x.id === c.container.id)?.portions_left ?? 0;
    expect(await left()).toBe(3);

    await t.tool("update_entry", { id: eatId, amount: 3, meal: "dinner" });
    expect(await left()).toBe(1);
    const audit = t.raw.prepare("select table_name from audit_log where tool = ?").all("update_entry") as { table_name: string }[];
    expect(audit.map((a) => a.table_name).sort()).toEqual(["container", "logEntry"]);

    const u = await t.tool("undo_last");
    expect(u).toMatchObject({ undone: true, tool: "update_entry" });
    expect(await left()).toBe(3);
    const entry = (await t.tool("get_day_summary")).meals.lunch.entries.find((e: any) => e.id === eatId);
    expect(entry).toMatchObject({ amount: 1, meal: "lunch" });
  });
});
