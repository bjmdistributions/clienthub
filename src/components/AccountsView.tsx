import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, ListChecks, Palette, RefreshCw } from "lucide-react";
import { api, AccountLook, BankBalance, BankBrand } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { accountCheck, AccountCheck, needsALook, CARD_CHIP, CARD_COLOURS, CARD_DEFAULT, CARD_FINISHES, CardFinish, darkText, finishFor } from "../lib/accountLooks";
import { toast } from "./Toast";
import { Button } from "./ui";
import StatusPill from "./StatusPill";
import AccountStatement from "./AccountStatement";
import NeedsYou, { needsOnAccount, useNeedsYou } from "./NeedsYou";
import { checkSentence } from "./BooksStatus";

// R-659 (Jack, 2026-11-16): "a nice ui where i can check all balances on all cards and accounts in real time. This
// will display the banks logo and colors. the ui will match the dashboard ui look and will be in finacials tab."
// Every business account a bank connected on this computer sends, grouped like Balances and tax. "Real time" is the
// balance Plaid last pulled, re-read every minute and after every sync; Refresh asks each bank for its latest (Refresh
// from bank), no paid Plaid product. Personal accounts (R-660) are not here: they live in Personal.
//
// R-678 (Jack, 2026-11-19): a logo and a look he picks per account (the shared setting `account_looks`, so every
// computer and the phone agree), and a red mark with the reason on an account whose books do not match the bank or
// whose bank needs reconnecting; the Accounts tab counts them.
//
// R-683 (Jack, 2026-11-23): "preset platinum gold cards in theer and pulling predesigns for all other business cards.
// I want it to be clealy shown and have them be smaller for business credit careds. I dont want bank accounts and
// savings accounts to be shapedc into cards"; then, the same day: "i dont want the bank views and savings views to
// look like vieboded cards. i still want them to look professional and clean and look like a banka ccount but the
// wetnire page needs to look great". So the page is two plain lists on hairlines, the way a bank shows accounts, with
// no boxes, tints or coloured edges:
//   - checking, savings, loans: a row each, logo, account, last four, what is available and the balance in columns;
//   - credit cards: the same row with a SMALL picture of the card in a preset finish (platinum, gold, black metal and
//     the rest of CARD_FINISHES, picked from the card's name until he chooses), then what is available and owed.
//
// R-685 (Jack, 2026-11-23): "i think the button no longer exist to check against the bank. I need to be able to check
// against the bank when i have red warnings that say off from books. this button looks at every single trransaction in
// and out and identifies the discrepencies to the ledger and to the actual bank record". The check never left (R-670
// put it in the strip above the tabs as Check now), but nothing on this screen led to it. So Check against bank is in
// this screen's header and on every Off from books row, and See why on such a row opens the differences under it
// (`DriftPanel`, R-622: every transaction behind the difference, bank against books), opened by itself after a check.
// R-688 replaced both: he was still the one pressing and reading.
//
// R-688 (Jack, 2026-11-24): "it look at the most current and up to sate bank balance. if it does not match waht out
// ledger records has. the system needs to on its own check every single transaction against the books to find
// discrepencyies. you have the bullshit screenw here i have to manual check it ... the point of this software is
// always to automize and save time." This screen now does that by itself: when an account's balance and books differ
// in a state the bank's list has not been read for, Check against bank runs with no click (the app also runs it after
// every bank pull), the row reads Checking every transaction, and it ends as Matches the bank or as the exact
// transactions that need his answer, drawn under the row with their answers (the same ones as Needs you). There is no
// See why, no differences panel and no per-row button.
//
// R-686 (Jack, 2026-11-23): "can we have color showing how much has been spent in red. so i know thats the balance
// owed. i then would like if it has a credit limit, lets do a color filling in the ammmount ... lets do tghe actual
// card looks. pull real card looks instead of artificial if possible". What a card owes is in red, and the limit bar is
// filled in red for what is used. A card's real artwork cannot be pulled (the bank feed gives a logo and one colour),
// so Card look takes a picture of the card that he chooses, and the card is drawn from it in place of a finish.

