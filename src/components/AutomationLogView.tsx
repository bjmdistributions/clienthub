import { useEffect, useState } from "react";
import { api, FollowUpLogEntry, FollowUpRule, AutomationsSummary, IntakeSourceSummary } from "../lib/api";
import {
  AlertCircle, CheckCircle2, Clock, Bell, UserPlus, Globe, ArrowRight,
  Copy, Check, BookOpen, ChevronRight, Settings2, Zap,
} from "lucide-react";
import { SetupGuide } from "./IntakeSetupGuide";

// Jump to a Settings sub-tab (persisted key the SettingsView reads on mount).
function goToSettings(tab: string) {
  try { localStorage.setItem("clienthub_settings_tab", tab); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "settings" }));
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(value).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <code className="flex-1 bg-surface-2 border border-line rounded-md h-7 px-2 text-[11px] text-ink-2 truncate flex items-center font-mono">{value}</code>
      <button onClick={copy} title="Copy URL"
        className="flex-shrink-0 flex items-center gap-1 border border-line px-2 h-7 rounded-md text-[11px] text-ink-2 hover:bg-surface-2 transition-colors">
        {copied ? <><Check size={12} className="text-success-ink" /> Copied</> : <><Copy size={12} /> Copy</>}
      </button>
    </div>
  );
}

