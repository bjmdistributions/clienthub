import { useEffect, useState } from "react";
import { api, FromOption } from "../lib/api";

/* R-194: a compose-time "send from" dropdown. Desktop routes From by message type
 * (invoices vs everything else) since v0.16.34, but that's a fixed default, not a
 * choice — this lets whoever's sending pick among the addresses actually configured
 * in Settings → Email, right where they click Send.
 *
 * Renders nothing when the account has fewer than two configured addresses: with
 * only one there is no real choice, and showing a single-option dropdown would just
 * be noise on every send surface.
 */
export function useSendFromOptions(): FromOption[] {
  const [options, setOptions] = useState<FromOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.getSendFromOptions().then((o) => { if (!cancelled) setOptions(o); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return options;
}

/**
 * The address a send actually goes out as when the picker is left untouched, mirroring
 * email.rs's precedence chains: invoice sends (send_invoice_mail) prefer from_invoices,
 * then from_email, then the SMTP login; every other send (send_threaded directly — quotes,
 * replies, drafts, newsletters) skips from_invoices and prefers from_email, then the login.
 */
export function defaultSendFrom(options: FromOption[], forInvoice?: boolean): string | undefined {
  if (options.length === 0) return undefined;
  const byKind = (kind: FromOption["kind"]) => options.find((o) => o.kind === kind)?.address;
  const address = forInvoice
    ? byKind("invoices") ?? byKind("sales") ?? byKind("login")
    : byKind("sales") ?? byKind("login");
  return address ?? options[0].address;
}

export function FromPicker({
  options,
  value,
  onChange,
  className,
  forInvoice,
}: {
  options: FromOption[];
  value: string | undefined;
  onChange: (address: string) => void;
  className?: string;
  forInvoice?: boolean;
}) {
  if (options.length < 2) return null;
  return (
    <label className={`flex items-center gap-2 text-[12.5px] text-ink-2 ${className ?? ""}`}>
      <span className="text-muted">Send from</span>
      <select
        value={value ?? defaultSendFrom(options, forInvoice)}
        onChange={(e) => onChange(e.target.value)}
        className="border border-line px-2.5 h-8 rounded-md text-[12.5px] bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
      >
        {options.map((o) => (
          <option key={o.address} value={o.address}>{o.label} · {o.address}</option>
        ))}
      </select>
    </label>
  );
}
