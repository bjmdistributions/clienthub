import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw } from "lucide-react";
import { api, type ApprovalRequest } from "../lib/api";
import { localDay } from "../lib/format";
import { renewalLine, renewalTitle, renewalsOf, sinceRenewed } from "../lib/renewals";
import { toast } from "./Toast";
import { PageActions } from "./ui";

// R-466: the storefront listings that have gone five days without a renewal, one compact row each. Renew keeps
// a listing live, Mark sold takes it off the storefront, Renew all does every one after a confirm. These are the
// same calls the Notifications screen made for each card: resolving the request approved renews the listing,
// rejected marks it sold. The Notifications screen now carries one line that opens this.

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const changed = () => window.dispatchEvent(new CustomEvent("approvals-changed"));

const ghost = "ui-btn ui-btn-sm";
const solid = "ui-btn ui-btn-sm ui-btn-ink";

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
    <div className="max-w-3xl min-w-0">
      <PageActions>
        {list.length > 0 && (
          <button onClick={renewAll} disabled={busy !== ""} className={solid}>
            <RefreshCw size={14} className={busy === "all" ? "animate-spin" : ""} /> Renew all
          </button>
        )}
      </PageActions>
      <p className="text-[13px] text-muted mb-5">
        {items === null ? "Looking..." : list.length === 0 ? "Listings that go five days without a renewal show up here." : `${renewalLine(list.length)}. Renew a listing to keep it live, or mark it sold.`}
      </p>

      {error && (
        <div className="mb-4 flex items-center justify-between gap-3 text-[13px] text-danger-ink bg-danger-bg rounded-lg px-3 py-2" role="alert">
          <span className="min-w-0">{error}</span>
          <button onClick={load} className={ghost}>Try again</button>
        </div>
      )}

      {items !== null && list.length === 0 ? (
        <div className="py-16 text-center text-[13px] text-muted">Nothing to renew.</div>
      ) : items !== null && (
        <div className="divide-y divide-line border-t border-line">
          {list.map((a) => (
            <div key={a.id} className="flex items-center gap-3 px-3 py-3 min-w-0 hover:bg-surface-2 transition-colors duration-150">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-ink truncate" title={renewalTitle(a)}>{renewalTitle(a)}</div>
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
