import { describe, expect, it } from "vitest";
import { approvalsBellCount, isRenewal, renewalLine, renewalTitle, renewalsOf, sinceRenewed } from "./renewals";

const req = (id: string, kind: string, summary = "") => ({ id, kind, entity_id: `lot_${id}`, summary, created_at: "2026-10-01T10:00:00Z" });

describe("the renewal requests", () => {
  it("picks out the stale-listing requests and nothing else", () => {
    const list = [req("a", "listing_stale"), req("b", "client_delete"), req("c", "listing_stale"), req("d", "client_add")];
    expect(renewalsOf(list).map((r) => r.id)).toEqual(["a", "c"]);
    expect(renewalsOf(null)).toEqual([]);
    expect(isRenewal({ kind: "listing_stale" })).toBe(true);
    expect(isRenewal({ kind: "client_delete" })).toBe(false);
  });

  it("the one compact line reads in the singular and the plural", () => {
    expect(renewalLine(1)).toBe("1 listing to renew");
    expect(renewalLine(12)).toBe("12 listings to renew");
  });

  it("the title drops the request's lead and falls back to Listing", () => {
    expect(renewalTitle({ summary: "Renew or mark sold: 12 pallets of tools" })).toBe("12 pallets of tools");
    expect(renewalTitle({ summary: "renew or mark sold:   Box lot" })).toBe("Box lot");
    expect(renewalTitle({ summary: "Mixed lot" })).toBe("Mixed lot");
    expect(renewalTitle({ summary: "" })).toBe("Listing");
    expect(renewalTitle({ summary: "Renew or mark sold: " })).toBe("Listing");
  });
});

describe("the bell counts renewals as one item", () => {
  it("forty stale listings add one, not forty", () => {
    const reqs = Array.from({ length: 40 }, (_, i) => req(String(i), "listing_stale"));
    expect(approvalsBellCount(0, reqs, 0)).toBe(1);
    expect(approvalsBellCount(2, reqs, 3)).toBe(6);
  });
  it("no renewals add nothing", () => {
    expect(approvalsBellCount(0, [], 0)).toBe(0);
  });
  it("a new-client request is its pending customer, a deletion is its own item", () => {
    const reqs = [req("a", "client_add"), req("b", "client_delete"), req("c", "client_delete"), req("d", "listing_stale"), req("e", "listing_stale")];
    expect(approvalsBellCount(1, reqs, 0)).toBe(1 + 2 + 1);
  });
});

describe("how long a listing has gone", () => {
  const today = "2026-10-07";
  it("counts from the lot's own last renewal when it is known", () => {
    expect(sinceRenewed("2026-09-29T14:00:00Z", "2026-10-04", today)).toBe("Renewed 8 days ago");
    expect(sinceRenewed("2026-10-06", "2026-10-04", today)).toBe("Renewed 1 day ago");
    expect(sinceRenewed("2026-10-07T01:00:00Z", "2026-10-04", today)).toBe("Renewed today");
  });
  it("says it was flagged, not renewed, when the lot is not known", () => {
    expect(sinceRenewed(null, "2026-10-04T08:00:00Z", today)).toBe("Flagged 3 days ago");
    expect(sinceRenewed(undefined, "2026-10-06", today)).toBe("Flagged 1 day ago");
    expect(sinceRenewed("", "2026-10-07", today)).toBe("Flagged today");
  });
  it("never reads a negative age or a blank", () => {
    expect(sinceRenewed("2026-10-20", "2026-10-04", today)).toBe("Renewed today");
    expect(sinceRenewed(null, "", today)).toBe("Not renewed in 5 or more days");
    expect(sinceRenewed("not a date", "garbage", today)).toBe("Not renewed in 5 or more days");
  });
});
