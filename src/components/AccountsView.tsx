import { Fragment, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw } from "lucide-react";
import { api, BankBalance, BankBrand } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { toast } from "./Toast";
import { Button } from "./ui";

// R-659 (Jack, 2026-11-16): "a nice ui where i can check all balances on all cards and accounts in real time. This
// will display the banks logo and colors. the ui will match the dashboard ui look and will be in finacials tab."
// Every business account a bank connected on this computer sends, as a card with the bank's own logo and colour from
// Plaid (`bank_branding`), grouped like Balances and tax. "Real time" is the balance Plaid last pulled, re-read every
// minute and after every sync; Refresh asks each bank for its latest (Refresh from bank), no paid Plaid product.
// Personal accounts (R-660) are not here: they live in Personal.

const GROUPS: { id: string; title: string; match: (a: BankBalance) => boolean }[] = [
  { id: "bank", title: "Checking and savings", match: (a) => a.type === "depository" },
  { id: "credit", title: "Credit cards", match: (a) => a.type === "credit" },
  { id: "loan", title: "Loans", match: (a) => a.type === "loan" },
  { id: "other", title: "Other accounts", match: (a) => !["depository", "credit", "loan"].includes(a.type) },
];

const initials = (name: string) =>
  name.split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "B";

/** A tint of the bank's colour for a tile behind its logo; nothing when Plaid gave no colour. */
const tint = (color: string | null | undefined, pct: number) =>
  color ? `color-mix(in srgb, ${color} ${pct}%, transparent)` : undefined;

function BankMark({ brand, institution }: { brand?: BankBrand; institution: string }) {
  return (
    <div
      className="w-10 h-10 rounded-xl ring-1 ring-line flex items-center justify-center flex-shrink-0 overflow-hidden bg-surface-2"
      style={{ background: tint(brand?.color, 14) }}
      aria-hidden
    >
      {brand?.logo
        ? <img src={`data:image/png;base64,${brand.logo}`} alt="" className="w-7 h-7 object-contain" />
        : <span className="text-[13px] font-medium text-ink">{initials(institution)}</span>}
    </div>
  );
}

function AccountCard({ a, brand }: { a: BankBalance; brand?: BankBrand }) {
  const credit = a.type === "credit";
  const owed = Math.abs(a.balance);
  const limit = credit && a.limit && a.limit > 0 ? a.limit : null;
  const used = limit ? Math.min(1, owed / limit) : 0;
  return (
    <div className="rounded-xl ring-1 ring-line bg-surface overflow-hidden min-w-0 flex flex-col">
      <div style={{ height: 3, background: brand?.color ?? "rgb(var(--c-line))" }} />
      <div className="p-4 flex items-start gap-3 min-w-0">
        <BankMark brand={brand} institution={a.institution} />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-muted truncate">{a.institution || "Bank"}</div>
          <div className="text-[13px] font-medium text-ink truncate" title={a.name}>
            {a.name}{a.mask && <span className="text-muted font-normal tabular-nums"> ··{a.mask}</span>}
          </div>
        </div>
      </div>
      <div className="px-4 pb-4 mt-auto">
        <div className="ui-label">{credit ? "Owed" : a.type === "loan" ? "Left to pay" : "Balance"}</div>
        <div className="ui-fig ui-fig-sm mt-1 tabular-nums">{fmtAmount(credit || a.type === "loan" ? owed : a.balance)}</div>
        {credit && limit ? (
          <>
            <div className="mt-3 h-1.5 rounded-full bg-surface-2 overflow-hidden" role="presentation">
              <div className="h-full rounded-full" style={{ width: `${Math.max(2, used * 100)}%`, background: brand?.color ?? "rgb(var(--c-accent))" }} />
            </div>
            <div className="mt-1.5 text-[12px] text-muted tabular-nums">
              {fmtAmount(Math.max(0, limit - owed))} available of {fmtAmount(limit)}
            </div>
          </>
        ) : a.available !== null && a.available !== undefined && Math.abs(a.available - a.balance) >= 0.005 ? (
          <div className="mt-1.5 text-[12px] text-muted tabular-nums">{fmtAmount(a.available)} available now</div>
        ) : null}
      </div>
    </div>
  );
}

