import { convertFileSrc } from "@tauri-apps/api/core";
import { CompanyInfo, InvoiceTemplate } from "../lib/api";

// Template defaults — keep today's look until the saved template loads.
export const DEFAULT_INVOICE_TEMPLATE: InvoiceTemplate = {
  logo_placement: "left",
  logo_size: "medium",
  show_company_name: true,
  show_address: true,
  show_email: true,
  show_phone: true,
  show_tax_id: true,
  accent_color: "#111827",
  title_label: "INVOICE",
  footer_note: "",
};

// Live values from the invoice form. When `data` is omitted the preview shows
// sample content (used by the Settings invoice studio), so that call site is
// visually unchanged.
export interface InvoicePreviewData {
  clientName?: string;
  clientAddress?: string;
  number?: string;
  issueDate?: string;   // pre-formatted display string
  dueDate?: string;     // pre-formatted display string
  items?: { description: string; qty: number; rate: number; amount: number }[];
  taxRate?: number;     // percent, e.g. 8
  notes?: string;
  /** Standing clauses printed below the notes (R-162), as [heading, body] pairs.
   *  Mirrors `document_clauses` in the Rust renderer so the on-screen preview and
   *  the emailed PDF cannot drift. */
  clauses?: [string, string][];
}

// Visual A4-proportion document — mirrors the backend PDF layout (invoice or quote).
export default function InvoicePreview({ info, tpl, logoVersion, kind = "invoice", data }: {
  info: CompanyInfo; tpl: InvoiceTemplate; logoVersion: number; kind?: "invoice" | "quote"; data?: InvoicePreviewData;
}) {
  const isQuote = kind === "quote";
  const accent = tpl.accent_color || "#111827";
  const logoH = tpl.logo_size === "small" ? 30 : tpl.logo_size === "large" ? 64 : 44;
  const align = tpl.logo_placement === "center" ? "items-center text-center" : tpl.logo_placement === "right" ? "items-end text-right" : "items-start text-left";

  const companyLines = [
    tpl.show_address && info.address,
    tpl.show_email && info.email,
    tpl.show_phone && (info.phone || ""),
    tpl.show_tax_id && info.tax_id && `Tax ID: ${info.tax_id}`,
  ].filter(Boolean) as string[];

  const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Live data drives the document; when absent, fall back to sample content.
  const rows = data
    ? (data.items ?? []).map((it) => ({ d: it.description, q: it.qty, r: it.rate }))
    : [
        { d: "Consulting services", q: 10, r: 150 },
        { d: "Setup & onboarding", q: 1, r: 500 },
        { d: "Monthly support", q: 3, r: 200 },
      ];
  const subtotal = rows.reduce((s, r) => s + r.q * r.r, 0);
  const taxPct = data ? (data.taxRate ?? 0) : 8;
  const tax = subtotal * (taxPct / 100);
  const total = subtotal + tax;

  const clientName = data ? (data.clientName || "—") : "Sample Client";
  const clientAddress = data ? (data.clientAddress || "") : "123 Example St";
  const number = data?.number || (isQuote ? "QUO-0001" : "INV-0001");
  const issueLabel = data ? (data.issueDate || "—") : "Jan 1, 2025";
  const dueLabel = data ? (data.dueDate || "—") : "Jan 15, 2025";
  const notes = (data?.notes || "").trim();

  return (
    // A4 portrait ratio (1 : 1.414). White paper regardless of app theme.
    <div className="w-full mx-auto rounded-lg overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.14)] border border-line"
      style={{ background: "#ffffff", color: "#1f2937", aspectRatio: "1 / 1.414", maxWidth: 620 }}>
      <div className="h-full w-full p-[6%] flex flex-col text-[10px] leading-snug">

        {/* Header: brand block (left/center/right) + title top-right */}
        <div className="flex items-start justify-between gap-4">
          <div className={`flex flex-col min-w-0 ${align}`}>
            {info.logo_path
              ? <img src={`${convertFileSrc(info.logo_path)}?t=${logoVersion}`} alt="" style={{ height: logoH, maxWidth: "60%", objectFit: "contain" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              : <div className="rounded flex items-center justify-center text-[8px] font-medium" style={{ height: logoH, width: logoH * 1.6, background: "#f3f4f6", color: "#9ca3af" }}>Logo</div>}
            {tpl.show_company_name && info.name && <div className="mt-1.5 font-bold text-[12px]" style={{ color: "#111827" }}>{info.name}</div>}
            {companyLines.length > 0 && (
              <div className="mt-0.5" style={{ color: "#6b7280" }}>
                {companyLines.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            <div className="font-extrabold tracking-wide text-[18px]" style={{ color: accent }}>{tpl.title_label || (isQuote ? "QUOTE" : "INVOICE")}</div>
            <div className="mt-0.5" style={{ color: "#6b7280" }}># {number}</div>
          </div>
        </div>

        {/* Accent divider */}
        <div className="mt-3 mb-4" style={{ height: 2, background: accent }} />

        {/* Bill-to + dates */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="uppercase tracking-wide font-semibold" style={{ color: "#9ca3af", fontSize: 8 }}>Bill to</div>
            <div className="mt-0.5 font-semibold" style={{ color: "#111827" }}>{clientName}</div>
            {clientAddress && <div style={{ color: "#6b7280" }}>{clientAddress}</div>}
          </div>
          <div className="text-right">
            <div><span style={{ color: "#9ca3af" }}>Issue </span><span style={{ color: "#374151" }}>{issueLabel}</span></div>
            <div><span style={{ color: "#9ca3af" }}>{isQuote ? "Valid until " : "Due "}</span><span style={{ color: "#374151" }}>{dueLabel}</span></div>
          </div>
        </div>

        {/* Line items table */}
        <table className="w-full border-collapse">
          <thead>
            <tr style={{ background: accent, color: "#ffffff" }}>
              <th className="text-left px-2 py-1.5 font-semibold rounded-l">Description</th>
              <th className="text-right px-2 py-1.5 font-semibold">Qty</th>
              <th className="text-right px-2 py-1.5 font-semibold">Rate</th>
              <th className="text-right px-2 py-1.5 font-semibold rounded-r">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #f0f0f2" }}>
                <td className="px-2 py-1.5" style={{ color: "#374151" }}>{r.d}</td>
                <td className="px-2 py-1.5 text-right" style={{ color: "#6b7280" }}>{r.q}</td>
                <td className="px-2 py-1.5 text-right" style={{ color: "#6b7280" }}>{money(r.r)}</td>
                <td className="px-2 py-1.5 text-right font-medium" style={{ color: "#111827" }}>{money(r.q * r.r)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div className="mt-3 flex justify-end">
          <div className="w-1/2 space-y-1">
            <div className="flex justify-between" style={{ color: "#6b7280" }}><span>Subtotal</span><span>{money(subtotal)}</span></div>
            <div className="flex justify-between" style={{ color: "#6b7280" }}><span>Tax ({taxPct}%)</span><span>{money(tax)}</span></div>
            <div className="flex justify-between pt-1.5 mt-1 font-bold text-[12px]" style={{ borderTop: `2px solid ${accent}`, color: accent }}>
              <span>TOTAL</span><span>{money(total)}</span>
            </div>
          </div>
        </div>

        {/* Invoice notes */}
        {notes && (
          <div className="mt-4">
            <div className="font-semibold" style={{ color: "#374151" }}>Notes</div>
            <div className="whitespace-pre-wrap" style={{ color: "#6b7280" }}>{notes}</div>
          </div>
        )}

        {/* Standing policy clauses (R-162) — terms, kept visually distinct from the
            per-shipment Notes above. Renders nothing when no clause is enabled. */}
        {(data?.clauses ?? []).filter(([, body]) => body.trim()).map(([heading, body]) => (
          <div className="mt-4" key={heading}>
            <div className="font-semibold" style={{ color: "#374151" }}>{heading}</div>
            <div className="whitespace-pre-wrap" style={{ color: "#6b7280" }}>{body}</div>
          </div>
        ))}

        {/* Footer note */}
        {tpl.footer_note.trim() && (
          <div className="mt-auto pt-4 text-center whitespace-pre-wrap" style={{ color: "#9ca3af" }}>{tpl.footer_note}</div>
        )}
      </div>
    </div>
  );
}
