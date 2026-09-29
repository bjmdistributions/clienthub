// Client marks as WebGL sprites, drawn like a map app's pins: a flat dot in the
// lens colour with a thin white border and a small shadow for one client, a
// badge with the count for several. No glow: halos smeared into each other when
// zoomed out. Sprites keep a constant size on screen (sizeAttenuation off) and
// cost the renderer one quad each, instead of the old per-client DOM tree that
// was re-projected on the main thread every frame.
import * as THREE from "three";

export interface MarkStyle {
  rgb: string;          // "r,g,b"
  count: number;
  approximate: boolean; // the pin is a state or country centre
  selected: boolean;
}

// The texture is drawn at 128px with the circle's radius at R_TEX, leaving room
// for the shadow and the selection ring.
const TEX = 128;
const R_TEX = 40;
const cache = new Map<string, THREE.CanvasTexture>();

export function countLabel(n: number): string {
  return n < 2 ? "" : n > 999 ? "999+" : String(n);
}

/** Circle diameter in CSS pixels: a dot for one client, a badge sized by digits. */
export function markDiameter(count: number): number {
  return count < 2 ? 13 : count < 10 ? 24 : count < 100 ? 28 : count < 1000 ? 34 : 40;
}

/** Room a mark claims on screen, in CSS pixels: its radius plus a small gap.
 *  Two marks merge when their centres are closer than the sum of these. */
export function markRoom(count: number): number {
  return markDiameter(count) / 2 + 3;
}

/** Dark text on light colours (gold, silver), white on the rest. */
export function inkFor(rgb: string): string {
  const [r, g, b] = rgb.split(",").map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "rgba(10,14,26,0.92)" : "#FFFFFF";
}

export const SELECTED_RGB = "255,101,32"; // Ecliptr orange

/** One texture per look, shared by every mark that looks the same. */
export function markTexture(s: MarkStyle): THREE.CanvasTexture {
  const label = countLabel(s.count);
  const key = `${s.rgb}|${label}|${s.approximate ? 1 : 0}|${s.selected ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const cv = document.createElement("canvas");
  cv.width = cv.height = TEX;
  const g = cv.getContext("2d")!;
  const c = TEX / 2;
  // Border width in texture pixels, so it lands near 2 CSS px at any mark size.
  const px = (2 * R_TEX) / markDiameter(s.count);

  if (s.selected) {
    g.beginPath();
    g.arc(c, c, R_TEX + 7 * px, 0, Math.PI * 2);
    g.fillStyle = `rgba(${SELECTED_RGB},0.35)`;
    g.fill();
  }

  g.save();
  g.shadowColor = "rgba(0,0,0,0.5)";
  g.shadowBlur = 5 * px;
  g.shadowOffsetY = 1.5 * px;
  g.beginPath();
  g.arc(c, c, R_TEX, 0, Math.PI * 2);
  g.fillStyle = s.approximate ? `rgba(${s.rgb},0.55)` : `rgb(${s.rgb})`;
  g.fill();
  g.restore();

  g.beginPath();
  g.arc(c, c, R_TEX - px, 0, Math.PI * 2);
  g.lineWidth = 2 * px;
  g.strokeStyle = s.selected ? `rgb(${SELECTED_RGB})` : "rgba(255,255,255,0.95)";
  g.stroke();

  if (label) {
    const size = (label.length > 3 ? 10 : label.length > 2 ? 11 : 12.5) * px;
    g.font = `700 ${size}px Satoshi, system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = s.approximate ? "#FFFFFF" : inkFor(s.rgb);
    g.fillText(label, c, c + 0.5 * px);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

export function makeSprite(): THREE.Sprite {
  // Not depth-tested: the globe would cut marks near its edge in half. The view
  // hides far-side marks and fades them toward the horizon instead (fadeToHorizon).
  const m = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false });
  const s = new THREE.Sprite(m);
  s.renderOrder = 10;
  return s;
}

/**
 * Applies a look and a size to a sprite. `pxToScale` converts CSS pixels to the
 * sprite's screen-space scale for the current canvas height and camera fov.
 */
export function styleSprite(s: THREE.Sprite, style: MarkStyle, pxToScale: number, grow = 1) {
  const m = s.material as THREE.SpriteMaterial;
  const tex = markTexture(style);
  if (m.map !== tex) { m.map = tex; m.needsUpdate = true; }
  const k = markDiameter(style.count) * (TEX / (2 * R_TEX)) * pxToScale * grow;
  s.scale.set(k, k, 1);
}

/** Frees every cached texture (on unmount). */
export function disposeMarkTextures() {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
