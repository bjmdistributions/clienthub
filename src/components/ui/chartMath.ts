// The pure maths behind MonoAreaChart (ported from the approved Home mockup).

/** A "nice" top for the y axis: four equal steps of 1, 2, 2.5, 5 or 10 times a power of ten, at or above v. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 4;
  const raw = v / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  return step * 4;
}

export interface Curve {
  /** SVG path data ("M x y C ..."). */
  path: string;
  /** The curve's y at any x, evaluated on the same Hermite segments the path draws. */
  at: (x: number) => number;
}

/** Monotone cubic through the points (Fritsch-Carlson): it never overshoots a data point, so the line is
 *  never wavy between two close values. xs must be increasing. */
export function mono(xs: number[], ys: number[]): Curve {
  const n = xs.length;
  if (n === 0) return { path: "", at: () => 0 };
  if (n === 1) return { path: `M${xs[0]} ${ys[0]}`, at: () => ys[0] };
  const d: number[] = [], m = new Array<number>(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / ((xs[i + 1] - xs[i]) || 1));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let path = `M${xs[0].toFixed(2)} ${ys[0].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1] - xs[i];
    path += ` C${(xs[i] + h / 3).toFixed(2)} ${(ys[i] + m[i] * h / 3).toFixed(2)} ${(xs[i + 1] - h / 3).toFixed(2)} ${(ys[i + 1] - m[i + 1] * h / 3).toFixed(2)} ${xs[i + 1].toFixed(2)} ${ys[i + 1].toFixed(2)}`;
  }
  const at = (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && xs[i + 1] < x) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
  return { path, at };
}

/** Compact axis numbers: 950, 1.2k, 12k, 3.4M. */
export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(v));
}
