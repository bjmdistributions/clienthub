/**
 * Cross-dock — the arcade.
 *
 * Every sound here is synthesised at runtime from oscillators and shaped noise. There
 * are no audio files anywhere in this app and this does not add any: a slot machine's
 * whole vocabulary is clicks, thunks, blips and a fanfare, all of which are cheaper to
 * generate than to ship, and generating them means the pitch can follow the game (each
 * reel thunks a tone lower than the last, a win chime rises with the size of the win).
 *
 * Two rules the browser imposes, and one this app imposes:
 *
 *   - An AudioContext may not start before a user gesture, so it is created lazily on
 *     the first press of Spin — which IS the gesture — and never at import time.
 *   - Scheduling is absolute against ctx.currentTime, never setTimeout, so a busy main
 *     thread cannot make the reel ticks stutter.
 *   - Muted is remembered per device, like every other per-device preference here, and
 *     a muted machine builds no AudioContext at all.
 */

const MUTE_KEY = "clienthub_crossdock_muted";

export type ReelTone = 0 | 1 | 2 | 3 | 4;

export class Arcade {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** The spin loop's nodes, held so they can be stopped and rebuilt per spin. */
  private whirr: { osc: OscillatorNode; gain: GainNode } | null = null;
  private tickTimer = 0;

  muted: boolean;

  constructor() {
    let m = false;
    try { m = localStorage.getItem(MUTE_KEY) === "1"; } catch { /* private window */ }
    this.muted = m;
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? "1" : "0"); } catch { /* private window */ }
    if (m) this.stopSpin();
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.02);
  }

  /** Built on demand, inside the click that asked for a sound. */
  private ready(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      try { this.ctx = new Ctor(); } catch { return null; }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    // resume() rejects if the browser has not seen a gesture yet, or if the window is
    // hidden. Neither is worth an unhandled rejection over a sound effect.
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => { /* stays silent */ });
    return this.ctx;
  }

  /** One enveloped oscillator. The building block for every pitched sound below. */
  private tone(
    at: number, freq: number, dur: number,
    { type = "square" as OscillatorType, gain = 0.18, to = freq, curve = 0.6 } = {},
  ) {
    const ctx = this.ctx!, out = this.master!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur * curve + 0.004);
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  /** A short burst of filtered noise — the body of every mechanical sound here. */
  private thump(at: number, cutoff: number, dur: number, gain = 0.3) {
    const ctx = this.ctx!, out = this.master!;
    const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(cutoff, at);
    f.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.25), at + dur);
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(out);
    src.start(at);
  }

  /** The Spin button. */
  press() {
    const ctx = this.ready(); if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(t, 880, 0.07, { gain: 0.14, to: 620 });
  }

  /**
   * The reels turning: a low mechanical whirr, plus a tick for every symbol that passes.
   * `symbolsPerSecond` is the real cruise rate, so what you hear matches what you see.
   */
  startSpin(symbolsPerSecond: number) {
    const ctx = this.ready(); if (!ctx) return;
    this.stopSpin();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(38, t);
    osc.frequency.linearRampToValueAtTime(52, t + 0.25);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 320;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.12);
    osc.connect(f).connect(g).connect(this.master!);
    osc.start(t);
    this.whirr = { osc, gain: g };

    // Ticks are scheduled ahead in batches against the audio clock, so a stalled main
    // thread cannot make them limp.
    const period = 1 / symbolsPerSecond;
    let next = t + period;
    const pump = () => {
      if (!this.ctx || !this.whirr) return;
      const horizon = this.ctx.currentTime + 0.3;
      while (next < horizon) { this.thump(next, 2600, 0.02, 0.05); next += period; }
      this.tickTimer = window.setTimeout(pump, 120);
    };
    pump();
  }

  /** One reel landing. Each reel a tone lower than the last, so the cascade descends. */
  reelStop(i: ReelTone) {
    const ctx = this.ready(); if (!ctx) return;
    const t = ctx.currentTime;
    this.thump(t, 900 - i * 90, 0.13, 0.42);
    this.tone(t, 300 - i * 26, 0.1, { type: "triangle", gain: 0.14, to: 150 - i * 12 });
  }

  stopSpin() {
    if (this.tickTimer) { clearTimeout(this.tickTimer); this.tickTimer = 0; }
    const w = this.whirr;
    if (!w || !this.ctx) { this.whirr = null; return; }
    const t = this.ctx.currentTime;
    w.gain.gain.cancelScheduledValues(t);
    w.gain.gain.setValueAtTime(Math.max(0.0001, w.gain.gain.value), t);
    w.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    w.osc.stop(t + 0.2);
    this.whirr = null;
  }

  /** A paying line revealing. `step` climbs with each line so a good spin ascends. */
  lineHit(step: number) {
    const ctx = this.ready(); if (!ctx) return;
    const t = ctx.currentTime;
    const f = 523.25 * Math.pow(2, Math.min(step, 7) / 12);
    this.tone(t, f, 0.1, { gain: 0.16 });
    this.tone(t + 0.05, f * 1.5, 0.12, { gain: 0.12 });
  }

  /** Credits counting up: a coin per tick, capped so a big win does not become a drone. */
  coins(count: number) {
    const ctx = this.ready(); if (!ctx) return;
    const t = ctx.currentTime;
    const n = Math.max(1, Math.min(14, count));
    for (let i = 0; i < n; i++) {
      const at = t + i * 0.055;
      this.tone(at, 1200 + (i % 3) * 140, 0.05, { gain: 0.09 });
      this.thump(at, 5200, 0.02, 0.05);
    }
  }

  /** Three sizes of celebration, and they are genuinely different lengths. */
  fanfare(size: "big" | "grand" | "bonus") {
    const ctx = this.ready(); if (!ctx) return;
    const t = ctx.currentTime;
    const runs: Record<typeof size, number[]> = {
      bonus: [523.25, 659.25, 783.99, 1046.5],
      big: [523.25, 659.25, 783.99, 1046.5, 1318.5],
      grand: [392, 523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98, 2093],
    };
    const notes = runs[size];
    notes.forEach((f, i) => {
      const at = t + i * (size === "grand" ? 0.1 : 0.08);
      this.tone(at, f, size === "grand" ? 0.34 : 0.2, { type: "square", gain: 0.15 });
      this.tone(at, f / 2, size === "grand" ? 0.34 : 0.2, { type: "triangle", gain: 0.09 });
    });
    if (size === "grand") {
      const end = t + notes.length * 0.1;
      [0, 0.09, 0.18].forEach((d) => this.tone(end + d, 2093, 0.5, { type: "square", gain: 0.13 }));
      this.thump(end, 7000, 0.5, 0.14);
    }
  }

  /** Out of money. The one sound in the set that falls rather than rises. */
  bust() {
    const ctx = this.ready(); if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(t, 320, 0.3, { type: "sawtooth", gain: 0.12, to: 90 });
  }

  dispose() {
    this.stopSpin();
    try { void this.ctx?.close(); } catch { /* already gone */ }
    this.ctx = null;
    this.master = null;
  }
}
