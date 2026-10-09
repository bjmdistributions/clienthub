// R-485: the basemap, made Ecliptr's. OpenFreeMap's "positron" and "dark" styles are fetched as JSON and recoloured here
// before MapLibre sees them, so the first frame is already right and a theme change is one new style, not a flash of the
// default one. Pure functions on plain objects: LogisticsMap.tsx reads the app's colours from the CSS variables and passes
// them in; nothing here touches the DOM, so vitest holds it (freightMapStyle.test.ts).
//
// What changes: the land is the app's surface colour, water a quiet blue-grey, labels a little quieter and in the case a
// name is written in. Roads, rails and
// boundaries keep the style's own design. On the dark style the whole palette moves up by the same amount the land does
// (the style's land is near black, and a map Jack calls "entirely black" is a map he cannot read), so the roads, outlines
// and labels keep the contrast they were drawn with.

export type Rgb = [number, number, number];
export interface BaseTheme {
  dark: boolean;
  /** The ground: the app's surface colour (lifted on the dark map). */
  land: Rgb;
  /** Lakes, rivers and the sea. */
  water: Rgb;
}
export interface StyleLayer {
  id: string; type: string; "source-layer"?: string; paint?: Record<string, unknown>; [k: string]: unknown;
}
export interface StyleJson { layers: StyleLayer[]; [k: string]: unknown }

/** How far a label's colour moves toward the land: 0 leaves it as the style has it, 1 hides it. */
export const LABEL_MUTE = 0.2;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as Rgb;
}

const SEP = "(?:\\s*,\\s*|\\s+)";
const NUM = "([\\d.]+)(%?)";
const RGB_RE = new RegExp(`^rgba?\\(\\s*${NUM}${SEP}${NUM}${SEP}${NUM}(?:\\s*[,/]\\s*([\\d.]+%?))?\\s*\\)$`, "i");
const HSL_RE = new RegExp(`^hsla?\\(\\s*([\\d.]+)(?:deg)?${SEP}([\\d.]+)%${SEP}([\\d.]+)%(?:\\s*[,/]\\s*([\\d.]+%?))?\\s*\\)$`, "i");

const alphaOf = (a: string | undefined): number => (a === undefined ? 1 : clamp(a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a), 0, 1));

/** A CSS colour (hex, rgb(), rgba(), hsl(), hsla(), with commas or spaces) as red, green, blue and alpha. null for anything else. */
export function parseColor(s: string): { rgb: Rgb; a: number } | null {
  const t = s.trim();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(t);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { rgb: [n(0), n(2), n(4)], a: h.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
  }
  m = RGB_RE.exec(t);
  if (m) {
    const ch = (v: string, pct: string) => clamp(Math.round(pct ? (parseFloat(v) / 100) * 255 : parseFloat(v)), 0, 255);
    return { rgb: [ch(m[1], m[2]), ch(m[3], m[4]), ch(m[5], m[6])], a: alphaOf(m[7]) };
  }
  m = HSL_RE.exec(t);
  if (m) {
    const h = (((parseFloat(m[1]) % 360) + 360) % 360) / 360, sat = clamp(parseFloat(m[2]), 0, 100) / 100, l = clamp(parseFloat(m[3]), 0, 100) / 100;
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p = 2 * l - q;
    const hue = (x: number) => {
      const k = (x + 1) % 1;
      return k < 1 / 6 ? p + (q - p) * 6 * k : k < 1 / 2 ? q : k < 2 / 3 ? p + (q - p) * (2 / 3 - k) * 6 : p;
    };
    return { rgb: [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((v) => Math.round(v * 255)) as Rgb, a: alphaOf(m[4]) };
  }
  return null;
}

export const formatColor = (rgb: Rgb, a = 1): string => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.round(a * 1000) / 1000})`;

/** Every colour string inside a paint value (a plain colour, or a zoom expression that holds some) through `fn`. */
function mapColors(v: unknown, fn: (c: { rgb: Rgb; a: number }) => { rgb: Rgb; a: number }): unknown {
  if (typeof v === "string") {
    const c = parseColor(v);
    if (!c) return v;
    const out = fn(c);
    return formatColor(out.rgb, out.a);
  }
  return Array.isArray(v) ? v.map((x) => mapColors(x, fn)) : v;
}

const isColorProp = (key: string) => key.endsWith("-color");

/** A style with Ecliptr's colours. The input is not changed. */
export function recolor(style: StyleJson, t: BaseTheme): StyleJson {
  const bgLayer = style.layers.find((l) => l.type === "background");
  const bg0 = typeof bgLayer?.paint?.["background-color"] === "string" ? parseColor(bgLayer.paint["background-color"] as string) : null;
  // The dark style is lifted by the amount its land is: the style's own near black becomes the land, and every other colour
  // moves the same distance, so its roads, outlines and labels keep their contrast with the ground.
  const shift: Rgb = t.dark && bg0 ? [t.land[0] - bg0.rgb[0], t.land[1] - bg0.rgb[1], t.land[2] - bg0.rgb[2]] : [0, 0, 0];
  const lift = (rgb: Rgb): Rgb => [0, 1, 2].map((i) => clamp(rgb[i] + shift[i], 0, 255)) as Rgb;
  const isLand = (c: { rgb: Rgb; a: number }) => !!bg0 && c.a === 1 && c.rgb.every((v, i) => v === bg0.rgb[i]);

  const layers = style.layers.map((layer): StyleLayer => {
    // A place name reads as a name, not a shout: the dark style sets its state and country labels in capitals.
    const layout = layer.layout as Record<string, unknown> | undefined;
    const out: StyleLayer = layer.type === "symbol" && layout?.["text-transform"] === "uppercase" ? { ...layer, layout: { ...layout, "text-transform": "none" } } : layer;
    if (!layer.paint) return out;
    const water = (layer.type === "fill" && layer["source-layer"] === "water") || (layer.type === "line" && layer["source-layer"] === "waterway");
    const paint: Record<string, unknown> = { ...layer.paint };
    for (const key of Object.keys(paint)) {
      if (!isColorProp(key)) continue;
      if (layer.type === "background" || (water && (key === "fill-color" || key === "line-color"))) {
        paint[key] = formatColor(layer.type === "background" ? t.land : t.water);
        continue;
      }
      const text = layer.type === "symbol" && key === "text-color";
      paint[key] = mapColors(paint[key], (c) => {
        if (isLand(c)) return { rgb: t.land, a: 1 };
        const moved = lift(c.rgb);
        return { rgb: text ? mix(moved, t.land, LABEL_MUTE) : moved, a: c.a };
      });
    }
    return { ...out, paint };
  });
  return { ...style, layers };
}
