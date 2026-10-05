import { openDealFlow } from "../lib/api";

/** A cost line's note. A resold line (R-435) names the other invoice; that name opens it. */
export default function ResoldNote({ note }: { note: string }) {
  const m = /^(?:Resold: cost moved to |Resold from )([^:]+)/.exec(note);
  const other = m && m[1] !== "the other deal" ? m[1] : null;
  if (!other) return <div className="text-[11px] text-muted truncate" title={note}>{note}</div>;
  const [before, after] = note.split(other);
  return (
    <div className="text-[11px] text-muted truncate" title={`${note}. Goods refunded on one deal and sold again on another: the cost sits on the deal they were sold on. Undo it from the refunded deal's refund step.`}>
      {before}
      <button onClick={(e) => { e.stopPropagation(); openDealFlow(other, note.startsWith("Resold from ") ? "refund" : "supplier"); }}
        className="text-accent hover:text-accent-hover underline underline-offset-2">{other}</button>
      {after}
    </div>
  );
}
