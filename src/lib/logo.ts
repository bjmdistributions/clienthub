// R-638/R-642: a logo for the reply signature, shrunk here to at most 400 by 160 so every reply carries a small
// picture. Resolves to a PNG (or JPEG) data URL; rejects with a sentence to show.
export function shrinkLogo(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg)$/.test(file.type)) { reject(new Error("Choose a PNG or JPEG picture.")); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 400 / img.width, 160 / img.height);
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const data = c.toDataURL(file.type === "image/jpeg" ? "image/jpeg" : "image/png", 0.9);
      if (data.length > 400_000) reject(new Error("That picture is too big even when shrunk. Try a simpler logo."));
      else resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That picture could not be read.")); };
    img.src = url;
  });
}
