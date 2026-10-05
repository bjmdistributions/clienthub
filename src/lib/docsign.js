// R-441 company documents: fill in a PDF form and sign it.
/* global window, document, Image, getComputedStyle */
//
// BYTE-IDENTICAL in two places: BUSINESS APP/src/lib/docsign.js (desktop, bundled by vite)
// and clienthub-api/www/docsign.js (phone, loaded as a module). Change both together.
// Plain DOM, no framework, no imports: each surface hands in its own copy of pdf-lib
// (PDFLib) and pdf.js (pdfjsLib).
//
//   openDocEditor({ bytes, filename, PDFLib, pdfjsLib, getSignature, drawSignature })
//     -> Promise<{ bytes: Uint8Array, signed: boolean } | null>   (null = closed without saving)
//   openSignaturePad() -> Promise<string | null>   (a transparent PNG data URL)
//
// The editor draws every page with pdf.js and lays a real input over each form field
// (from pdf-lib's widget rectangles), so you type straight onto the boxes. Signatures
// and free text are dragged into place. Saving writes the values into the form fields
// (still editable afterwards) and draws the signature and text onto the page.

const CSS = `
.dse-ov{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:var(--dse-bg);color:var(--dse-fg);font:inherit;font-size:14px}
.dse-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;padding-top:max(10px,env(safe-area-inset-top));border-bottom:1px solid var(--dse-line);flex-wrap:wrap}
.dse-title{font-weight:600;flex:1 1 160px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dse-btn{appearance:none;border:1px solid var(--dse-line);background:transparent;color:inherit;font:inherit;padding:7px 12px;border-radius:9px;cursor:pointer;white-space:nowrap}
.dse-btn:hover{background:var(--dse-soft)}
.dse-btn.pri{background:var(--dse-fg);color:var(--dse-bg);border-color:var(--dse-fg)}
.dse-btn:disabled{opacity:.5;cursor:default}
.dse-hint{padding:8px 14px;font-size:12.5px;opacity:.7;border-bottom:1px solid var(--dse-line)}
.dse-scroll{flex:1;overflow:auto;background:var(--dse-soft);padding:16px 10px 60px;-webkit-overflow-scrolling:touch}
.dse-page{position:relative;margin:0 auto 16px;box-shadow:0 1px 4px rgba(0,0,0,.18);background:#fff}
.dse-page canvas{display:block;width:100%;height:100%}
.dse-layer{position:absolute;inset:0}
/* !important throughout: the host app styles every input, and a dark-mode rule there outranks a class. */
.dse-f{position:absolute;box-sizing:border-box;border:0!important;margin:0!important;padding:0 2px!important;min-height:0!important;background:rgba(0,122,255,.10)!important;color:#111!important;font-family:Helvetica,Arial,sans-serif!important;line-height:1.15!important;outline:none;border-radius:2px!important;box-shadow:none!important}
.dse-f:focus{background:rgba(0,122,255,.18)!important;box-shadow:0 0 0 1.5px #007AFF!important}
textarea.dse-f{resize:none;line-height:1.15}
input[type=checkbox].dse-f,input[type=radio].dse-f{accent-color:#007AFF;background:transparent!important;cursor:pointer;-webkit-appearance:auto!important;appearance:auto!important}
.dse-sig{position:absolute;box-sizing:border-box;border:1.5px dashed #007AFF;background:rgba(0,122,255,.06);color:#007AFF;font-size:11px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:3px}
.dse-item{position:absolute;box-sizing:border-box;border:1.5px dashed transparent;touch-action:none;cursor:move}
.dse-item:hover,.dse-item.on{border-color:#007AFF}
.dse-item img{width:100%;height:100%;display:block;pointer-events:none;user-select:none;-webkit-user-drag:none}
.dse-item input{width:100%!important;height:100%!important;min-height:0!important;box-sizing:border-box;border:0!important;margin:0!important;border-radius:0!important;box-shadow:none!important;background:transparent!important;color:#111!important;font-family:Helvetica,Arial,sans-serif!important;outline:none;padding:0 2px!important;cursor:text}
.dse-x,.dse-rs{position:absolute;width:22px;height:22px;border-radius:50%;background:#007AFF;color:#fff;display:none;align-items:center;justify-content:center;font-size:14px;line-height:1;touch-action:none}
.dse-item.on .dse-x,.dse-item.on .dse-rs,.dse-item:hover .dse-x,.dse-item:hover .dse-rs{display:flex}
.dse-x{top:-11px;right:-11px;cursor:pointer}
.dse-rs{bottom:-11px;right:-11px;cursor:nwse-resize}
.dse-mask{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px}
.dse-card{background:var(--dse-bg);color:var(--dse-fg);border-radius:14px;padding:16px;width:min(560px,100%);box-shadow:0 10px 40px rgba(0,0,0,.3)}
.dse-card h3{margin:0 0 4px;font-size:16px;font-weight:600}
.dse-card p{margin:0 0 12px;font-size:12.5px;opacity:.7}
.dse-pad{width:100%;height:200px;max-width:100%;border:1px solid var(--dse-line);border-radius:10px;background:#fff;touch-action:none;display:block;cursor:crosshair}
.dse-row{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.dse-row .dse-btn:first-child{margin-right:auto}
`;

