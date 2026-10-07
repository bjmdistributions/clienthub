import { describe, expect, it } from "vitest";
import type { LeadNotification } from "./api";
import {
  ADMIN_NOTICE_KINDS, DESKTOP_NOTIFY_KEY, FIRST_RUN_WINDOW_MS, BILL_OPEN_KEY, PAY_TRACKER_KEY, PAY_TRACKER_SUB, NOTICE_KIND_LABEL, TEAM_NOTICE_KINDS, noticeTone, RAISE_CAP, SEEN_CAP, canOpenTarget, canSeeTeamNotices, derivedKindsOf, desktopNoticesOn,
  logisticsBellCount, mergeSeen, noticeTarget, planDerived, planTeamRaise, readSeen, seenKey, teamNoticesOf, writeSeen,
  type NoticeLoad,
} from "./notices";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const note = (id: string, kind: string, over: Partial<LeadNotification> = {}): LeadNotification => ({
  id, org_id: "o1", kind: kind as LeadNotification["kind"], title: `Title ${id}`, body: `Body ${id}`, payload_json: null, entity_id: null,
  status: "unread", acknowledged_at: null, acknowledged_by: null, created_at: hoursAgo(1), ...over,
});

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, v); } };
};

describe("who sees the team notices", () => {
  it("admins, deal viewers and book viewers do; others and Logistics-only accounts do not", () => {
    expect(canSeeTeamNotices({ permissions: ["*"] })).toBe(true);
    expect(canSeeTeamNotices({ permissions: ["admin:manage"] })).toBe(true);
    expect(canSeeTeamNotices({ permissions: ["deal_flow:view"] })).toBe(true);
    expect(canSeeTeamNotices({ permissions: ["financials:view"] })).toBe(true);
    expect(canSeeTeamNotices({ permissions: ["clients:view"] })).toBe(false);
    expect(canSeeTeamNotices({ permissions: ["logistics:view", "logistics:edit"] })).toBe(false);
    expect(canSeeTeamNotices(null)).toBe(false);
  });
});

describe("the list of team notices", () => {
  it("keeps only the six kinds, unread, newest first", () => {
    const list = [
      note("a", "carrier_due", { created_at: hoursAgo(5) }),
      note("b", "supply_lead"),
      note("c", "bill_overdue", { created_at: hoursAgo(2) }),
      note("d", "bill_paid", { status: "acknowledged" }),
      note("e", "logistics_quote", { created_at: hoursAgo(3) }),
    ];
    expect(teamNoticesOf(list).map((n) => n.id)).toEqual(["c", "e", "a"]);
    expect(teamNoticesOf(null)).toEqual([]);
  });
});

