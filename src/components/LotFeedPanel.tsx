// R-559: the Muse upload address, on the Import screen. A private address Muse (or any script)
// sends the filled template to on a schedule; the server adds the rows (clienthub-api
// routes/lot_feed.rs). The key can only add lots. It is shown once, when it is made, and only
// its fingerprint is kept on the server, so a lost key is replaced, never looked up.
import { useEffect, useState } from "react";
import { Copy, KeyRound } from "lucide-react";
import { api, LotFeedSettings } from "../lib/api";
import { copyText, COPY_FAILED } from "../lib/clipboard";
import { MAX_EXPIRE_DAYS } from "../lib/lotTimer";
import { toast } from "./Toast";

const when = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

export function museInstructions(address: string, key: string): string {
  return [
    "Every day, put the deals posted in the WhatsApp group into the Ecliptr lot import template, one row per deal, with photos as web links.",
    "Then upload the file to Ecliptr with this command:",
    "",
    `curl -X POST ${address} -H "Authorization: Bearer ${key}" --data-binary @lots.xlsx`,
    "",
    "The answer says how many lots were added. Never send this key to anyone or put it in a chat.",
  ].join("\n");
}

export default function LotFeedPanel() {
  const [s, setS] = useState<LotFeedSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ key: string; address: string } | null>(null);
  const [days, setDays] = useState("");

  useEffect(() => {
    api.lotFeed("get").then((v) => { setS(v); setDays(String(v.expire_days)); }).catch((e) => setError(String(e)));
  }, []);

  const run = async (action: "set" | "key" | "off", body?: { review?: boolean; expire_days?: number }) => {
    if (action === "key" && s?.on && !confirm("Make a new key? The one Muse has now stops working straight away.")) return;
    if (action === "off" && !confirm("Turn the upload address off? Muse's uploads will be refused until you make a new key.")) return;
    setBusy(true);
    try {
      const v = await api.lotFeed(action, body);
      setS(v);
      setDays(String(v.expire_days));
      if (action === "key" && v.key && v.address) setFresh({ key: v.key, address: v.address });
      if (action === "off") setFresh(null);
    } catch (e) { toast(String(e), "error"); }
    setBusy(false);
  };

  const copy = async (text: string, what: string) => {
    const ok = await copyText(text);
    toast(ok ? `${what} copied` : COPY_FAILED, ok ? "success" : "error");
  };

  const saveDays = () => {
    const n = Math.floor(Number(days));
    const v = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_EXPIRE_DAYS) : 0;
    if (s && v !== s.expire_days) run("set", { expire_days: v });
    else setDays(String(s?.expire_days ?? 0));
  };

  const last = s?.last_result;
  return (
    <div className="rounded-xl border border-line bg-surface-2/50 px-5 py-4 space-y-3">
      <div>
        <p className="text-[13.5px] font-semibold text-ink">Send it automatically</p>
        <p className="text-[12.5px] text-muted mt-1 leading-relaxed">
          A private upload address Muse can send the filled template to every day. It can only add lots. It cannot read anything in Ecliptr: no lots, prices, customers or money.
        </p>
      </div>
      {error && <p className="text-[12.5px] text-danger-ink">{error}</p>}
      {s && (
        <>
          {fresh && (
            <div className="rounded-lg border border-accent/40 bg-surface px-4 py-3 space-y-2">
              <p className="text-[12.5px] font-medium text-ink">Your upload key. It is shown this once; keep it only in Muse.</p>
              <code className="block text-[12px] text-ink-2 break-all select-all">{fresh.key}</code>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => copy(museInstructions(fresh.address, fresh.key), "Instructions for Muse")}
                  className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12.5px] font-medium"><Copy size={13} /> Copy instructions for Muse</button>
                <button onClick={() => copy(fresh.key, "Key")}
                  className="flex items-center gap-1.5 border border-line-3 text-ink-2 px-3 h-8 rounded-lg text-[12.5px] font-medium bg-surface hover:bg-surface-2"><Copy size={13} /> Copy the key</button>
              </div>
            </div>
          )}
          {s.on ? (
            <div className="space-y-3">
              <p className="text-[12.5px] text-ink-2">
                On since {when(s.made_at)}.
                {s.last_upload_at
                  ? ` Last upload ${when(s.last_upload_at)}: ${last?.added ?? 0} added, ${last?.waiting_for_approval ?? 0} waiting for you, ${last?.already_listed ?? 0} already listed, ${(last?.refused ?? []).length} refused.`
                  : " Nothing has been sent yet."}
              </p>
              {(last?.refused ?? []).length > 0 && (
                <ul className="text-[12px] text-warning-ink space-y-0.5">
                  {(last?.refused ?? []).slice(0, 8).map((r) => <li key={r.row}>Row {r.row}: {r.why}</li>)}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-ink-2">
                <span className="font-medium text-ink">New deals</span>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="feed-review" className="accent-accent" checked={!s.review} disabled={busy} onChange={() => run("set", { review: false })} /> Go live straight away
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="feed-review" className="accent-accent" checked={s.review} disabled={busy} onChange={() => run("set", { review: true })} /> Wait for my approval
                </label>
              </div>
              <div>
                <label className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
                  <span className="font-medium text-ink">Take them off the site after</span>
                  <input type="number" min={0} max={MAX_EXPIRE_DAYS} value={days} onChange={(e) => setDays(e.target.value)} onBlur={saveDays}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    className="w-16 h-8 px-2 rounded-lg border border-line bg-surface text-[13px] text-ink tabular-nums" />
                  days
                </label>
                <p className="text-[12px] text-muted mt-1">0 keeps them up until you take them down. A row with its own Off the site after keeps its own.</p>
              </div>
              <p className="text-[12px] text-muted">A deal already listed is never added twice. You get a notice to reset its time or remove the duplicate, and a changed price is shown on it.</p>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => run("key")} disabled={busy}
                  className="flex items-center gap-1.5 border border-line-3 text-ink-2 px-3 h-8 rounded-lg text-[12.5px] font-medium bg-surface hover:bg-surface-2 disabled:opacity-50"><KeyRound size={13} /> Make a new key</button>
                <button onClick={() => run("off")} disabled={busy}
                  className="border border-line-3 text-danger-ink px-3 h-8 rounded-lg text-[12.5px] font-medium bg-surface hover:bg-surface-2 disabled:opacity-50">Turn off</button>
              </div>
            </div>
          ) : (
            <button onClick={() => run("key")} disabled={busy}
              className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50">
              <KeyRound size={14} /> {busy ? "Making it…" : "Make an upload address"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
