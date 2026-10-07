import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw } from "lucide-react";
import { api, type ApprovalRequest } from "../lib/api";
import { localDay } from "../lib/format";
import { renewalLine, renewalTitle, renewalsOf, sinceRenewed } from "../lib/renewals";
import { toast } from "./Toast";

// R-466: the storefront listings that have gone five days without a renewal, one compact row each. Renew keeps
// a listing live, Mark sold takes it off the storefront, Renew all does every one after a confirm. These are the
// same calls the Notifications screen made for each card: resolving the request approved renews the listing,
// rejected marks it sold. The Notifications screen now carries one line that opens this.

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const changed = () => window.dispatchEvent(new CustomEvent("approvals-changed"));

const ghost = "border border-line text-ink-2 hover:bg-surface-2 px-3 h-8 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50 whitespace-nowrap";
const solid = "bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50 whitespace-nowrap";

export default function RenewalsView() {
  const [items, setItems] = useState<ApprovalRequest[] | null>(null);
  // The lot's own last renewal, by id, so a row can say how long it has gone. Missing for a lot no longer on sale.
  const [renewed, setRenewed] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const reqs = await api.listApprovalRequests();
      setItems(renewalsOf(reqs));
      setError("");
    } catch (e) {
      setError(msg(e));
      setItems((v) => v ?? []);
    }
    // The ages are a nicety: a failure here leaves the row saying when it was flagged.
    api.listInventory("available")
      .then((lots) => setRenewed(new Map(lots.map((l) => [l.id, l.updated_at]))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const un: (() => void)[] = [];
    let dead = false;
    listen("netsync-applied", () => load()).then((u) => { if (dead) u(); else un.push(u); }).catch(() => {});
    window.addEventListener("approvals-changed", load);
    return () => { dead = true; un.forEach((u) => u()); window.removeEventListener("approvals-changed", load); };
  }, [load]);

  const today = localDay();
  const list = useMemo(() => items ?? [], [items]);

  const decide = async (a: ApprovalRequest, renew: boolean) => {
    setBusy(a.id);
    try {
      await api.resolveApprovalRequest(a.id, renew);
      toast(renew ? "Renewed" : "Marked sold");
    } catch (e) { toast(msg(e), "error"); }
    setBusy("");
    changed();
    await load();
  };

  const renewAll = async () => {
    if (list.length === 0) return;
    if (!confirm(`Renew all ${list.length} ${list.length === 1 ? "listing" : "listings"}? Each one stays live for another 5 days.`)) return;
    setBusy("all");
    let done = 0;
    let failed = "";
    // One at a time: each renewal writes the listing and syncs it.
    for (const a of list) {
      try { await api.resolveApprovalRequest(a.id, true); done++; }
      catch (e) { failed = msg(e); break; }
    }
    setBusy("");
    changed();
    await load();
    if (failed) toast(`Renewed ${done} of ${list.length}. ${failed}`, "error");
    else toast(done === 1 ? "Renewed 1 listing" : `Renewed ${done} listings`);
  };

  return (
    <div className="max-w-3xl mx-auto min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Renewals</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {items === null ? "Looking..." : list.length === 0 ? "Listings that go five days without a renewal show up here." : `${renewalLine(list.length)}. Renew a listing to keep it live, or mark it sold.`}
          </p>
        </div>
        {list.length > 0 && (
          <button onClick={renewAll} disabled={busy !== ""} className={solid + " inline-flex items-center gap-1.5"}>
            <RefreshCw size={13} className={busy === "all" ? "animate-spin" : ""} /> Renew all
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 flex items-center justify-between gap-3 text-[13px] text-danger-ink bg-danger-bg border border-danger-ink/20 rounded-lg px-3 py-2" role="alert">
          <span className="min-w-0">{error}</span>
          <button onClick={load} className={ghost}>Try again</button>
        </div>
      )}

      {items !== null && list.length === 0 ? (
        <div className="bg-surface border border-line rounded-2xl py-12 text-center text-[13px] text-muted">Nothing to renew.</div>
      ) : items !== null && (
        <div className="bg-surface border border-line rounded-2xl divide-y divide-line-2 overflow-hidden">
          {list.map((a) => (
            <div key={a.id} className="flex items-center gap-3 px-4 py-2.5 min-w-0">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium text-ink truncate" title={renewalTitle(a)}>{renewalTitle(a)}</div>
                <div className="text-[11.5px] text-muted truncate">{sinceRenewed(a.entity_id ? renewed.get(a.entity_id) : null, a.created_at, today)}</div>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button onClick={() => decide(a, true)} disabled={busy !== ""} className={solid}>Renew</button>
                <button onClick={() => decide(a, false)} disabled={busy !== ""} className={ghost}>Mark sold</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
