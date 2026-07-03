import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Building2, Users, UserCircle, RefreshCw } from "lucide-react";

function fmtDate(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function relTime(s?: string | null): string {
  if (!s) return "never";
  const ms = Date.now() - new Date(s).getTime();
  if (isNaN(ms)) return "—";
  const d = Math.floor(ms / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "1d ago";
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`;
}

const COLS = "grid grid-cols-[1.4fr_1.7fr_0.8fr_0.9fr_0.55fr_0.55fr_0.8fr] gap-2";

export default function PlatformView() {
  const [orgs, setOrgs] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.getPlatformSignups()
      .then((r) => { setOrgs(r.orgs || []); setErr(null); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const totalMembers = orgs.reduce((a, o) => a + (o.members || 0), 0);
  const totalClients = orgs.reduce((a, o) => a + (o.clients || 0), 0);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Platform</h2>
          <p className="text-[12px] text-muted mt-0.5">Every workspace signed up on Ecliptr.</p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 px-3 h-9 border border-line rounded-lg text-[13px] text-ink-2 hover:bg-surface-2 transition-colors">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {err ? (
        <div className="text-[13px] text-muted bg-surface border border-line rounded-xl p-8 text-center">{err}</div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-5">
            <Stat icon={Building2} label="Signups" value={orgs.length} />
            <Stat icon={UserCircle} label="Total members" value={totalMembers} />
            <Stat icon={Users} label="Total clients" value={totalClients} />
          </div>

          <div className="bg-surface border border-line rounded-xl overflow-hidden">
            <div className={`${COLS} px-4 py-2.5 text-[12.5px] font-medium text-muted border-b border-line`}>
              <div>Workspace</div><div>Owner</div><div>Plan</div><div>Signed up</div><div>Members</div><div>Clients</div><div>Last active</div>
            </div>
            {orgs.length === 0 && !loading && <div className="px-4 py-10 text-center text-[13px] text-muted">No signups yet.</div>}
            {orgs.map((o) => (
              <div key={o.org_id} className={`${COLS} px-4 py-2.5 text-[12.5px] items-center border-b border-line last:border-0`}>
                <div className="text-ink font-medium truncate" title={o.name}>{o.name || "—"}</div>
                <div className="text-ink-2 truncate" title={o.owner_email || ""}>{o.owner_email || "—"}</div>
                <div><span className="text-[11px] px-2 py-0.5 rounded-full border border-line text-ink-2 capitalize">{o.plan || "free"}</span></div>
                <div className="text-muted tabular-nums">{fmtDate(o.created_at)}</div>
                <div className="text-ink-2 tabular-nums">{o.members ?? 0}</div>
                <div className="text-ink-2 tabular-nums">{o.clients ?? 0}</div>
                <div className="text-muted">{relTime(o.last_event_at)}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <div className="bg-surface border border-line rounded-xl p-4">
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-muted mb-2"><Icon size={13} /> {label}</div>
      <div className="text-[24px] font-bold text-ink tabular-nums">{value}</div>
    </div>
  );
}
