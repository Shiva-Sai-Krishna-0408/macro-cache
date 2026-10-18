/**
 * On-device label OCR with Tesseract.js. Everything (worker, wasm core, English model)
 * is served from this app's own /ocr/ assets and loaded only when needed; the photo
 * never leaves the phone.
 */

export interface OcrProgress {
  status: string;
  progress: number; // 0–1
}

/** Downscale, grayscale and contrast-stretch the photo — big accuracy win for glossy packaging. */
async function preprocess(file: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const maxSide = 2000;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = y;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    const v = ((d[i] - min) / range) * 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

export async function recognizeLabel(file: Blob, onProgress: (p: OcrProgress) => void): Promise<string> {
  onProgress({ status: "Preparing photo", progress: 0 });
  const canvas = await preprocess(file);
  onProgress({ status: "Loading text recognizer", progress: 0.05 });
  const { createWorker, OEM, PSM } = await import("tesseract.js");
  const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: "/ocr/worker.min.js",
    corePath: "/ocr/core",
    langPath: "/ocr/lang",
    gzip: true,
    workerBlobURL: false,
    logger: (m: { status: string; progress: number }) =>
      onProgress({ status: m.status === "recognizing text" ? "Reading label" : "Loading text recognizer", progress: m.status === "recognizing text" ? 0.3 + m.progress * 0.7 : 0.05 + m.progress * 0.25 }),
  });
  try {
    // Nutrition panels are table-like blocks; "single block" segmentation reads rows in order.
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: "1" });
    const { data } = await worker.recognize(canvas);
    return data.text;
  } finally {
    await worker.terminate();
  }
}
