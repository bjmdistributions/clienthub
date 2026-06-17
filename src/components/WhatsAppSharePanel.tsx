import { useEffect, useRef, useState } from "react";
import { api, Lot } from "../lib/api";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import {
  ArrowLeft, Copy, Check, FileText, RefreshCw, X,
  FolderOpen, Plus, AlertCircle, MessageCircle, WifiOff, GripVertical,
} from "lucide-react";

interface Props {
  lotIds: string[];
  onClose: () => void;
  mediaBase: string;
}

const isAbsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
const resolvePhoto = (p: string, base: string) => (isAbsPath(p) || !base) ? p : `${base}/${p}`;
const parsePhotos = (lot: Lot): string[] => { try { return JSON.parse(lot.photos_json || "[]") ?? []; } catch { return []; } };

export default function WhatsAppSharePanel({ lotIds, onClose, mediaBase }: Props) {
  const [message, setMessage] = useState("");
  const [lots, setLots] = useState<Lot[]>([]);
  const [copied, setCopied] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [busyLot, setBusyLot] = useState<string | null>(null);
  const [wa, setWa] = useState<"checking" | "open" | "offline">("checking");
  const paneRef = useRef<HTMLDivElement>(null);
  const waRef = useRef(wa);
  waRef.current = wa;

  const copy = async (text: string) => {
    try { await writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch {}
  };

  const loadAll = async () => {
    const [msg, all] = await Promise.all([
      api.generateWhatsappMessage(lotIds),
      api.listInventory(),
    ]);
    setMessage(msg);
    setLots(all.filter((l) => lotIds.includes(l.id)));
    return msg;
  };

  // Pin the embedded WhatsApp webview to the right pane (logical/CSS px). When
  // `hidden`, it's parked off-screen so HTML overlays (the photo lightbox) show.
  const syncEmbed = (hidden = false) => {
    const el = paneRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = hidden ? -100000 : r.left;
    api.whatsappEmbedShow(x, r.top, r.width, r.height).catch(() => {});
  };

  // Embed WhatsApp Web inside the right pane. Check reachability first so we can
  // show a clean offline state instead of a blank webview.
  const openWhatsApp = async () => {
    setWa("checking");
    try {
      const ok = await api.whatsappWebReachable();
      if (!ok) { setWa("offline"); return; }
      setWa("open");
      requestAnimationFrame(() => syncEmbed());
    } catch { setWa("offline"); }
  };

  useEffect(() => {
    loadAll().then((msg) => copy(msg));
    openWhatsApp();
    return () => { api.whatsappEmbedClose().catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the embedded webview pinned to the pane as the window/layout resizes.
  useEffect(() => {
    if (wa !== "open") return;
    const onResize = () => { if (waRef.current === "open") syncEmbed(!!previewImage); };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    if (paneRef.current) ro.observe(paneRef.current);
    return () => { window.removeEventListener("resize", onResize); ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wa]);

  // Park the webview off-screen while the lightbox is up so it isn't covered.
  useEffect(() => {
    if (wa === "open") syncEmbed(!!previewImage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewImage]);

  const close = () => { api.whatsappEmbedClose().catch(() => {}); onClose(); };

  const regenerate = async () => { const msg = await loadAll(); copy(msg); };

  // Start a native OS file-drag so the file can be dropped straight onto the
  // embedded WhatsApp chat (which accepts file drops just like a browser).
  const dragFile = async (e: React.DragEvent, fsPath: string, iconPath?: string) => {
    e.preventDefault();
    try { await startDrag({ item: [fsPath], icon: iconPath || fsPath }); } catch {}
  };

  const addPhotos = async (lot: Lot) => {
    const f = await openDialog({ multiple: true, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    const picked = Array.isArray(f) ? f : (typeof f === "string" ? [f] : []);
    if (picked.length === 0) return;
    setBusyLot(lot.id);
    try {
      const rel = await api.importLotPhotos(lot.id, picked);
      await api.updateLot(lot.id, { photos: [...parsePhotos(lot), ...rel] });
      await loadAll();
    } catch (e: any) { alert(e); }
    setBusyLot(null);
  };

  const addManifest = async (lot: Lot) => {
    const f = await openDialog({ multiple: false, filters: [{ name: "Manifest", extensions: ["pdf", "csv", "xlsx", "xls"] }] });
    if (typeof f !== "string") return;
    setBusyLot(lot.id);
    try { await api.attachLotManifest(lot.id, f); await loadAll(); } catch (e: any) { alert(e); }
    setBusyLot(null);
  };

  const openFolder = (lot: Lot) => api.openLotFolder(lot.id).catch((e: any) => alert(e));

  const missingMedia = lots.filter((l) => parsePhotos(l).length === 0 || !l.manifest_path);

  const btn = "flex items-center gap-1 text-[11px] font-medium px-2 h-7 rounded-md border transition-colors";
  const btnQuiet = `${btn} text-[var(--t-tx2)]`;
  const fileName = (p: string) => p.split(/[/\\]/).pop() || p;

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "var(--t-bg)" }}>
      {/* Top bar */}
      <div className="h-12 flex items-center px-4 gap-4 flex-shrink-0" style={{ background: "var(--t-s1)", borderBottom: "1px solid var(--t-b1)" }}>
        <button onClick={close} className="flex items-center gap-1.5 text-[13px] transition-colors" style={{ color: "var(--t-tx3)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--t-tx1)")} onMouseLeave={(e) => (e.currentTarget.style.color = "var(--t-tx3)")}>
          <ArrowLeft size={15} /> Back to Inventory
        </button>
        <span className="text-[14px] font-semibold" style={{ color: "var(--t-tx1)" }}>Share to WhatsApp</span>
        <span className="text-[12px]" style={{ color: "var(--t-tx4)" }}>· {lots.length} lot{lots.length !== 1 ? "s" : ""}</span>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Left control panel */}
        <div className="w-[440px] flex-shrink-0 overflow-y-auto p-5 flex flex-col gap-6" style={{ background: "var(--t-s1)", borderRight: "1px solid var(--t-b1)" }}>

          {/* Message */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--t-tx4)" }}>Message</span>
              <button onClick={regenerate} className="flex items-center gap-1 text-[11px]" style={{ color: "var(--t-tx3)" }}>
                <RefreshCw size={11} /> Regenerate
              </button>
            </div>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} spellCheck={false}
              className="w-full h-[180px] rounded-lg p-3 text-[13px] font-mono resize-none focus:outline-none focus:ring-2 focus:ring-accent/30"
              style={{ background: "var(--t-input-bg)", border: "1px solid var(--t-input-border)", color: "var(--t-tx1)" }} />
            <button onClick={() => copy(message)}
              className={`flex items-center gap-1.5 mt-2 text-[12px] font-medium px-3 h-8 rounded-md transition-colors ${copied ? "text-success-ink" : "text-white bg-accent hover:bg-accent-hover"}`}
              style={copied ? { background: "var(--t-s3)" } : undefined}>
              {copied ? <><Check size={13} /> Copied to clipboard</> : <><Copy size={13} /> Copy message</>}
            </button>
          </section>

          {/* Upload media — only surfaces when something is missing */}
          {missingMedia.length > 0 && (
            <section className="rounded-lg px-3 py-2.5 flex items-start gap-2" style={{ background: "var(--t-s2)", border: "1px solid var(--t-b1)" }}>
              <AlertCircle size={14} className="text-warning-ink flex-shrink-0 mt-0.5" />
              <p className="text-[12px]" style={{ color: "var(--t-tx2)" }}>
                {missingMedia.length} lot{missingMedia.length !== 1 ? "s are" : " is"} missing photos or a manifest. Add them below before sharing.
              </p>
            </section>
          )}

          {/* Files, grouped per lot */}
          <section>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--t-tx4)" }}>Files</span>
              <span className="flex items-center gap-1 text-[10px]" style={{ color: "var(--t-tx4)" }}><GripVertical size={11} /> drag into the chat →</span>
            </div>
            <div className="space-y-2.5 mt-2">
              {lots.map((lot) => {
                const photos = parsePhotos(lot);
                const hasManifest = !!lot.manifest_path;
                const busy = busyLot === lot.id;
                const firstAbs = photos.length ? resolvePhoto(photos[0], mediaBase) : undefined;
                return (
                  <div key={lot.id} className="rounded-lg p-3" style={{ background: "var(--t-s2)", border: "1px solid var(--t-b1)" }}>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[13px] font-medium truncate" style={{ color: "var(--t-tx1)" }}>{lot.name}</span>
                        {(photos.length === 0 || !hasManifest) && <span className="w-1.5 h-1.5 rounded-full bg-warning flex-shrink-0" title="Missing media" />}
                      </div>
                      <button onClick={() => openFolder(lot)} className={btnQuiet} style={{ borderColor: "var(--t-b1)" }} title="Open this lot's media folder">
                        <FolderOpen size={12} /> Folder
                      </button>
                    </div>

                    {/* Thumbnails / files — draggable straight into the chat */}
                    {(photos.length > 0 || hasManifest) && (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {photos.map((p, i) => (
                          <button key={i} onClick={() => setPreviewImage(p)} draggable
                            onDragStart={(e) => dragFile(e, resolvePhoto(p, mediaBase))}
                            className="w-11 h-11 rounded-md overflow-hidden flex-shrink-0 cursor-grab active:cursor-grabbing" style={{ border: "1px solid var(--t-b1)" }}
                            title="Click to preview · drag into the chat to attach">
                            <img src={convertFileSrc(resolvePhoto(p, mediaBase))} alt="" className="w-full h-full object-cover pointer-events-none" onError={(e) => ((e.target as HTMLImageElement).style.opacity = "0.2")} />
                          </button>
                        ))}
                        {hasManifest && (
                          <div draggable onDragStart={(e) => dragFile(e, resolvePhoto(lot.manifest_path || "", mediaBase), firstAbs)}
                            className="h-11 px-2 rounded-md flex items-center gap-1.5 flex-shrink-0 cursor-grab active:cursor-grabbing" style={{ border: "1px solid var(--t-b1)", background: "var(--t-s1)" }}
                            title="Drag into the chat to attach">
                            <FileText size={13} style={{ color: "var(--t-tx3)" }} />
                            <span className="text-[11px] truncate max-w-[90px]" style={{ color: "var(--t-tx3)" }}>{fileName(lot.manifest_path || "manifest")}</span>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex items-center gap-1.5">
                      <button onClick={() => addPhotos(lot)} disabled={busy} className={btnQuiet} style={{ borderColor: "var(--t-b1)" }}>
                        <Plus size={12} /> {photos.length === 0 ? "Add Photos" : "Photos"}
                      </button>
                      <button onClick={() => addManifest(lot)} disabled={busy} className={btnQuiet} style={{ borderColor: "var(--t-b1)" }}>
                        <Plus size={12} /> {hasManifest ? "Replace Manifest" : "Manifest"}
                      </button>
                      {busy && <RefreshCw size={12} className="animate-spin" style={{ color: "var(--t-tx4)" }} />}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Steps */}
          <section>
            <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--t-tx4)" }}>How to send</span>
            <ol className="space-y-1.5 mt-2 text-[12px]" style={{ color: "var(--t-tx3)" }}>
              <li className="flex items-center gap-2"><Check size={12} className="text-success-ink" /> Message copied to clipboard</li>
              <li>2. Open your group chat in the WhatsApp panel →</li>
              <li>3. Paste the message (Ctrl/Cmd + V)</li>
              <li>4. Drag the photos &amp; manifest above straight into the chat</li>
              <li>5. Send</li>
            </ol>
          </section>
        </div>

        {/* Right — embedded WhatsApp Web (a native webview is pinned over this pane) */}
        <div ref={paneRef} className="flex-1 min-w-0 relative" style={{ background: "var(--t-bg)" }}>
          {wa === "checking" && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <RefreshCw size={22} className="animate-spin mx-auto mb-3" style={{ color: "var(--t-tx4)" }} />
                <p className="text-[13px]" style={{ color: "var(--t-tx3)" }}>Loading WhatsApp Web…</p>
              </div>
            </div>
          )}
          {wa === "open" && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <MessageCircle size={22} className="mx-auto mb-2" style={{ color: "var(--t-tx4)" }} />
                <p className="text-[12px]" style={{ color: "var(--t-tx4)" }}>WhatsApp Web</p>
              </div>
            </div>
          )}
          {wa === "offline" && (
            <div className="absolute inset-0 flex items-center justify-center p-8">
              <div className="text-center max-w-sm">
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)" }}>
                  <WifiOff size={22} className="text-danger-ink" />
                </div>
                <p className="text-[15px] font-semibold mb-1" style={{ color: "var(--t-tx1)" }}>Unable to load WhatsApp Web</p>
                <p className="text-[13px] mb-4" style={{ color: "var(--t-tx3)" }}>Check your internet connection and try again.</p>
                <button onClick={openWhatsApp} className="flex items-center gap-1.5 mx-auto text-[12px] font-medium px-4 h-9 rounded-lg text-white bg-accent hover:bg-accent-hover transition-colors">
                  <RefreshCw size={13} /> Retry
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Photo lightbox */}
      {previewImage && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90" onClick={() => setPreviewImage(null)}>
          <button onClick={() => setPreviewImage(null)} className="absolute top-4 right-4 text-white/70 hover:text-white p-2"><X size={24} /></button>
          <img src={convertFileSrc(resolvePhoto(previewImage, mediaBase))} alt="" className="max-w-[90vw] max-h-[90vh] object-contain" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