// A dashboard tile summarizing an automation family.
function StatCard({ icon: Icon, tint, label, value, sub, cta, onCta }: {
  icon: typeof Bell; tint: string; label: string; value: string; sub: string; cta?: string; onCta?: () => void;
}) {
  return (
    <div className="bg-surface border border-line rounded-xl p-4 flex flex-col">
      <div className="flex items-center gap-2.5 mb-3">
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${tint}`}><Icon size={16} /></span>
        <span className="text-[12px] font-semibold text-ink-2">{label}</span>
      </div>
      <div className="text-[24px] font-bold text-ink tabular-nums leading-none">{value}</div>
      <div className="text-[11.5px] text-muted mt-1.5 flex-1">{sub}</div>
      {cta && (
        <button onClick={onCta} className="mt-3 inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:text-accent-hover self-start">
          {cta} <ChevronRight size={13} />
        </button>
      )}
    </div>
  );
}

export default function AutomationLogView() {
  const [summary, setSummary] = useState<AutomationsSummary | null>(null);
  const [log, setLog] = useState<FollowUpLogEntry[]>([]);
  const [rules, setRules] = useState<FollowUpRule[]>([]);
  const [filterRule, setFilterRule] = useState("");
  const [since, setSince] = useState("30");
  const [loading, setLoading] = useState(true);
  const [guideFor, setGuideFor] = useState<IntakeSourceSummary | "generic" | null>(null);

  const load = async () => {
    setLoading(true);
    const [s, l, r] = await Promise.all([
      api.automationsSummary().catch(() => null),
      api.getFollowupLog().catch(() => []),
      api.listFollowupRules().catch(() => []),
    ]);
    setSummary(s); setLog(l); setRules(r);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const ruleName = (ruleId: string) => rules.find((r) => r.id === ruleId)?.name || ruleId.slice(0, 8);
  const sinceDate = () => { const d = new Date(); if (since !== "all") d.setDate(d.getDate() - parseInt(since)); return d.toISOString(); };
  const filtered = log.filter((e) => {
    if (filterRule && e.rule_id !== filterRule) return false;
    if (since !== "all" && e.triggered_at < sinceDate()) return false;
    return true;
  });

  if (guideFor) {
    return <SetupGuide
      source={guideFor === "generic" ? null : guideFor}
      baseUrl={summary?.intake_base_url || ""}
      onBack={() => setGuideFor(null)}
    />;
  }

  const fu = summary?.followup_rules ?? { total: 0, active: 0 };
  const su = summary?.signup_rules ?? { total: 0, active: 0 };
  const sources = summary?.intake_sources ?? [];

  return (
    <div className="max-w-[1100px] space-y-6">
      <div>
        <h2 className="text-[18px] font-bold text-ink">Automations</h2>
        <p className="text-[12px] text-muted mt-0.5">Rules and inbound forms that create and nurture clients without manual work.</p>
      </div>

      {/* Dashboard tiles */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <StatCard icon={Bell} tint="bg-accent/10 text-accent-hover"
          label="Follow-up rules" value={`${fu.active}`}
          sub={`${fu.active} active of ${fu.total} · e.g. email a client after 30 quiet days`}
          cta="Manage rules" onCta={() => goToSettings("automation")} />
        <StatCard icon={UserPlus} tint="bg-success-bg text-success-ink"
          label="Signup automations" value={`${su.active}`}
          sub={`${su.active} active of ${su.total} · turn signup emails into pending clients`}
          cta="Manage signups" onCta={() => goToSettings("automation")} />
        <StatCard icon={Globe} tint="bg-warning-bg text-warning-ink"
          label="Web forms" value={`${sources.length}`}
          sub={`${sources.reduce((n, s) => n + (s.captured_count || 0), 0)} leads captured across all forms`}
          cta="How it works" onCta={() => setGuideFor("generic")} />
      </div>

      {/* Web forms / intake sources */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Globe size={15} className="text-muted" />
            <h3 className="text-[14px] font-semibold text-ink">Web forms &amp; intake sources</h3>
          </div>
          <button onClick={() => goToSettings("webforms")}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:text-accent-hover">
            <Settings2 size={13} /> Add / configure
          </button>
        </div>

        {loading && !summary ? (
          <div className="bg-surface border border-line rounded-xl h-32 animate-pulse" />
        ) : sources.length === 0 ? (
          <div className="bg-surface border border-dashed border-line rounded-xl py-12 px-6 text-center">
            <div className="mx-auto w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-muted mb-3"><Globe size={18} /></div>
            <div className="text-[13px] font-medium text-ink-2">No web forms yet</div>
            <div className="text-[12px] text-muted mt-1 max-w-sm mx-auto leading-relaxed">
              Create an intake source, drop its URL into any website form, and submissions arrive as pending leads.
            </div>
            <div className="flex items-center justify-center gap-2 mt-4">
              <button onClick={() => goToSettings("webforms")} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium">Create a web form</button>
              <button onClick={() => setGuideFor("generic")} className="border border-line text-ink-2 hover:bg-surface-2 px-4 h-9 rounded-lg text-[13px] font-medium inline-flex items-center gap-1.5"><BookOpen size={13} /> Setup guide</button>
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            {sources.map((s) => (
              <div key={s.id} className="bg-surface border border-line rounded-xl p-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13.5px] font-semibold text-ink truncate">{s.name}</span>
                      <span className="text-[10px] font-medium uppercase tracking-wide text-muted bg-surface-2 px-1.5 py-0.5 rounded">{s.kind || "form"}</span>
                    </div>
                    <div className="text-[11.5px] text-muted mt-0.5 tabular-nums">
                      {s.captured_count} lead{s.captured_count !== 1 ? "s" : ""} captured
                    </div>
                  </div>
                  <button onClick={() => setGuideFor(s)}
                    className="flex-shrink-0 inline-flex items-center gap-1.5 border border-line px-3 h-8 rounded-lg text-[12px] font-medium text-ink-2 hover:bg-surface-2 transition-colors">
                    <BookOpen size={13} /> Setup guide
                  </button>
                </div>
                <CopyField value={s.url} />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Follow-up activity log — one section, below the dashboard */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Zap size={15} className="text-muted" />
          <h3 className="text-[14px] font-semibold text-ink">Follow-up activity</h3>
        </div>

        <div className="flex items-center gap-2.5 mb-3 flex-wrap">
          <select value={filterRule} onChange={(e) => setFilterRule(e.target.value)}
            className="border border-line h-8 px-2.5 rounded-lg text-[12.5px] text-ink-2 bg-surface">
            <option value="">All rules</option>
            {rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select value={since} onChange={(e) => setSince(e.target.value)}
            className="border border-line h-8 px-2.5 rounded-lg text-[12.5px] text-ink-2 bg-surface">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="all">All time</option>
          </select>
        </div>

        {loading ? (
          <div className="text-center py-10 text-[13px] text-muted"><Clock size={16} className="inline mr-1 animate-spin" /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="bg-surface border border-line rounded-xl py-10 px-6 text-center">
            <div className="text-[13px] text-ink-2 font-medium mb-1">No follow-up activity yet</div>
            <div className="text-[12px] text-muted max-w-md mx-auto leading-relaxed">
              This log tracks follow-up rules firing (e.g. "email a client after 30 days of no order").
              Configure them in <button onClick={() => goToSettings("automation")} className="text-accent hover:underline">Settings → Automation</button>.
            </div>
          </div>
        ) : (
          <div className="bg-surface border border-line rounded-xl overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-line-2">
                  <th className="text-left px-4 py-2.5 text-[12px] font-medium text-muted">Date</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-medium text-muted">Rule</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-medium text-muted">Action</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-medium text-muted">Result</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((e) => {
                  const ok = !e.details?.includes("failed") && !e.details?.includes("error") && !e.details?.includes("SMTP");
                  return (
                    <tr key={e.id} className="border-b border-line-2 last:border-0 hover:bg-surface-2/60">
                      <td className="px-4 py-2.5 text-[12px] text-muted tabular-nums whitespace-nowrap">
                        {new Date(e.triggered_at).toLocaleDateString()} {new Date(e.triggered_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td className="px-4 py-2.5 text-[13px] font-medium text-ink">{ruleName(e.rule_id)}</td>
                      <td className="px-4 py-2.5 text-[12px] text-ink-2">{e.action_taken}</td>
                      <td className="px-4 py-2.5">
                        {ok
                          ? <span className="inline-flex items-center gap-1 text-[11px] text-success-ink"><CheckCircle2 size={12} /> {e.details || "OK"}</span>
                          : <span className="inline-flex items-center gap-1 text-[11px] text-danger-ink"><AlertCircle size={12} /> {e.details || "Failed"}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Legend footer: the inbound flow, so users grasp what "pending" means */}
      <div className="flex items-center flex-wrap gap-2 text-[11.5px] text-muted bg-surface-2/50 border border-line-2 rounded-lg px-4 py-2.5">
        <span className="font-medium text-ink-2">How inbound works:</span>
        <span className="flex items-center gap-1.5">Form / signup <ArrowRight size={12} className="text-faint" /> Pending lead <ArrowRight size={12} className="text-faint" /> you approve in <button onClick={() => window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "approvals" }))} className="text-accent hover:underline">Approvals</button></span>
      </div>
    </div>
  );
}
