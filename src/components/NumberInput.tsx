import { useState, type InputHTMLAttributes } from "react";
import { parseAmount, parseCount } from "../lib/format";

/**
 * A number field you can paste into (R-206).
 *
 * `<input type="number">` refuses a value it cannot parse, so pasting "1,234.56"
 * left the element in bad-input state and every handler read `e.target.value` as
 * the empty string — which `parseFloat("") || 0` then stored as **0**. This box is
 * a text input, so the paste survives, and it keeps the raw text while it is being
 * edited: a controlled input backed by a NUMBER would otherwise erase the "." the
 * moment you typed it, because React rewrites the node whenever it disagrees with
 * the value prop.
 *
 * `value` takes exactly what the old `value={qty || ""}` passed, so an empty box
 * stays an empty box. `onValue` reports the parsed figure and the raw text, for the
 * callers that need to tell "cleared" apart from "zero".
 */
type Base = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "step" | "min" | "max">;

export interface NumberInputProps extends Base {
  value: number | string | null | undefined;
  onValue: (n: number, raw: string) => void;
  /** Whole numbers only — quantities, pallets, ports, days. */
  integer?: boolean;
}

export default function NumberInput({ value, onValue, integer, onBlur, ...rest }: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...rest}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      value={draft ?? (value == null ? "" : String(value))}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        onValue(integer ? parseCount(raw) : parseAmount(raw), raw);
      }}
      onBlur={(e) => { setDraft(null); onBlur?.(e); }}
    />
  );
}
