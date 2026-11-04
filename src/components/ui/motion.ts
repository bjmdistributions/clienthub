import { useEffect, useRef, useState } from "react";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Ease-out quart: fast start, long soft landing. The curve every figure and chart morph uses. */
export const easeOutQuart = (p: number) => 1 - Math.pow(1 - p, 4);

/** A number that counts to its new value when it changes. The first value is shown as is (no count from
 *  zero on mount); null passes through. Reduced motion jumps straight to the value. */
export function useCountUp(target: number | null, ms = 700): number | null {
  const [shown, setShown] = useState<number | null>(target);
  const from = useRef<number | null>(target);
  const raf = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (target === null || from.current === null || prefersReducedMotion() || from.current === target) {
      from.current = target;
      setShown(target);
      return;
    }
    const a = from.current, b = target, t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const v = a + (b - a) * easeOutQuart(p);
      from.current = v;
      setShown(v);
      if (p < 1) raf.current = requestAnimationFrame(step);
      else from.current = b;
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms]);
  return shown;
}
