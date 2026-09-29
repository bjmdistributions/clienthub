// Client marks as WebGL sprites: a glowing bead per place, a count inside when the
// mark stands for more than one client, a hollow ring when the pin is only a state
// or country centre. Sprites keep a constant size on screen (sizeAttenuation off),
// are depth-tested against the globe so the far side hides itself, and cost the
// renderer one quad each, instead of the old per-client DOM tree that was
// re-projected on the main thread every frame.
import * as THREE from "three";

export interface MarkStyle {
  rgb: string;          // "r,g,b"
  count: number;
  approximate: boolean;
  selected: boolean;
}

const TEX = 128;
const cache = new Map<string, THREE.CanvasTexture>();

const mix = (rgb: number[], to: number, t: number) => rgb.map((c) => Math.round(c + (to - c) * t));
const css = (rgb: number[], a = 1) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;

export function countLabel(n: number): string {
  return n < 2 ? "" : n > 999 ? "999+" : String(n);
}

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
  const rgb = s.rgb.split(",").map(Number);
  const core = label ? 30 : 19;

  // Soft light around the bead.
  const glow = g.createRadialGradient(c, c, core * 0.6, c, c, c - 1);
  glow.addColorStop(0, css(rgb, 0.5));
  glow.addColorStop(0.45, css(rgb, 0.16));
  glow.addColorStop(1, css(rgb, 0));
  g.fillStyle = glow;
  g.fillRect(0, 0, TEX, TEX);

  // A dark seat so the bead separates from the land and from its neighbours.
  g.beginPath();
  g.arc(c, c, core + 3.5, 0, Math.PI * 2);
  g.fillStyle = "rgba(6,8,18,0.88)";
  g.fill();

  if (s.approximate) {
    // A ring, not a point: the client is somewhere in this state or country.
    g.beginPath();
    g.arc(c, c, core - 3, 0, Math.PI * 2);
    g.fillStyle = css(rgb, 0.16);
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = css(rgb, 1);
    g.stroke();
  } else {
    // A lit bead: highlight up and to the left, shading toward the rim.
    const bead = g.createRadialGradient(c - core * 0.35, c - core * 0.4, core * 0.1, c, c, core);
    bead.addColorStop(0, css(mix(rgb, 255, 0.55)));
    bead.addColorStop(0.55, css(rgb));
    bead.addColorStop(1, css(mix(rgb, 0, 0.3)));
    g.beginPath();
    g.arc(c, c, core, 0, Math.PI * 2);
    g.fillStyle = bead;
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = "rgba(255,255,255,0.35)";
    g.stroke();
  }

  if (label) {
    g.font = `700 ${label.length > 2 ? 22 : 28}px Satoshi, system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = s.approximate ? "rgba(242,244,248,0.96)" : "rgba(8,10,20,0.9)";
    g.fillText(label, c, c + 1.5);
  }

  if (s.selected) {
    g.beginPath();
    g.arc(c, c, core + 9, 0, Math.PI * 2);
    g.lineWidth = 3.5;
    g.strokeStyle = "rgba(255,255,255,0.95)";
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

/** Sprite size in CSS pixels, glow included (the bead is about 30% of it for one
 *  client, 47% with a count): a single client is small, a crowd grows slowly. */
export function markPx(count: number): number {
  return count < 2 ? 34 : Math.min(76, 42 + 6 * Math.log2(count));
}

export function makeSprite(): THREE.Sprite {
  const m = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, sizeAttenuation: false });
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
  const k = markPx(style.count) * pxToScale * grow;
  s.scale.set(k, k, 1);
}

/** Frees every cached texture (on unmount). */
export function disposeMarkTextures() {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
