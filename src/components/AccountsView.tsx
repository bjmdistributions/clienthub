import { Fragment, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Palette, RefreshCw } from "lucide-react";
import { api, AccountLook, BankBalance, BankBrand } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { accountIssue, CARD_COLOURS, CARD_DEFAULT, darkText } from "../lib/accountLooks";
import { toast } from "./Toast";
import { Button } from "./ui";
import StatusPill from "./StatusPill";
import AccountStatement from "./AccountStatement";

// R-659 (Jack, 2026-11-16): "a nice ui where i can check all balances on all cards and accounts in real time. This
// will display the banks logo and colors. the ui will match the dashboard ui look and will be in finacials tab."
// Every business account a bank connected on this computer sends, grouped like Balances and tax. "Real time" is the
// balance Plaid last pulled, re-read every minute and after every sync; Refresh asks each bank for its latest (Refresh
// from bank), no paid Plaid product. Personal accounts (R-660) are not here: they live in Personal.
//
// R-678 (Jack, 2026-11-19): "make the accounts have color themes that match card colors or have it be the card in a
// cool way and have red notfication when it has issues ... i need to be able to link the proper stuff to get the
// correct logos too." Each account is drawn as its card, in the colour he picks (the bank's own from Plaid until he
// does), with the logo he sets from the bank's website or an image file. An account whose books do not match the bank,
// or whose bank needs reconnecting, is marked red on the card and says why under it, and the Accounts tab counts them.
// Looks are the shared setting `account_looks`, so every computer and the phone draw the same cards.

const GROUPS: { id: string; title: string; match: (a: BankBalance) => boolean }[] = [
  { id: "bank", title: "Checking and savings", match: (a) => a.type === "depository" },
  { id: "credit", title: "Credit cards", match: (a) => a.type === "credit" },
  { id: "loan", title: "Loans", match: (a) => a.type === "loan" },
  { id: "other", title: "Other accounts", match: (a) => !["depository", "credit", "loan"].includes(a.type) },
];

const initials = (name: string) =>
  name.split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "B";

interface Look { color: string; logo: string | null }

/** His choice, else the bank's own, else graphite. */
const lookOf = (mine: AccountLook | undefined, brand: BankBrand | undefined): Look => ({
  color: mine?.color || brand?.color || CARD_DEFAULT,
  logo: mine?.logo || brand?.logo || null,
});

/** The account as its card. The card's colour is his and does not follow the theme, so its text is picked from that
 *  colour (dark on pale cards, white on strong ones) rather than from the theme's tokens. */
