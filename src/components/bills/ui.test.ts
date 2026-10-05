import { describe, it, expect } from "vitest";
import { okLogo, signed } from "./ui";

// R-449. The two small rules the Bills screen draws money and logos with.

describe("signed", () => {
  it("puts the minus in front of the dollar sign", () => {
    expect(signed(-12)).toBe("−$12.00");
    expect(signed(1234.5)).toBe("$1,234.50");
  });
  it("writes zero, negative zero and less than half a cent as $0.00", () => {
    // Negating a zero total (the "less shipping" step of an org with none) gives -0.
    expect(signed(-0)).toBe("$0.00");
    expect(signed(-0.004)).toBe("$0.00");
    expect(signed(0.004)).toBe("$0.00");
    expect(signed(-0.005)).toBe("−$0.01");
  });
});

describe("okLogo", () => {
  it("accepts only a PNG or JPEG data address", () => {
    expect(okLogo("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(okLogo("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
  });
  it("refuses an address that would make the window fetch something, and anything else", () => {
    expect(okLogo("https://example.com/logo.png")).toBe(false);
    expect(okLogo("http://127.0.0.1/pixel.gif")).toBe(false);
    expect(okLogo("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(okLogo("data:text/html;base64,PGI+")).toBe(false);
    expect(okLogo("")).toBe(false);
    expect(okLogo(undefined)).toBe(false);
  });
});
