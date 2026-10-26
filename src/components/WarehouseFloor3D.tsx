// R-554: the warehouse in 3D. The building as drawn on the floor plan (floor, low walls open at the
// doors, the office and shelving standing up, an area as its outline) and every pallet on it with its
// boxes stacked: each row of boxes 12 inches high and laid out to fill the 48 by 40 deck (boxGrid),
// filled boxes in the delivery's colour and empty ones pale. Drag to turn it, right drag to slide it,
// scroll to zoom; click a pallet to pick it (its panel shows beside the view). The phone's twin is
// `whf3d*` in www/app.js. Box sizes are never asked for: the boxes are drawn to fit.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DECK_HEIGHT, ROW_HEIGHT, boxGrid, insideRect, type Floor, type FloorPallet } from "../lib/floor";
import type { LoadDetail } from "../lib/deliveries";
import { teamColor } from "./warehouseUi";
import { triplet } from "./PalletView3D";

interface Props {
  floor: Floor;
  /** The pallets standing on this building. */
  pallets: FloorPallet[];
  /** Deliveries read so far: which boxes are filled, exactly. A pallet whose delivery is not here
   *  shows its first `filled` boxes as filled. */
  details: Record<string, LoadDetail>;
  selId: string | null;
  /** The legend's picked delivery: the others are drawn faint. */
  focusLoad: string | null;
  height: number;
  onPick: (palletId: string | null) => void;
}

const color = (c: string) => { const [r, g, b] = triplet(c); return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace); };
const css = (name: string, fb: string) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb);