function CardFace({ a, look, issue, onEdit }: { a: BankBalance; look: Look; issue: boolean; onEdit?: () => void }) {
  const credit = a.type === "credit";
  const owed = Math.abs(a.balance);
  const limit = credit && a.limit && a.limit > 0 ? a.limit : null;
  const used = limit ? Math.min(1, owed / limit) : 0;
  const dark = darkText(look.color);
  const ink = dark ? "rgba(17,17,19,0.92)" : "rgba(255,255,255,0.96)";
  const soft = dark ? "rgba(17,17,19,0.62)" : "rgba(255,255,255,0.72)";
  const track = dark ? "rgba(17,17,19,0.16)" : "rgba(255,255,255,0.24)";
  return (
    <div
      className={`group relative rounded-2xl overflow-hidden aspect-[1.586/1] min-w-0 flex flex-col justify-between p-4 shadow-[0_10px_24px_-12px_rgba(0,0,0,0.45)] ${issue ? "ring-2 ring-danger ring-offset-2 ring-offset-surface" : "ring-1 ring-black/10"}`}
      style={{ background: `linear-gradient(135deg, ${look.color} 0%, color-mix(in srgb, ${look.color} 72%, black) 100%)`, color: ink }}
    >
      {/* The sheen across the top, as on a real card. */}
      <div aria-hidden className="pointer-events-none absolute inset-0"
        style={{ background: "linear-gradient(160deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.04) 38%, transparent 60%)" }} />
      <div className="relative flex items-start gap-2.5 min-w-0">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden"
          style={{ background: dark ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.9)" }} aria-hidden>
          {look.logo
            ? <img src={`data:image/png;base64,${look.logo}`} alt="" className="w-7 h-7 object-contain" />
            : <span className="text-[12px] font-semibold" style={{ color: "rgba(17,17,19,0.85)" }}>{initials(a.institution)}</span>}
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="text-[13px] font-medium truncate">{a.institution || "Bank"}</div>
          <div className="text-[11.5px] truncate" style={{ color: soft }}>{credit ? "Credit card" : a.subtype ? a.subtype[0].toUpperCase() + a.subtype.slice(1) : "Account"}</div>
        </div>
        {issue && (
          <span className="w-5 h-5 rounded-full bg-danger flex items-center justify-center text-[12px] font-bold leading-none flex-shrink-0"
            style={{ color: "rgba(255,255,255,0.96)", boxShadow: `0 0 0 2px ${ink}` }} title="Needs a look: see under the card" aria-label="Needs a look">!</span>
        )}
        {onEdit && (
          <button onClick={onEdit} title="Change this card's colour and logo" aria-label="Change this card's colour and logo"
            className="w-7 h-7 -mr-1 -mt-0.5 rounded-lg flex items-center justify-center flex-shrink-0 opacity-70 hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-[130ms]"
            style={{ background: track }}>
            <Palette size={14} />
          </button>
        )}
      </div>
      <div className="relative min-w-0">
        <div className="text-[11.5px]" style={{ color: soft }}>{credit ? "Owed" : a.type === "loan" ? "Left to pay" : "Balance"}</div>
        <div className="text-[24px] leading-tight font-semibold tabular-nums truncate">{fmtAmount(credit || a.type === "loan" ? owed : a.balance)}</div>
        {credit && limit ? (
          <div className="mt-1.5">
            <div className="h-1 rounded-full overflow-hidden" style={{ background: track }} role="presentation">
              <div className="h-full rounded-full" style={{ width: `${Math.max(2, used * 100)}%`, background: ink }} />
            </div>
            <div className="mt-1 text-[11.5px] tabular-nums" style={{ color: soft }}>{fmtAmount(Math.max(0, limit - owed))} available of {fmtAmount(limit)}</div>
          </div>
        ) : a.available !== null && a.available !== undefined && Math.abs(a.available - a.balance) >= 0.005 ? (
          <div className="mt-0.5 text-[11.5px] tabular-nums" style={{ color: soft }}>{fmtAmount(a.available)} available now</div>
        ) : null}
      </div>
      <div className="relative flex items-end justify-between gap-3 min-w-0">
        <div className="text-[12.5px] font-medium truncate" title={a.name}>{a.name}</div>
        {a.mask && <div className="text-[13px] tabular-nums tracking-[0.12em] flex-shrink-0" style={{ color: soft }}>·· {a.mask}</div>}
      </div>
    </div>
  );
}

/** A picture file as base64, for `setAccountLook` to shrink and store. */
const readFile = (f: File) => new Promise<string>((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split("base64,")[1] ?? "");
  r.onerror = () => fail(new Error("That file could not be read."));
  r.readAsDataURL(f);
});

/** Change one card: its colour (Apple's colours, the bank's own, or any colour) and its logo (from the bank's
 *  website, from an image file, or the bank's own). Each change is saved as it is made, with the card shown live. */