export default function AccountsView() {
  const [accounts, setAccounts] = useState<BankBalance[] | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [brands, setBrands] = useState<Record<string, BankBrand>>({});
  const [refreshing, setRefreshing] = useState(false);

  const load = () => {
    api.bankBalances().then((r) => { setAccounts(r.accounts); setLastSync(r.last_sync); }).catch(() => setAccounts([]));
  };

  useEffect(() => {
    load();
    api.bankBranding().then(setBrands).catch(() => {});
    // Background pulls change the balances without telling this screen: re-read each minute and after any sync.
    const t = window.setInterval(load, 60_000);
    let un: (() => void) | null = null;
    let dead = false;
    listen("netsync-applied", () => { load(); }).then((u) => { if (dead) u(); else un = u; }).catch(() => {});
    return () => { window.clearInterval(t); dead = true; un?.(); };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.plaidRefreshSync();
      const refused = r.refresh_refused ?? [];
      toast(refused.length ? `Updated. ${refused.join(", ")} did not send a newer balance yet.` : "Asked every bank for its latest balance.", refused.length ? undefined : "success");
    } catch (e: any) {
      toast(String(e?.message || e), "error");
    } finally {
      setRefreshing(false);
      load();
    }
  };

  const list = accounts ?? [];
  const cash = list.filter((a) => a.type === "depository").reduce((s, a) => s + a.balance, 0);
  const owed = list.filter((a) => a.type === "credit").reduce((s, a) => s + Math.abs(a.balance), 0);
  const when = lastSync
    ? new Date(lastSync).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "Not yet";
  const figures: [string, string, string][] = [
    ["Cash in banks", fmtAmount(cash), `${list.filter((a) => a.type === "depository").length} accounts`],
    ["Owed on cards", fmtAmount(owed), `${list.filter((a) => a.type === "credit").length} cards`],
    ["After cards", fmtAmount(cash - owed), "Cash in banks less what the cards owe"],
    ["Updated", when, "Refreshes on its own every minute"],
  ];

  return (
    <div className="space-y-2 min-w-0">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-[15px] font-medium text-ink">Accounts</h3>
          <p className="ui-note mt-0.5">Every business account and card your banks send, with what each holds or owes now.</p>
        </div>
        <Button onClick={refresh} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} /> Refresh from banks
        </Button>
      </div>
      <div className="hsep" />
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] xl:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] gap-x-6 gap-y-4 py-4">
        {figures.map(([label, value, sub], i) => (
          <Fragment key={label}>
            {i > 0 && <div className={`vsep ${i === 2 ? "hidden xl:block" : "hidden sm:block"}`} />}
            <div className="min-w-0">
              <div className="ui-label">{label}</div>
              <div className="ui-fig mt-1 tabular-nums truncate">{value}</div>
              <div className="text-[12px] text-muted truncate mt-0.5" title={sub}>{sub}</div>
            </div>
          </Fragment>
        ))}
      </div>
      <div className="hsep" />
      {accounts !== null && list.length === 0 && (
        <p className="ui-note pt-4">No bank is connected on this computer. Connect one under Setup to see its accounts here.</p>
      )}
      {GROUPS.map((g) => {
        const rows = list.filter(g.match);
        if (rows.length === 0) return null;
        return (
          <section key={g.id} className="pt-4">
            <h4 className="text-[13px] font-medium text-ink mb-3">
              {g.title} <span className="text-muted font-normal tabular-nums">{rows.length}</span>
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
              {rows.map((a) => <AccountCard key={a.key} a={a} brand={a.item ? brands[a.item] : undefined} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
