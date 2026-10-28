import { describe, expect, it } from "vitest";
import { authReasonWords } from "./ReconnectSheet";

describe("authReasonWords", () => {
  it("says why for each reason the server gives", () => {
    expect(authReasonWords("expired")).toBe("This device was not used for 90 days, so it was signed out.");
    expect(authReasonWords("password_changed")).toBe("Your password was changed, so this device needs the new one.");
    expect(authReasonWords("account_off")).toBe("This account is switched off. Ask the owner to turn it back on.");
  });
  it("falls back for signed_out, an unknown reason, or none", () => {
    const words = "The server did not accept this device's sign-in.";
    expect(authReasonWords("signed_out")).toBe(words);
    expect(authReasonWords("whatever")).toBe(words);
    expect(authReasonWords(undefined)).toBe(words);
    expect(authReasonWords("")).toBe(words);
  });
});