export default function WarehouseFloor3D({ floor, pallets, details, selId, focusLoad, height, onPick }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<{ build: (p: Props) => void; render: () => void } | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  // The renderer, camera and controls live as long as the building on screen.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";
    const scene = new THREE.Scene();
    const size = Math.max(floor.width, floor.depth);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.3, 20000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.minPolarAngle = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.minDistance = 6;
    controls.maxDistance = size * 4;
    controls.screenSpacePanning = false;
    const home = () => {
      // From the front (the bottom wall as drawn), a little to the left and above.
      const r = size * 1.25;
      camera.position.set(-r * 0.32, r * 0.58, r * 0.75);
      controls.target.set(0, 0, 0);
      controls.update();
    };
    home();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8e, 1.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-size, size * 2, size * 1.5);
    scene.add(sun);
    const root = new THREE.Group();
    scene.add(root);
    let trash: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(x: T) => { trash.push(x); return x; };
    let pickables: THREE.Object3D[] = [];
    let picked: string | null = null;

    const render = () => renderer.render(scene, camera);
    const fit = () => {
      const w = el.clientWidth || 600;
      renderer.setSize(w, height, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = `${height}px`;
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
      render();
    };

    const build = ({ floor: f, pallets: ps, details: ds, selId: sel, focusLoad: focus }: Props) => {
      trash.forEach((x) => x.dispose());
      trash = [];
      root.clear();
      pickables = [];
      const W = f.width, D = f.depth, X = (x: number) => x - W / 2, Z = (y: number) => y - D / 2;
      // The floor, and a line every 10 ft.
      const fl = new THREE.Mesh(keep(new THREE.PlaneGeometry(W, D)), keep(new THREE.MeshStandardMaterial({ color: color(css("--c-surface-2", "242 242 247")), roughness: 1 })));
      fl.rotation.x = -Math.PI / 2;
      root.add(fl);
      const gp: number[] = [];
      for (let x = 10; x < W; x += 10) gp.push(X(x), 0.01, Z(0), X(x), 0.01, Z(D));
      for (let y = 10; y < D; y += 10) gp.push(X(0), 0.01, Z(y), X(W), 0.01, Z(y));
      if (gp.length) {
        const g = keep(new THREE.BufferGeometry());
        g.setAttribute("position", new THREE.Float32BufferAttribute(gp, 3));
        root.add(new THREE.LineSegments(g, keep(new THREE.LineBasicMaterial({ color: color(css("--c-line", "209 209 214")) }))));
      }
      // Low walls, open where the doors are.
      const wallM = keep(new THREE.MeshStandardMaterial({ color: color(css("--c-faint", "142 142 147")), roughness: 0.9, transparent: true, opacity: 0.55 }));
      const WH = 2, T = 0.35;
      (["top", "bottom", "left", "right"] as const).forEach((side) => {
        const len = side === "left" || side === "right" ? D : W;
        const gaps = f.shape.doors.filter((d) => d.side === side).map((d) => [Math.max(0, d.at), Math.min(len, d.at + d.width)] as const).sort((a, b) => a[0] - b[0]);
        let at = 0;
        const seg = (a: number, b: number) => {
          if (b - a < 0.05) return;
          const horiz = side === "top" || side === "bottom";
          const m = new THREE.Mesh(keep(new THREE.BoxGeometry(horiz ? b - a : T, WH, horiz ? T : b - a)), wallM);
          const mid = (a + b) / 2;
          if (side === "top") m.position.set(X(mid), WH / 2, Z(0) - T / 2);
          else if (side === "bottom") m.position.set(X(mid), WH / 2, Z(D) + T / 2);
          else if (side === "left") m.position.set(X(0) - T / 2, WH / 2, Z(mid));
          else m.position.set(X(W) + T / 2, WH / 2, Z(mid));
          root.add(m);
        };
        gaps.forEach(([a, b]) => { seg(at, a); at = Math.max(at, b); });
        seg(at, len);
      });
      // The office and shelving stand up; an area is its outline on the floor.
      f.shape.areas.forEach((a) => {
        if (a.kind === "area") {
          const pts = [[a.x, a.y], [a.x + a.w, a.y], [a.x + a.w, a.y + a.d], [a.x, a.y + a.d], [a.x, a.y]].map(([x, y]) => new THREE.Vector3(X(x), 0.03, Z(y)));
          root.add(new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints(pts)), keep(new THREE.LineBasicMaterial({ color: color(css("--c-faint", "142 142 147")) }))));
          return;
        }
        const h = a.kind === "office" ? 8 : 6;
        const geo = keep(new THREE.BoxGeometry(a.w, h, a.d));
        const m = new THREE.Mesh(geo, keep(new THREE.MeshStandardMaterial({ color: color(a.kind === "office" ? css("--c-ink-2", "99 99 102") : css("--c-faint", "142 142 147")), transparent: true, opacity: a.kind === "office" ? 0.16 : 0.45, depthWrite: false })));
        m.position.set(X(a.x + a.w / 2), h / 2, Z(a.y + a.d / 2));
        const e = new THREE.LineSegments(keep(new THREE.EdgesGeometry(geo)), keep(new THREE.LineBasicMaterial({ color: color(css("--c-ink-2", "99 99 102")) })));
        e.position.copy(m.position);
        root.add(m, e);
      });
      // Every pallet: the deck, then its boxes row by row.
      const deckM = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(162 / 255, 132 / 255, 94 / 255, THREE.SRGBColorSpace), roughness: 0.9 }));
      const mats = new Map<string, THREE.Material>();
      const matFor = (loadId: string, full: boolean, faint: boolean) => {
        const k = `${loadId}:${full ? 1 : 0}:${faint ? 1 : 0}`;
        let m = mats.get(k);
        if (!m) {
          const c = color(teamColor(loadId));
          m = keep(full && !faint ? new THREE.MeshStandardMaterial({ color: c, roughness: 0.75 })
            : new THREE.MeshStandardMaterial({ color: full ? c : c.clone().lerp(new THREE.Color(1, 1, 1), 0.72), roughness: 0.9, transparent: true, opacity: faint ? 0.18 : 0.62 }));
          mats.set(k, m);
        }
        return m;
      };
      for (const p of ps) {
        const r = insideRect(p, W, D);
        const faint = focus !== null && focus !== p.load_id && p.id !== sel;
        const deck = new THREE.Mesh(keep(new THREE.BoxGeometry(r.w, DECK_HEIGHT, r.d)), deckM);
        deck.position.set(X(r.x + r.w / 2), DECK_HEIGHT / 2, Z(r.y + r.d / 2));
        deck.userData.pid = p.id;
        root.add(deck);
        pickables.push(deck);
        const n = p.boxes || 0;
        let top = DECK_HEIGHT;
        if (n > 0) {
          const per = Math.max(1, Math.min(p.per_layer || Math.min(n, 6), n));
          const g = boxGrid(per, r.w, r.d);
          const cw = r.w / g.cols, cd = r.d / g.rows, gap = 0.07;
          const geo = keep(new THREE.BoxGeometry(Math.max(0.1, cw - gap), ROW_HEIGHT - 0.05, Math.max(0.1, cd - gap)));
          // Which boxes are filled: exactly, when the delivery has been read; else the first ones.
          const d = ds[p.load_id];
          const bs = d ? d.cases.filter((c) => c.pallet === p.number && c.kind !== "loose").sort((a, b) => a.number - b.number) : null;
          for (let i = 0; i < n; i++) {
            const layer = Math.floor(i / per), slot = i % per, col = slot % g.cols, row = Math.floor(slot / g.cols);
            const full = bs && bs[i] ? bs[i].contents.some((x) => x.pairs > 0) : i < (p.filled || 0);
            const m = new THREE.Mesh(geo, matFor(p.load_id, full, faint));
            m.position.set(X(r.x + cw * (col + 0.5)), DECK_HEIGHT + ROW_HEIGHT * (layer + 0.5), Z(r.y + cd * (row + 0.5)));
            m.userData.pid = p.id;
            root.add(m);
            pickables.push(m);
          }
          top = DECK_HEIGHT + ROW_HEIGHT * Math.ceil(n / per);
        } else if (p.pairs > 0) {
          const m = new THREE.Mesh(keep(new THREE.BoxGeometry(r.w * 0.9, 0.6, r.d * 0.9)), matFor(p.load_id, true, faint));
          m.position.set(X(r.x + r.w / 2), DECK_HEIGHT + 0.3, Z(r.y + r.d / 2));
          m.userData.pid = p.id;
          root.add(m);
          pickables.push(m);
          top = DECK_HEIGHT + 0.6;
        }
        if (p.id === sel) {
          const geo = keep(new THREE.BoxGeometry(r.w + 0.3, top + 0.15, r.d + 0.3));
          const e = new THREE.LineSegments(keep(new THREE.EdgesGeometry(geo)), keep(new THREE.LineBasicMaterial({ color: color(css("--c-ink", "29 29 31")) })));
          e.position.set(X(r.x + r.w / 2), (top + 0.15) / 2, Z(r.y + r.d / 2));
          root.add(e);
          // A pallet picked here or beside the view: turn about it.
          if (picked !== p.id) {
            const t = new THREE.Vector3(X(r.x + r.w / 2), 0, Z(r.y + r.d / 2));
            camera.position.add(t.clone().sub(controls.target));
            controls.target.copy(t);
            controls.update();
            picked = p.id;
          }
        }
      }
      if (!sel) picked = null;
      render();
    };

    // A click (not a drag) picks the pallet under it.
    let down: [number, number] | null = null;
    const onDown = (e: PointerEvent) => { down = [e.clientX, e.clientY]; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || e.button !== 0) { down = null; return; }
      down = null;
      const rc = renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(pickables, false)[0];
      pickRef.current(hit ? (hit.object.userData.pid as string) : null);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    controls.addEventListener("change", render);
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    view.current = { build, render };
    const reset = () => { home(); render(); };
    (el as HTMLDivElement & { resetView?: () => void }).resetView = reset;
    return () => {
      view.current = null;
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.dispose();
      trash.forEach((x) => x.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floor.id, height]);

  // Everything drawn again when what is on the floor changes (cheap: no new renderer).
  useEffect(() => { view.current?.build({ floor, pallets, details, selId, focusLoad, height, onPick }); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [floor, pallets, details, selId, focusLoad, height]);

  return (
    <div className="relative rounded-xl border border-line overflow-hidden bg-surface-2" style={{ height }}>
      <div ref={host} className="w-full h-full" />
      <button onClick={() => (host.current as (HTMLDivElement & { resetView?: () => void }) | null)?.resetView?.()}
        className="absolute right-2 top-2 h-8 px-3 rounded-lg border border-line bg-surface text-[12px] text-ink-2 hover:bg-surface-2">Reset view</button>
    </div>
  );
}
