import type { Agent } from "@tagconn/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CosmeticClaims } from "../../cosmetic/claims";
import { LifeDirector } from "../lifeDirector";
import type { ActivityPlan, LifeHost, LifeScript, MeetingPlan } from "../types";

type Pt = { x: number; y: number };
class FakeChar {
  walking = false;
  leaving = false;
  gone = false;
  isWaiting = false;
  realmIndex: number | null = null;
  lifecycleFrame: { state: string } = { state: "resting" };
  said: string[] = [];
  constructor(
    public key: string,
    public tile: Pt,
    public boundAgentId: string | null = null,
  ) {}
  walk() {}
  teleport(p: Pt) {
    this.tile = p;
  }
  setSeated() {}
  sayDrama(t: string) {
    this.said.push(t);
  }
}

const W = 14;
const H = 8;
const grid = <T>(v: T) =>
  Array.from({ length: H }, () => Array.from({ length: W }, () => v));
const room = (id: string, type: string, x0: number, x1: number) => ({
  id,
  type,
  interior: { x: x0, y: 0, w: x1 - x0, h: H },
  seats: [],
});
const furn = (
  kind: string,
  roomId: string,
  x: number,
  y: number,
  w = 1,
  h = 1,
) => ({ kind, roomId, x, y, w, h, blocking: true });
const roomAt = grid<string | null>("meet");
for (let y = 0; y < H; y++)
  for (let x = 7; x < W; x++) roomAt[y]![x] = "lounge";
const map = {
  walkable: grid(0),
  roomAt,
  rooms: [room("meet", "meeting-room", 0, 7), room("lounge", "lounge", 7, W)],
  furniture: [
    furn("table", "meet", 3, 3, 2, 1),
    furn("water-cooler", "lounge", 10, 3),
    furn("arcade", "lounge", 12, 3),
  ],
};

const activities = [
  {
    id: "chat",
    requires: ["water-cooler"],
    cast: [1, 2],
    weight: 1,
    durationSec: [10, 10],
    pose: "chat",
    lines: ["hi"],
  },
  {
    id: "stretch",
    requires: [],
    cast: [1, 1],
    weight: 1,
    durationSec: [5, 5],
    pose: "stretch",
    lines: ["ah"],
  },
];
const lines = {
  invite: ["i"],
  fetch: ["f"],
  dawdle: ["d"],
  talk: ["t"],
  close: ["c"],
};
const theme = { life: { activities, kickoff: lines, standup: lines } };

const T0 = 1_000_000;
let now = T0;

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    sessionId: "s1",
    projectId: "p",
    isMain: false,
    agentType: "x",
    role: "x",
    status: "active",
    activity: "idle",
    zone: "desks",
    toolCount: 0,
    startedAt: now,
    updatedAt: now,
    ...over,
  } as Agent;
}

interface Fake extends LifeScript {
  plan: MeetingPlan | ActivityPlan;
  cancelled: number;
  aborted: number;
  result: "running" | "done";
}

function setup(
  over: {
    life?: Record<string, unknown>;
    ambient?: boolean;
    reduced?: boolean;
    low?: boolean;
    realms?: Map<number, Set<string>>;
  } = {},
) {
  const chars = new Map<string, FakeChar>();
  const agents: Agent[] = [];
  const claims = new CosmeticClaims();
  const office = {
    showBubbles: true,
    ambientEffects: over.ambient ?? true,
    life: {
      enabled: true,
      kickoffWindowSec: 30,
      meetingSec: 20,
      standupEverySec: 100,
      standupMinCast: 3,
      idleActivityEverySec: 60,
      maxConcurrent: 2,
      maxMeetingSize: 6,
      ...over.life,
    },
  };
  const flags = { reduced: !!over.reduced, low: !!over.low };
  const host = {
    map: () => map,
    finder: () => ({ find: (a: Pt, b: Pt) => [a, b] }),
    seats: () => ({
      get: (k: string) => ({ x: 0, y: 0, seated: true, k }),
      occupant: () => undefined,
    }),
    actors: () => chars,
    agents: () => agents,
    themeFor: () => theme,
    office: () => office,
    floorKey: () => "f",
    reducedMotion: () => flags.reduced,
    lowQuality: () => flags.low,
    claims: () => claims,
    keyForAgent: (id: string) =>
      chars.has(`agent:${id}`) ? `agent:${id}` : undefined,
    realmRooms: (c: FakeChar) =>
      c.realmIndex === null ? null : (over.realms?.get(c.realmIndex) ?? null),
  };
  const started: Fake[] = [];
  const mk =
    (kind: "meeting" | "activity") =>
    (_ctx: unknown, plan: MeetingPlan | ActivityPlan): LifeScript => {
      const keys =
        "hostKey" in plan ? [plan.hostKey, ...plan.inviteeKeys] : plan.keys;
      for (const k of keys) claims.tryClaim(k, kind, () => {});
      const s: Fake = {
        id: plan.id,
        kind: "kind" in plan ? plan.kind : "activity",
        keys,
        plan,
        cancelled: 0,
        aborted: 0,
        result: "running",
        step: () => {
          if (s.result === "done")
            for (const k of keys) claims.release(k, kind);
          return s.result;
        },
        revoke: () => {},
        cancel: () => void s.cancelled++,
        abort: () => {
          s.aborted++;
          for (const k of keys) claims.release(k, kind);
        },
      } as Fake;
      started.push(s);
      return s;
    };
  const startMeeting = vi.fn(mk("meeting"));
  const startActivity = vi.fn(mk("activity"));
  const d = new LifeDirector(
    host as unknown as LifeHost,
    { startMeeting, startActivity } as never,
  );
  const add = (
    id: string,
    x: number,
    y: number,
    state = "resting",
    ag?: Agent,
  ) => {
    const c = new FakeChar(`agent:${id}`, { x, y }, ag ? ag.id : null);
    c.lifecycleFrame = { state };
    chars.set(c.key, c);
    if (ag) agents.push(ag);
    return c;
  };
  return {
    d,
    chars,
    agents,
    claims,
    office,
    flags,
    started,
    startMeeting,
    startActivity,
    add,
  };
}

