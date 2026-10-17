import { useEffect, useRef, useState } from "react";

/** Camera barcode scanner using @zxing/browser (loaded on demand). */
export default function BarcodeScanner({ onDetected }: { onDetected: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    let controls: { stop: () => void } | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const { BarcodeFormat, DecodeHintType } = await import("@zxing/library");
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E]);
        const reader = new BrowserMultiFormatReader(hints);
        if (cancelled || !videoRef.current) return;
        controls = await reader.decodeFromConstraints({ video: { facingMode: "environment" } }, videoRef.current, (result) => {
          if (result && !done.current) {
            done.current = true;
            navigator.vibrate?.(50);
            controls?.stop();
            onDetected(result.getText());
          }
        });
      } catch (e) {
        setError((e as Error).name === "NotAllowedError" ? "Camera permission denied. Type the barcode below instead." : "Camera unavailable. Type the barcode below instead.");
      }
    })();
    return () => {
      cancelled = true;
      controls?.stop();
    };
  }, [onDetected]);

  return (
    <div>
      {error ? (
        <p className="rounded-xl bg-panel-2 p-3 text-sm text-ink-2">{error}</p>
      ) : (
        <div className="relative overflow-hidden rounded-2xl bg-black">
          <video ref={videoRef} className="aspect-[4/3] w-full object-cover" muted playsInline />
          <div className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-accent/80 shadow-[0_0_12px_var(--color-accent)]" />
        </div>
      )}
    </div>
  );
}
