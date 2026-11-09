import { useEffect, useState } from "react";
import { api, ManifestAnalysis, ManifestReadOptions } from "../../lib/api";
import { fmtAmount } from "../../lib/format";
import { toast } from "../Toast";
import { fmtDay, num, S } from "./shared";

/** R-640: the currencies a sheet can be read in. */
const CURRENCIES: [string, string][] = [
  ["USD", "US dollars"], ["EUR", "Euros"], ["GBP", "British pounds"], ["CAD", "Canadian dollars"], ["MXN", "Mexican pesos"],
  ["CNY", "Chinese yuan"], ["HKD", "Hong Kong dollars"], ["JPY", "Japanese yen"], ["AUD", "Australian dollars"],
];

/**
 * R-640. The sheet's currency and its rate to dollars. With a rate the reader turns every money
 * cell into dollars, so every figure on the screen is dollars. A sheet found in another currency
 * gets today's European Central Bank rate on its first reading; Jack can type over it. The
 * converter turns a quote in that currency into dollars.
 */
export default function Currency({ analysis, options, canRead, busy, onReread, onAsk }: {
  analysis: ManifestAnalysis;
  options: ManifestReadOptions;
  canRead: boolean;
  busy: boolean;
  onReread: (patch: Partial<ManifestReadOptions>) => Promise<void>;
  onAsk: (v: string) => void;
}) {
  const code = options.currency || analysis.currency || "USD";
  const rate = options.fx_rate ?? null;
  const [rateText, setRateText] = useState(rate != null ? String(rate) : "");
  const [fetching, setFetching] = useState(false);
  const [amount, setAmount] = useState("");
  useEffect(() => { setRateText(rate != null ? String(rate) : ""); }, [rate]);

  const readIn = async (c: string) => {
    if (c === "USD") { await onReread({ currency: "USD", fx_rate: null, fx_date: null }); return; }
    setFetching(true);
    try {
      const r = await api.manifestFxRate(c);
      await onReread({ currency: c, fx_rate: r.rate, fx_date: r.date });
    } catch (e: any) {
      toast(String(e), "error");
      await onReread({ currency: c, fx_rate: null, fx_date: null });
    }
    setFetching(false);
  };

  // A sheet in another currency gets today's rate once, on its first reading.
  useEffect(() => {
    if (canRead && analysis.currency && options.currency == null) readIn(analysis.currency);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const typed = () => {
    const v = num(rateText);
    if (v == null || v <= 0) { toast("Type the rate as a number, like 1.12.", "error"); return; }
    if (v !== rate) onReread({ currency: code, fx_rate: v, fx_date: null });
  };

  const off = !canRead || busy || fetching;
  const amt = num(amount);
  const name = CURRENCIES.find(([c]) => c === code)?.[1] ?? code;

  return (
    <section className={`${S.card} space-y-2`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
          Prices on this sheet are in
          <select value={code} disabled={off} onChange={(e) => readIn(e.target.value)} className={`${S.input} pr-7`}>
            {CURRENCIES.map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
          </select>
        </label>
        {code !== "USD" && (
          <>
            <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
              1 {code} = $
              <input className={`${S.input} w-24`} value={rateText} disabled={off} placeholder="rate"
                onChange={(e) => setRateText(e.target.value)} onBlur={typed} onKeyDown={(e) => { if (e.key === "Enter") typed(); }} />
            </label>
            <button onClick={() => readIn(code)} disabled={off} className={S.btn}>{fetching ? "Getting the rate…" : "Today's rate"}</button>
          </>
        )}
      </div>
      {!canRead && <p className="text-[11.5px] text-muted">The original file is not on this computer, so the currency cannot be changed here.</p>}
      {code === "USD" && analysis.currency && options.currency === "USD" && (
        <p className="text-[11.5px] text-muted">The sheet looks like it is in {analysis.currency}. It is read as dollars because you chose US dollars.</p>
      )}
      {code !== "USD" && rate != null && (
        <p className="text-[11.5px] text-muted">
          Every figure below is in dollars at this rate. {options.fx_date ? `European Central Bank rate for ${fmtDay(`${options.fx_date}T12:00:00`)}.` : "You typed this rate."}
        </p>
      )}
      {code !== "USD" && rate == null && (
        <p className="text-[12px] text-danger-ink">The figures below are still in {name}, not dollars. Get today's rate or type the rate.</p>
      )}
      {code !== "USD" && rate != null && (
        <div className="flex flex-wrap items-center gap-2 pt-1 text-[12.5px] text-ink-2">
          <input className={`${S.input} w-32`} value={amount} placeholder={`Amount in ${code}`} onChange={(e) => setAmount(e.target.value)} />
          <span>{code} is</span>
          <span className="font-semibold text-ink tabular-nums">{amt != null ? fmtAmount(amt * rate) : "$0.00"}</span>
          {amt != null && amt > 0 && (
            <button onClick={() => { onAsk((amt * rate).toFixed(2)); toast("Asking price set in dollars."); }} className={S.btn}>Use as asking price</button>
          )}
        </div>
      )}
    </section>
  );
}
