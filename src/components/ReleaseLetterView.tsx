import { useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { Eraser, Loader2, FileDown } from "lucide-react";
import { Button, PageActions } from "./ui";
import { toast } from "./Toast";

const DEFAULT_BODY = `This letter confirms that {SELLER} agrees to sell and release a bulk closeout lot of branded merchandise to {BUYER}.

The inventory consists of {DESCRIPTION}, sold as part of a final closeout.

All merchandise is being sold as-is, where-is, with no warranties or guarantees expressed or implied. Upon receipt of full payment and transfer of goods, {SELLER} releases all responsibility related to the inventory.

Once the transaction is completed, the buyer assumes full responsibility for the goods, including handling, resale, and distribution.

Please confirm your acceptance of these terms by signing below.`;

const INPUT_CLASS =
  "w-full border border-line-3 bg-transparent px-3 h-10 rounded-lg text-[13.5px] text-ink placeholder:text-faint focus:outline-none focus:border-ink transition-colors duration-150";

export default function ReleaseLetterView() {
  const [buyerName, setBuyerName] = useState("");
  const [buyerCompany, setBuyerCompany] = useState("");
  const [description, setDescription] = useState("");
  const [letterDate, setLetterDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sellerName, setSellerName] = useState("");
  const [body, setBody] = useState(DEFAULT_BODY);
  const [working, setWorking] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [hasSignature, setHasSignature] = useState(false);

  // Canvas pixels per CSS pixel — the canvas is a fixed 600x180 bitmap stretched to
  // the card width, so pointer coords have to be scaled back into bitmap space.
  const pointFrom = (clientX: number, clientY: number) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * c.width, y: ((clientY - r.top) / r.height) * c.height };
  };

  const strokeTo = (clientX: number, clientY: number) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const { x, y } = pointFrom(clientX, clientY);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const startStroke = (clientX: number, clientY: number) => {
    const ctx = canvasRef.current!.getContext("2d")!;
    const { x, y } = pointFrom(clientX, clientY);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
    ctx.beginPath();
    ctx.moveTo(x, y);
    drawing.current = true;
    setHasSignature(true);
  };

  const clearSignature = () => {
    const c = canvasRef.current;
    if (!c) return;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setHasSignature(false);
  };

  const download = async () => {
    if (working) return;
    const path = await saveDialog({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      defaultPath: "release-letter.pdf",
    });
    if (!path) return;
    setWorking(true);
    try {
      await api.generateReleaseLetter({
        buyer_name: buyerName.trim(),
        buyer_company: buyerCompany.trim(),
        description: description.trim(),
        letter_date: letterDate,
        seller_name: sellerName.trim(),
        body,
        signature_png: hasSignature ? canvasRef.current!.toDataURL("image/png") : null,
        output_path: path as string,
      });
      toast("Release letter saved");
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="max-w-[820px] space-y-6">
      <PageActions>
        <Button variant="ink" onClick={download} disabled={working}
          icon={working ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />}>
          {working ? "Saving..." : "Download PDF"}
        </Button>
      </PageActions>

      {/* Header */}
      <div className="min-w-0">
        <div className="text-[16px] font-medium text-ink">Release letter</div>
        <p className="text-[13px] text-muted mt-0.5 leading-relaxed max-w-[640px]">
          Fill in the deal, sign it, and download a merchandise release &amp; closeout
          authorization letter on your own letterhead.
        </p>
      </div>

      <div className="hsep" />

      {/* Details */}
      <div className="space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-1.5 min-w-0">
            <label className="block text-[12px] font-medium text-muted">Buyer name</label>
            <input
              value={buyerName}
              onChange={(e) => setBuyerName(e.target.value)}
              placeholder="Jane Doe"
              className={INPUT_CLASS}
            />
          </div>
          <div className="space-y-1.5 min-w-0">
            <label className="block text-[12px] font-medium text-muted">Buyer company</label>
            <input
              value={buyerCompany}
              onChange={(e) => setBuyerCompany(e.target.value)}
              placeholder="Acme Retail Co."
              className={INPUT_CLASS}
            />
          </div>
          <div className="space-y-1.5 min-w-0">
            <label className="block text-[12px] font-medium text-muted">Date</label>
            <input
              type="date"
              value={letterDate}
              onChange={(e) => setLetterDate(e.target.value)}
              className={INPUT_CLASS}
            />
          </div>
          <div className="space-y-1.5 min-w-0">
            <label className="block text-[12px] font-medium text-muted">Signer name</label>
            <input
              value={sellerName}
              onChange={(e) => setSellerName(e.target.value)}
              placeholder="Your name"
              className={INPUT_CLASS}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="block text-[12px] font-medium text-muted">Merchandise description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="1,200 units of assorted branded apparel"
            className={INPUT_CLASS}
          />
        </div>
      </div>

      <div className="hsep" />

      {/* Letter body */}
      <div className="space-y-2.5">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <label className="text-[14px] font-medium text-ink">Letter body</label>
          <span className="text-[12px] text-faint">
            {"{BUYER}"}, {"{SELLER}"} and {"{DESCRIPTION}"} are filled in from the fields above.
          </span>
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          className="w-full border border-line-3 bg-transparent px-3 py-2.5 rounded-lg text-[13px] text-ink leading-relaxed focus:outline-none focus:border-ink transition-colors duration-150 resize-y"
        />
      </div>

      <div className="hsep" />

      {/* Signature */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <label className="text-[14px] font-medium text-ink">Signature</label>
          <button
            onClick={clearSignature}
            disabled={!hasSignature}
            className="ui-btn ui-btn-sm"
          >
            <Eraser size={14} /> Clear
          </button>
        </div>
        {/* The pad is always paper-coloured: the pen is dark ink and the PNG prints on a white page, so a themed
            (dark) pad would hide the signature while it is drawn. */}
        <canvas
          ref={canvasRef}
          width={600}
          height={180}
          onMouseDown={(e) => startStroke(e.clientX, e.clientY)}
          onMouseMove={(e) => strokeTo(e.clientX, e.clientY)}
          onMouseUp={() => (drawing.current = false)}
          onMouseLeave={() => (drawing.current = false)}
          onTouchStart={(e) => {
            e.preventDefault();
            startStroke(e.touches[0].clientX, e.touches[0].clientY);
          }}
          onTouchMove={(e) => {
            e.preventDefault();
            strokeTo(e.touches[0].clientX, e.touches[0].clientY);
          }}
          onTouchEnd={() => (drawing.current = false)}
          style={{ background: "rgb(250 250 249)" }}
          className="w-full h-[180px] rounded-lg border border-line-3 cursor-crosshair touch-none"
        />
        <p className="text-[12px] text-muted">Draw your signature above. It prints over the signature line.</p>
      </div>
    </div>
  );
}