const GROUPS: { id: string; title: string; figure: string; match: (a: BankBalance) => boolean }[] = [
  { id: "bank", title: "Checking and savings", figure: "Balance", match: (a) => a.type === "depository" },
  { id: "credit", title: "Credit cards", figure: "Owed", match: (a) => a.type === "credit" },
  { id: "loan", title: "Loans", figure: "Left to pay", match: (a) => a.type === "loan" },
  { id: "other", title: "Other accounts", figure: "Balance", match: (a) => !["depository", "credit", "loan"].includes(a.type) },
];

/** One set of columns for every list, so the figures line up down the page: who, available, the figure, actions. */
const COLS = "grid grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_180px_150px_270px] items-center gap-x-5 gap-y-2";

const initials = (name: string) =>
  name.split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "B";

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

interface Look { color: string; logo: string | null; finish: CardFinish | null; /** His picture of the card (R-686). */ art: string | null }

/** His choice, else the bank's own, else graphite; a credit card also gets its finish (his, else from its name). */
const lookOf = (a: BankBalance, mine: AccountLook | undefined, brand: BankBrand | undefined): Look => ({
  color: mine?.color || brand?.color || CARD_DEFAULT,
  logo: mine?.logo || brand?.logo || null,
  finish: a.type === "credit" ? finishFor(mine?.finish, `${a.name} ${a.label}`) : null,
  art: a.type === "credit" ? mine?.art || null : null,
});

/** A card's face: its finish, or his colour when it has none. */
const faceOf = (look: Look) => ({
  background: look.finish?.background ?? `linear-gradient(135deg, ${look.color} 0%, color-mix(in srgb, ${look.color} 70%, black) 100%)`,
  dark: look.finish ? look.finish.dark : darkText(look.color),
  frame: !!look.finish?.frame,
});

/** The picture of a credit card: finish, logo, chip, name and last four. Its colours are the card's own and do not
 *  follow the theme, so its text is picked from the face (near-black on pale metals, white on dark ones). The money
 *  is NOT on it: that sits in the columns beside it, in the app's own type. `big` is the editor's preview. */
