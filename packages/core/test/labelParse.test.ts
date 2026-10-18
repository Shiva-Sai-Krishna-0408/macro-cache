import { describe, expect, it } from "vitest";
import { normalizeOcr, parseNutritionLabel, validatePer100g } from "../src";

// FDA's sample "Nutrition Facts" label, as Tesseract typically returns it.
const US_LABEL = `Nutrition Facts
8 servings per container
Serving size 2/3 cup (55g)
Amount per serving
Calories 230
% Daily Value*
Total Fat 8g 10%
Saturated Fat 1g 5%
Trans Fat 0g
Cholesterol 0mg 0%
Sodium 160mg 7%
Total Carbohydrate 37g 13%
Dietary Fiber 4g 14%
Total Sugars 12g
Includes 10g Added Sugars 20%
Protein 3g
Vitamin D 2mcg 10%
* The % Daily Value (DV) tells you how much a nutrient in a serving of food contributes to a daily diet. 2,000 calories a day is used for general nutrition advice.`;

// EU/UK table, per 100 g with energy in kJ and kcal, salt instead of sodium.
const EU_LABEL = `NUTRITION INFORMATION
Typical values per 100g
Energy 2252 kJ / 539 kcal
Fat 30.9 g
of which saturates 10.6 g
Carbohydrate 57.5 g
of which sugars 56.3 g
Fibre 0 g
Protein 6.3 g
Salt 0.107 g`;

// Two columns: per 100 g first, per 30 g portion second.
const EU_TWO_COLUMN = `Nutrition  Per 100g  Per 30g serving
Energy  1580kJ  474kJ
  375kcal  113kcal
Fat  6.5g  2.0g
of which saturates  1.1g  0.3g
Carbohydrate  60g  18g
of which sugars  1.1g  0.3g
Fibre  9.0g  2.7g
Protein  13g  3.9g
Salt  0.02g  <0.01g`;

// OCR noise: O for 0, l for 1, the calories number on its own line, sodium in g, decimal commas.
const NOISY = `Nutrition Facts
Serving Size l cup (24Og)
Calories
l50
Total Fat 2,5g 3%
Sodium 0.12g 5%
Total Carbohydrate 2Og 7%
Dietary Fiber <1g
Sugars 18 g
Protein 1Og`;

describe("parseNutritionLabel", () => {
  it("parses a US Nutrition Facts panel (per serving)", () => {
    const r = parseNutritionLabel(US_LABEL);
    expect(r.basis).toBe("serving");
    expect(r).toMatchObject({ servingSizeG: 55, kcal: 230, fat: 8, sodiumMg: 160, carbs: 37, fiber: 4, sugar: 12, protein: 3 });
    expect(r.missing).toEqual([]);
  });

  it("does not confuse 'Saturated Fat', 'Added Sugars' or the 2,000-calorie footnote with real values", () => {
    const r = parseNutritionLabel(US_LABEL);
    expect(r.fat).toBe(8);
    expect(r.sugar).toBe(12);
    expect(r.kcal).toBe(230);
  });

  it("parses an EU per-100 g table: kcal over kJ, sugars from 'of which', sodium from salt", () => {
    const r = parseNutritionLabel(EU_LABEL);
    expect(r.basis).toBe("100g");
    expect(r).toMatchObject({ kcal: 539, fat: 30.9, carbs: 57.5, sugar: 56.3, fiber: 0, protein: 6.3 });
    expect(r.sodiumMg).toBe(43); // 0.107 g salt ÷ 2.5
    expect(r.notes.join(" ")).toMatch(/salt/);
  });

  it("takes the per-100 g column from a two-column EU table and finds the serving size", () => {
    const r = parseNutritionLabel(EU_TWO_COLUMN);
    expect(r.basis).toBe("100g");
    expect(r.servingSizeG).toBe(30);
    expect(r).toMatchObject({ kcal: 375, fat: 6.5, carbs: 60, sugar: 1.1, fiber: 9, protein: 13, sodiumMg: 8 });
  });

  it("copes with common OCR noise", () => {
    const r = parseNutritionLabel(NOISY);
    expect(r).toMatchObject({ servingSizeG: 240, kcal: 150, fat: 2.5, sodiumMg: 120, carbs: 20, sugar: 18, protein: 10 });
    expect(r.fiber).toBe(0.5); // "<1g"
  });

  it("recovers serving size when OCR reads '(55g)' as '(559)' (real Tesseract output)", () => {
    const tesseractOutput = `Nutrition Facts
8 servings per container
Serving size                           2/3 cup (559)
Amount per serving
Calories         230
Total Fat 8g                                              10%
Trans Fat Og
Cholesterol Omg                                   0%
Sodium 160mg                          7%
Total Carbohydrate 37g                                          13%
Protein 3g`;
    const r = parseNutritionLabel(tesseractOutput);
    expect(r).toMatchObject({ servingSizeG: 55, kcal: 230, fat: 8, sodiumMg: 160, carbs: 37, protein: 3 });
    expect(parseNutritionLabel("Serving size 1 bar (40 9)\nCalories 190").servingSizeG).toBe(40);
  });

  it("converts kJ when no kcal is printed", () => {
    const r = parseNutritionLabel("Per 100 g\nEnergy 1046 kJ\nFat 12 g\nCarbohydrate 31 g\nProtein 5 g");
    expect(r.kcal).toBe(250);
    expect(r.notes.join(" ")).toMatch(/kJ/);
  });

  it("leaves unknown fields null instead of guessing, and reports them", () => {
    const r = parseNutritionLabel("Nutrition Facts\nCalories 90\nProtein 20g");
    expect(r).toMatchObject({ kcal: 90, protein: 20, fat: null, carbs: null, servingSizeG: null });
    expect(r.missing).toEqual(expect.arrayContaining(["fat", "carbs", "servingSizeG"]));
    expect(r.notes.join(" ")).toMatch(/Serving size/);
  });

  it("returns nothing useful for non-label text", () => {
    const r = parseNutritionLabel("Hello world\nThis is a receipt\nTotal $12.99");
    expect(r.found).toEqual([]);
  });

  it("parsed labels pass the server's plausibility validation once converted to per 100 g", () => {
    const us = parseNutritionLabel(US_LABEL);
    const f = 100 / us.servingSizeG!;
    expect(validatePer100g({ kcal: us.kcal! * f, protein: us.protein! * f, carbs: us.carbs! * f, fat: us.fat! * f, fiber: us.fiber! * f, sugar: us.sugar! * f, sodiumMg: us.sodiumMg! * f }).ok).toBe(true);
    const eu = parseNutritionLabel(EU_LABEL);
    expect(validatePer100g({ kcal: eu.kcal!, protein: eu.protein!, carbs: eu.carbs!, fat: eu.fat!, sugar: eu.sugar!, sodiumMg: eu.sodiumMg! }).ok).toBe(true);
  });

  it("normalizeOcr fixes digits without mangling words", () => {
    expect(normalizeOcr("Protein 1Og")).toBe("Protein 10g");
    expect(normalizeOcr("Fat 3,5 g")).toBe("Fat 3.5 g");
    expect(normalizeOcr("Sodium Og")).toBe("Sodium 0g");
    expect(normalizeOcr("Total Carbohydrate")).toBe("Total Carbohydrate");
  });
});
