import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../lib/api";
import type { ImportRow } from "../lib/supplierImport";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import { Button } from "./ui";

// R-634: the rows read from a supplier spreadsheet, before anything is saved. A row that exactly matches a saved
// supplier or an earlier row (company name, email or phone) starts unticked and says what it matched.
export default function SupplierImportModal({ file, rows, onClose }: {
  file: string;
  rows: ImportRow[];
  /** `added` is how many suppliers were saved, so the list behind re-reads. */
  onClose: (added: number) => void;
}) {
  const [picked, setPicked] = useState<Set<number>>(() => new Set(rows.filter((r) => r.dupes.length === 0).map((r) => r.line)));
  const [saving, setSaving] = useState(false);
  const dupes = rows.filter((r) => r.dupes.length > 0).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !saving) onClose(0); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, onClose]);

  const toggle = (line: number) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(line)) n.delete(line); else n.add(line);
    return n;
  });

  const save = async () => {
    setSaving(true);
    let added = 0;
    try {
      for (const r of rows) {
        if (!picked.has(r.line)) continue;
        await api.createSupplier(r.input);
        added++;
      }
      toast(`Added ${added} supplier${added === 1 ? "" : "s"}`, "success");
      onClose(added);
    } catch (e) {
      toast(`Stopped after ${added} added: ${String(e)}`, "error");
      onClose(added);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={() => !saving && onClose(0)} />
      <div className="relative w-[94vw] max-w-[1000px] max-h-[88vh] flex flex-col rounded-2xl bg-surface ring-1 ring-line-3 shadow-2xl overflow-hidden animate-fade-up">
        <div className="flex items-start justify-between gap-3 px-6 py-4">
          <div className="min-w-0">
            <h3 className="text-[16px] font-medium text-ink m-0">Import suppliers</h3>
            <p className="text-[12px] text-muted mt-0.5 truncate">
              {rows.length} supplier{rows.length === 1 ? "" : "s"} in {file}
              {dupes > 0 ? `. ${dupes} may already be in Ecliptr and start unticked.` : ". None match a supplier you have."}
            </p>
          </div>
          <button onClick={() => onClose(0)} disabled={saving} aria-label="Close" className="ui-ib flex-shrink-0">
            <X size={16} />
          </button>
        </div>
        <div className="hsep" />
        <div className="overflow-auto flex-1">
          <table className="ui-table ui-table-sm">
            <thead>
              <tr>
                <th className="w-10" />
                <th className="w-14">Row</th>
                <th>Company name</th>
                <th>Contact</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Possible duplicate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.line} className="cursor-pointer" onClick={() => toggle(r.line)}>
                  <td><input type="checkbox" checked={picked.has(r.line)} onChange={() => toggle(r.line)} onClick={(e) => e.stopPropagation()} /></td>
                  <td className="tabular-nums text-muted">{r.line}</td>
                  <td className="text-ink">{r.input.name}</td>
                  <td className="text-ink-2">{r.input.contact_name || ""}</td>
                  <td className="text-ink-2">{r.input.email || ""}</td>
                  <td className="text-ink-2 tabular-nums">{r.input.phone || ""}</td>
                  <td>
                    {r.dupes.length > 0
                      ? <StatusPill tone="warning" title={r.dupes.join("\n")}>{r.dupes[0]}{r.dupes.length > 1 ? ` +${r.dupes.length - 1}` : ""}</StatusPill>
                      : <span className="text-muted">None</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="hsep" />
        <div className="flex items-center justify-end gap-2 px-6 py-3">
          <Button onClick={() => onClose(0)} disabled={saving}>Cancel</Button>
          <Button variant="ink" onClick={save} disabled={saving || picked.size === 0}>
            {saving ? "Adding" : `Add ${picked.size} supplier${picked.size === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
