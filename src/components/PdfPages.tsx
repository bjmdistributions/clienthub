// R-650: a file preview drawn by the app itself. A PDF's pages are painted with pdf.js (the library Documents
// already uses), one under the other; an image is shown as it is. The previews used to put the file in an
// iframe, which hands a PDF to WebView2's own PDF plugin, and that showed a carrier invoice as a blank white
// frame (Jack, 2026-11-12: "they show all white when i open the invoice dropped in from logistics").
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

async function pdfjs() {
  const [lib, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  return lib;
}

/** The file at `url` (a blob: URL the caller made and revokes), fitted to the box's width. */
export default function PdfPages({ url, title, className = "" }: { url: string; title: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "failed">("loading");

  useEffect(() => {
    const host = pages.current;
    if (!host) return;
    let dead = false;
    let doc: PDFDocumentProxy | null = null;
    host.replaceChildren();
    setState("loading");
    (async () => {
      try {
        const blob = await (await fetch(url)).blob();
        if (blob.type.startsWith("image/")) {
          const img = document.createElement("img");
          img.src = url;
          img.alt = title;
          img.className = "max-w-full rounded-sm ring-1 ring-line";
          host.appendChild(img);
          if (!dead) setState("ok");
          return;
        }
        const lib = await pdfjs();
        doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
        const dpr = window.devicePixelRatio || 1;
        const room = (box.current?.clientWidth ?? 0) - 32;
        for (let n = 1; n <= doc.numPages && !dead; n++) {
          const page = await doc.getPage(n);
          const plain = page.getViewport({ scale: 1 });
          const fit = room > 0 ? room / plain.width : 1.5;
          const vp = page.getViewport({ scale: fit * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(vp.width);
          canvas.height = Math.floor(vp.height);
          canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
          canvas.className = "max-w-full rounded-sm ring-1 ring-line";
          canvas.setAttribute("aria-label", `${title}, page ${n} of ${doc.numPages}`);
          host.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
          if (n === 1 && !dead) setState("ok");
        }
      } catch {
        if (!dead) setState("failed");
      }
    })();
    return () => { dead = true; void doc?.destroy(); };
  }, [url, title]);

  return (
    <div ref={box} role="document" aria-label={title} onClick={(e) => e.stopPropagation()}
      className={`overflow-auto bg-surface-2 ${className}`}>
      {state !== "ok" && (
        <p className="m-0 p-6 text-center text-[14px] text-muted">
          {state === "loading" ? "Opening the file..." : "This file could not be shown here. Save a copy to open it."}
        </p>
      )}
      <div ref={pages} className="flex flex-col items-center gap-4 p-4" />
    </div>
  );
}
