// R-449: a bill's logo, shrunk in the browser before it is saved. The logo rides the bill row
// itself as a small data URL (like a staff avatar), so it syncs to every device with no file
// to ship. The rules are bills_core::MAX_LOGO_CHARS (40,000 characters) and "PNG or JPEG
// data URL"; the Rust command enforces both again, this just keeps a normal picture under them.
//
// Not the avatar helper: that one encodes JPEG, which paints a transparent background black,
// and a logo is mostly a shape on nothing. PNG first, transparency kept; JPEG only as a last
// resort for a picture too detailed to fit as a PNG.

/** bills_core::MAX_LOGO_CHARS: the most data-URL characters a bill may carry. */
export const LOGO_MAX_CHARS = 40_000;
/** Longest side to try, biggest first. A smaller picture is a smaller string. */
export const LOGO_SIDES = [128, 96, 64] as const;
export const LOGO_TOO_DETAILED = "That image is too detailed for a logo. Try a simpler one.";
export const LOGO_UNREADABLE = "That image could not be read. Try a different one.";

/** The size an image of w x h takes when its longest side is capped at `max`. Never scales up,
 *  keeps the aspect, never returns 0. A zero or missing size (an SVG with no intrinsic width,
 *  a broken file) is null: the caller says it could not be read instead of dividing by zero. */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number } | null {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || max <= 0) return null;
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

export interface LogoEncoders {
  /** The picture as a PNG data URL with its longest side at most `side`. */
  png: (side: number) => string;
  /** The same as a JPEG data URL over a filled background. */
  jpeg: (side: number) => string;
}

/** The first encoding that fits: PNG at each side in turn, then JPEG at each, then give up. */
export function chooseLogo(enc: LogoEncoders, limit = LOGO_MAX_CHARS): string {
  for (const side of LOGO_SIDES) {
    const url = enc.png(side);
    if (url.length <= limit) return url;
  }
  for (const side of LOGO_SIDES) {
    const url = enc.jpeg(side);
    if (url.length <= limit) return url;
  }
  throw new Error(LOGO_TOO_DETAILED);
}

function load(src: Blob | string): Promise<{ img: HTMLImageElement; release: () => void }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = typeof src === "string" ? src : URL.createObjectURL(src);
    const release = () => { if (typeof src !== "string") URL.revokeObjectURL(url); };
    img.onload = () => resolve({ img, release });
    img.onerror = () => { release(); reject(new Error(LOGO_UNREADABLE)); };
    img.src = url;
  });
}

/** A picked file, or a data URL (the website icon), as a logo data URL that fits a bill.
 *  Throws a plain sentence when it cannot be read or cannot be made small enough. */
export async function resizeLogo(src: Blob | string): Promise<string> {
  const { img, release } = await load(src);
  try {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!fitWithin(w, h, LOGO_SIDES[0])) throw new Error(LOGO_UNREADABLE);
    const render = (side: number, type: "image/png" | "image/jpeg") => {
      const size = fitWithin(w, h, side)!;
      const cv = document.createElement("canvas");
      cv.width = size.w;
      cv.height = size.h;
      const ctx = cv.getContext("2d");
      if (!ctx) throw new Error(LOGO_UNREADABLE);
      ctx.imageSmoothingQuality = "high";
      if (type === "image/jpeg") {
        // A JPEG has no transparency, so the background is baked into the pixels. White is
        // right for a logo whatever the theme is, which is why this is not a theme token.
        ctx.fillStyle = "rgb(255 255 255)";
        ctx.fillRect(0, 0, size.w, size.h);
      }
      // PNG: the canvas starts clear and is not filled, so transparency survives.
      ctx.drawImage(img, 0, 0, size.w, size.h);
      return type === "image/jpeg" ? cv.toDataURL(type, 0.8) : cv.toDataURL(type);
    };
    return chooseLogo({ png: (s) => render(s, "image/png"), jpeg: (s) => render(s, "image/jpeg") });
  } finally {
    release();
  }
}