const tick = (d: LifeDirector, ms: number) => {
  now += ms;
  vi.setSystemTime(now);
  d.update(0, 500);
};

function kickoffSetup(over: Parameters<typeof setup>[0] = {}) {
  const s = setup(over);
  const host = agent("main:s1", { isMain: true, activity: "delegating" });
  s.add("main:s1", 1, 1, "quest", host);
  s.d.afterCast(now);
  const a = agent("a", { startedAt: now + 500 });
  const b = agent("b", { startedAt: now + 500 });
  const ca = s.add("a", 1, 5, "quest", a);
  const cb = s.add("b", 2, 5, "quest", b);
  return { ...s, ca, cb, host, a, b };
}

beforeEach(() => {
  vi.useFakeTimers();
  now = T0;
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe("kickoff", () => {
  it("starts a meeting for a delegating session with two spawns", () => {
    const s = kickoffSetup();
    now += 1000;
    s.d.afterCast(now);
    expect(s.startMeeting).toHaveBeenCalledTimes(1);
    const plan = s.startMeeting.mock.calls[0]![1] as MeetingPlan;
    expect(plan.kind).toBe("kickoff");
    expect(plan.hostKey).toBe("agent:main:s1");
    expect(plan.inviteeKeys).toEqual(["agent:a", "agent:b"]);
    expect(plan.stragglerKey).not.toBeNull();
    expect(plan.venue.roomId).toBe("meet");
    expect(plan.venue.table?.kind).toBe("table");
    expect(plan.venue.spots).toHaveLength(3);
    expect(plan.meetingMs).toBe(20_000);
    expect(plan.lines).toBe(lines);
    expect(s.d.scripts()).toHaveLength(1);
    // Fires once.
    s.d.afterCast(now + 1000);
    expect(s.startMeeting).toHaveBeenCalledTimes(1);
  });

  it("drops invitees that are waiting or running a tool, and starts nothing with fewer than two", () => {
    const s = kickoffSetup();
    s.ca.isWaiting = true;
    now += 1000;
    s.d.afterCast(now);
    expect(s.startMeeting).not.toHaveBeenCalled();
  });

  // Regression: subagents spawn mid-tool (the demo's all do), so requiring idle/thinking meant no kickoff ever ran.
  it("pulls invitees that are already typing or running a tool into the kickoff", () => {
    const s = kickoffSetup();
    s.a.activity = "typing";
    s.b.activity = "reading";
    s.b.currentTool = "Bash";
    now += 1000;
    s.d.afterCast(now);
    expect(s.startMeeting).toHaveBeenCalledTimes(1);
    expect((s.startMeeting.mock.calls[0]![1] as MeetingPlan).inviteeKeys).toEqual(["agent:a", "agent:b"]);
  });

  it("drops an invitee whose agent is no longer active", () => {
    const s = kickoffSetup();
    s.b.status = "done";
    now += 1000;
    s.d.afterCast(now);
    expect(s.startMeeting).not.toHaveBeenCalled();
  });

  it("caps invitees to maxMeetingSize - 1", () => {
    const s = kickoffSetup({ life: { maxMeetingSize: 3 } });
    const c = agent("c", { startedAt: now + 500 });
    s.add("c", 3, 5, "quest", c);
    now += 1000;
    s.d.afterCast(now);
    expect(
      (s.startMeeting.mock.calls[0]![1] as MeetingPlan).inviteeKeys,
    ).toHaveLength(2);
  });

  it("is gated by life.enabled, ambientEffects and reduced motion", () => {
    for (const over of [
      { life: { enabled: false } },
      { ambient: false },
      { reduced: true },
    ]) {
      const s = kickoffSetup(over);
      now += 1000;
      s.d.afterCast(now);
      expect(s.startMeeting).not.toHaveBeenCalled();
    }
  });

  it("pulls a drama-claimed invitee but not one already in a meeting", () => {
    const s = kickoffSetup();
    s.claims.tryClaim("agent:a", "drama", () => {});
    s.claims.tryClaim("agent:b", "meeting", () => {});
    now += 1000;
    s.d.afterCast(now);
    expect(s.startMeeting).not.toHaveBeenCalled();
  });

  it("allows one meeting at a time on a floor", () => {
    const s = kickoffSetup();
    now += 1000;
    s.d.afterCast(now);
    expect(s.started).toHaveLength(1);
    const host2 = agent("main:s2", {
      isMain: true,
      sessionId: "s2",
      activity: "delegating",
    });
    s.add("main:s2", 5, 5, "quest", host2);
    s.d.afterCast(now + 100);
    s.agents.push(
      agent("x", { sessionId: "s2" }),
      agent("y", { sessionId: "s2" }),
    );
    s.add("x", 6, 5, "quest", s.agents.at(-2));
    s.add("y", 6, 6, "quest", s.agents.at(-1));
    s.d.afterCast(now + 200);
    expect(s.startMeeting).toHaveBeenCalledTimes(1);
  });

  it("uses the lounge centre when there is no table", () => {
    const s = kickoffSetup();
    const saved = map.furniture.splice(0, 1);
    try {
      now += 1000;
      s.d.afterCast(now);
      const plan = s.startMeeting.mock.calls[0]![1] as MeetingPlan;
      expect(plan.venue.table).toBeNull();
      expect(plan.venue.roomId).toBe("lounge");
      expect(plan.venue.spots).toHaveLength(3);
    } finally {
      map.furniture.unshift(...saved);
    }
  });

  it("keeps the venue clear of waiting characters", () => {
    const s = kickoffSetup();
    const w = s.add("w", 3, 6, "quest", agent("w", { status: "waiting" }));
    w.isWaiting = true;
    now += 1000;
    s.d.afterCast(now);
    const plan = s.startMeeting.mock.calls[0]![1] as MeetingPlan;
    for (const p of plan.venue.spots)
      expect(Math.max(Math.abs(p.x - 3), Math.abs(p.y - 6))).toBeGreaterThan(2);
    expect([plan.hostKey, ...plan.inviteeKeys]).not.toContain(w.key);
  });

  it("limits the venue to the host realm on the Multiverse and allows one meeting per realm", () => {
    const realms = new Map([
      [0, new Set(["lounge"])],
      [1, new Set(["meet"])],
    ]);
    const s = kickoffSetup({ realms });
    for (const c of s.chars.values()) c.realmIndex = 0;
    now += 1000;
    s.d.afterCast(now);
    const plan = s.startMeeting.mock.calls[0]![1] as MeetingPlan;
    expect(plan.venue.roomId).toBe("lounge");
    expect(plan.venue.table).toBeNull();
  });

  it("ignores invitees of another realm", () => {
    const s = kickoffSetup();
    s.ca.realmIndex = 1;
    now += 1000;
    s.d.afterCast(now);
    expect(s.startMeeting).not.toHaveBeenCalled();
  });
});

describe("stand-up", () => {
  function pool(over: Parameters<typeof setup>[0] = {}) {
    const s = setup({ life: { idleActivityEverySec: 3600 }, ...over });
    s.add("z", 2, 2);
    s.add("b", 4, 6);
    s.add("c", 6, 6);
    return s;
  }
  it("never fires on load, fires after standupEverySec, hosted by the smallest key", () => {
    const s = pool();
    s.d.afterCast(now);
    tick(s.d, 500);
    expect(s.startMeeting).not.toHaveBeenCalled();
    tick(s.d, 99_000);
    expect(s.startMeeting).not.toHaveBeenCalled();
    tick(s.d, 1000);
    expect(s.startMeeting).toHaveBeenCalledTimes(1);
    const plan = s.startMeeting.mock.calls[0]![1] as MeetingPlan;
    expect(plan.kind).toBe("standup");
    expect(plan.hostKey).toBe("agent:b");
    expect(plan.inviteeKeys.sort()).toEqual(["agent:c", "agent:z"]);
  });

  it("prefers the Guild Master as host", () => {
    const s = pool();
    s.chars.set("gm:p", new FakeChar("gm:p", { x: 9, y: 6 }));
    s.chars.get("gm:p")!.lifecycleFrame = { state: "resting" };
    tick(s.d, 100_500);
    const plan = s.startMeeting.mock.calls[0]![1] as MeetingPlan;
    expect(plan.hostKey).toBe("gm:p");
  });

  it("needs standupMinCast idle characters and skips waiting ones", () => {
    const s = pool();
    s.chars.get("agent:z")!.isWaiting = true;
    tick(s.d, 100_500);
    expect(s.startMeeting).not.toHaveBeenCalled();
  });

  it("runs again only after the next interval, and not while a meeting runs", () => {
    const s = pool();
    tick(s.d, 100_500);
    expect(s.startMeeting).toHaveBeenCalledTimes(1);
    s.started[0]!.result = "done";
    tick(s.d, 500);
    expect(s.d.scripts()).toHaveLength(0);
    tick(s.d, 50_000);
    expect(s.startMeeting).toHaveBeenCalledTimes(1);
    tick(s.d, 50_000);
    expect(s.startMeeting).toHaveBeenCalledTimes(2);
  });

  it("is off under reduced motion", () => {
    const s = pool({ reduced: true });
    tick(s.d, 100_500);
    expect(s.startMeeting).not.toHaveBeenCalled();
  });

  it("runs one per realm", () => {
    const s = pool();
    s.add("r1", 1, 1).realmIndex = 1;
    s.add("r2", 1, 2).realmIndex = 1;
    s.add("r3", 1, 3).realmIndex = 1;
    tick(s.d, 100_500);
    expect(s.startMeeting).toHaveBeenCalledTimes(2);
    const realms = s.started.map(
      (x) => s.chars.get((x.plan as MeetingPlan).hostKey)!.realmIndex,
    );
    expect(realms).toHaveLength(2);
    expect(new Set(realms)).toEqual(new Set([null, 1]));
  });
});

describe("activities", () => {
  function pool(over: Parameters<typeof setup>[0] = {}) {
    const s = setup({ life: { standupEverySec: 86_400 }, ...over });
    s.add("a", 8, 2);
    s.add("b", 9, 5);
    return s;
  }
  const run = (s: ReturnType<typeof pool>, n = 4) => {
    for (let i = 0; i < n; i++) tick(s.d, 61_000);
  };

  it("starts activities on the schedule, not at the first tick", () => {
    const s = pool();
    tick(s.d, 500);
    expect(s.startActivity).not.toHaveBeenCalled();
    run(s, 2);
    expect(s.startActivity).toHaveBeenCalled();
    const plan = s.startActivity.mock.calls[0]![1] as ActivityPlan;
    expect(plan.durationMs).toBeGreaterThan(0);
    expect(plan.keys.length).toBeGreaterThanOrEqual(plan.activity.cast[0]);
    expect(plan.keys.length).toBeLessThanOrEqual(plan.activity.cast[1]);
    if (plan.activity.requires.length) {
      expect(plan.prop).not.toBeNull();
      expect(plan.spots).toHaveLength(plan.keys.length);
    } else {
      expect(plan.prop).toBeNull();
    }
  });

  it("only picks in-place activities under reduced motion", () => {
    const s = pool({ reduced: true });
    run(s, 10);
    expect(s.startActivity).toHaveBeenCalled();
    for (const c of s.startActivity.mock.calls)
      expect((c[1] as ActivityPlan).activity.requires).toEqual([]);
  });

  it("respects the concurrency cap and the low quality cap of 1", () => {
    const s = pool({
      life: { standupEverySec: 86_400, maxConcurrent: 2 },
      low: true,
    });
    run(s, 12);
    expect(s.d.scripts().length).toBeLessThanOrEqual(1);
    const t = pool();
    t.add("c", 8, 6);
    t.add("d", 11, 6);
    run(t, 12);
    expect(t.d.scripts().length).toBeLessThanOrEqual(2);
    expect(t.d.scripts().length).toBeGreaterThan(0);
  });

  it("never casts waiting characters, claimed characters or walkers", () => {
    const s = pool();
    s.chars.get("agent:a")!.isWaiting = true;
    s.chars.get("agent:b")!.walking = true;
    run(s, 6);
    expect(s.startActivity).not.toHaveBeenCalled();
    s.chars.get("agent:b")!.walking = false;
    s.claims.tryClaim("agent:b", "drama", () => {});
    run(s, 6);
    expect(s.startActivity).not.toHaveBeenCalled();
  });

  it("does not reuse a prop that another running activity holds", () => {
    const s = pool({ life: { standupEverySec: 86_400, maxConcurrent: 4 } });
    s.add("c", 8, 6);
    run(s, 30);
    const props = s.started
      .map((x) => (x.plan as ActivityPlan).prop)
      .filter(Boolean);
    expect(new Set(props.map((p) => `${p!.x},${p!.y}`)).size).toBe(
      props.length,
    );
  });

  it("stops scheduling when life is off", () => {
    const s = pool({ life: { enabled: false } });
    run(s, 8);
    expect(s.startActivity).not.toHaveBeenCalled();
  });
});

describe("gates, reset and lifetime", () => {
  it("cancels every script once when the flag turns off", () => {
    const s = kickoffSetup();
    now += 1000;
    s.d.afterCast(now);
    s.office.life.enabled = false;
    tick(s.d, 500);
    tick(s.d, 500);
    expect(s.started[0]!.cancelled).toBe(1);
  });

  it("reduced motion cancels meetings and walking activities but not in-place ones", () => {
    const s = setup();
    s.add("a", 8, 2);
    s.add("b", 9, 5);
    s.add("c", 8, 6);
    const ctx = {} as never;
    // Drive activities directly through the schedule with controlled picks.
    for (let i = 0; i < 40 && s.started.length < 2; i++) tick(s.d, 61_000);
    void ctx;
    const walking = s.started.filter(
      (x) => (x.plan as ActivityPlan).activity?.requires?.length,
    );
    const inPlace = s.started.filter(
      (x) => (x.plan as ActivityPlan).activity?.requires?.length === 0,
    );
    s.flags.reduced = true;
    s.d.afterCast(now);
    for (const w of walking) expect(w.cancelled).toBe(1);
    for (const p of inPlace) expect(p.cancelled).toBe(0);
  });

  it("drops done scripts and aborts everything on reset/destroy", () => {
    const s = kickoffSetup();
    now += 1000;
    s.d.afterCast(now);
    const sc = s.started[0]!;
    s.d.reset();
    expect(sc.aborted).toBe(1);
    expect(s.d.scripts()).toEqual([]);
    expect(s.claims.count()).toBe(0);
    s.d.destroy();
    expect(sc.aborted).toBe(1);
  });

  it("reset restarts the stand-up clock", () => {
    const s = setup();
    s.add("a", 1, 1);
    s.add("b", 2, 1);
    s.add("c", 3, 1);
    tick(s.d, 90_000);
    s.d.reset();
    tick(s.d, 50_000);
    expect(s.startMeeting).not.toHaveBeenCalled();
    tick(s.d, 60_000);
    expect(s.startMeeting).toHaveBeenCalledTimes(1);
  });

  it("exposes a ctx whose eligible() follows live agent state", () => {
    const s = kickoffSetup();
    now += 1000;
    s.d.afterCast(now);
    const ctx = s.startMeeting.mock.calls[0]![0] as import("../types").LifeCtx;
    expect(ctx.eligible("agent:a", "invitee")).toBe(true);
    expect(ctx.eligible("agent:a", "idle")).toBe(true);
    expect(ctx.eligible("agent:main:s1", "host")).toBe(true);
    s.a.activity = "typing";
    s.d.afterCast(now);
    expect(ctx.eligible("agent:a", "invitee")).toBe(true);
    expect(ctx.eligible("agent:a", "idle")).toBe(false);
    s.a.status = "done";
    s.d.afterCast(now);
    expect(ctx.eligible("agent:a", "invitee")).toBe(false);
    s.a.status = "active";
    s.ca.isWaiting = true;
    expect(ctx.eligible("agent:b", "idle")).toBe(true);
    s.cb.leaving = true;
    expect(ctx.eligible("agent:b", "idle")).toBe(false);
    expect(ctx.eligible("npc:cat", "idle")).toBe(false);
    expect(ctx.isSitTile({ x: 0, y: 0 })).toBe(false);
    ctx.say(s.ca as never, "yo", 3);
    expect(s.ca.said).toEqual(["yo"]);
    s.office.showBubbles = false;
    ctx.say(s.ca as never, "no", 3);
    expect(s.ca.said).toEqual(["yo"]);
  });
});