describe("the pay-day notice (R-464)", () => {
  const payDay = (id: string, over: Partial<LeadNotification> = {}) =>
    note(id, "logistics_pay_due", { title: "Pay Sam Rivera today", body: "2 loads. Open it to record the payment.", payload_json: '{"pay_date":"2026-10-09"}', ...over });

  it("is one of the team kinds, and the only admin kind", () => {
    expect(TEAM_NOTICE_KINDS).toContain("logistics_pay_due");
    expect([...ADMIN_NOTICE_KINDS]).toEqual(["logistics_pay_due"]);
  });
  it("an admin sees it in the list, newest first among the rest", () => {
    const list = [note("a", "carrier_due", { created_at: hoursAgo(5) }), payDay("p", { created_at: hoursAgo(1) }), note("b", "bill_due", { created_at: hoursAgo(3) })];
    expect(teamNoticesOf(list, true).map((n) => n.id)).toEqual(["p", "b", "a"]);
  });
  it("anyone else never sees it, whatever the server sent", () => {
    const list = [payDay("p"), note("a", "carrier_due")];
    expect(teamNoticesOf(list, false).map((n) => n.id)).toEqual(["a"]);
    expect(teamNoticesOf(list).map((n) => n.id)).toEqual(["a"]);
  });
  it("an acknowledged one is gone", () => {
    expect(teamNoticesOf([payDay("p", { status: "acknowledged" })], true)).toEqual([]);
  });
  it("opens the pay tracker, for an admin only", () => {
    const t = noticeTarget(payDay("p"));
    expect(t).toEqual({ to: "paytracker" });
    expect(canOpenTarget(t, { permissions: ["*"] })).toBe(true);
    expect(canOpenTarget(t, { permissions: ["admin:manage"] })).toBe(true);
    expect(canOpenTarget(t, { permissions: ["financials:view", "deal_flow:view"] })).toBe(false);
    expect(canOpenTarget(t, null)).toBe(false);
  });
  it("opens the tracker even when the payload is empty or broken", () => {
    expect(noticeTarget({ kind: "logistics_pay_due", payload_json: null })).toEqual({ to: "paytracker" });
    expect(noticeTarget({ kind: "logistics_pay_due", payload_json: "nope" })).toEqual({ to: "paytracker" });
  });
  it("reads as a warning labelled Pay day, with the handoff keys named", () => {
    expect(NOTICE_KIND_LABEL.logistics_pay_due).toBe("Pay day");
    expect(noticeTone("logistics_pay_due")).toBe("warning");
    expect(PAY_TRACKER_KEY).toBe("settings_team_sub");
    expect(PAY_TRACKER_SUB).toBe("payouts");
  });
  it("is raised once per device like the others, with no dollar figure in it", () => {
    const n = payDay("p");
    const first = planTeamRaise([n], [], NOW);
    expect(first.raise.map((x) => x.id)).toEqual(["p"]);
    expect(first.raise[0].title + first.raise[0].body).not.toContain("$");
    expect(planTeamRaise([n], first.seen, NOW).raise).toEqual([]);
  });
});

describe("where a notice opens", () => {
  it("a quote opens its load on Quote, a carrier alert on Pay", () => {
    expect(noticeTarget({ kind: "logistics_quote", payload_json: '{"booking_id":"fb_1"}' })).toEqual({ to: "load", id: "fb_1", step: "quote" });
    expect(noticeTarget({ kind: "carrier_due", payload_json: '{"booking_id":"fb_2"}' })).toEqual({ to: "load", id: "fb_2", step: "pay" });
    expect(noticeTarget({ kind: "carrier_overdue", payload_json: '{"booking_id":"fb_3"}' })).toEqual({ to: "load", id: "fb_3", step: "pay" });
  });
  it("a bill opens the Bills screen, on the bill when the payload names one", () => {
    expect(noticeTarget({ kind: "bill_due", payload_json: '{"bill_id":"b_9"}' })).toEqual({ to: "bill", id: "b_9" });
    expect(noticeTarget({ kind: "bill_overdue", payload_json: null })).toEqual({ to: "bill" });
    expect(noticeTarget({ kind: "bill_paid", payload_json: "not json" })).toEqual({ to: "bill" });
  });
  it("a payload with no load falls back to the screen that holds it", () => {
    expect(noticeTarget({ kind: "logistics_quote", payload_json: "{}" })).toEqual({ to: "logistics" });
    expect(noticeTarget({ kind: "carrier_due", payload_json: '{"booking_id":""}' })).toEqual({ to: "bill" });
  });
  it("any other kind opens nothing", () => {
    expect(noticeTarget({ kind: "supply_lead", payload_json: "{}" })).toBeNull();
  });
  it("Open shows only where the person can go", () => {
    const books = { permissions: ["financials:view"] };
    const deals = { permissions: ["deal_flow:view"] };
    expect(canOpenTarget({ to: "bill" }, books)).toBe(true);
    expect(canOpenTarget({ to: "load", id: "x", step: "pay" }, books)).toBe(false);
    expect(canOpenTarget({ to: "load", id: "x", step: "quote" }, deals)).toBe(true);
    expect(canOpenTarget({ to: "bill" }, deals)).toBe(false);
    expect(canOpenTarget(null, deals)).toBe(false);
    expect(canOpenTarget({ to: "bill" }, { permissions: ["*"] })).toBe(true);
  });
});

