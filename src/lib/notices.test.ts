import { describe, expect, it } from "vitest";
import type { LeadNotification } from "./api";
import {
  ADMIN_NOTICE_KINDS, ALERT_ONLY_NOTICE_KINDS, ALERT_NOTICE_KINDS, NEEDS_YOU_NOTICE_KINDS, DESKTOP_NOTIFY_KEY, FIRST_RUN_WINDOW_MS, BILL_OPEN_KEY, PAY_TRACKER_KEY, PAY_TRACKER_SUB, NOTICE_KIND_LABEL, TEAM_NOTICE_KINDS, RAISE_CAP, SEEN_CAP, canOpenTarget, canReadTeamNotices, canSeeTeamNotices, derivedKindsOf, desktopNoticesOn,
  logisticsBellCount, mergeSeen, noticeTarget, planDerived, planTeamRaise, readSeen, seenKey, teamNoticesOf, writeSeen,
  GROUP_LABEL, GROUP_ORDER, bellCountOf, bellTitle, canSeeGroup, compareRows, customerRow, dueDayOf, groupRows, leadNoticesOf, noticeRow, requestRow, whenWearsUrgency, whenWords,
  type NoticeLoad, type NoticeRow,
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

describe("who the server lets read the team notices (R-477)", () => {
  it("only an admin or someone with the clients module; the route is behind it", () => {
    expect(canReadTeamNotices({ permissions: ["*"] })).toBe(true);
    expect(canReadTeamNotices({ permissions: ["admin:manage"] })).toBe(true);
    expect(canReadTeamNotices({ permissions: ["clients:view", "financials:view"] })).toBe(true);
    expect(canReadTeamNotices({ permissions: ["financials:view", "financials:export", "financials:edit"] })).toBe(false);
    expect(canReadTeamNotices({ permissions: ["deal_flow:view"] })).toBe(false);
    expect(canReadTeamNotices({ permissions: [] })).toBe(false);
    expect(canReadTeamNotices(null)).toBe(false);
  });
  it("a books-only role sees the bell but is refused the list, so its read is skipped, not failed", () => {
    const accountant = { permissions: ["financials:view", "financials:export", "financials:edit"] };
    expect(canSeeTeamNotices(accountant)).toBe(true);
    expect(canReadTeamNotices(accountant)).toBe(false);
  });
});

describe("the list of team notices", () => {
  it("keeps only the team kinds, unread, newest first", () => {
    const list = [
      note("a", "carrier_due", { created_at: hoursAgo(5) }),
      note("b", "supply_lead"),
      note("c", "bill_overdue", { created_at: hoursAgo(2) }),
      note("d", "bill_paid", { status: "acknowledged" }),
      note("e", "logistics_quote", { created_at: hoursAgo(3) }),
      note("f", "logistics_bol", { created_at: hoursAgo(4) }),
    ];
    expect(teamNoticesOf(list).map((n) => n.id)).toEqual(["c", "e", "f", "a"]);
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
  it("reads as an amber Pay day, with the handoff keys named", () => {
    expect(NOTICE_KIND_LABEL.logistics_pay_due).toBe("Pay day");
    expect(noticeRow(payDay("p"))?.urgency).toBe("needs");
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
  it("a BOL upload opens its load on the Pay step, or the Logistics screen with no load (R-478)", () => {
    expect(noticeTarget({ kind: "logistics_bol", payload_json: '{"booking_id":"fb_4"}' })).toEqual({ to: "load", id: "fb_4", step: "pay" });
    expect(noticeTarget({ kind: "logistics_bol", payload_json: "{}" })).toEqual({ to: "logistics" });
    expect(noticeTarget({ kind: "logistics_bol", payload_json: null })).toEqual({ to: "logistics" });
    expect(canOpenTarget(noticeTarget({ kind: "logistics_bol", payload_json: '{"booking_id":"fb_4"}' }), { permissions: ["deal_flow:view", "logistics:view"] })).toBe(true);
    expect(canOpenTarget(noticeTarget({ kind: "logistics_bol", payload_json: '{"booking_id":"fb_4"}' }), { permissions: ["financials:view"] })).toBe(false);
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
  it("never raises a paid bill, still marks it seen, and it takes no slot of the cap (R-477)", () => {
    const paid = note("paid", "bill_paid", { created_at: hoursAgo(1) });
    const due = Array.from({ length: RAISE_CAP }, (_, i) => note(`d${i}`, "bill_due", { created_at: hoursAgo(20 - i) }));
    const plan = planTeamRaise([paid, ...due], [], NOW);
    expect(plan.raise.map((n) => n.id)).toEqual(due.map((n) => n.id));
    expect(plan.seen).toContain("paid");
    expect(planTeamRaise([paid], null, NOW).raise).toEqual([]);
    // each kind that asks something of you is still raised
    for (const k of ["logistics_quote", "carrier_due", "carrier_overdue", "bill_due", "bill_overdue", "logistics_pay_due"]) {
      expect(planTeamRaise([note(k, k)], [], NOW).raise.map((n) => n.id)).toEqual([k]);
    }
  });
  it("raises oldest first and no more than the cap per poll, marking the rest seen", () => {
    const list = Array.from({ length: RAISE_CAP + 3 }, (_, i) => note(`n${i}`, "bill_overdue", { created_at: hoursAgo(20 - i) }));
    const plan = planTeamRaise(list, [], NOW);
    expect(plan.raise).toHaveLength(RAISE_CAP);
    expect(plan.raise.map((n) => n.id)).toEqual(list.slice(-RAISE_CAP).map((n) => n.id));
    expect(plan.seen).toHaveLength(list.length);
  });
  it("fills the cap with what needs you first; BOL uploads only take the room left, oldest first (R-478)", () => {
    // an overdue carrier raised before a burst of BOL uploads must not be crowded out by them
    const overdue = note("od", "carrier_overdue", { created_at: hoursAgo(5) });
    const bols = Array.from({ length: RAISE_CAP }, (_, i) => note(`bol${i}`, "logistics_bol", { created_at: hoursAgo(4 - i * 0.5) }));
    const plan = planTeamRaise([...bols, overdue], [], NOW);
    expect(plan.raise).toHaveLength(RAISE_CAP);
    expect(plan.raise.map((n) => n.id)).toEqual(["od", "bol1", "bol2", "bol3", "bol4"]);
    // every fresh id is still marked seen, raised or not
    for (const n of [overdue, ...bols]) expect(plan.seen).toContain(n.id);
    // with room to spare every one is raised, oldest first
    const few = planTeamRaise([bols[1], overdue, bols[0]], [], NOW);
    expect(few.raise.map((n) => n.id)).toEqual(["od", "bol0", "bol1"]);
    // a full set of needs-you notices leaves no room for a BOL
    const bills = Array.from({ length: RAISE_CAP }, (_, i) => note(`b${i}`, "bill_overdue", { created_at: hoursAgo(20 - i) }));
    const full = planTeamRaise([note("late", "logistics_bol", { created_at: hoursAgo(0.5) }), ...bills], [], NOW);
    expect(full.raise.map((n) => n.id)).toEqual(bills.map((n) => n.id));
    expect(full.seen).toContain("late");
  });
  it("does not raise a BOL upload for the person who uploaded it, but still marks it seen (R-478)", () => {
    const mine = note("mine", "logistics_bol", { payload_json: '{"booking_id":"fb_1","by_user":"u_me"}' });
    const theirs = note("theirs", "logistics_bol", { payload_json: '{"booking_id":"fb_2","by_user":"u_other"}' });
    const none = note("none", "logistics_bol", { payload_json: '{"booking_id":"fb_3"}' });
    const nopayload = note("nopayload", "logistics_bol");
    const plan = planTeamRaise([mine, theirs, none, nopayload], [], NOW, "u_me");
    expect(plan.raise.map((n) => n.id).sort()).toEqual(["none", "nopayload", "theirs"]);
    expect(plan.seen).toEqual(expect.arrayContaining(["mine", "theirs", "none", "nopayload"]));
    // the uploader's notice takes no slot of the cap
    const others = Array.from({ length: RAISE_CAP }, (_, i) => note(`o${i}`, "logistics_bol", { created_at: hoursAgo(10 - i) }));
    expect(planTeamRaise([...others, { ...mine, created_at: hoursAgo(0.1) }], [], NOW, "u_me").raise.map((n) => n.id)).toEqual(others.map((n) => n.id));
    // the notice stays in the shared list, and the same notice raises for a different person
    expect(teamNoticesOf([mine]).map((n) => n.id)).toEqual(["mine"]);
    expect(planTeamRaise([mine], [], NOW, "u_other").raise.map((n) => n.id)).toEqual(["mine"]);
    // no signed-in id raises everything, as before
    expect(planTeamRaise([mine], [], NOW).raise.map((n) => n.id)).toEqual(["mine"]);
    expect(planTeamRaise([mine], [], NOW, "").raise.map((n) => n.id)).toEqual(["mine"]);
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
    for (const k of TEAM_NOTICE_KINDS) expect(NOTICE_KIND_LABEL[k]).toMatch(/^[A-Z][A-Za-z]+( [a-z]+)*$/);
    expect(BILL_OPEN_KEY).toBe("bills_open_id");
  });
});

// ─── R-477: the Notifications screen ──────────────────────────────────────

const TODAY = "2026-10-08";
const noon = (day: string) => `${day}T12:00:00Z`;
const row = (over: Partial<NoticeRow>): NoticeRow => ({
  key: "k", group: "bills", kind: "bill_due", label: "Bill due", urgency: "needs", subject: "Warehouse rent", dueDay: "", createdAt: "", ...over,
});

describe("each kind's group, label and urgency", () => {
  const table: [string, string, string, string][] = [
    ["bill_overdue", "bills", "Bill overdue", "overdue"],
    ["bill_due", "bills", "Bill due", "needs"],
    ["bill_paid", "bills", "Bill paid", "info"],
    ["carrier_overdue", "logistics", "Carrier overdue", "overdue"],
    ["carrier_due", "logistics", "Carrier due", "needs"],
    ["logistics_pay_due", "logistics", "Pay day", "needs"],
    ["logistics_quote", "logistics", "Quote ready", "needs"],
    ["logistics_bol", "logistics", "BOL uploaded", "info"],
    ["supply_lead", "leads", "New lead", "needs"],
    ["supplier_profile", "leads", "Supplier details", "info"],
  ];
  it.each(table)("%s is in %s, reads %s and is %s", (kind, group, label, urgency) => {
    const r = noticeRow(note("x", kind));
    expect([r?.group, r?.label, r?.urgency, r?.kind]).toEqual([group, label, urgency, kind]);
  });
  it("a pending customer, a deletion and an unsubscribe fit the same shape", () => {
    const c = customerRow({ id: "c1", name: "Harbor Surplus", created_at: noon("2026-10-06") });
    expect([c.group, c.label, c.urgency, c.subject, c.createdAt]).toEqual(["customers", "To review", "needs", "Harbor Surplus", noon("2026-10-06")]);
    const del = requestRow({ id: "a1", kind: "client_delete", summary: "Delete client: Lakeside Discount Co", created_at: noon("2026-10-06") });
    expect([del?.group, del?.label, del?.urgency, del?.subject]).toEqual(["requests", "Delete request", "needs", "Lakeside Discount Co"]);
    const un = requestRow({ id: "a2", kind: "unsubscribe", summary: "pat@example.test unsubscribed from email", created_at: noon("2026-10-06") });
    expect([un?.group, un?.label, un?.urgency, un?.subject]).toEqual(["requests", "Unsubscribed", "info", "pat@example.test"]);
  });
  it("kinds this screen does not list are not rows", () => {
    expect(noticeRow(note("x", "call_request"))).toBeNull();
    expect(noticeRow(note("x", "system"))).toBeNull();
    expect(requestRow({ id: "a", kind: "client_add", summary: "New client", created_at: "" })).toBeNull();
    expect(requestRow({ id: "a", kind: "listing_stale", summary: "Renew or mark sold: Box lot", created_at: "" })).toBeNull();
  });
  it("every row key is its own, so two sources never collide", () => {
    expect(new Set([noticeRow(note("1", "bill_due"))!.key, customerRow({ id: "1", name: "A" }).key, requestRow({ id: "1", kind: "unsubscribe", summary: "", created_at: "" })!.key]).size).toBe(3);
  });
});

describe("the subject and the day of a row", () => {
  it("the subject is the server's, else the stored title (an older server)", () => {
    expect(noticeRow(note("a", "bill_due", { subject: "  Warehouse rent ", title: "Warehouse rent is due tomorrow" }))?.subject).toBe("Warehouse rent");
    expect(noticeRow(note("b", "bill_due", { title: "Warehouse rent is due tomorrow" }))?.subject).toBe("Warehouse rent is due tomorrow");
    expect(noticeRow(note("c", "bill_due", { subject: "", title: "Insurance" }))?.subject).toBe("Insurance");
  });
  it("the day is the server's due_day", () => {
    expect(dueDayOf({ kind: "bill_due", entity_id: "bill:b1:2026-10-12:due", due_day: "2026-10-11" })).toBe("2026-10-11");
  });
  it("an older server sends none, so the day is read from the entity key", () => {
    expect(dueDayOf({ kind: "bill_due", entity_id: "bill:b1:2026-10-12:due" })).toBe("2026-10-12");
    expect(dueDayOf({ kind: "bill_overdue", entity_id: "bill:b1:2026-10-05:overdue" })).toBe("2026-10-05");
    expect(dueDayOf({ kind: "bill_paid", entity_id: "bill:b1:2026-10-01:paid" })).toBe("2026-10-01");
    expect(dueDayOf({ kind: "carrier_overdue", entity_id: "carrier:fb_9:2026-10-03:overdue" })).toBe("2026-10-03");
    expect(dueDayOf({ kind: "carrier_due", entity_id: "carrier:fb_9:2026-10-08:due" })).toBe("2026-10-08");
    expect(dueDayOf({ kind: "logistics_pay_due", entity_id: "lpay:o1:2026-10-10" })).toBe("2026-10-10");
  });
  it("a junk or missing key and kinds without a day give none", () => {
    expect(dueDayOf({ kind: "bill_due", entity_id: null })).toBe("");
    expect(dueDayOf({ kind: "bill_due", entity_id: "bill:b1:soon:due", due_day: "later" })).toBe("");
    expect(dueDayOf({ kind: "logistics_quote", entity_id: "quote:fb_1:2026-10-02T10:00:00Z" })).toBe("");
    expect(dueDayOf({ kind: "supply_lead", entity_id: "lpay:o1:2026-10-10" })).toBe("");
    expect(dueDayOf({ kind: "bill_due", entity_id: "lpay:o1:2026-10-10" })).toBe("");
  });
});

describe("the when of a row, worked out live", () => {
  it("an overdue row counts the days since its due day", () => {
    expect(whenWords(row({ kind: "bill_overdue", dueDay: "2026-10-05" }), TODAY)).toBe("3 days overdue");
    expect(whenWords(row({ kind: "carrier_overdue", dueDay: "2026-10-07" }), TODAY)).toBe("1 day overdue");
    expect(whenWords(row({ kind: "bill_overdue", dueDay: TODAY }), TODAY)).toBe("Due today");
  });
  it("a due row reads today, tomorrow or the date", () => {
    expect(whenWords(row({ kind: "bill_due", dueDay: TODAY }), TODAY)).toBe("Due today");
    expect(whenWords(row({ kind: "carrier_due", dueDay: "2026-10-09" }), TODAY)).toBe("Due tomorrow");
    expect(whenWords(row({ kind: "bill_due", dueDay: "2026-10-12" }), TODAY)).toBe("Due Oct 12");
    expect(whenWords(row({ kind: "bill_due", dueDay: "2026-10-05" }), TODAY)).toBe("Due Oct 5");
  });
  it("a paid bill and a pay day name their date", () => {
    expect(whenWords(row({ kind: "bill_paid", dueDay: "2026-10-05" }), TODAY)).toBe("Paid Oct 5");
    expect(whenWords(row({ kind: "logistics_pay_due", dueDay: "2026-10-10" }), TODAY)).toBe("Pay day Oct 10");
  });
  it("it moves with the day, so a row never goes stale the way its stored title did", () => {
    const r = row({ kind: "bill_due", dueDay: "2026-10-09" });
    expect(whenWords(r, "2026-10-08")).toBe("Due tomorrow");
    expect(whenWords(r, "2026-10-09")).toBe("Due today");
    expect(whenWords(r, "2026-10-10")).toBe("Due Oct 9");
  });
  it("every other row reads from when it was raised", () => {
    const at = (day: string) => row({ kind: "supply_lead", createdAt: noon(day) });
    expect(whenWords(at("2026-10-08"), TODAY)).toBe("Today");
    expect(whenWords(at("2026-10-07"), TODAY)).toBe("Yesterday");
    expect(whenWords(at("2026-10-06"), TODAY)).toBe("2 days ago");
    expect(whenWords(at("2026-10-02"), TODAY)).toBe("6 days ago");
    expect(whenWords(at("2026-10-01"), TODAY)).toBe("Oct 1");
    expect(whenWords(at("2026-08-20"), TODAY)).toBe("Aug 20");
  });
  it("a quote reads from when it was raised, and a row with no time reads nothing", () => {
    expect(whenWords(row({ kind: "logistics_quote", createdAt: noon("2026-10-07") }), TODAY)).toBe("Yesterday");
    // R-478: a BOL upload has no due day (its key is bol:<load>:<file>), so it reads from when it was uploaded
    const bol = noticeRow(note("b", "logistics_bol", { entity_id: "bol:fb_4:ff_2", created_at: noon("2026-10-08") }))!;
    expect(bol.dueDay).toBe("");
    expect(whenWords(bol, TODAY)).toBe("Today");
    expect(whenWords({ ...bol, createdAt: noon("2026-10-07") }, TODAY)).toBe("Yesterday");
    expect(whenWords(customerRow({ id: "c", name: "A" }), TODAY)).toBe("");
    expect(whenWords(customerRow({ id: "c", name: "A", created_at: "" }), TODAY)).toBe("");
    expect(whenWords(row({ kind: "supply_lead", createdAt: "not a time" }), TODAY)).toBe("");
  });
  it("comes from the day on the row, not from words in the stored title", () => {
    const r = noticeRow(note("p", "bill_due", { title: "Warehouse rent is due tomorrow", due_day: "2026-10-12" }))!;
    expect(whenWords(r, TODAY)).toBe("Due Oct 12");
  });
});

describe("the order of the screen", () => {
  it("inside a group: red, then amber, then grey", () => {
    const rows = [
      row({ key: "paid", kind: "bill_paid", urgency: "info" }),
      row({ key: "due", urgency: "needs" }),
      row({ key: "late", kind: "bill_overdue", urgency: "overdue" }),
    ];
    expect(groupRows(rows)[0].rows.map((r) => r.key)).toEqual(["late", "due", "paid"]);
  });
  it("inside one colour: dated rows first, earliest day first; the rest newest first", () => {
    const rows = [
      row({ key: "undated-old", group: "logistics", kind: "logistics_quote", createdAt: noon("2026-10-01") }),
      row({ key: "later", group: "logistics", kind: "carrier_due", dueDay: "2026-10-12", createdAt: noon("2026-10-02") }),
      row({ key: "undated-new", group: "logistics", kind: "logistics_quote", createdAt: noon("2026-10-07") }),
      row({ key: "sooner", group: "logistics", kind: "carrier_due", dueDay: "2026-10-09", createdAt: noon("2026-10-05") }),
    ];
    expect(groupRows(rows)[0].rows.map((r) => r.key)).toEqual(["sooner", "later", "undated-new", "undated-old"]);
  });
  it("a pending customer shows when it signed up and the newest sits first, like every other group", () => {
    const old = customerRow({ id: "old", name: "Harbor Surplus", created_at: noon("2026-09-26") });
    const fresh = customerRow({ id: "new", name: "Lakeside Discount Co", created_at: noon("2026-10-08") });
    const mid = customerRow({ id: "mid", name: "Pine Street Liquidators", created_at: noon("2026-10-07") });
    expect(whenWords(old, TODAY)).toBe("Sep 26");
    expect(whenWords(mid, TODAY)).toBe("Yesterday");
    expect(whenWords(fresh, TODAY)).toBe("Today");
    // The server lists them oldest first; the screen does not keep that order.
    expect(groupRows([old, mid, fresh])[0].rows.map((r) => r.key)).toEqual(["c:new", "c:mid", "c:old"]);
  });
  it("two rows on one day keep the newest first", () => {
    const a = row({ key: "a", dueDay: "2026-10-09", createdAt: noon("2026-10-01") });
    const b = row({ key: "b", dueDay: "2026-10-09", createdAt: noon("2026-10-05") });
    expect([a, b].sort(compareRows).map((r) => r.key)).toEqual(["b", "a"]);
  });
  it("groups go by their most urgent row, and a tie keeps the fixed order", () => {
    const rows = [
      row({ key: "lead", group: "leads", kind: "supply_lead", urgency: "needs" }),
      row({ key: "paid", group: "bills", kind: "bill_paid", urgency: "info" }),
      row({ key: "late", group: "logistics", kind: "carrier_overdue", urgency: "overdue" }),
      row({ key: "cust", group: "customers", kind: "pending_customer", urgency: "needs" }),
      row({ key: "unsub", group: "requests", kind: "unsubscribe", urgency: "info" }),
    ];
    expect(groupRows(rows).map((g) => g.group)).toEqual(["logistics", "customers", "leads", "bills", "requests"]);
    expect(GROUP_ORDER).toEqual(["bills", "logistics", "customers", "requests", "leads"]);
  });
  it("a group with nothing in it is left out, and the input is not reordered", () => {
    const rows = [row({ key: "b", urgency: "info", kind: "bill_paid" }), row({ key: "a", urgency: "overdue", kind: "bill_overdue" })];
    const g = groupRows(rows);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe(GROUP_LABEL.bills);
    expect(rows.map((r) => r.key)).toEqual(["b", "a"]);
    expect(groupRows([])).toEqual([]);
  });
  it("a group that could not load shows no rows, sits after the rest, and is never dropped", () => {
    const rows = [
      row({ key: "bill", group: "bills" }),
      row({ key: "stale", group: "logistics", kind: "carrier_due" }),
      row({ key: "cust", group: "customers", kind: "pending_customer", urgency: "info" }),
    ];
    const g = groupRows(rows, ["bills", "leads"]);
    expect(g.map((x) => [x.group, x.failed, x.rows.length])).toEqual([["logistics", false, 1], ["customers", false, 1], ["bills", true, 0], ["leads", true, 0]]);
    expect(groupRows([], ["customers"]).map((x) => [x.group, x.failed])).toEqual([["customers", true]]);
  });
  it("a failed read only complains about the groups this person has", () => {
    // A read can only fail for someone the server lets read the list, so these hold the clients module.
    const books = { permissions: ["clients:view", "financials:view"] };
    const deals = { permissions: ["clients:view", "deal_flow:view"] };
    const seen = (me: { permissions: string[] }) => (["bills", "logistics", "leads"] as const).map((g) => canSeeGroup(g, me));
    expect(seen({ permissions: ["*"] })).toEqual([true, true, true]);
    expect(seen(books)).toEqual([true, true, false]);
    expect(seen(deals)).toEqual([false, true, false]);
    expect(canSeeGroup("bills", null)).toBe(false);
  });
});

describe("the colour of a row's when", () => {
  it("an overdue row's when is written in the label's colour, and no other row's is", () => {
    for (const k of [...TEAM_NOTICE_KINDS, "supply_lead", "supplier_profile"]) {
      const r = noticeRow(note("x", k))!;
      expect(whenWearsUrgency(r), k).toBe(k === "bill_overdue" || k === "carrier_overdue");
    }
    expect(whenWearsUrgency(customerRow({ id: "c", name: "A" }))).toBe(false);
    for (const k of ["client_delete", "unsubscribe"]) expect(whenWearsUrgency(requestRow({ id: "a", kind: k, summary: "", created_at: "" })!), k).toBe(false);
  });
  it("it holds on the day an overdue kind falls due, when the words read Due today", () => {
    const r = row({ kind: "bill_overdue", urgency: "overdue", dueDay: TODAY });
    expect(whenWords(r, TODAY)).toBe("Due today");
    expect(whenWearsUrgency(r)).toBe(true);
    expect(whenWearsUrgency(row({ kind: "bill_due", urgency: "needs", dueDay: TODAY }))).toBe(false);
  });
});

describe("the supplier leads list", () => {
  it("is the unread supply_lead and supplier_profile notices, newest first, for an admin only", () => {
    const list = [
      note("a", "supply_lead", { created_at: hoursAgo(5) }),
      note("b", "supplier_profile", { created_at: hoursAgo(2) }),
      note("c", "supply_lead", { status: "acknowledged" }),
      note("d", "bill_due"),
    ];
    expect(leadNoticesOf(list, true).map((n) => n.id)).toEqual(["b", "a"]);
    expect(leadNoticesOf(list).map((n) => n.id)).toEqual([]);
    expect(leadNoticesOf(null, true)).toEqual([]);
  });
});

describe("the bell counts only what needs you", () => {
  const unread = (kind: string, status: "unread" | "acknowledged" = "unread") => ({ kind, status });
  it("counts customers, deletions, one for renewals, new leads and the notices that ask something", () => {
    const requests = [{ kind: "client_delete" }, { kind: "client_delete" }, { kind: "listing_stale" }, { kind: "listing_stale" }, { kind: "client_add" }];
    const notices = ["supply_lead", "bill_due", "bill_overdue", "carrier_due", "carrier_overdue", "logistics_quote", "logistics_pay_due"].map((k) => unread(k));
    expect(bellCountOf({ pendingCustomers: 3, requests, notices })).toBe(3 + 2 + 1 + 7);
  });
  it("leaves out a paid bill, supplier details, an unsubscribe and anything already read", () => {
    const requests = [{ kind: "unsubscribe" }, { kind: "unsubscribe" }, { kind: "client_add" }];
    const notices = [unread("bill_paid"), unread("supplier_profile"), unread("bill_due", "acknowledged"), unread("supply_lead", "acknowledged"), unread("call_request")];
    expect(bellCountOf({ pendingCustomers: 0, requests, notices })).toBe(0);
  });
  it("forty listings to renew add one, not forty", () => {
    const requests = Array.from({ length: 40 }, () => ({ kind: "listing_stale" }));
    expect(bellCountOf({ pendingCustomers: 0, requests, notices: [] })).toBe(1);
  });
  it("is nothing when nothing is waiting", () => {
    expect(bellCountOf({ pendingCustomers: 0, requests: [], notices: [] })).toBe(0);
  });
  it("counts exactly the rows the screen marks red or amber, whichever source they came from", () => {
    for (const k of [...TEAM_NOTICE_KINDS, "supply_lead", "supplier_profile"]) {
      const needs = noticeRow(note("x", k))!.urgency !== "info";
      expect(bellCountOf({ pendingCustomers: 0, requests: [], notices: [unread(k)] }), k).toBe(needs ? 1 : 0);
    }
    expect(bellCountOf({ pendingCustomers: 1, requests: [], notices: [] })).toBe(customerRow({ id: "c", name: "A" }).urgency !== "info" ? 1 : 0);
    for (const k of ["client_delete", "unsubscribe"]) {
      const needs = requestRow({ id: "a", kind: k, summary: "", created_at: "" })!.urgency !== "info";
      expect(bellCountOf({ pendingCustomers: 0, requests: [{ kind: k }], notices: [] }), k).toBe(needs ? 1 : 0);
    }
  });
  it("an operating-system alert goes out for the notices the bell counts, plus the alert-only kinds (R-478)", () => {
    for (const k of TEAM_NOTICE_KINDS) {
      const raised = planTeamRaise([note("x", k)], [], NOW).raise.length === 1;
      const counted = bellCountOf({ pendingCustomers: 0, requests: [], notices: [unread(k)] }) === 1;
      const alertOnly = (ALERT_ONLY_NOTICE_KINDS as readonly string[]).includes(k);
      expect(raised, k).toBe(counted || alertOnly);
      // an alert-only kind never counts on the bell, and the bell kinds are all alerts
      if (alertOnly) expect(counted, k).toBe(false);
    }
    for (const k of NEEDS_YOU_NOTICE_KINDS) expect(ALERT_NOTICE_KINDS).toContain(k);
    expect(ALERT_ONLY_NOTICE_KINDS.some((k) => (NEEDS_YOU_NOTICE_KINDS as readonly string[]).includes(k))).toBe(false);
  });
  it("a BOL upload is grey on the screen, raised as an alert and silent on the bell (R-478)", () => {
    const r = noticeRow(note("b", "logistics_bol"))!;
    expect([r.urgency, r.group, r.label]).toEqual(["info", "logistics", "BOL uploaded"]);
    expect(planTeamRaise([note("b", "logistics_bol")], [], NOW).raise.map((n) => n.id)).toEqual(["b"]);
    expect(bellCountOf({ pendingCustomers: 0, requests: [], notices: [unread("logistics_bol")] })).toBe(0);
  });
  it("the tooltip says how many need you, or just Notifications", () => {
    expect(bellTitle(0)).toBe("Notifications");
    expect(bellTitle(1)).toBe("1 needs you");
    expect(bellTitle(7)).toBe("7 need you");
  });
});

describe("no text on the screen carries an em dash", () => {
  it("every label, group name and tooltip is plain", () => {
    const words = [...Object.values(NOTICE_KIND_LABEL), ...Object.values(GROUP_LABEL), "To review", "Delete request", "Unsubscribed", "New lead", "Supplier details", bellTitle(0), bellTitle(1), bellTitle(4)];
    for (const w of words) expect(w).not.toMatch(/[—–]/);
  });
});
