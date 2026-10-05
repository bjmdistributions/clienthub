import { openDealFlow } from "../lib/api";

/** A cost line's note. A resold line (R-435) names the other invoice; that name opens it.
 *  A buy-back line (R-442) reads "Bought back from <buyer> (refunded on INV-x)". */
export default function ResoldNote({ note }: { note: string }) {
  const m = /^(?:Resold: cost moved to |Resold from )([^:]+)/.exec(note) || /^Bought back from .*\(refunded on ([^)]+)\)/.exec(note);
  const other = m && m[1] !== "the other deal" ? m[1] : null;
  if (!other) return <div className="text-[11px] text-muted truncate" title={note}>{note}</div>;
  const [before, after] = note.split(other);
  return (
    <div className="text-[11px] text-muted truncate" title={`${note}. Goods refunded on one deal and sold again on another: the cost sits on the deal they were sold on. Undo it from the refunded deal's refund step.`}>
      {before}
      <button onClick={(e) => { e.stopPropagation(); openDealFlow(other, note.startsWith("Resold: cost moved to ") ? "supplier" : "refund"); }}
        className="text-accent hover:text-accent-hover underline underline-offset-2">{other}</button>
      {after}
    </div>
  );
}