function ensureStyle() {
  if (document.getElementById("dse-style")) return;
  const s = document.createElement("style");
  s.id = "dse-style";
  s.textContent = CSS;
  document.head.appendChild(s);
}

// Follow whatever theme the host app is in: read the page's own colours.
function themeVars(el) {
  const cs = getComputedStyle(document.body);
  let bg = cs.backgroundColor;
  if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") bg = "Canvas";
  const fg = cs.color || "CanvasText";
  el.style.setProperty("--dse-bg", bg);
  el.style.setProperty("--dse-fg", fg);
  el.style.setProperty("--dse-line", "color-mix(in srgb, " + fg + " 16%, transparent)");
  el.style.setProperty("--dse-soft", "color-mix(in srgb, " + fg + " 6%, " + bg + ")");
}

function h(tag, attrs, kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of kids || []) el.appendChild(c);
  return el;
}

// pdf-lib's standard fonts only encode WinAnsi; anything else would throw at save.
function winAnsi(s) {
  return String(s || "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "");
}

function today() {
  const d = new Date();
  return String(d.getMonth() + 1).padStart(2, "0") + "/" + String(d.getDate()).padStart(2, "0") + "/" + d.getFullYear();
}

// ---------------------------------------------------------------- signature pad

export function openSignaturePad() {
  ensureStyle();
  return new Promise((resolve) => {
    const pad = h("canvas", { class: "dse-pad" });
    const done = (v) => { mask.remove(); resolve(v); };
    let drawn = false;
    const useBtn = h("button", { class: "dse-btn pri", text: "Use this signature", disabled: "" });
    useBtn.disabled = true;
    const card = h("div", { class: "dse-card" }, [
      h("h3", { text: "Draw your signature" }),
      h("p", { text: "Use your mouse, trackpad or finger. It is saved to your account so you only do this once." }),
      pad,
      h("div", { class: "dse-row" }, [
        h("button", { class: "dse-btn", text: "Clear", onclick: () => { ctx.clearRect(0, 0, pad.width, pad.height); drawn = false; useBtn.disabled = true; } }),
        h("button", { class: "dse-btn", text: "Cancel", onclick: () => done(null) }),
        useBtn,
      ]),
    ]);
    const mask = h("div", { class: "dse-mask" }, [card]);
    themeVars(mask);
    document.body.appendChild(mask);

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const r = pad.getBoundingClientRect();
    pad.width = Math.round(r.width * dpr);
    pad.height = Math.round(r.height * dpr);
    const ctx = pad.getContext("2d");
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0b1f4b";
    ctx.lineWidth = 2.4 * dpr;

    let last = null, mid = null;
    const pt = (e) => { const b = pad.getBoundingClientRect(); return [(e.clientX - b.left) * dpr, (e.clientY - b.top) * dpr]; };
    pad.addEventListener("pointerdown", (e) => { pad.setPointerCapture(e.pointerId); last = pt(e); mid = last; ctx.beginPath(); ctx.arc(last[0], last[1], ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fillStyle = ctx.strokeStyle; ctx.fill(); });
    pad.addEventListener("pointermove", (e) => {
      if (!last) return;
      const p = pt(e);
      const m = [(last[0] + p[0]) / 2, (last[1] + p[1]) / 2];
      ctx.beginPath();
      ctx.moveTo(mid[0], mid[1]);
      ctx.quadraticCurveTo(last[0], last[1], m[0], m[1]);
      ctx.stroke();
      last = p; mid = m;
      if (!drawn) { drawn = true; useBtn.disabled = false; }
    });
    const end = () => {
      if (last && mid) { ctx.beginPath(); ctx.moveTo(mid[0], mid[1]); ctx.lineTo(last[0], last[1]); ctx.stroke(); }
      last = null;
    };
    pad.addEventListener("pointerup", end);
    pad.addEventListener("pointercancel", end);

    useBtn.addEventListener("click", () => {
      // Trim to the ink so the stamp is not mostly empty space.
      const { data, width, height } = ctx.getImageData(0, 0, pad.width, pad.height);
      let x0 = width, y0 = height, x1 = -1, y1 = -1;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) return done(null);
      const pad2 = Math.round(4 * dpr);
      x0 = Math.max(0, x0 - pad2); y0 = Math.max(0, y0 - pad2); x1 = Math.min(width - 1, x1 + pad2); y1 = Math.min(height - 1, y1 + pad2);
      const out = document.createElement("canvas");
      out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
      out.getContext("2d").drawImage(pad, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
      done(out.toDataURL("image/png"));
    });
  });
}

// ---------------------------------------------------------------- editor

export async function openDocEditor({ bytes, filename, PDFLib, pdfjsLib, getSignature, drawSignature }) {
  ensureStyle();
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const pdfDoc = await PDFLib.PDFDocument.load(src, { ignoreEncryption: true });
  const libPages = pdfDoc.getPages();
  // pdf.js transfers the buffer it is given to its worker; hand it a copy.
  const view = await pdfjsLib.getDocument({ data: src.slice() }).promise;

  return new Promise((resolve) => {
    const fields = [];   // { field, kind, el, option? }
    const items = [];    // { type: 'img'|'text', pageIdx, el, png?, input? }
    const pageViews = []; // { viewport, layer, wrap }
    let closed = false;

    const saveBtn = h("button", { class: "dse-btn pri", text: "Save" });
    const ov = h("div", { class: "dse-ov" }, [
      h("div", { class: "dse-bar" }, [
        h("div", { class: "dse-title", text: filename || "Document" }),
        h("button", { class: "dse-btn", text: "Sign", onclick: () => addSignature() }),
        h("button", { class: "dse-btn", text: "Add text", onclick: () => addText("") }),
        h("button", { class: "dse-btn", text: "Add date", onclick: () => addText(today()) }),
        h("button", { class: "dse-btn", text: "New signature", onclick: () => addSignature(true) }),
        h("button", { class: "dse-btn", text: "Cancel", onclick: () => close(null) }),
        saveBtn,
      ]),
      h("div", { class: "dse-hint", text: "Tap a shaded box to type in it. Drag your signature or text into place; the corner handle resizes it. The original stays in the version history." }),
    ]);
    const scroll = h("div", { class: "dse-scroll" });
    ov.appendChild(scroll);
    themeVars(ov);
    document.body.appendChild(ov);

    function close(v) {
      if (closed) return;
      closed = true;
      ov.remove();
      try { view.destroy(); } catch { /* already gone */ }
      resolve(v);
    }

    // The page a new stamp goes on: the one most in view.
    function currentPage() {
      const top = scroll.getBoundingClientRect().top + scroll.clientHeight / 3;
      let best = 0;
      pageViews.forEach((p, i) => { if (p.wrap.getBoundingClientRect().top <= top) best = i; });
      return best;
    }

    // Where a new stamp goes: the middle of the part of the page that is on screen.
    function visibleMiddle(L, w, hh) {
      const s = scroll.getBoundingClientRect(), r = L.getBoundingClientRect();
      const top = Math.max(s.top, r.top) - r.top, bottom = Math.min(s.bottom, r.bottom) - r.top;
      const left = Math.max(s.left, r.left) - r.left, right = Math.min(s.right, r.right) - r.left;
      const x = (left + right) / 2 - w / 2, y = (top + bottom) / 2 - hh / 2;
      return { left: Math.max(0, Math.min(L.clientWidth - w, x)), top: Math.max(0, Math.min(L.clientHeight - hh, y)) };
    }

    function selectItem(el) {
      for (const it of items) it.el.classList.toggle("on", it.el === el);
    }

    function makeDraggable(it) {
      const el = it.el;
      let start = null;
      el.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".dse-x") || e.target.closest(".dse-rs")) return;
        if (e.target.tagName === "INPUT" && document.activeElement === e.target) return;
        selectItem(el);
        start = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop, moved: false };
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener("pointermove", (e) => {
        if (!start) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!start.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
        start.moved = true;
        const L = pageViews[it.pageIdx].layer;
        el.style.left = Math.max(0, Math.min(L.clientWidth - el.offsetWidth, start.l + dx)) + "px";
        el.style.top = Math.max(0, Math.min(L.clientHeight - el.offsetHeight, start.t + dy)) + "px";
      });
      el.addEventListener("pointerup", (e) => {
        if (start && !start.moved && it.input) it.input.focus();
        start = null;
        try { el.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      });
      const rs = el.querySelector(".dse-rs");
      let rz = null;
      rs.addEventListener("pointerdown", (e) => { e.stopPropagation(); rz = { x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight }; rs.setPointerCapture(e.pointerId); });
      rs.addEventListener("pointermove", (e) => {
        if (!rz) return;
        let w = Math.max(24, rz.w + (e.clientX - rz.x));
        let hh = it.type === "img" ? w * (rz.h / rz.w) : Math.max(14, rz.h + (e.clientY - rz.y));
        el.style.width = w + "px";
        el.style.height = hh + "px";
        if (it.input) it.input.style.fontSize = Math.max(8, hh * 0.72) + "px";
      });
      rs.addEventListener("pointerup", () => { rz = null; });
      el.querySelector(".dse-x").addEventListener("click", () => {
        el.remove();
        items.splice(items.indexOf(it), 1);
      });
    }

    function placeItem(it, pageIdx, box) {
      const L = pageViews[pageIdx].layer;
      it.pageIdx = pageIdx;
      it.el.style.left = box.left + "px";
      it.el.style.top = box.top + "px";
      it.el.style.width = box.width + "px";
      it.el.style.height = box.height + "px";
      it.el.appendChild(h("div", { class: "dse-x", text: "×", title: "Remove" }));
      it.el.appendChild(h("div", { class: "dse-rs", title: "Resize" }));
      L.appendChild(it.el);
      items.push(it);
      makeDraggable(it);
      selectItem(it.el);
    }

    async function addSignature(fresh, pageIdx, box) {
      let png = fresh ? null : await getSignature();
      if (!png) {
        png = await openSignaturePad();
        if (!png) return;
        try { await drawSignature(png); } catch { /* still usable for this document */ }
      }
      const img = new Image();
      img.src = png;
      await img.decode().catch(() => {});
      const ratio = img.naturalWidth && img.naturalHeight ? img.naturalHeight / img.naturalWidth : 0.33;
      const p = pageIdx ?? currentPage();
      const L = pageViews[p].layer;
      let b = box;
      if (b) {
        // Fit inside the signature field's box, keeping the ink's shape.
        let w = b.width, hh = w * ratio;
        if (hh > b.height) { hh = b.height; w = hh / ratio; }
        b = { left: b.left, top: b.top + (b.height - hh) / 2, width: w, height: hh };
      } else {
        const w = Math.min(220, L.clientWidth * 0.35);
        const hh = w * ratio;
        b = { ...visibleMiddle(L, w, hh), width: w, height: hh };
      }
      const el = h("div", { class: "dse-item" }, [h("img", { src: png, alt: "Signature" })]);
      placeItem({ type: "img", png, el }, p, b);
    }

    function addText(value) {
      const p = currentPage();
      const L = pageViews[p].layer;
      const hh = 18;
      const input = h("input", { type: "text", value, placeholder: "Type here" });
      input.style.fontSize = hh * 0.72 + "px";
      const el = h("div", { class: "dse-item" }, [input]);
      const w = Math.min(200, L.clientWidth * 0.4);
      placeItem({ type: "text", el, input }, p, { ...visibleMiddle(L, w, hh), width: w, height: hh });
      if (!value) input.focus();
    }

    // Which page a form widget sits on.
    function widgetPage(widget) {
      const pref = widget.P();
      let idx = pref ? libPages.findIndex((pg) => pg.ref === pref) : -1;
      if (idx < 0) {
        const wref = pdfDoc.context.getObjectRef(widget.dict);
        idx = libPages.findIndex((pg) => {
          const annots = pg.node.Annots();
          return !!annots && annots.asArray().some((a) => a === wref);
        });
      }
      return idx;
    }

    function overlayFields() {
      let form;
      try { form = pdfDoc.getForm(); } catch { return; }
      for (const field of form.getFields()) {
        let ro = false;
        try { ro = field.isReadOnly(); } catch { /* treat as editable */ }
        const widgets = field.acroField.getWidgets();
        widgets.forEach((widget, wi) => {
          const pi = widgetPage(widget);
          if (pi < 0 || !pageViews[pi]) return;
          const { viewport, layer } = pageViews[pi];
          const r = widget.getRectangle();
          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([r.x, r.y, r.x + r.width, r.y + r.height]);
          const box = { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
          if (box.width < 2 || box.height < 2) return;
          const pos = (el) => { Object.assign(el.style, { left: box.left + "px", top: box.top + "px", width: box.width + "px", height: box.height + "px" }); return el; };
          let el = null;
          if (field instanceof PDFLib.PDFTextField) {
            const multi = field.isMultiline();
            el = h(multi ? "textarea" : "input", multi ? { class: "dse-f" } : { class: "dse-f", type: "text" });
            el.value = field.getText() || "";
            const max = field.getMaxLength();
            if (max) el.maxLength = max;
            el.style.fontSize = Math.max(7, Math.min(multi ? 12 * viewport.scale : box.height * 0.68, 13 * viewport.scale)) + "px";
            // One field can have several widgets (the same name printed twice): keep them in step.
            el.addEventListener("input", () => { for (const f of fields) if (f.field === field && f.el !== el) f.el.value = el.value; });
            fields.push({ field, kind: "text", el });
          } else if (field instanceof PDFLib.PDFCheckBox) {
            el = h("input", { class: "dse-f", type: "checkbox" });
            el.checked = field.isChecked();
            fields.push({ field, kind: "check", el });
          } else if (field instanceof PDFLib.PDFRadioGroup) {
            const opt = field.getOptions()[wi];
            el = h("input", { class: "dse-f", type: "radio", name: "dse-r-" + field.getName() });
            el.checked = opt != null && field.getSelected() === opt;
            fields.push({ field, kind: "radio", el, option: opt });
          } else if (field instanceof PDFLib.PDFDropdown) {
            el = h("select", { class: "dse-f" }, [h("option", { value: "", text: "" }), ...field.getOptions().map((o) => h("option", { value: o, text: o }))]);
            el.value = (field.getSelected() || [])[0] || "";
            el.style.fontSize = Math.max(8, box.height * 0.6) + "px";
            fields.push({ field, kind: "select", el });
          } else if (field instanceof PDFLib.PDFSignature) {
            el = h("div", { class: "dse-sig", text: "Sign here" });
            el.addEventListener("click", () => { el.remove(); addSignature(false, pi, box); });
          }
          if (!el) return;
          if (ro && el.tagName !== "DIV") el.disabled = true;
          layer.appendChild(pos(el));
        });
      }
    }

    async function renderPages() {
      // Never narrower than 640px: on a phone you pan across a readable form rather than
      // squint at a shrunken one.
      const width = Math.min(900, Math.max(640, scroll.clientWidth - 20));
      for (let i = 1; i <= view.numPages; i++) {
        const page = await view.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: width / base.width });
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const canvas = h("canvas");
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        const layer = h("div", { class: "dse-layer" });
        const wrap = h("div", { class: "dse-page" }, [canvas, layer]);
        wrap.style.width = viewport.width + "px";
        wrap.style.height = viewport.height + "px";
        scroll.appendChild(wrap);
        pageViews.push({ viewport, layer, wrap });
        // Form widgets are drawn as live inputs instead, so leave them off the canvas.
        await page.render({
          canvasContext: canvas.getContext("2d"),
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          annotationMode: pdfjsLib.AnnotationMode.DISABLE,
        }).promise;
        if (closed) return;
      }
    }

    async function save() {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving";
      try {
        const helv = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
        const seenRadio = new Set();
        for (const f of fields) {
          if (f.el.disabled) continue;
          if (f.kind === "text") f.field.setText(winAnsi(f.el.value) || undefined);
          else if (f.kind === "check") { if (f.el.checked) f.field.check(); else f.field.uncheck(); }
          else if (f.kind === "radio") { if (f.el.checked && f.option != null) { f.field.select(f.option); seenRadio.add(f.field); } }
          else if (f.kind === "select") { if (f.el.value) f.field.select(f.el.value); else f.field.clear(); }
        }
        try { pdfDoc.getForm().updateFieldAppearances(helv); } catch { /* fields keep their values; viewers redraw them */ }
        const imgs = new Map();
        for (const it of items) {
          const { viewport } = pageViews[it.pageIdx];
          const page = libPages[it.pageIdx];
          const l = it.el.offsetLeft, t = it.el.offsetTop, w = it.el.offsetWidth, hh = it.el.offsetHeight;
          const [ax, ay] = viewport.convertToPdfPoint(l, t + hh);
          const [bx, by] = viewport.convertToPdfPoint(l + w, t);
          const x = Math.min(ax, bx), y = Math.min(ay, by), pw = Math.abs(bx - ax), ph = Math.abs(by - ay);
          if (it.type === "img") {
            if (!imgs.has(it.png)) imgs.set(it.png, await pdfDoc.embedPng(it.png));
            page.drawImage(imgs.get(it.png), { x, y, width: pw, height: ph });
          } else {
            const text = winAnsi(it.input.value).replace(/\n/g, " ").trim();
            if (!text) continue;
            const size = Math.max(6, ph * 0.72);
            page.drawText(text, { x: x + 2 / viewport.scale, y: y + ph * 0.22, size, font: helv, color: PDFLib.rgb(0, 0, 0) });
          }
        }
        const out = await pdfDoc.save();
        // Never hand back a file that will not open: read it back first.
        const check = await pdfjsLib.getDocument({ data: out.slice() }).promise;
        await check.getPage(1);
        check.destroy();
        close({ bytes: out, signed: items.some((it) => it.type === "img") });
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save";
        window.alert("This PDF could not be saved with your changes (" + ((e && e.message) || e) + "). The original is unchanged.");
      }
    }
    saveBtn.addEventListener("click", save);

    renderPages().then(() => { if (!closed) overlayFields(); }).catch((e) => {
      window.alert("This PDF could not be opened for editing (" + ((e && e.message) || e) + ").");
      close(null);
    });
  });
}

