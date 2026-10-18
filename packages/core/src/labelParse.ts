/**
 * Parse OCR text from a nutrition panel (US "Nutrition Facts" or EU/UK
 * "Nutrition information" tables) into numbers for the manual-entry form.
 * Deliberately conservative: anything not clearly found is left null for
 * the user to fill in; nothing is invented.
 */

export interface ParsedLabel {
  /** Which basis the numbers are on. */
  basis: "serving" | "100g";
  servingSizeG: number | null;
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
  sugar: number | null;
  sodiumMg: number | null;
  /** Fields found / not found, for the UI. */
  found: string[];
  missing: string[];
  notes: string[];
}

const NUM = String.raw`(<\s*)?(\d+(?:\.\d+)?)`;

/** Fix common OCR confusions inside numbers and units. */
export function normalizeOcr(text: string): string {
  return (
    text
      .replace(/\r/g, "")
      // "O"/"o" → 0 and "l"/"I" → 1 when sitting among digits: "1O g", "l2g", "0.5O"
      .replace(/(?<=\d|\.)[Oo](?=\d|\s*(?:g|mg|kcal|kj|%)\b)/gi, "0")
      .replace(/\b[Oo](?=\s?(?:g|mg)\b)/g, "0")
      .replace(/(?<=\d)[lI](?=\d)/g, "1")
      .replace(/\b[lI](?=\d)/g, "1")
      // decimal commas (EU): "3,5 g" → "3.5 g"
      .replace(/(\d),(\d)/g, "$1.$2")
      // unit glued variants: "12gm" "12grams"
      .replace(/(\d)\s*(?:gm|grams?)\b/gi, "$1 g")
      .replace(/[|]/g, " ")
  );
}

interface NumHit {
  value: number;
  unit: string | null;
}

/** All numbers (with optional units) after `from` in a line. "<1 g" counts as 0.5. */
function numbersIn(s: string): NumHit[] {
  const re = new RegExp(`${NUM}\\s*(mg|g|kcal|kj|ml|%)?`, "gi");
  const out: NumHit[] = [];
  for (const m of s.matchAll(re)) {
    let v = Number(m[2]);
    if (m[1]) v = v / 2; // "<1g" → 0.5 g
    out.push({ value: v, unit: m[3]?.toLowerCase() ?? null });
  }
  return out;
}

interface Rule {
  key: keyof Omit<ParsedLabel, "basis" | "found" | "missing" | "notes" | "servingSizeG">;
  match: RegExp;
  exclude?: RegExp;
}

const RULES: Rule[] = [
  { key: "fat", match: /\b(total\s+fat|fat|lipides|fett|grassi|grasas)\b/i, exclude: /saturat|trans|mono|poly|of which|from fat|calories from/i },
  { key: "carbs", match: /\b(total\s+carbohydrates?|carbohydrates?|carbs|glucides|kohlenhydrate|carboidrati|hidratos)\b/i, exclude: /of which|fibre|fiber/i },
  { key: "fiber", match: /\b(dietary\s+fib(?:er|re)|fib(?:er|re)|ballaststoffe|fibres?)\b/i },
  { key: "sugar", match: /\b(total\s+sugars?|sugars?|sucres|zucker|zuccheri|azúcares)\b/i, exclude: /added|incl|alcohol/i },
  { key: "protein", match: /\b(proteins?|protéines|eiweiß|eiweiss|proteine|proteínas)\b/i },
];

function isUnitOk(key: Rule["key"], unit: string | null): boolean {
  if (unit === "%" || unit === "kcal" || unit === "kj" || unit === "mg" || unit === "ml") return false;
  return true; // "g" or missing unit (OCR often drops it)
}