describe("the seen set", () => {
  it("reads null before anything is stored, and a stored list after", () => {
    const s = mem();
    const k = seenKey("team", "u1");
    expect(readSeen(s, k)).toBeNull();
    writeSeen(s, k, ["a", "b"]);
    expect(readSeen(s, k)).toEqual(["a", "b"]);
  });
  it("junk or blocked storage reads as a first run and never throws", () => {
    const s = mem();
    s.setItem("k", "{oops");
    expect(readSeen(s, "k")).toBeNull();
    expect(readSeen(null, "k")).toBeNull();
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readSeen(blocked, "k")).toBeNull();
    expect(() => writeSeen(blocked, "k", ["a"])).not.toThrow();
    expect(desktopNoticesOn(blocked)).toBe(true);
  });
  it("keys differ per person and per source", () => {
    expect(seenKey("team", "u1")).not.toBe(seenKey("team", "u2"));
    expect(seenKey("team", "u1")).not.toBe(seenKey("derived", "u1"));
  });
  it("merges without repeats, newest last, and trims to the cap", () => {
    expect(mergeSeen(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
    expect(mergeSeen(null, ["x"])).toEqual(["x"]);
    const big = Array.from({ length: SEEN_CAP }, (_, i) => `id${i}`);
    const out = mergeSeen(big, ["new"]);
    expect(out).toHaveLength(SEEN_CAP);
    expect(out[out.length - 1]).toBe("new");
    expect(out[0]).toBe("id1");
  });
  it("the Desktop notifications switch is on by default and off only when set to 0", () => {
    const s = mem();
    expect(desktopNoticesOn(s)).toBe(true);
    s.setItem(DESKTOP_NOTIFY_KEY, "0");
    expect(desktopNoticesOn(s)).toBe(false);
    s.setItem(DESKTOP_NOTIFY_KEY, "1");
    expect(desktopNoticesOn(s)).toBe(true);
  });
});

describe("raising the team's notices", () => {
  it("on a first run raises only notices from the last two days and marks every one seen", () => {
    const list = [note("old", "bill_due", { created_at: hoursAgo(24 * 5) }), note("new", "carrier_due", { created_at: hoursAgo(3) })];
    const plan = planTeamRaise(list, null, NOW);
    expect(plan.raise.map((n) => n.id)).toEqual(["new"]);
    expect(plan.seen).toEqual(["old", "new"]);
    expect(FIRST_RUN_WINDOW_MS).toBe(2 * 24 * 3600 * 1000);
  });
  it("a notice exactly at the window edge still counts and one with a junk date does not (first run)", () => {
    const plan = planTeamRaise([note("edge", "bill_due", { created_at: hoursAgo(48) }), note("junk", "bill_due", { created_at: "nope" })], null, NOW);
    expect(plan.raise.map((n) => n.id)).toEqual(["edge"]);
  });
  it("after the first run every notice not seen is raised once, whatever its age", () => {
    const list = [note("a", "bill_due", { created_at: hoursAgo(24 * 9) }), note("b", "bill_due")];
    const first = planTeamRaise(list, ["b"], NOW);
    expect(first.raise.map((n) => n.id)).toEqual(["a"]);
    const again = planTeamRaise(list, first.seen, NOW);
    expect(again.raise).toEqual([]);
  });
  it("raises oldest first and no more than the cap per poll, marking the rest seen", () => {
    const list = Array.from({ length: RAISE_CAP + 3 }, (_, i) => note(`n${i}`, "bill_overdue", { created_at: hoursAgo(20 - i) }));
    const plan = planTeamRaise(list, [], NOW);
    expect(plan.raise).toHaveLength(RAISE_CAP);
    expect(plan.raise.map((n) => n.id)).toEqual(list.slice(-RAISE_CAP).map((n) => n.id));
    expect(plan.seen).toHaveLength(list.length);
  });
});

const load = (id: string, status: string, over: Partial<NoticeLoad> = {}): NoticeLoad => ({ id, status, code: `L-${id}`, load_number: `LD-00${id}`, ...over });
const route = () => "Dallas to Newark";

describe("what a Logistics-only account is told", () => {
  it("names the kinds a load is in", () => {
    expect(derivedKindsOf({ status: "quote" })).toEqual(["quote"]);
    expect(derivedKindsOf({ status: "requested" })).toEqual(["book"]);
    expect(derivedKindsOf({ status: "requested", urgent: true })).toEqual(["book", "urgent"]);
    expect(derivedKindsOf({ status: "booked", urgent: true })).toEqual(["urgent"]);
    expect(derivedKindsOf({ status: "picked_up", urgent: true })).toEqual([]);
    expect(derivedKindsOf({ status: "booked" })).toEqual([]);
    expect(derivedKindsOf({ status: "quote", archived: true })).toEqual([]);
    expect(derivedKindsOf({ status: "cancelled", urgent: true })).toEqual([]);
  });
  it("the bell counts Quotes to give plus To book", () => {
    const rows = [load("1", "quote"), load("2", "requested"), load("3", "booked"), load("4", "requested", { urgent: true }), load("5", "quote", { archived: true }), load("6", "delivered")];
    expect(logisticsBellCount(rows)).toBe(3);
    expect(logisticsBellCount(null)).toBe(0);
  });
  it("the first poll raises nothing and seeds what already exists", () => {
    const rows = [load("1", "quote"), load("2", "requested", { urgent: true })];
    const plan = planDerived(rows, null, route);
    expect(plan.raise).toEqual([]);
    expect(plan.seen.sort()).toEqual(["1:quote", "2:book", "2:urgent"]);
  });
  it("a load that arrives later is raised once, with the load number and route", () => {
    const seeded = planDerived([load("1", "quote")], null, route).seen;
    const rows = [load("1", "quote"), load("2", "quote"), load("3", "requested")];
    const plan = planDerived(rows, seeded, route);
    expect(plan.raise.map((r) => [r.kind, r.title, r.body])).toEqual([
      ["quote", "Quote needed", "LD-002, Dallas to Newark"],
      ["book", "To book", "LD-003, Dallas to Newark"],
    ]);
    expect(planDerived(rows, plan.seen, route).raise).toEqual([]);
  });
  it("a load that moves on raises for its new state only, and urgent is raised when it turns urgent", () => {
    const seeded = planDerived([load("1", "quote"), load("2", "booked")], null, route).seen;
    const moved = planDerived([load("1", "requested"), load("2", "booked", { urgent: true })], seeded, route);
    expect(moved.raise.map((r) => `${r.id}:${r.kind}`)).toEqual(["1:book", "2:urgent"]);
  });
  it("a load with no visible route reads as its number alone", () => {
    const plan = planDerived([load("9", "quote")], [], () => "");
    expect(plan.raise[0].body).toBe("LD-009");
  });
  it("falls back to the old code when the load has no number yet", () => {
    const plan = planDerived([{ id: "7", status: "quote", code: "L-ab12cd" }], [], route);
    expect(plan.raise[0].body).toBe("L-ab12cd, Dallas to Newark");
  });
  it("caps the alerts of one poll", () => {
    const rows = Array.from({ length: RAISE_CAP + 4 }, (_, i) => load(String(i), "quote"));
    const plan = planDerived(rows, [], route);
    expect(plan.raise).toHaveLength(RAISE_CAP);
    expect(plan.seen).toHaveLength(rows.length);
  });
});

describe("how a notice reads", () => {
  it("every kind has a label and a tone", () => {
    for (const k of TEAM_NOTICE_KINDS) expect(NOTICE_KIND_LABEL[k]).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
    expect(noticeTone("bill_overdue")).toBe("danger");
    expect(noticeTone("carrier_overdue")).toBe("danger");
    expect(noticeTone("carrier_due")).toBe("warning");
    expect(noticeTone("bill_paid")).toBe("success");
    expect(noticeTone("logistics_quote")).toBe("neutral");
    expect(BILL_OPEN_KEY).toBe("bills_open_id");
  });
});