function LookEditor({ a, mine, brand, onSaved, onClose }: {
  a: BankBalance; mine: AccountLook | undefined; brand: BankBrand | undefined;
  onSaved: (looks: Record<string, AccountLook>) => void; onClose: () => void;
}) {
  const [site, setSite] = useState(mine?.site ?? "");
  const [busy, setBusy] = useState<"" | "site" | "file" | "save">("");
  const file = useRef<HTMLInputElement>(null);
  const look = lookOf(mine, brand);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async (patch: Parameters<typeof api.setAccountLook>[1], kind: typeof busy = "save") => {
    setBusy(kind);
    try { onSaved(await api.setAccountLook(a.key, patch)); }
    catch (e: unknown) { toast(typeof e === "string" ? e : (e as Error)?.message || "That could not be saved", "error"); }
    finally { setBusy(""); }
  };
  const fromSite = async () => {
    if (!site.trim()) return;
    setBusy("site");
    try {
      const logo = await api.siteLogo(site);
      onSaved(await api.setAccountLook(a.key, { logo, site }));
      toast("Logo taken from the bank's website.", "success");
    } catch (e: unknown) {
      toast(typeof e === "string" ? e : (e as Error)?.message || "No logo came back from that website", "error");
    } finally { setBusy(""); }
  };
  const fromFile = async (f: File | undefined) => {
    if (!f) return;
    try { await save({ logo: await readFile(f) }, "file"); }
    catch (e: unknown) { toast((e as Error)?.message || "That file could not be read", "error"); }
  };

  const swatch = (hex: string, name: string) => {
    const on = look.color.toUpperCase() === hex.toUpperCase();
    return (
      <button key={name} onClick={() => save({ color: hex })} title={name} aria-label={name} aria-pressed={on}
        className={`w-8 h-8 rounded-full ring-1 ring-black/10 transition-transform duration-[130ms] hover:scale-110 ${on ? "outline outline-2 outline-offset-2 outline-ink" : ""}`}
        style={{ background: hex }} />
    );
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`${a.name} card look`}
        className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-4 border-b border-line">
          <h2 className="text-[16px] font-semibold text-ink">Card look</h2>
          <p className="text-[12px] text-muted mt-0.5">{a.institution} {a.name}{a.mask ? ` ··${a.mask}` : ""}. Shows the same on every computer and your phone.</p>
        </div>
        <div className="p-5 space-y-5">
          <div className="max-w-[320px] mx-auto"><CardFace a={a} look={look} issue={false} /></div>

          <section>
            <h3 className="text-[13px] font-medium text-ink mb-2">Colour</h3>
            <div className="flex flex-wrap items-center gap-2.5">
              {brand?.color && swatch(brand.color, "The bank's own colour")}
              {CARD_COLOURS.map((c) => swatch(c.hex, c.name))}
              <label className="w-8 h-8 rounded-full ring-1 ring-line-3 flex items-center justify-center cursor-pointer relative overflow-hidden"
                title="Any colour" style={{ background: "conic-gradient(#FF3B30, #FF9500, #FFCC00, #34C759, #30B0C7, #007AFF, #AF52DE, #FF2D55, #FF3B30)" }}>
                <input type="color" value={look.color} onChange={(e) => save({ color: e.target.value })}
                  className="absolute inset-0 opacity-0 cursor-pointer" aria-label="Any colour" />
              </label>
            </div>
            {mine?.color && <button onClick={() => save({ color: "" })} className="ui-link muted mt-2 !text-[12px]">Use the bank's colour</button>}
          </section>

          <section>
            <h3 className="text-[13px] font-medium text-ink mb-1">Logo</h3>
            <p className="text-[12px] text-muted mb-2">Type the bank's website and its logo is taken from there, or choose a picture.</p>
            <div className="flex items-center gap-2">
              <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="chase.com" spellCheck={false}
                onKeyDown={(e) => { if (e.key === "Enter") fromSite(); }}
                className="flex-1 min-w-0 border border-line-3 rounded-lg h-9 px-2.5 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent" />
              <Button size="sm" onClick={fromSite} disabled={!site.trim() || busy !== ""}>{busy === "site" ? "Getting it" : "Get logo"}</Button>
            </div>
            <div className="flex items-center gap-4 mt-3 flex-wrap">
              <Button size="sm" onClick={() => file.current?.click()} disabled={busy !== ""}>{busy === "file" ? "Saving" : "Choose a picture"}</Button>
              <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/bmp" className="hidden"
                onChange={(e) => { fromFile(e.target.files?.[0]); e.target.value = ""; }} />
              {mine?.logo && <button onClick={() => save({ logo: "" })} className="ui-link muted !text-[12px]">{brand?.logo ? "Use the bank's logo" : "Remove the logo"}</button>}
            </div>
          </section>
        </div>
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-line">
          {mine ? <button onClick={() => save({ reset: true })} className="ui-link muted !text-[12.5px]">Back to the bank's look</button> : <span />}
          <Button variant="ink" onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
}

export default function AccountsView({ onOpenRow, onFix }: { onOpenRow?: (id: string, amount: number) => void; onFix?: () => void }) {
  const [statement, setStatement] = useState<BankBalance | null>(null);
  const [editing, setEditing] = useState<BankBalance | null>(null);
  const [accounts, setAccounts] = useState<BankBalance[] | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [brands, setBrands] = useState<Record<string, BankBrand>>({});
  const [looks, setLooks] = useState<Record<string, AccountLook>>({});
  const [refreshing, setRefreshing] = useState(false);

  const load = () => {
    api.bankBalances().then((r) => { setAccounts(r.accounts); setLastSync(r.last_sync); }).catch(() => setAccounts([]));
    api.accountLooks().then(setLooks).catch(() => {});
  };

  useEffect(() => {
    load();
    api.bankBranding().then(setBrands).catch(() => {});
    // Background pulls change the balances without telling this screen: re-read each minute and after any sync
    // (which also brings a look set on another computer).
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
  const issues = list.filter((a) => accountIssue(a, fmtAmount)).length;
  const when = lastSync
    ? new Date(lastSync).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "Not yet";
  const figures: [string, string, string][] = [
    ["Cash in banks", fmtAmount(cash), `${list.filter((a) => a.type === "depository").length} accounts`],
    ["Owed on cards", fmtAmount(owed), `${list.filter((a) => a.type === "credit").length} cards`],
    ["After cards", fmtAmount(cash - owed), "Cash in banks less what the cards owe"],
    ["Updated", when, issues ? `${issues} ${issues === 1 ? "account needs" : "accounts need"} a look, marked red` : "Refreshes on its own every minute"],
  ];

  return (
    <div className="space-y-2 min-w-0">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-[15px] font-medium text-ink">Accounts</h3>
          <p className="ui-note mt-0.5">Every business account and card your banks send, with what each holds or owes now. Press the palette on a card to change its colour and logo.</p>
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
              <div className={`text-[12px] truncate mt-0.5 ${i === 3 && issues ? "text-danger" : "text-muted"}`} title={sub}>{sub}</div>
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
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-5 gap-y-6">
              {rows.map((a) => {
                const brand = a.item ? brands[a.item] : undefined;
                const issue = accountIssue(a, fmtAmount);
                const statementable = a.type === "depository" || a.type === "credit";
                return (
                  <div key={a.key} className="min-w-0">
                    <CardFace a={a} look={lookOf(looks[a.key], brand)} issue={!!issue} onEdit={() => setEditing(a)} />
                    <div className="mt-2.5 px-0.5 min-h-[22px] flex items-start justify-between gap-3">
                      {issue ? (
                        <div className="min-w-0 flex items-start gap-2">
                          <StatusPill tone="danger">{issue.kind === "connection" ? "Reconnect" : "Off from books"}</StatusPill>
                          <span className="text-[12px] text-muted leading-snug">{issue.text}</span>
                        </div>
                      ) : <span className="text-[12px] text-muted">{a.drift != null ? "Books agree with the bank" : ""}</span>}
                      <div className="flex items-center gap-3 flex-shrink-0">
                        {issue?.kind === "connection" && onFix && <button onClick={onFix} className="ui-link !text-[12.5px]">Fix it</button>}
                        {statementable && (
                          <button onClick={() => setStatement(a)} className="ui-link !text-[12.5px]" title="Every transaction with the balance after it, to hold against your bank">
                            {issue?.kind === "books" ? "See why" : "Statement"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {statement && (
        <AccountStatement account={statement.label} name={`${statement.name}${statement.mask ? ` ··${statement.mask}` : ""}`}
          card={statement.type === "credit"} onClose={() => setStatement(null)} onOpenRow={onOpenRow} />
      )}
      {editing && (
        <LookEditor a={editing} mine={looks[editing.key]} brand={editing.item ? brands[editing.item] : undefined}
          onSaved={setLooks} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