export function parseNutritionLabel(raw: string): ParsedLabel {
  const text = normalizeOcr(raw);
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const lower = text.toLowerCase();
  const notes: string[] = [];

  const per100 = /per\s*100\s*(g|ml)|100\s*(g|ml)\b|pour\s*100|je\s*100|per\s*100/i.test(lower);
  const usStyle = /nutrition\s*facts|serving\s*size|daily\s*value|%\s*dv/i.test(lower);
  const basis: ParsedLabel["basis"] = per100 && !usStyle ? "100g" : "serving";
  if (per100 && usStyle) notes.push("Label mentions both per-serving and per-100 g values; using per serving.");

  const result: ParsedLabel = { basis, servingSizeG: null, kcal: null, protein: null, carbs: null, fat: null, fiber: null, sugar: null, sodiumMg: null, found: [], missing: [], notes };

  /** First number after the keyword on this line, or on the next line if this one has none. */
  const valueAfter = (i: number, keyword: RegExp, accept: (h: NumHit) => boolean): NumHit | null => {
    const line = lines[i];
    const m = keyword.exec(line);
    const tail = m ? line.slice(m.index + m[0].length) : line;
    const hit = numbersIn(tail).find(accept);
    if (hit) return hit;
    if (!numbersIn(tail).length && lines[i + 1]) return numbersIn(lines[i + 1]).find(accept) ?? null;
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Serving size: "Serving size 2/3 cup (55g)", "Per serving (30 g)", "Portion: 30g"
    if (result.servingSizeG == null && /serving\s*size|per\s*serving|per\s*portion|portion\s*[:(]|serving\s*\(|1\s*serving|\d\s*(g|ml)\s*(serving|portion)/i.test(line)) {
      // OCR often reads the "g" in "(55g)" as "9" → "(559)". Only fixed inside parentheses on this line.
      const servingLine = line.replace(/\((\d{1,4}(?:\.\d+)?)\s?9\)/g, "($1g)");
      const grams = [...servingLine.matchAll(/(\d+(?:\.\d+)?)\s*(g|ml)\b/gi)].map((m) => Number(m[1]));
      if (grams.length) result.servingSizeG = grams[grams.length - 1] === 100 && grams.length > 1 ? grams[0] : grams[grams.length - 1];
    }

    // Energy: "Calories 230" (US) or "Energy 1046 kJ / 250 kcal" (EU)
    if (result.kcal == null && /\b(calories|energy|energie|énergie|valeur énergétique|kcal)\b/i.test(line) && !/from\s+fat|daily|diet of/i.test(line)) {
      const nums = numbersIn(line.replace(/^.*?(calories|energy|energie|énergie)/i, ""));
      const kcal = nums.find((n) => n.unit === "kcal");
      const kj = nums.find((n) => n.unit === "kj");
      if (kcal) result.kcal = kcal.value;
      else if (/calories/i.test(line)) {
        const h = valueAfter(i, /calories/i, (n) => n.unit === null || n.unit === "kcal");
        if (h) result.kcal = h.value;
      } else {
        // Printed kcal (often on the next line under the kJ figure) beats converting from kJ.
        const nextKcal = (lines[i + 1] ? numbersIn(lines[i + 1]) : []).find((n) => n.unit === "kcal");
        if (nextKcal) result.kcal = nextKcal.value;
        else if (kj) {
          result.kcal = Math.round(kj.value / 4.184);
          notes.push("Converted energy from kJ.");
        }
      }
    }

    // Sodium (mg or g) / salt (g → sodium = salt ÷ 2.5)
    if (result.sodiumMg == null && /\bsodium\b/i.test(line)) {
      const h = valueAfter(i, /sodium/i, (n) => n.unit !== "%");
      if (h) result.sodiumMg = h.unit === "g" ? Math.round(h.value * 1000) : Math.round(h.value);
    } else if (result.sodiumMg == null && /\b(salt|sel|salz|sale|sal)\b/i.test(line)) {
      const h = valueAfter(i, /\b(salt|sel|salz|sale|sal)\b/i, (n) => n.unit !== "%" && n.unit !== "mg");
      if (h) {
        result.sodiumMg = Math.round((h.value / 2.5) * 1000);
        notes.push("Sodium calculated from salt (salt ÷ 2.5).");
      }
    }

    for (const rule of RULES) {
      if (result[rule.key] != null) continue;
      const m = rule.match.exec(line);
      if (!m) continue;
      if (rule.exclude?.test(line)) continue;
      // "Total Carbohydrate" lines can also mention fiber on the same OCR line — only take numbers after the keyword.
      const h = valueAfter(i, rule.match, (n) => isUnitOk(rule.key, n.unit));
      if (h) result[rule.key] = h.value;
    }
  }

  // Sugars on EU labels appear as "of which sugars" — catch them if the generic rule excluded the line.
  if (result.sugar == null) {
    const i = lines.findIndex((l) => /of which\s*sugars?/i.test(l));
    if (i >= 0) {
      const h = valueAfter(i, /sugars?/i, (n) => isUnitOk("sugar", n.unit));
      if (h) result.sugar = h.value;
    }
  }

  const fields: (keyof ParsedLabel)[] = ["servingSizeG", "kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodiumMg"];
  for (const f of fields) (result[f] == null ? result.missing : result.found).push(f);
  if (result.basis === "serving" && result.servingSizeG == null) notes.push("Serving size in grams not found — enter it so values can be converted to per 100 g.");
  return result;
}
