// Copies Tesseract.js worker, wasm cores and English model into the dashboard's static
// assets so label OCR runs fully on-device with no third-party CDN. Runs before `vite build`.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const out = join(root, "apps/dashboard/public/ocr");
const files = [
  ["tesseract.js/dist/worker.min.js", "worker.min.js"],
  // OEM 1 (LSTM only) — Tesseract picks the fastest variant the device supports.
  ["tesseract.js-core/tesseract-core-lstm.wasm.js", "core/tesseract-core-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "core/tesseract-core-simd-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js", "core/tesseract-core-relaxedsimd-lstm.wasm.js"],
  ["@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "lang/eng.traineddata.gz"],
];
for (const [from, to] of files) {
  mkdirSync(dirname(join(out, to)), { recursive: true });
  copyFileSync(join(nm, from), join(out, to));
}
console.log(`OCR assets → ${out}`);
