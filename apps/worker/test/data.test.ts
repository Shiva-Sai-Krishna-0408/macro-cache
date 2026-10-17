import { describe, expect, it } from "vitest";
import { exportCsv, exportJson, importJson } from "../src/services/data";
import { CHICKEN, PROFILE, setup } from "./helpers";

describe("export / import", () => {
  it("round-trips all data through JSON", async () => {
    const a = setup();
    await a.tool("update_profile", PROFILE);
    const ch = await a.tool("upsert_food", CHICKEN);
    await a.tool("log_food", { items: [{ food_id: ch.food.id, meal: "lunch" }] });
    await a.tool("log_weight", { weight_kg: 89.5 });
    const dump = JSON.parse(JSON.stringify(await exportJson(a.dashboard)));

    const b = setup();
    const r = await importJson(b.dashboard, dump);
    expect(r.imported.food).toBe(1);
    expect((await b.tool("search_foods", { query: "chicken" })).results[0].aliases).toEqual(["chicken"]);
    expect((await b.tool("get_day_summary")).totals.kcal).toBe((await a.tool("get_day_summary")).totals.kcal);
    expect((await b.tool("get_profile")).targets.kcal).toBe((await a.tool("get_profile")).targets.kcal);
  });

  it("rejects files that aren't macro-cache exports", async () => {
    const t = setup();
    await expect(importJson(t.dashboard, { app: "other", data: {} } as never)).rejects.toThrow();
  });

  it("CSV export neutralizes spreadsheet formulas", async () => {
    const t = setup();
    await t.tool("log_food", { items: [{ adhoc: { name: "=HYPERLINK(\"http://evil\")", kcal: 100, protein: 5, carbs: 10, fat: 4.4 }, meal: "snack" }] });
    const csv = await exportCsv(t.dashboard, "log");
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv.split("\n")[0]).toMatch(/^date,meal,name/);
  });
});
