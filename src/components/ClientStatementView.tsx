import { useEffect, useMemo, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, type Client, type StatementData, type StatementOptions, type StatementOverrides } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { Receipt, FileDown, Send, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "./Toast";

const INPUT_CLASS =
  "w-full border border-line px-3 h-10 rounded-lg text-[13.5px] text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";
const SMALL_INPUT =
  "border border-line px-2.5 h-8 rounded-lg text-[12.5px] text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

const DEFAULT_OPTIONS: StatementOptions = {
  include_items: true,
  include_payments: true,
  include_refunds: true,
  include_dates: true,
  include_summary: true,
  include_balance: true,
  title: "",
  intro: "",
};

type StageFilter = "all" | "complete" | "open" | "refunded";

const STAGE_LABEL: Record<string, string> = {
  invoiced: "Invoiced",
  payment_received: "Payment received",
  supplier_paid: "Supplier paid",
  complete: "Completed",
};

/** The same handoff Receivables and the client screen use: the opener stashes the
 *  client, then switches tabs. Read once and cleared, so re-opening the tab later
 *  doesn't silently reload someone from last week. */
const takeStashedClient = (): string => {
  try {
    const id = localStorage.getItem("statement_client_id") || "";
    if (id) localStorage.removeItem("statement_client_id");
    return id;
  } catch {
    return "";
  }
};

export default function ClientStatementView({ initialClientId }: { initialClientId?: string }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState(initialClientId ?? takeStashedClient());
  const [data, setData] = useState<StatementData | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stage, setStage] = useState<StageFilter>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [options, setOptions] = useState<StatementOptions>(DEFAULT_OPTIONS);
  const [overrides, setOverrides] = useState<StatementOverrides>({
    payment_dates: {},
    payment_methods: {},
    deal_labels: {},
  });

  // Client-level fills. These DO write back to the record — unlike the payment
  // dates and methods, which live on bank_txn and stay on this document only.
  const [fillEmail, setFillEmail] = useState("");
  const [fillStreet, setFillStreet] = useState("");
  const [fillCity, setFillCity] = useState("");
  const [fillState, setFillState] = useState("");
  const [fillZip, setFillZip] = useState("");

  useEffect(() => {
    api.listClients().then(setClients).catch(() => {});
  }, []);

  const load = async (id: string) => {
    if (!id) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const d = await api.clientStatementData(id);
      setData(d);
      setSelected(new Set(d.deals.map((x) => x.deal_flow_id)));
      setFillEmail(d.client.email);
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(clientId);
  }, [clientId]);

  const visible = useMemo(() => {
    if (!data) return [];
    return data.deals.filter((d) => {
      if (stage === "complete" && d.stage !== "complete") return false;
      if (stage === "open" && d.stage === "complete") return false;
      if (stage === "refunded" && d.refunds.length === 0) return false;
      const day = d.issue_date || d.closed_date;
      if (from && day && day < from) return false;
      if (to && day && day > to) return false;
      return true;
    });
  }, [data, stage, from, to]);

  const chosen = useMemo(
    () => (data ? data.deals.filter((d) => selected.has(d.deal_flow_id)) : []),
    [data, selected],
  );

  const totals = useMemo(() => {
    const invoiced = chosen.reduce((s, d) => s + d.total, 0);
    const paid = chosen.reduce((s, d) => s + d.paid, 0);
    const refunded = chosen.reduce((s, d) => s + d.refunded, 0);
    const balance = chosen.reduce((s, d) => s + d.balance, 0);
    return { invoiced, paid, refunded, netReceived: paid - refunded, balance };
  }, [chosen]);

  // Only the blanks that would actually print: gaps on deals nobody ticked are not
  // this document's problem.
  const gaps = useMemo(() => {
    if (!data) return [];
    return data.gaps.filter((g) => !g.deal_flow_id || selected.has(g.deal_flow_id));
  }, [data, selected]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const buildInput = (outputPath: string) => ({
    client_id: clientId,
    deal_ids: chosen.map((d) => d.deal_flow_id),
    options,
    overrides,
    output_path: outputPath,
  });

  const download = async () => {
    if (working || !data || chosen.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await saveDialog({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      defaultPath: `statement-${data.client.name.replace(/[^a-z0-9]+/gi, "-")}-${stamp}.pdf`,
    });
    if (!path) return;
    setWorking(true);
    try {
      await api.generateClientStatement(buildInput(path as string));
      toast("Statement saved");
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setWorking(false);
    }
  };

  const emailIt = async () => {
    if (working || !data || chosen.length === 0) return;
    const to = (fillEmail || data.client.email).trim();
    if (!to) {
      toast("No email address for this client", "error");
      return;
    }
    setWorking(true);
    try {
      const path = await api.generateClientStatement(buildInput(""));
      const title = options.title.trim() || "Statement of account";
      await api.sendEmail(
        to,
        title,
        `Hi ${data.client.name},\n\nAttached is your ${title.toLowerCase()} covering ${chosen.length} ${
          chosen.length === 1 ? "deal" : "deals"
        }.\n\nThanks,`,
        path,
      );
      toast(`Statement sent to ${to}`);
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setWorking(false);
    }
  };

  const saveClientFills = async () => {
    if (!clientId) return;
    try {
      await api.saveStatementClientFills(clientId, {
        email: fillEmail.trim() || undefined,
        streetAddress: fillStreet.trim() || undefined,
        city: fillCity.trim() || undefined,
        state: fillState.trim() || undefined,
        zipCode: fillZip.trim() || undefined,
      });
      setFillStreet("");
      setFillCity("");
      setFillState("");
      setFillZip("");
      toast("Saved to the client record");
      await load(clientId);
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  const setOpt = (k: keyof StatementOptions, v: boolean) =>
    setOptions((o) => ({ ...o, [k]: v }));

  const paymentGaps = gaps.filter((g) => g.kind === "payment_date" || g.kind === "payment_method");
  const labelGaps = gaps.filter((g) => g.kind === "deal_label");
  const clientGaps = gaps.filter((g) => g.kind === "client_email" || g.kind === "client_address");

  return (
    <div className="p-6 max-w-[1080px] space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center text-accent flex-shrink-0 mt-0.5">
          <Receipt size={18} />
        </div>
        <div className="min-w-0">
          <h2 className="text-[18px] font-bold text-ink">Client receipt</h2>
          <p className="text-[12.5px] text-muted mt-0.5 leading-relaxed">
            Pick a client, tick the deals, and send them one PDF of every payment with its
            date — invoice numbers, item labels and refunds included. Nothing on it shows
            cost or margin.
          </p>
        </div>
      </div>

      {/* Client */}
      <div className="bg-surface border border-line rounded-xl p-5 space-y-1.5">
        <label className="block text-[12px] font-medium text-muted">Client</label>
        <select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          style={{ background: "var(--t-input-bg)" }}
          className={INPUT_CLASS}
        >
          <option value="">Select a client…</option>
          {[...clients]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.company ? `${c.name} — ${c.company}` : c.name}
              </option>
            ))}
        </select>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading deals…
        </div>
      )}

      {data && !loading && (
        <>
          {/* Deals */}
          <div className="bg-surface border border-line rounded-xl overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 px-5 py-3.5 border-b border-line">
              <span className="text-[13px] font-semibold text-ink mr-1">
                {chosen.length} of {data.deals.length} selected
              </span>
              <button
                onClick={() => setSelected(new Set(visible.map((d) => d.deal_flow_id)))}
                className="border border-line text-ink-2 hover:bg-surface-2 px-3 h-8 rounded-lg text-[12px] font-medium transition-colors"
              >
                Select all
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="border border-line text-ink-2 hover:bg-surface-2 px-3 h-8 rounded-lg text-[12px] font-medium transition-colors"
              >
                Clear
              </button>
              <div className="flex-1" />
              <div className="flex flex-wrap items-center gap-2">
                {(["all", "complete", "open", "refunded"] as StageFilter[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStage(s)}
                    className={`px-3 h-8 rounded-lg border text-[12px] font-medium transition-colors ${
                      stage === s
                        ? "bg-accent text-on-accent border-accent"
                        : "bg-surface text-muted border-line hover:bg-surface-2"
                    }`}
                  >
                    {s === "all" ? "All" : s === "complete" ? "Completed" : s === "open" ? "In progress" : "Refunded"}
                  </button>
                ))}
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  style={{ background: "var(--t-input-bg)" }}
                  className={SMALL_INPUT}
                />
                <span className="text-[12px] text-faint">to</span>
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  style={{ background: "var(--t-input-bg)" }}
                  className={SMALL_INPUT}
                />
              </div>
            </div>

            {visible.length === 0 ? (
              <p className="px-5 py-8 text-[13px] text-muted text-center">
                {data.deals.length === 0 ? "This client has no deals yet." : "No deals match these filters."}
              </p>
            ) : (
              <div className="divide-y divide-line">
                {visible.map((d) => (
                  <label
                    key={d.deal_flow_id}
                    className="flex items-start gap-3 px-5 py-3 cursor-pointer hover:bg-surface-2 transition-colors"
                  >
                    <input
                      type="checkbox"
                      className="accent-accent mt-1"
                      checked={selected.has(d.deal_flow_id)}
                      onChange={() => toggle(d.deal_flow_id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-[13.5px] font-semibold text-ink">
                          {d.invoice_number || "No invoice number"}
                        </span>
                        {d.name && <span className="text-[13px] text-ink-2 truncate">{d.name}</span>}
                        <span className="text-[11.5px] text-faint">
                          {STAGE_LABEL[d.stage] ?? d.stage}
                        </span>
                      </div>
                      <div className="text-[12px] text-muted mt-0.5">
                        {d.issue_date || "—"}
                        {d.items.length > 0 && (
                          <>
                            {" · "}
                            {d.items.length === 1
                              ? d.items[0].description
                              : `${d.items.length} items`}
                          </>
                        )}
                        {d.payments.length > 0 && ` · ${d.payments.length} payment${d.payments.length === 1 ? "" : "s"}`}
                        {d.refunds.length > 0 && ` · refunded ${fmtAmount(d.refunded)}`}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-[13.5px] font-semibold text-ink tabular-nums">{fmtAmount(d.total)}</div>
                      <div className="text-[11.5px] text-muted tabular-nums">
                        paid {fmtAmount(d.paid)}
                        {d.balance > 0.005 && ` · due ${fmtAmount(d.balance)}`}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}

            {chosen.length > 0 && (
              <div className="flex flex-wrap gap-x-6 gap-y-1 px-5 py-3 border-t border-line text-[12.5px]">
                <span className="text-muted">
                  Invoiced <span className="text-ink font-semibold tabular-nums">{fmtAmount(totals.invoiced)}</span>
                </span>
                <span className="text-muted">
                  Paid <span className="text-ink font-semibold tabular-nums">{fmtAmount(totals.paid)}</span>
                </span>
                {totals.refunded > 0.005 && (
                  <span className="text-muted">
                    Refunded <span className="text-ink font-semibold tabular-nums">{fmtAmount(totals.refunded)}</span>
                  </span>
                )}
                <span className="text-muted">
                  Balance due <span className="text-ink font-semibold tabular-nums">{fmtAmount(totals.balance)}</span>
                </span>
              </div>
            )}
          </div>

          {/* Missing information */}
          {gaps.length > 0 && (
            <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
              <div className="flex items-start gap-2.5">
                <AlertTriangle size={16} className="text-warning flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <h3 className="text-[13.5px] font-semibold text-ink">Missing information</h3>
                  <p className="text-[12px] text-muted mt-0.5 leading-relaxed">
                    These would print blank. Payment dates and methods are used on this
                    document only — they sit on the bank transaction, and changing one
                    there would move the deal's closed date.
                  </p>
                </div>
              </div>

              {clientGaps.length > 0 && (
                <div className="space-y-2.5">
                  {clientGaps.map((g) => (
                    <p key={g.kind} className="text-[12.5px] text-ink-2">
                      {g.label}
                    </p>
                  ))}
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
                    <input
                      value={fillEmail}
                      onChange={(e) => setFillEmail(e.target.value)}
                      placeholder="Email address"
                      style={{ background: "var(--t-input-bg)" }}
                      className={`${SMALL_INPUT} w-full`}
                    />
                    <input
                      value={fillStreet}
                      onChange={(e) => setFillStreet(e.target.value)}
                      placeholder="Street address"
                      style={{ background: "var(--t-input-bg)" }}
                      className={`${SMALL_INPUT} w-full`}
                    />
                    <input
                      value={fillCity}
                      onChange={(e) => setFillCity(e.target.value)}
                      placeholder="City"
                      style={{ background: "var(--t-input-bg)" }}
                      className={`${SMALL_INPUT} w-full`}
                    />
                    <input
                      value={fillState}
                      onChange={(e) => setFillState(e.target.value)}
                      placeholder="State"
                      style={{ background: "var(--t-input-bg)" }}
                      className={`${SMALL_INPUT} w-full`}
                    />
                    <input
                      value={fillZip}
                      onChange={(e) => setFillZip(e.target.value)}
                      placeholder="ZIP"
                      style={{ background: "var(--t-input-bg)" }}
                      className={`${SMALL_INPUT} w-full`}
                    />
                    <button
                      onClick={saveClientFills}
                      className="border border-line text-ink-2 hover:bg-surface-2 px-3 h-8 rounded-lg text-[12px] font-medium transition-colors"
                    >
                      Save to client record
                    </button>
                  </div>
                </div>
              )}

              {labelGaps.map((g) => (
                <div key={g.target_id} className="space-y-1.5">
                  <p className="text-[12.5px] text-ink-2">{g.label}</p>
                  <input
                    value={overrides.deal_labels[g.target_id] ?? ""}
                    onChange={(e) =>
                      setOverrides((o) => ({
                        ...o,
                        deal_labels: { ...o.deal_labels, [g.target_id]: e.target.value },
                      }))
                    }
                    placeholder="What was sold, e.g. 20 pallets of assorted apparel"
                    style={{ background: "var(--t-input-bg)" }}
                    className={`${SMALL_INPUT} w-full`}
                  />
                </div>
              ))}

              {paymentGaps.map((g) => (
                <div key={`${g.kind}-${g.target_id}`} className="space-y-1.5">
                  <p className="text-[12.5px] text-ink-2">{g.label}</p>
                  {g.kind === "payment_date" ? (
                    <input
                      type="date"
                      value={overrides.payment_dates[g.target_id] ?? ""}
                      onChange={(e) =>
                        setOverrides((o) => ({
                          ...o,
                          payment_dates: { ...o.payment_dates, [g.target_id]: e.target.value },
                        }))
                      }
                      style={{ background: "var(--t-input-bg)" }}
                      className={SMALL_INPUT}
                    />
                  ) : (
                    <input
                      value={overrides.payment_methods[g.target_id] ?? ""}
                      onChange={(e) =>
                        setOverrides((o) => ({
                          ...o,
                          payment_methods: { ...o.payment_methods, [g.target_id]: e.target.value },
                        }))
                      }
                      placeholder="Wire, ACH, check…"
                      style={{ background: "var(--t-input-bg)" }}
                      className={`${SMALL_INPUT} w-full max-w-[260px]`}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* What goes on it */}
          <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
            <h3 className="text-[13.5px] font-semibold text-ink">What goes on it</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
              {([
                ["include_items", "Item lines"],
                ["include_payments", "Payments with dates"],
                ["include_refunds", "Refunds"],
                ["include_dates", "Invoice, pickup and closed dates"],
                ["include_summary", "Summary at the top"],
                ["include_balance", "Balance due"],
              ] as [keyof StatementOptions, string][]).map(([key, label]) => (
                <label
                  key={key}
                  className="flex items-center gap-2 text-[12.5px] text-ink-2 cursor-pointer select-none"
                >
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={options[key] as boolean}
                    onChange={(e) => setOpt(key, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="space-y-1.5 min-w-0">
                <label className="block text-[12px] font-medium text-muted">Title</label>
                <input
                  value={options.title}
                  onChange={(e) => setOptions((o) => ({ ...o, title: e.target.value }))}
                  placeholder="Statement of account"
                  style={{ background: "var(--t-input-bg)" }}
                  className={INPUT_CLASS}
                />
              </div>
              <div className="space-y-1.5 min-w-0">
                <label className="block text-[12px] font-medium text-muted">Note to the client</label>
                <input
                  value={options.intro}
                  onChange={(e) => setOptions((o) => ({ ...o, intro: e.target.value }))}
                  placeholder="Optional — printed under their address"
                  style={{ background: "var(--t-input-bg)" }}
                  className={INPUT_CLASS}
                />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              onClick={download}
              disabled={working || chosen.length === 0}
              className="inline-flex items-center gap-2 px-4 h-9 rounded-lg bg-accent text-on-accent text-[13px] font-semibold hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {working ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />}
              Download PDF
            </button>
            <button
              onClick={emailIt}
              disabled={working || chosen.length === 0}
              className="inline-flex items-center gap-2 border border-line text-ink-2 hover:bg-surface-2 px-4 h-9 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send size={14} /> Email to client
            </button>
            {chosen.length === 0 && (
              <span className="text-[12.5px] text-faint">Tick at least one deal.</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
