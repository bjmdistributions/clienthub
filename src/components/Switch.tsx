// One switch for every on/off control. The knob is the surface colour with a hairline ring, never a
// white literal: a white knob vanishes on mono-dark's near-white accent track (gotcha 24, R-511 FD-21).
export default function Switch({ on, onToggle, label, disabled }: { on: boolean; onToggle: () => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button" onClick={onToggle} role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      className={`w-9 h-5 rounded-full relative transition-colors flex-shrink-0 disabled:opacity-50 ${on ? "bg-accent" : "bg-surface-3"}`}
    >
      <span className={`absolute top-0.5 left-0 w-4 h-4 rounded-full bg-surface ring-1 ring-ink/10 shadow-sm transition-transform ${on ? "translate-x-[18px]" : "translate-x-0.5"}`} />
    </button>
  );
}