// ---------------------------------------------------------------- shared catalogue

export const DOC_CATEGORIES = [
  { key: "formation", label: "Formation" },
  { key: "tax", label: "Tax" },
  { key: "certificates", label: "Certificates" },
  { key: "licenses", label: "Licenses and insurance" },
  { key: "banking", label: "Banking" },
  { key: "contracts", label: "Contracts" },
  { key: "other", label: "Other" },
];

// The papers most companies are asked for. A document fills a slot by its checklist_key.
export const DOC_CHECKLIST = [
  { key: "articles", category: "formation", label: "Articles of organization", hint: "The state filing that created the company." },
  { key: "operating_agreement", category: "formation", label: "Operating agreement", hint: "Who owns what and how decisions are made." },
  { key: "annual_report", category: "formation", label: "Latest annual report", hint: "The yearly state filing that keeps the company in good standing." },
  { key: "ein_letter", category: "tax", label: "EIN letter from the IRS", hint: "The CP 575, or a 147C letter if the original is lost." },
  { key: "sales_tax_reg", category: "tax", label: "Sales tax registration", hint: "Your state seller's permit or registration certificate." },
  { key: "w9", category: "tax", label: "W-9", hint: "Suppliers and buyers ask for it. Fill it once and keep it ready." },
  { key: "tax_return", category: "tax", label: "Last year's tax return", hint: "Federal and state. Put the year in the title." },
  { key: "resale_cert", category: "certificates", label: "Resale certificate (CRT-61)", hint: "What suppliers keep on file so you buy for resale without sales tax." },
  { key: "business_license", category: "licenses", label: "Business license", hint: "City, county or state, if your area requires one." },
  { key: "insurance", category: "licenses", label: "Certificate of insurance", hint: "General liability. Landlords and warehouses often ask for it." },
  { key: "bank_letter", category: "banking", label: "Bank account letter", hint: "A bank letter or voided check for buyers who pay by wire or ACH." },
];

// { tone: "danger" | "warning" | null, text } for a YYYY-MM-DD renewal date.
export function expiryState(expiresOn, now = new Date()) {
  if (!expiresOn) return { tone: null, text: "" };
  const [y, m, d] = expiresOn.split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due - start) / 86400000);
  if (days < 0) return { tone: "danger", text: "Expired " + (-days === 1 ? "yesterday" : -days + " days ago") };
  if (days === 0) return { tone: "danger", text: "Expires today" };
  if (days <= 60) return { tone: "warning", text: "Expires in " + days + (days === 1 ? " day" : " days") };
  return { tone: null, text: "Renews " + due.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) };
}
