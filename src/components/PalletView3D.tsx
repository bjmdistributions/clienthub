// R-346: one built pallet, in 3D and layer by layer — the picture Jack builds from.
// Every box is drawn at exactly the place the fitter gave it (pallet_fit.rs), in its team's map
// colour; the layer stepper fades the layers below and hides the ones above, and the plan under
// it is the same layer from above, with the front marked the way the 3D view first faces.

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type FitPallet, type PalletSpec, feet, inches, layerSections } from "../lib/palletFit";
import { n0, rgba } from "./warehouseUi";

interface Props {
  pallet: FitPallet;
  spec: PalletSpec;
  /** A box's colour: an "r g b" triplet or a var() holding one (teamColor). */
  colorOf: (section_id: string) => string;
  /** Short name for a section, drawn on its boxes in the plan. */
  labelOf: (section_id: string) => string;
  typeName: (type_id: string) => string;
  height?: number;
}

/** "r g b" or "var(--x)" → 0..255 triplet (three.js cannot read CSS variables). */
function triplet(c: string): [number, number, number] {
  let s = (c || "").trim();
  const m = s.match(/^var\((--[^)]+)\)$/);
  if (m) s = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
  const p = s.split(/[\s,/]+/).filter(Boolean).map(Number);
  return p.length >= 3 && p.slice(0, 3).every(Number.isFinite) ? [p[0], p[1], p[2]] : [142, 142, 147];
}

const DECK = new THREE.Color().setRGB(162 / 255, 132 / 255, 94 / 255, THREE.SRGBColorSpace); // Apple system brown

