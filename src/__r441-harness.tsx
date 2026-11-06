// DEV ONLY: the fixture behind r441-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build. Every value is invented.
// R-441: the company documents screen against an in-memory server, with a generated fillable form.
import ReactDOM from "react-dom/client";
import { PDFDocument, StandardFonts } from "pdf-lib";
import DocumentsView from "./components/DocumentsView";
import { ToastHost } from "./components/Toast";
import { fromB64, toB64 } from "./lib/documentsApi";
import "./index.css";

async function sampleForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Certificate of resale (test form)", { x: 50, y: 740, size: 18, font });
  const form = doc.getForm();
  const row = (label: string, name: string, y: number) => {
    page.drawText(label, { x: 50, y: y + 6, size: 10, font });
    const f = form.createTextField(name);
    f.addToPage(page, { x: 200, y, width: 340, height: 20 });
  };
  row("Seller name", "seller_name", 680);
  row("Purchaser name", "purchaser_name", 650);
  row("Purchaser address", "purchaser_address", 620);
  row("Resale number", "resale_number", 590);
  page.drawText("Blanket certificate", { x: 50, y: 566, size: 10, font });
  form.createCheckBox("blanket").addToPage(page, { x: 200, y: 560, width: 16, height: 16 });
  page.drawText("Signature", { x: 50, y: 506, size: 10, font });
  page.drawLine({ start: { x: 200, y: 500 }, end: { x: 540, y: 500 } });
  page.drawText("Date", { x: 50, y: 476, size: 10, font });
  page.drawLine({ start: { x: 200, y: 470 }, end: { x: 360, y: 470 } });
  return doc.save();
}

const now = "2026-10-05T14:00:00.000Z";
const files = new Map<string, Uint8Array>();
let signature: string | null = null;
const docs: any[] = [];
const add = (id: string, title: string, category: string, checklist_key: string, filename: string, mime: string, bytes: Uint8Array, expires_on = "") => {
  files.set(id + ":1", bytes);
  docs.push({ id, title, category, checklist_key, expires_on, notes: "", current_version: 1, archived: false, created_at: now, updated_at: now,
    versions: [{ version: 1, filename, mime, size: bytes.length, sha256: "x", note: "Uploaded", created_by: "Test Admin", created_at: now }] });
};

(async () => {
  add("d1", "CRT-61 resale certificate", "certificates", "resale_cert", "crt-61.pdf", "application/pdf", await sampleForm());
  add("d2", "General liability insurance", "licenses", "insurance", "coi.pdf", "application/pdf", await sampleForm(), "2026-11-01");
  add("d3", "EIN letter", "tax", "ein_letter", "ein.pdf", "application/pdf", await sampleForm());
  (window as any).__FIXTURE = (cmd: string, a: any) => {
    const d = a?.id ? docs.find((x) => x.id === a.id) : null;
    switch (cmd) {
      case "docs_list": return { documents: JSON.parse(JSON.stringify(docs)) };
      case "docs_mirror": return { folder: "C:/fake/company-documents", copied: 0 };
      case "docs_file": return toB64(files.get(a.id + ":" + (a.version ?? d.current_version))!);
      case "docs_signature_get": return { png: signature };
      case "docs_signature_put": signature = a.png; return { ok: true };
      case "docs_new_version": {
        const bytes = fromB64(a.bytesB64);
        const v = d.current_version + 1;
        files.set(d.id + ":" + v, bytes);
        (window as any).__lastSaved = bytes;
        d.versions.unshift({ version: v, filename: d.versions[0].filename, mime: "application/pdf", size: bytes.length, sha256: "x", note: a.note, created_by: "Test Admin", created_at: now });
        d.current_version = v;
        return { ok: true, version: v };
      }
      case "docs_update": Object.assign(d, a.patch); return { ok: true };
      case "docs_archive": d.archived = a.archived; return { ok: true };
      case "docs_upload": {
        const id = "d" + (docs.length + 1);
        add(id, a.title, a.category, a.checklistKey, a.filename, "application/pdf", fromB64(a.bytesB64));
        return { id };
      }
      default: return null;
    }
  };
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <div style={{ minHeight: "100vh", background: "var(--t-bg)" }}><DocumentsView /><ToastHost /></div>,
  );
})();
