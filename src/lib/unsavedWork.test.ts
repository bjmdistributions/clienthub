import { afterEach, describe, expect, it } from "vitest";
import { UNSAVED_LEAVE, confirmLeaveUnsaved, hasUnsavedWork, setUnsavedWork } from "./unsavedWork";

afterEach(() => setUnsavedWork(false));

describe("unsaved work", () => {
  it("leaves without asking when nothing is unsaved", () => {
    let asked = 0;
    expect(confirmLeaveUnsaved(() => { asked++; return false; })).toBe(true);
    expect(asked).toBe(0);
  });

  it("asks the plain sentence and stays when the person says no", () => {
    setUnsavedWork(true);
    let message = "";
    expect(confirmLeaveUnsaved((m) => { message = m; return false; })).toBe(false);
    expect(message).toBe(UNSAVED_LEAVE);
    expect(hasUnsavedWork()).toBe(true);
  });

  it("leaves and clears the flag when the person says yes, so a second step does not ask again", () => {
    setUnsavedWork(true);
    expect(confirmLeaveUnsaved(() => true)).toBe(true);
    expect(hasUnsavedWork()).toBe(false);
  });
});