export default function PalletView3D({ pallet, spec, colorOf, labelOf, typeName, height = 340 }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const layers = pallet.layers.length;
  const [upTo, setUpTo] = useState(0); // 0 = the whole pallet
  const meshes = useRef<{ layer: number; mesh: THREE.Mesh; edges: THREE.LineSegments }[]>([]);
  const redraw = useRef<() => void>(() => {});
  const resetView = useRef<() => void>(() => {});

  // The scene: built once per pallet.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const L = spec.length, W = spec.width, D = spec.deck, H = pallet.load_height;
    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";

    const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 5000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.minPolarAngle = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    const size = Math.max(L, W, H + D);
    controls.minDistance = size * 0.9;
    controls.maxDistance = size * 5;
    const front = () => {
      // Looking at the front (the pallet's width side nearest the plan's bottom edge), from a little left and above.
      // A narrow view stands back further, so the whole pallet fits across it.
      const aspect = (el.clientWidth || 300) / height;
      const r = size * (2.05 + Math.max(0, 1.6 - aspect) * 1.2);
      camera.position.set(-r * 0.45, H * 0.45 + r * 0.42, r * 0.82);
      controls.target.set(0, H * 0.42, 0);
      controls.update();
    };

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8e, 1.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-size, size * 2, size * 1.5);
    scene.add(sun);

    const disposables: { dispose: () => void }[] = [];
    const add = <T extends { dispose: () => void }>(x: T) => { disposables.push(x); return x; };

    // The deck: its top at y = 0.
    const deckGeo = add(new THREE.BoxGeometry(L, Math.max(D, 0.4), W));
    const deck = new THREE.Mesh(deckGeo, add(new THREE.MeshStandardMaterial({ color: DECK, roughness: 0.9 })));
    deck.position.set(0, -Math.max(D, 0.4) / 2, 0);
    scene.add(deck);
    const deckEdges = new THREE.LineSegments(add(new THREE.EdgesGeometry(deckGeo)), add(new THREE.LineBasicMaterial({ color: DECK.clone().multiplyScalar(0.6) })));
    deckEdges.position.copy(deck.position);
    scene.add(deckEdges);

    // The boxes, exactly where the plan puts them; drawn a hair smaller so neighbours read as two boxes.
    const GAP = 0.12;
    const colors = new Map<string, THREE.Color>();
    const colorFor = (sid: string) => {
      let c = colors.get(sid);
      if (!c) {
        const [r, g, b] = triplet(colorOf(sid));
        c = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
        colors.set(sid, c);
      }
      return c;
    };
    meshes.current = pallet.boxes.map((b) => {
      const geo = add(new THREE.BoxGeometry(Math.max(0.1, b.l - GAP), Math.max(0.1, b.h - GAP), Math.max(0.1, b.w - GAP)));
      const c = colorFor(b.section_id);
      const mat = add(new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, transparent: true, opacity: 1 }));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(b.x + b.l / 2 - L / 2, b.z + b.h / 2, b.y + b.w / 2 - W / 2);
      const edges = new THREE.LineSegments(add(new THREE.EdgesGeometry(geo)), add(new THREE.LineBasicMaterial({ color: c.clone().multiplyScalar(0.45), transparent: true, opacity: 1 })));
      edges.position.copy(mesh.position);
      scene.add(mesh, edges);
      return { layer: b.layer, mesh, edges };
    });

    const render = () => renderer.render(scene, camera);
    redraw.current = render;
    resetView.current = () => { front(); render(); };
    const fitSize = () => {
      const w = el.clientWidth || 300;
      renderer.setSize(w, height, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = `${height}px`;
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
      render();
    };
    controls.addEventListener("change", render);
    const ro = new ResizeObserver(fitSize);
    ro.observe(el);
    front();
    fitSize();
    return () => {
      ro.disconnect();
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      meshes.current = [];
    };
    // colorOf is stable enough per pallet; rebuilding on every render would reset the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pallet, spec.length, spec.width, spec.deck, height]);

  // Showing one layer: the ones above hidden, the ones below faded.
  useEffect(() => {
    for (const { layer, mesh, edges } of meshes.current) {
      const above = upTo > 0 && layer > upTo, below = upTo > 0 && layer < upTo;
      mesh.visible = edges.visible = !above;
      const m = mesh.material as THREE.MeshStandardMaterial, e = edges.material as THREE.LineBasicMaterial;
      m.opacity = below ? 0.22 : 1;
      m.depthWrite = !below;
      e.opacity = below ? 0.3 : 1;
    }
    redraw.current();
  }, [upTo, pallet]);

  useEffect(() => { setUpTo(0); }, [pallet]);

  const shown = upTo || layers;
  const layer = pallet.layers[shown - 1];
  const inLayer = useMemo(() => pallet.boxes.filter((b) => b.layer === shown), [pallet, shown]);
  const who = layerSections(pallet, shown);
  const kinds = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of inLayer) m.set(b.type_id, (m.get(b.type_id) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [inLayer]);
  const tallest = Math.max(0, ...inLayer.map((b) => b.h));

  return (
    <div className="space-y-3">
      <div className="relative rounded-lg border border-line overflow-hidden" style={{ background: "rgb(var(--c-surface-2))" }}>
        <div ref={host} role="img" aria-label={`Pallet ${pallet.n}: ${pallet.boxes.length} boxes in ${layers} layers, ${feet(pallet.total_height)} from the floor`} />
        <button onClick={() => resetView.current()} className="absolute right-2 top-2 text-[11.5px] px-2 h-7 rounded-md border border-line bg-surface/90 text-ink-2 hover:text-ink">Front view</button>
        <div className="absolute left-2 bottom-2 text-[11px] text-muted bg-surface/85 rounded-md px-1.5 py-0.5">Drag to turn · scroll to zoom</div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center rounded-lg border border-line overflow-hidden">
          <button onClick={() => setUpTo(Math.max(1, shown - 1))} disabled={shown <= 1 && upTo > 0} className="w-8 h-8 grid place-items-center text-ink-2 hover:bg-surface-2 disabled:opacity-30" aria-label="Layer below"><ChevronLeft size={15} /></button>
          <span className="px-2 text-[12.5px] text-ink tabular-nums whitespace-nowrap">{upTo ? `Layer ${upTo} of ${layers}` : `All ${layers} layers`}</span>
          <button onClick={() => setUpTo(upTo === 0 ? 0 : upTo >= layers ? 0 : upTo + 1)} disabled={upTo === 0} className="w-8 h-8 grid place-items-center text-ink-2 hover:bg-surface-2 disabled:opacity-30" aria-label="Layer above"><ChevronRight size={15} /></button>
        </div>
        {upTo === 0
          ? <button onClick={() => setUpTo(1)} className="text-[12.5px] text-accent hover:underline">Build it layer by layer</button>
          : <button onClick={() => setUpTo(0)} className="text-[12.5px] text-muted hover:text-ink-2">Whole pallet</button>}
      </div>

      {layer && (
        <div className="rounded-lg border border-line p-3 space-y-2">
          <div className="text-[13px] text-ink">
            <span className="font-semibold">Layer {shown}</span> · {kinds.map(([t, n]) => `${n} × ${typeName(t)}`).join(", ")}{layer.on_side ? ", on their sides" : ""}
            <span className="text-muted"> · {kinds.length > 1 ? "up to " : ""}{inches(tallest)} in high, starting {inches(layer.z + spec.deck)} in from the floor</span>
          </div>
          <div className="text-[12px] text-ink-2">{who.map(([sid, n]) => `${labelOf(sid)} ${n}`).join(" · ")}</div>
          <LayerPlan spec={spec} boxes={inLayer} colorOf={colorOf} labelOf={labelOf} sizeOf={kinds.length > 1 ? typeName : undefined} />
          {kinds.length > 1 && <div className="text-[11.5px] text-muted">{kinds.map(([t]) => `${initials(typeName(t))} = ${typeName(t)}`).join(" · ")}</div>}
        </div>
      )}
      <div className="text-[12px] text-muted tabular-nums">
        {n0(pallet.boxes.length)} boxes · {n0(pallet.units)} units · {inches(pallet.total_height)} in ({feet(pallet.total_height)}) from the floor, of {inches(spec.max_height)} allowed
      </div>
    </div>
  );
}

