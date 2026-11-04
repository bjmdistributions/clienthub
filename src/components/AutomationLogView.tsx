import { useEffect, useState } from "react";
import { api, FollowUpLogEntry, FollowUpRule, AutomationsSummary, IntakeSourceSummary } from "../lib/api";
import {
  AlertCircle, CheckCircle2, Bell, UserPlus, Globe, ArrowRight,
  Copy, Check, BookOpen, Zap,
} from "lucide-react";
import { SetupGuide } from "./IntakeSetupGuide";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import { copyText, COPY_FAILED } from "../lib/clipboard";
import { Button, PageActions } from "./ui";

// Jump to a Settings sub-tab (persisted key the SettingsView reads on mount).
function goToSettings(tab: string) {
  try { localStorage.setItem("clienthub_settings_tab", tab); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "settings" }));
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyText(value))) { toast(COPY_FAILED, "error"); return; }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex items-center gap-2 min-w-0">
      <code className="flex-1 min-w-0 bg-surface-2 ring-1 ring-line rounded-lg h-8 px-2.5 text-[12px] text-muted truncate flex items-center font-mono">{value}</code>
      <Button size="sm" onClick={copy} title="Copy URL" aria-label="Copy URL"
        icon={copied ? <Check size={13} className="text-success-ink" /> : <Copy size={13} />}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

