// One switch for every on/off control (R-583: the mockups' 40x24 track). The knob is the surface colour
// with a hairline ring, never a white literal: a white knob vanishes on mono-dark's near-white accent track
// (gotcha 24, R-511 FD-21). On = the accent (ink in Mono); off = the quiet track.
export default function Switch({ on, onToggle, label, disabled }: { on: boolean; onToggle: () => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button" onClick={onToggle} role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      className={`w-10 h-6 rounded-full relative flex-shrink-0 transition-colors duration-200 disabled:opacity-50 ${on ? "bg-accent" : "bg-line-3"}`}
    >
      <span className={`absolute top-[3px] left-[3px] w-[18px] h-[18px] rounded-full bg-surface ring-1 ring-ink/10 transition-transform duration-200 ${on ? "translate-x-4" : "translate-x-0"}`} />
    </button>
  );
}