function CardArt({ a, look, big }: { a: BankBalance; look: Look; big?: boolean }) {
  const shape = big ? "w-[280px] rounded-[14px] shadow-[0_14px_28px_-14px_rgba(0,0,0,0.55)]" : "w-[112px] rounded-[7px] shadow-[0_4px_10px_-6px_rgba(0,0,0,0.5)]";
  // R-686: his own picture of the card is the card; nothing is drawn over it.
  if (look.art) {
    return (
      <div className={`relative overflow-hidden aspect-[1.586/1] flex-shrink-0 ring-1 ring-black/10 ${shape}`} aria-hidden>
        <img src={`data:image/jpeg;base64,${look.art}`} alt="" className="w-full h-full object-cover" />
      </div>
    );
  }
  const face = faceOf(look);
  const ink = face.dark ? "rgba(17,17,19,0.88)" : "rgba(255,255,255,0.96)";
  const soft = face.dark ? "rgba(17,17,19,0.6)" : "rgba(255,255,255,0.74)";
  return (
    <div className={`relative overflow-hidden aspect-[1.586/1] flex flex-col justify-between flex-shrink-0 ring-1 ring-black/10 ${shape} ${big ? "p-4" : "p-[7px]"}`}
      style={{ background: face.background, color: ink }} aria-hidden>
      {/* Brushed grain and the light across the top, as on a metal card. */}
      <div className="pointer-events-none absolute inset-0"
        style={{ background: "repeating-linear-gradient(100deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 3px), linear-gradient(160deg, rgba(255,255,255,0.26) 0%, rgba(255,255,255,0.03) 40%, transparent 62%)" }} />
      {face.frame && <div className={`pointer-events-none absolute ${big ? "inset-[7px] rounded-[9px]" : "inset-[3px] rounded-[5px]"}`} style={{ boxShadow: `inset 0 0 0 1px ${face.dark ? "rgba(17,17,19,0.22)" : "rgba(255,255,255,0.26)"}` }} />}
      <div className={`relative flex items-center min-w-0 ${big ? "gap-2.5" : "gap-1"}`}>
        <div className={`flex items-center justify-center flex-shrink-0 overflow-hidden ${big ? "w-9 h-9 rounded-lg" : "w-4 h-4 rounded-[4px]"}`} style={{ background: "rgba(255,255,255,0.92)" }}>
          {look.logo
            ? <img src={`data:image/png;base64,${look.logo}`} alt="" className={`object-contain ${big ? "w-7 h-7" : "w-3 h-3"}`} />
            : <span className={`font-semibold ${big ? "text-[12px]" : "text-[6.5px]"}`} style={{ color: "rgba(17,17,19,0.85)" }}>{initials(a.institution)}</span>}
        </div>
        <div className={`font-medium truncate min-w-0 flex-1 ${big ? "text-[14px]" : "text-[7.5px]"}`}>{a.institution || "Bank"}</div>
      </div>
      <div className={`relative ${big ? "w-[42px] h-[31px] rounded-[6px]" : "w-[17px] h-[13px] rounded-[3px]"}`} style={{ background: CARD_CHIP, boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.18)" }}>
        <div className="absolute inset-x-0 top-1/2 h-px" style={{ background: "rgba(0,0,0,0.22)" }} />
        <div className="absolute inset-y-0 left-1/3 w-px" style={{ background: "rgba(0,0,0,0.22)" }} />
        <div className="absolute inset-y-0 right-1/3 w-px" style={{ background: "rgba(0,0,0,0.22)" }} />
      </div>
      <div className="relative flex items-end justify-between gap-2 min-w-0">
        <div className={`font-medium truncate ${big ? "text-[12.5px]" : "text-[7px]"}`} style={{ color: soft }}>{a.name}</div>
        {a.mask && <div className={`font-medium tabular-nums tracking-[0.1em] flex-shrink-0 ${big ? "text-[15px]" : "text-[8.5px]"}`}>·· {a.mask}</div>}
      </div>
    </div>
  );
}

/** A bank's logo beside an account that is not a card: plain, on the app's own surface. */
function BankLogo({ a, look }: { a: BankBalance; look: Look }) {
  return (
    <div className="w-9 h-9 rounded-lg ring-1 ring-line bg-surface-2 flex items-center justify-center flex-shrink-0 overflow-hidden" aria-hidden>
      {look.logo
        ? <img src={`data:image/png;base64,${look.logo}`} alt="" className="w-6 h-6 object-contain" />
        : <span className="text-[12px] font-medium text-ink">{initials(a.institution)}</span>}
    </div>
  );
}

/** One account on the list, the way a bank shows it: who it is, what is available, the figure, then what the automatic
 *  check found (R-688). It is red only when he has something to do, and then the exact transactions are under it. */
function AccountRow({ a, look, check, onEdit, onFix, onStatement, children }: {
  a: BankBalance; look: Look; check: AccountCheck; onEdit?: () => void; onFix?: () => void; onStatement?: () => void;
  /** The transactions waiting on his answer on this account, under the row. */
  children?: ReactNode;
}) {
  const credit = a.type === "credit", loan = a.type === "loan";
  const owed = Math.abs(a.balance);
  const limit = credit && a.limit && a.limit > 0 ? a.limit : null;
  const used = limit ? Math.min(1, owed / limit) : 0;
  const kind = credit ? "" : a.subtype ? cap(a.subtype) : loan ? "Loan" : "Account";
  const availNow = !credit && a.available !== null && a.available !== undefined ? a.available : null;
  const red = needsALook(check);
  const quiet = "inline-flex items-center gap-1 text-[12px] text-muted whitespace-nowrap";
  return (
    <div className="py-3.5 border-t border-line">
      <div className={COLS}>
        <div className="flex items-center gap-3.5 min-w-0">
          {credit ? <CardArt a={a} look={look} /> : <BankLogo a={a} look={look} />}
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              {red && <span className="w-2 h-2 rounded-full bg-danger flex-shrink-0" title="Needs you" aria-label="Needs you" />}
              <span className="text-[14px] font-medium text-ink truncate" title={a.name}>{a.name}</span>
            </div>
            <div className="text-[12.5px] text-muted truncate">
              {a.institution || "Bank"}{kind && ` · ${kind}`}{a.mask && <span className="tabular-nums"> ··{a.mask}</span>}
            </div>
          </div>
        </div>
        <div className="hidden lg:block text-right min-w-0">
          {limit ? (
            <>
              <div className="text-[13.5px] text-ink tabular-nums">{fmtAmount(Math.max(0, limit - owed))}</div>
              {/* R-686: the limit as a bar, filled in red for what is owed of it. */}
              <div className="mt-1.5 h-1.5 rounded-full bg-line overflow-hidden" role="img" aria-label={`${Math.round(used * 100)}% of the limit used`}>
                {owed >= 0.005 && <div className="h-full rounded-full bg-danger" style={{ width: `${Math.max(2, used * 100)}%` }} />}
              </div>
              <div className="mt-1 text-[11.5px] text-muted tabular-nums truncate">of {fmtAmount(limit)} limit</div>
            </>
          ) : availNow !== null ? <div className="text-[13.5px] text-ink tabular-nums">{fmtAmount(availNow)}</div> : null}
        </div>
        {/* R-686: what a card owes is in red; a card that owes nothing, and every other figure, is in ink. */}
        <div className={`text-right text-[17px] font-medium tabular-nums whitespace-nowrap ${credit && owed >= 0.005 ? "text-danger-ink" : "text-ink"}`}>
          {fmtAmount(credit || loan ? owed : a.balance)}
        </div>
        <div className="col-span-2 lg:col-span-1 flex items-center justify-end gap-3 min-w-0">
          {check.kind === "connection" && <StatusPill tone="danger">Reconnect</StatusPill>}
          {check.kind === "answer" && <StatusPill tone="danger">{check.count} to answer</StatusPill>}
          {check.kind === "match" && <span className={quiet} title="Your books and your bank agree on this account"><Check size={13} className="text-success" /> Matches the bank</span>}
          {check.kind === "checking" && <span className={quiet} title="The balance and the books differ, so every transaction is being checked against the bank"><RefreshCw size={12} className="animate-spin" /> Checking every transaction</span>}
          {check.kind === "waiting" && <span className={quiet} title="Every transaction is checked and nothing is left to answer. The bank's own balance has not caught up with its list yet."><Check size={13} className="text-success" /> Checked, bank catching up</span>}
          {check.kind === "unread" && <span className={quiet} title="The bank could not be read for this account just now. It is checked again by itself after the next bank pull.">Not checked yet</span>}
          {check.kind === "elsewhere" && <span className={quiet} title={`Your ${check.on} feeds this account from the bank and checks it there`}>Checked on your {check.on}</span>}
          {onStatement && (
            <button onClick={onStatement} className="ui-link !text-[12.5px]" title="Every transaction with the balance after it, to hold against your bank">
              Statement
            </button>
          )}
          {onEdit && (
            <button onClick={onEdit} title={`Change how this ${credit ? "card" : "account"} looks`} aria-label={`Change how this ${credit ? "card" : "account"} looks`}
              className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-muted hover:text-ink hover:bg-surface-2 transition-colors duration-[130ms]">
              <Palette size={14} />
            </button>
          )}
        </div>
      </div>
      {check.kind === "connection" && (
        <div className="mt-2 text-[12.5px] text-danger-ink flex items-baseline gap-3 flex-wrap">
          <span>The bank connection needs fixing, so this account cannot be checked and its balance may be old.</span>
          {onFix && <button onClick={onFix} className="ui-link !text-[12.5px]">Fix it</button>}
        </div>
      )}
      {check.kind === "answer" && (
        <div className="mt-2 text-[12.5px] text-danger-ink">
          Every transaction on this account was checked against your bank. {check.count === 1 ? "This one needs" : `These ${check.count} need`} your answer; the rest match.
        </div>
      )}
      {children}
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

/** Change how one account looks. A credit card picks a finish (platinum, gold and the rest, or a colour of his own);
 *  every account picks its logo (from the bank's website, from a picture, or the bank's own). Each change is saved as
 *  it is made, with the account shown live. */
function LookEditor({ a, mine, brand, onSaved, onClose }: {
  a: BankBalance; mine: AccountLook | undefined; brand: BankBrand | undefined;
  onSaved: (looks: Record<string, AccountLook>) => void; onClose: () => void;
}) {
  const [site, setSite] = useState(mine?.site ?? "");
  const [busy, setBusy] = useState<"" | "site" | "file" | "art" | "save">("");
  const file = useRef<HTMLInputElement>(null);
  const artFile = useRef<HTMLInputElement>(null);
  const credit = a.type === "credit";
  const look = lookOf(a, mine, brand);
  const plain = credit && !look.finish;

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
  const fromFile = async (f: File | undefined, what: "logo" | "art" = "logo") => {
    if (!f) return;
    try { await save(what === "art" ? { art: await readFile(f) } : { logo: await readFile(f) }, what === "art" ? "art" : "file"); }
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
  const finishBtn = (id: string, name: string, background: string, on: boolean) => (
    <button key={id} onClick={() => save({ finish: id })} aria-pressed={on} className="group text-left min-w-0">
      <div className={`aspect-[1.586/1] rounded-md ring-1 ring-black/10 transition-transform duration-[130ms] group-hover:scale-[1.04] ${on ? "outline outline-2 outline-offset-2 outline-ink" : ""}`}
        style={{ background }} />
      <div className={`mt-1.5 text-[11.5px] truncate ${on ? "text-ink font-medium" : "text-muted"}`}>{name}</div>
    </button>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`${a.name} look`}
        className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-4 border-b border-line">
          <h2 className="text-[16px] font-semibold text-ink">{credit ? "Card look" : "Account logo"}</h2>
          <p className="text-[12px] text-muted mt-0.5">{a.institution} {a.name}{a.mask ? ` ··${a.mask}` : ""}. Shows the same on every computer and your phone.</p>
        </div>
        <div className="p-5 space-y-5">
          {credit ? (
            <div className="flex justify-center"><CardArt a={a} look={look} big /></div>
          ) : (
            <div className="flex items-center gap-3.5">
              <BankLogo a={a} look={look} />
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-ink truncate">{a.name}</div>
                <div className="text-[12.5px] text-muted truncate">{a.institution || "Bank"}{a.mask ? ` ··${a.mask}` : ""}</div>
              </div>
            </div>
          )}

          {credit && (
            <section>
              <h3 className="text-[13px] font-medium text-ink mb-1">Picture of your card</h3>
              <p className="text-[12px] text-muted mb-2.5">For the card's real look, choose a picture of it: save the card's picture from your bank's website or app, or take a photo. It is cropped to the card's shape. Banks do not send a card's artwork, so it cannot be fetched for you.</p>
              <div className="flex items-center gap-4 flex-wrap">
                <Button size="sm" onClick={() => artFile.current?.click()} disabled={busy !== ""}>{busy === "art" ? "Saving" : look.art ? "Choose another picture" : "Choose a picture of the card"}</Button>
                <input ref={artFile} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" className="hidden"
                  onChange={(e) => { fromFile(e.target.files?.[0], "art"); e.target.value = ""; }} />
                {look.art && <button onClick={() => save({ art: "" })} className="ui-link muted !text-[12px]">Remove the picture</button>}
              </div>
            </section>
          )}

          {credit && !look.art && (
            <section>
              <h3 className="text-[13px] font-medium text-ink mb-1">Finish</h3>
              <p className="text-[12px] text-muted mb-2.5">Picked from the card's name until you choose one. These are finishes, not the bank's own artwork.</p>
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-x-3 gap-y-3">
                {CARD_FINISHES.map((f) => finishBtn(f.id, f.name, f.background, look.finish?.id === f.id))}
                {finishBtn("plain", "My colour", `linear-gradient(135deg, ${look.color} 0%, color-mix(in srgb, ${look.color} 70%, black) 100%)`, plain)}
              </div>
              {mine?.finish && <button onClick={() => save({ finish: "" })} className="ui-link muted mt-2.5 !text-[12px]">Pick it from the card's name</button>}
            </section>
          )}

          {plain && !look.art && (
            <section>
              <h3 className="text-[13px] font-medium text-ink mb-2">Colour</h3>
              <div className="flex flex-wrap items-center gap-2.5">
                {brand?.color && swatch(brand.color, "The bank's own colour")}
                {CARD_COLOURS.map((c) => swatch(c.hex, c.name))}
                <label className="w-8 h-8 rounded-full ring-1 ring-line-3 flex items-center justify-center cursor-pointer relative overflow-hidden"
                  title="Any colour" style={{ background: `conic-gradient(${CARD_COLOURS.slice(0, 8).map((c) => c.hex).concat(CARD_COLOURS[0].hex).join(", ")})` }}>
                  <input type="color" value={look.color} onChange={(e) => save({ color: e.target.value })}
                    className="absolute inset-0 opacity-0 cursor-pointer" aria-label="Any colour" />
                </label>
              </div>
              {mine?.color && <button onClick={() => save({ color: "" })} className="ui-link muted mt-2 !text-[12px]">Use the bank's colour</button>}
            </section>
          )}

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

export default function AccountsView({ onOpenRow, onFix, onChanged }: {
  onOpenRow?: (id: string, amount: number) => void;
  onFix?: () => void;
  /** R-685: a check changed the books, so the rest of Financials reads again. */
  onChanged?: () => void;
}) {
  const [statement, setStatement] = useState<BankBalance | null>(null);
  const [editing, setEditing] = useState<BankBalance | null>(null);
  const [accounts, setAccounts] = useState<BankBalance[] | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [brands, setBrands] = useState<Record<string, BankBrand>>({});
  const [looks, setLooks] = useState<Record<string, AccountLook>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [checking, setChecking] = useState(false);
  // R-688: what is waiting on his answer, read again whenever the accounts are.
  const [needsKey, setNeedsKey] = useState(0);
  const needs = useNeedsYou(needsKey);
  // R-688: the state the automatic check last ran for, so one state is checked once and not on every re-read.
  const auto = useRef("");

  const load = () => {
    api.bankBalances().then((r) => { setAccounts(r.accounts); setLastSync(r.last_sync); }).catch(() => setAccounts([]));
    api.accountLooks().then(setLooks).catch(() => {});
    setNeedsKey((k) => k + 1);
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

  // Read every posted transaction from the banks and put the books right (`check_against_bank`). Run by itself
  // (R-688) it speaks only when it changed something or left something for him; pressed, it always says what it did.
  const checkBank = async (byItself = false) => {
    setChecking(true);
    try {
      const c = await api.checkAgainstBank();
      const changed = Object.entries(c.fixed ?? {}).some(([k, v]) => k !== "agreed" && Number(v) > 0);
      if (!byItself || changed || (c.missing || 0) + (c.differs || 0) + (c.not_at_bank || 0) > 0) toast(checkSentence(c), "success");
      onChanged?.();
    } catch (e: unknown) {
      if (!byItself) toast(typeof e === "string" ? e : (e as Error)?.message || "The banks could not be read", "error");
    } finally {
      setChecking(false);
      load();
    }
  };

  const list = accounts ?? [];
  const cash = list.filter((a) => a.type === "depository").reduce((s, a) => s + a.balance, 0);
  const owed = list.filter((a) => a.type === "credit").reduce((s, a) => s + Math.abs(a.balance), 0);
  // R-688: each account's waiting transactions, and the accounts whose balance and books differ with nothing left to
  // answer: unchecked in this state, or checked with every answer now given. Those are checked without a click.
  const todo = (a: BankBalance) => needsOnAccount(needs, a.label, a.mask);
  const off = (a: BankBalance) => a.drift != null && Math.abs(a.drift) >= 0.005 && !a.needs_fix;
  const stale = list.filter((a) => off(a) && todo(a).items.length === 0)
    .map((a) => `${a.key}:${a.balance}:${a.drift}:${a.ledger_rows}:${a.checked ? 1 : 0}`).join("|");
  useEffect(() => {
    if (!stale || checking || auto.current === stale) return;
    auto.current = stale;
    checkBank(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale, checking]);
  const verdict = (a: BankBalance) => accountCheck(a, todo(a).items.length, checking, auto.current === stale);
  const issues = list.filter((a) => needsALook(verdict(a))).length;
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
          <p className="ui-note mt-0.5">Every business account and card your banks send, with what each holds or owes now. Each one is checked against your bank, transaction by transaction, by itself.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button onClick={() => checkBank()} disabled={checking}
            title="This runs by itself whenever an account does not match. Press it to read every posted transaction from your banks again now.">
            <ListChecks size={14} /> {checking ? "Checking against the bank" : "Check against bank"}
          </Button>
          <Button onClick={refresh} disabled={refreshing} title="Asks each bank for its latest balance">
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} /> Refresh from banks
          </Button>
        </div>
      </div>
      <div className="hsep" />
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] xl:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] gap-x-6 gap-y-4 py-4">
        {figures.map(([label, value, sub], i) => (
          <Fragment key={label}>
            {i > 0 && <div className={`vsep ${i === 2 ? "hidden xl:block" : "hidden sm:block"}`} />}
            <div className="min-w-0">
              <div className="ui-label">{label}</div>
              <div className={`ui-fig mt-1 tabular-nums truncate ${i === 1 && owed >= 0.005 ? "text-danger-ink" : ""}`}>{value}</div>
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
          <section key={g.id} className="pt-6">
            <div className={`${COLS} pb-2.5`}>
              <h4 className="text-[14px] font-medium text-ink">
                {g.title} <span className="text-muted font-normal tabular-nums">{rows.length}</span>
              </h4>
              <div className="hidden lg:block ui-label text-right">Available</div>
              <div className="ui-label text-right">{g.figure}</div>
              <div className="hidden lg:block" />
            </div>
            {rows.map((a) => {
              const check = verdict(a);
              return (
                <AccountRow key={a.key} a={a} look={lookOf(a, looks[a.key], a.item ? brands[a.item] : undefined)}
                  check={check} onFix={onFix} onEdit={() => setEditing(a)}
                  onStatement={a.type === "depository" || a.type === "credit" ? () => setStatement(a) : undefined}>
                  {check.kind === "answer" && (
                    <div className="mt-3">
                      <NeedsYou inline data={todo(a)} onChanged={() => { load(); onChanged?.(); }} />
                    </div>
                  )}
                </AccountRow>
              );
            })}
            <div className="border-t border-line" />
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