// One automation family: label, the figure, a line of context and the one link that goes further.
function Stat({ icon: Icon, label, value, sub, cta, onCta }: {
  icon: typeof Bell; label: string; value: string; sub: string; cta?: string; onCta?: () => void;
}) {
  return (
    <div className="min-w-0 p-4 flex flex-col">
      <div className="flex items-center gap-2 text-muted">
        <Icon size={16} />
        <span className="ui-label">{label}</span>
      </div>
      <div className="ui-fig mt-2">{value}</div>
      <div className="ui-note mt-1 leading-[1.5] flex-1">{sub}</div>
      {cta && <button onClick={onCta} className="ui-link mt-2.5 self-start">{cta}</button>}
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
  const captured = sources.reduce((n, s) => n + (s.captured_count || 0), 0);

  return (
    <div className="max-w-[1120px] animate-fade-up motion-reduce:animate-none">
      <PageActions>
        <Button icon={<BookOpen size={14} />} onClick={() => setGuideFor("generic")}>Setup guide</Button>
        <Button variant="ink" icon={<Zap size={14} />} onClick={() => goToSettings("webforms")}>Add or configure</Button>
      </PageActions>

      <p className="text-[13px] text-muted mb-2">Rules and inbound forms that create and nurture clients without manual work.</p>

      {/* The three families. No boxes: a fading vertical hairline between them. */}
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)]">
        <Stat icon={Bell} label="Follow-up rules" value={`${fu.active}`}
          sub={`${fu.active} active of ${fu.total}. For example, email a client after 30 quiet days.`}
          cta="Manage rules" onCta={() => goToSettings("automation")} />
        <div className="vsep hidden md:block mt-4" />
        <Stat icon={UserPlus} label="Signup automations" value={`${su.active}`}
          sub={`${su.active} active of ${su.total}. Turn signup emails into pending clients.`}
          cta="Manage signups" onCta={() => goToSettings("automation")} />
        <div className="vsep hidden md:block mt-4" />
        <Stat icon={Globe} label="Web forms" value={`${sources.length}`}
          sub={`${captured} lead${captured !== 1 ? "s" : ""} captured across all forms.`}
          cta="How it works" onCta={() => setGuideFor("generic")} />
      </div>

      <div className="hsep" />

      {/* Web forms and intake sources */}
      <section className="pt-5 pb-4">
        <div className="flex items-center justify-between gap-3 px-1 mb-2">
          <div className="flex items-center gap-2 text-muted">
            <Globe size={16} />
            <h3 className="text-[14px] font-medium text-ink">Web forms and intake sources</h3>
          </div>
          <Button size="sm" onClick={() => goToSettings("webforms")}>Add or configure</Button>
        </div>

        {loading && !summary ? (
          <div className="h-32 rounded-xl bg-surface-2 animate-pulse" />
        ) : sources.length === 0 ? (
          <div className="py-12 px-6 text-center">
            <div className="text-[14px] font-medium text-ink">No web forms yet</div>
            <div className="text-[13px] text-muted mt-1.5 max-w-sm mx-auto leading-relaxed">
              Create an intake source, drop its URL into any website form, and submissions arrive as pending leads.
            </div>
            <div className="flex items-center justify-center gap-2 mt-4">
              <Button variant="ink" onClick={() => goToSettings("webforms")}>Create a web form</Button>
              <Button icon={<BookOpen size={14} />} onClick={() => setGuideFor("generic")}>Setup guide</Button>
            </div>
          </div>
        ) : (
          <div>
            {sources.map((s, i) => (
              <div key={s.id}
                className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2.5 items-center py-3.5 px-1 ${i > 0 ? "shadow-[inset_0_1px_0_rgb(var(--c-line))]" : ""}`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium text-ink truncate">{s.name}</span>
                    <StatusPill tone="neutral">{s.kind || "form"}</StatusPill>
                  </div>
                  <div className="ui-note mt-0.5 tabular-nums">
                    {s.captured_count} lead{s.captured_count !== 1 ? "s" : ""} captured
                  </div>
                </div>
                <Button size="sm" icon={<BookOpen size={13} />} onClick={() => setGuideFor(s)}>Setup guide</Button>
                <div className="col-span-2 min-w-0"><CopyField value={s.url} /></div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="hsep" />

      {/* Follow-up activity log */}
      <section className="pt-5 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <div className="flex items-center gap-2 text-muted">
            <Zap size={16} />
            <h3 className="text-[14px] font-medium text-ink">Follow-up activity</h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={filterRule} onChange={(e) => setFilterRule(e.target.value)} aria-label="Rule"
              className="ring-1 ring-line-3 h-8 px-2.5 rounded-lg text-[13px] text-ink bg-surface transition-colors duration-[130ms]">
              <option value="">All rules</option>
              {rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <select value={since} onChange={(e) => setSince(e.target.value)} aria-label="Period"
              className="ring-1 ring-line-3 h-8 px-2.5 rounded-lg text-[13px] text-ink bg-surface transition-colors duration-[130ms]">
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="all">All time</option>
            </select>
          </div>
        </div>

        {/* The old rows stay until the new ones arrive, so a refresh never flashes empty. */}
        {loading && log.length === 0 ? (
          <div className="mt-3 h-40 rounded-xl bg-surface-2 animate-pulse" />
        ) : filtered.length === 0 ? (
          <div className="py-10 px-6 text-center">
            <div className="text-[14px] font-medium text-ink mb-1">No follow-up activity yet</div>
            <div className="text-[13px] text-muted max-w-md mx-auto leading-relaxed">
              This log tracks follow-up rules firing, for example email a client after 30 days of no order.
              Configure them in <button onClick={() => goToSettings("automation")} className="ui-link">Settings, Automation</button>.
            </div>
          </div>
        ) : (
          <div className={`mt-2 overflow-x-auto transition-opacity duration-200 ${loading ? "opacity-60" : "opacity-100"}`}>
            <table className="ui-table ui-table-sm min-w-[640px]">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Rule</th>
                  <th>Action</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((e) => {
                  const ok = !e.details?.includes("failed") && !e.details?.includes("error") && !e.details?.includes("SMTP");
                  return (
                    <tr key={e.id}>
                      <td className="text-muted tabular-nums whitespace-nowrap">
                        {new Date(e.triggered_at).toLocaleDateString()} {new Date(e.triggered_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td className="font-medium text-ink">{ruleName(e.rule_id)}</td>
                      <td className="text-muted">{e.action_taken}</td>
                      <td>
                        {ok
                          ? <span className="inline-flex items-center gap-1.5 text-[13px] text-success-ink"><CheckCircle2 size={14} className="flex-none" /> {e.details || "OK"}</span>
                          : <span className="inline-flex items-center gap-1.5 text-[13px] text-danger-ink"><AlertCircle size={14} className="flex-none" /> {e.details || "Failed"}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {filtered.length > 0 && (
          <div className="ui-note px-1 pb-3">
            {filtered.length > 200 ? `Showing the latest 200 of ${filtered.length} entries` : `${filtered.length} entr${filtered.length !== 1 ? "ies" : "y"}`}
          </div>
        )}
      </section>

      <div className="hsep" />

      {/* The inbound flow, so "pending" is understood */}
      <div className="flex items-center flex-wrap gap-x-2.5 gap-y-1.5 p-4 text-[13px]">
        <span className="font-medium text-ink">How inbound works</span>
        <span className="text-muted">Form or signup</span>
        <ArrowRight size={13} className="text-faint" />
        <span className="text-muted">Pending lead</span>
        <ArrowRight size={13} className="text-faint" />
        <span className="text-muted">you approve in</span>
        <button onClick={() => window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "approvals" }))} className="ui-link">Notifications</button>
      </div>
    </div>
  );
}
