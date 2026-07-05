const SHORTCUTS = [
  { key: "Cmd/Ctrl + K", desc: "Open global search" },
  { key: "Cmd/Ctrl + N", desc: "New item (context-sensitive)" },
  { key: "Cmd/Ctrl + S", desc: "Save current form" },
  { key: "Cmd/Ctrl + ,", desc: "Open Settings" },
  { key: "Esc", desc: "Close current modal or palette" },
  { key: "?", desc: "Show this help dialog" },
  { key: "L", desc: "Toggle QuickLog" },
];

interface Props { onClose: () => void; }

export default function ShortcutsModal({ onClose }: Props) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-[2px]" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-xl w-[420px] max-w-[92vw] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-line flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-ink">Keyboard shortcuts</h2>
          <kbd className="text-[10px] text-muted bg-surface-3 px-1.5 py-0.5 rounded font-mono">?</kbd>
        </div>
        <div className="p-2">
          {SHORTCUTS.map(s => (
            <div key={s.key} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-surface-2">
              <span className="text-[13px] text-ink-2">{s.desc}</span>
              <kbd className="text-[11px] text-muted bg-surface-3 px-2 py-0.5 rounded font-mono">{s.key}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
