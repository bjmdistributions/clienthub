import { useEffect, useState, useRef } from "react";
import { api, LotMediaFiles } from "../lib/api";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowLeft, Copy, Check, Image, FileText, Eye, RefreshCw, X } from "lucide-react";

interface Props {
  lotIds: string[];
  onClose: () => void;
  mediaBase: string;
}

const isAbsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
const resolvePhoto = (p: string, base: string) => (isAbsPath(p) || !base) ? p : `${base}/${p}`;

export default function WhatsAppSharePanel({ lotIds, onClose, mediaBase }: Props) {
  const [message, setMessage] = useState("");
  const [mediaFiles, setMediaFiles] = useState<LotMediaFiles | null>(null);
  const [copied, setCopied] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const webviewRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    (async () => {
      const [msg, files] = await Promise.all([
        api.generateWhatsappMessage(lotIds),
        api.getLotMediaFiles(lotIds),
      ]);
      setMessage(msg);
      setMediaFiles(files);
      try { await navigator.clipboard.writeText(msg); setCopied(true); } catch {}
    })();
  }, []);

  useEffect(() => {
    if (copied) {
      const t = setTimeout(() => setCopied(false), 3000);
      return () => clearTimeout(t);
    }
  }, [copied]);

  const copyAgain = async () => {
    try { await navigator.clipboard.writeText(message); setCopied(true); } catch {}
  };

  const regenerate = async () => {
    const msg = await api.generateWhatsappMessage(lotIds);
    setMessage(msg);
    try { await navigator.clipboard.writeText(msg); setCopied(true); } catch {}
  };

  const previewFile = (path: string, isImage: boolean) => {
    if (isImage) {
      setPreviewImage(path);
    } else {
      window.open(convertFileSrc(path), "_blank");
    }
  };

  const allFiles = mediaFiles ? [...mediaFiles.photos, ...mediaFiles.manifests] : [];

  return (
    <div className="fixed inset-0 z-50 bg-[#111] flex flex-col">
      {/* Top bar */}
      <div className="h-12 bg-[#1a1a1a] flex items-center px-4 gap-4 border-b border-[#333] flex-shrink-0">
        <button onClick={() => { setPreviewImage(null); onClose(); }}
          className="flex items-center gap-1.5 text-[13px] text-gray-400 hover:text-white transition-colors">
          <ArrowLeft size={15} /> Back to Inventory
        </button>
        <span className="text-[14px] font-semibold text-white">Share to WhatsApp</span>
      </div>

      {/* Main split */}
      <div className="flex-1 flex min-h-0">
        {/* Left panel */}
        <div className="w-[420px] flex-shrink-0 bg-[#1a1a1a] border-r border-[#333] p-4 flex flex-col gap-4 overflow-y-auto">
          {/* Message */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">📋 Message</span>
              <button onClick={regenerate} className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-300">
                <RefreshCw size={11} /> Regenerate
              </button>
            </div>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full h-[200px] bg-[#111] border border-[#333] rounded-lg p-3 text-[13px] text-gray-200 font-mono resize-none focus:outline-none focus:border-indigo-500/50"
            />
            <button onClick={copyAgain}
              className={`flex items-center gap-1.5 mt-2 text-[12px] font-medium px-3 py-1.5 rounded-md transition-colors ${copied ? "bg-emerald-600/20 text-emerald-400" : "bg-indigo-600 text-white hover:bg-indigo-500"}`}>
              {copied ? <><Check size={13} /> Copied!</> : <><Copy size={13} /> Copy Again</>}
            </button>
          </div>

          {/* Files */}
          <div>
            <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">📎 Files ({allFiles.length})</span>
            <div className="space-y-1 mt-2">
              {allFiles.length === 0 ? (
                <p className="text-[12px] text-gray-600 italic">No files. Add photos or manifests to lots first.</p>
              ) : (
                allFiles.map((f, i) => {
                  const isImg = /\.(png|jpg|jpeg|webp|gif)$/i.test(f.path);
                  const fname = f.path.split(/[/\\]/).pop() || f.path;
                  return (
                    <div key={i} className="flex items-center gap-2 bg-[#111] rounded-lg px-3 py-2">
                      {isImg ? <Image size={14} className="text-indigo-400 flex-shrink-0" /> : <FileText size={14} className="text-violet-400 flex-shrink-0" />}
                      <span className="text-[12px] text-gray-300 truncate flex-1" title={f.path}>{fname}</span>
                      <span className="text-[10px] text-gray-500 flex-shrink-0">{f.lot_name}</span>
                      <button onClick={() => previewFile(f.path, isImg)} className="text-gray-500 hover:text-white p-1">
                        <Eye size={13} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Steps */}
          <div>
            <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">📋 Steps</span>
            <div className="space-y-1.5 mt-2 text-[12px] text-gray-400">
              <div className="flex items-center gap-2"><span className="text-emerald-500">✅</span> Message copied to clipboard</div>
              <div>2. Open your WhatsApp group chat</div>
              <div>3. Paste the message (Ctrl+V)</div>
              <div>4. Drag the files into the chat</div>
              <div>5. Click Send</div>
            </div>
          </div>
        </div>

        {/* Right panel — WhatsApp Web */}
        <div className="flex-1 min-w-0 bg-[#0d0d0d]">
          <iframe
            ref={webviewRef}
            src="https://web.whatsapp.com"
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            allow="camera; microphone"
          />
        </div>
      </div>

      {/* Photo preview lightbox */}
      {previewImage && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90" onClick={() => setPreviewImage(null)}>
          <button onClick={() => setPreviewImage(null)} className="absolute top-4 right-4 text-white/70 hover:text-white p-2"><X size={24} /></button>
          <img src={convertFileSrc(resolvePhoto(previewImage, mediaBase))} alt="" className="max-w-[90vw] max-h-[90vh] object-contain" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}