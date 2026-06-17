import { useState, useRef, useEffect } from "react";

const VARIABLES: { token: string; label: string }[] = [
  { token: "{first_name}", label: "Client's first name" },
  { token: "{full_name}", label: "Client's full name" },
  { token: "{company}", label: "Company name" },
  { token: "{city}", label: "City" },
  { token: "{invoice_number}", label: "Latest invoice number" },
  { token: "{amount_due}", label: "Latest unpaid total" },
  { token: "{due_date}", label: "Latest invoice due date" },
  { token: "{days_overdue}", label: "Days past due" },
  { token: "{last_order_date}", label: "Date of last completed invoice" },
  { token: "{tier}", label: "Buyer tier" },
];

interface VariablePickerProps {
  onSelect: (token: string) => void;
}

export default function VariablePicker({ onSelect }: VariablePickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-accent hover:text-indigo-800 font-medium bg-accent/10 px-2 py-0.5 rounded text-[12px]"
      >
        Variables ▾
      </button>
      {open && (
        <div className="absolute z-50 left-0 mt-1 w-[320px] bg-surface border border-line rounded-lg shadow-lg py-1">
          <div className="px-3 py-1.5 text-[10px] font-semibold text-muted uppercase tracking-widest border-b border-line">
            Insert Variable
          </div>
          {VARIABLES.map((v) => (
            <button
              key={v.token}
              type="button"
              className="w-full text-left px-3 py-1.5 hover:bg-accent/10 flex items-center gap-3 transition-colors"
              onClick={() => { onSelect(v.token); setOpen(false); }}
            >
              <code className="text-[12px] font-mono text-accent-hover whitespace-nowrap min-w-[140px]">{v.token}</code>
              <span className="text-[11px] text-muted">{v.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