/** "Small Square" → "SS": which size a box is, on a layer that mixes sizes. */
const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").toUpperCase();

/** One layer from above: the pallet with its front at the bottom, each box where it goes. */
function LayerPlan({ spec, boxes, colorOf, labelOf, sizeOf }: { spec: PalletSpec; boxes: FitPallet["boxes"]; colorOf: (sid: string) => string; labelOf: (sid: string) => string; sizeOf?: (type_id: string) => string }) {
  const L = spec.length, W = spec.width, pad = 5;
  const fs = Math.max(1.6, Math.min(3.2, Math.min(L, W) / 14));
  return (
    <svg viewBox={`${-pad} ${-pad} ${L + pad * 2} ${W + pad * 2 + 5}`} className="w-full max-w-[420px] h-auto" role="img" aria-label="This layer from above">
      <rect x={0} y={0} width={L} height={W} rx={0.6} fill="rgb(162 132 94 / 0.25)" stroke="rgb(162 132 94)" strokeWidth={0.35} />
      {boxes.map((b, i) => {
        const c = colorOf(b.section_id);
        return (
          <g key={i}>
            <rect x={b.x + 0.15} y={b.y + 0.15} width={b.l - 0.3} height={b.w - 0.3} rx={0.4} fill={rgba(c, 0.32)} stroke={rgba(c, 0.95)} strokeWidth={0.3} />
            <text x={b.x + b.l / 2} y={b.y + b.w / 2 - (sizeOf ? Math.min(fs, b.w / 4) * 0.55 : 0)} textAnchor="middle" dominantBaseline="central" fontSize={Math.min(fs, b.l / 4, b.w / 2)} fill="rgb(var(--c-ink))" style={{ fontWeight: 600 }}>{labelOf(b.section_id)}</text>
            {sizeOf && <text x={b.x + b.l / 2} y={b.y + b.w / 2 + Math.min(fs, b.w / 4) * 0.75} textAnchor="middle" dominantBaseline="central" fontSize={Math.min(fs, b.l / 4, b.w / 2) * 0.8} fill="rgb(var(--c-ink-2))">{initials(sizeOf(b.type_id))}</text>}
          </g>
        );
      })}
      <text x={L / 2} y={-1.4} textAnchor="middle" fontSize={2.2} fill="rgb(var(--c-muted))">Back · {inches(L)} in</text>
      <text x={L / 2} y={W + 3.6} textAnchor="middle" fontSize={2.2} fill="rgb(var(--c-ink-2))" style={{ fontWeight: 600 }}>Front</text>
      <text x={-1.6} y={W / 2} textAnchor="middle" fontSize={2.2} fill="rgb(var(--c-muted))" transform={`rotate(-90 ${-1.6} ${W / 2})`}>{inches(W)} in</text>
    </svg>
  );
}
