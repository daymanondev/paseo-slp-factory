import { test } from "node:test";
import assert from "node:assert/strict";
import { createTimelineFetcher } from "../plugin/server/timeline.ts";
import type { TimelineSourceApi } from "../plugin/server/timeline.ts";

/**
 * The watch's timeline feed (v0.0.6) — the seam where daemon data crosses
 * into the pure core. Hermetic: a fake agent-timeline API shaped exactly like
 * the real call path (`agents.ref(id).timeline.refetch`), the choke's
 * PaseoResponderApi precedent. The live proof against the real daemon rides
 * the battery ticket's runs; the mechanics are what this file pins.
 */

/** A fake daemon answering one timeline page — the SDK's payload shape, structurally. */
function fakeApi(page: { entries?: unknown[]; error?: string | null } | Error): TimelineSourceApi {
  return {
    agents: {
      ref: (id: string) => ({
        timeline: {
          refetch: async (options?: { direction?: string }) => {
            assert.equal(options?.direction, "tail", "the feed reads the tail — the transcript's own cap is the trim policy");
            calls.push(id);
            if (page instanceof Error) throw page;
            return page;
          },
        },
      }),
    },
  };
}
const calls: string[] = [];

test("reduces the daemon's page to plain entries: seqEnd becomes seq, item passes through", async () => {
  calls.length = 0;
  const fetch = createTimelineFetcher(() => fakeApi({ entries: [{ seqEnd: 7, item: { type: "user_message", text: "hi" } }, { seqEnd: 9, item: { type: "error", message: "boom" } }] }));
  const result = await fetch("agent-1");
  assert.deepEqual(result, {
    ok: true,
    entries: [
      { seq: 7, item: { type: "user_message", text: "hi" } },
      { seq: 9, item: { type: "error", message: "boom" } },
    ],
  });
  assert.deepEqual(calls, ["agent-1"], "the agent id the claim carried is who gets asked");
});

test("the daemon's own error string becomes the failure reason", async () => {
  const fetch = createTimelineFetcher(() => fakeApi({ entries: [], error: "Unknown agent" }));
  const result = await fetch("agent-gone");
  assert.ok(!result.ok);
  assert.match(result.reason, /Unknown agent/);
});

test("a refetch that throws names the failure — the daemon restarted, or worse", async () => {
  const fetch = createTimelineFetcher(() => fakeApi(new Error("socket died")));
  const result = await fetch("agent-2");
  assert.ok(!result.ok);
  assert.match(result.reason, /fetching the timeline of agent agent-2 failed/);
  assert.match(result.reason, /socket died/);
});

test("no captured PaseoApi is a named failure, never a crash", async () => {
  const fetch = createTimelineFetcher(() => undefined);
  const result = await fetch("agent-3");
  assert.ok(!result.ok);
  assert.match(result.reason, /no PaseoApi/);
});

test("an empty page is an honest failure — a claiming agent always has timeline entries", async () => {
  const fetch = createTimelineFetcher(() => fakeApi({ entries: [] }));
  const result = await fetch("agent-4");
  assert.ok(!result.ok);
  assert.match(result.reason, /holds no timeline for agent agent-4/);
});

test("defensive reduction: a malformed entry degrades to seq 0 and an empty item", async () => {
  const fetch = createTimelineFetcher(() => fakeApi({ entries: [{ seqEnd: "seven", item: "not an object" }, {}] }));
  const result = await fetch("agent-5");
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.entries[0], { seq: 0, item: {} });
    assert.deepEqual(result.entries[1], { seq: 0, item: {} });
  }
});
