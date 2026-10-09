/**
 * The watch's timeline feed (v0.0.6): the one seam where daemon data crosses
 * into the pure core. The shell captures the process's one long-lived
 * `PaseoApi` from a lifecycle hook (ticket 02 §a — every hook receives the
 * same object; the watch-feed scout verified the wiring end to end) and hands
 * it here; the fetcher asks the daemon for the agent's projected timeline
 * tail at verdict and reduces each entry to plain data the core's transcript
 * renderer reads. SDK types stay out of `src/` by law (zero Paseo imports).
 *
 * The one real fragility (ticket 02 §a): the timeline store is in-memory
 * only — a daemon restart between the agent's work and the pass erases it,
 * and the fetcher's failure reason becomes the pass's honest `failed` line.
 */
import type { TimelineFetchResult } from "./core/watch.ts";

/**
 * The structural slice of the agent-timeline API the feed needs — tests pass
 * a fake shaped exactly like the real call path
 * (`agents.ref(id).timeline.refetch`), the choke's `PaseoResponderApi`
 * precedent.
 */
export interface TimelineSourceApi {
  agents: {
    ref(id: string): {
      timeline: {
        refetch(options?: {
          direction?: "tail" | "before" | "after";
          cursor?: unknown;
          limit?: number;
          projection?: "projected" | "canonical";
        }): Promise<{ entries?: readonly unknown[]; error?: string | null }>;
      };
    };
  };
}

/** One projected entry from the daemon, as the SDK payload carries it — reduced defensively, no schema import. */
interface SdkTimelineEntry {
  seqEnd?: unknown;
  item?: unknown;
}

/**
 * Builds the fetcher the factory holds. `resolveApi` answers with the
 * captured PaseoApi, or undefined while no lifecycle hook has fired yet —
 * that state fails the pass as "no PaseoApi captured", never as a crash.
 */
export function createTimelineFetcher(resolveApi: () => TimelineSourceApi | undefined) {
  return async (agentId: string): Promise<TimelineFetchResult> => {
    const api = resolveApi();
    if (api === undefined) {
      return { ok: false, reason: "the plugin captured no PaseoApi — no lifecycle hook has fired since boot" };
    }
    let page: { entries?: readonly unknown[]; error?: string | null };
    try {
      // Tail direction, one page: default limit 200 covers every measured
      // real task (27–41 entries), and the transcript's own tail cap is the
      // trim policy — older pages would be cut anyway.
      page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail" });
    } catch (err) {
      return { ok: false, reason: `fetching the timeline of agent ${agentId} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (typeof page.error === "string" && page.error !== "") {
      return { ok: false, reason: `the daemon answered: ${page.error}` };
    }
    const entries = (page.entries ?? []).map((raw) => {
      const entry = raw as SdkTimelineEntry;
      return {
        seq: typeof entry.seqEnd === "number" ? entry.seqEnd : 0,
        item: typeof entry.item === "object" && entry.item !== null ? (entry.item as Record<string, unknown>) : {},
      };
    });
    if (entries.length === 0) {
      return { ok: false, reason: `the daemon holds no timeline for agent ${agentId} — unknown agent, or a restart wiped the in-memory store` };
    }
    return { ok: true, entries };
  };
}
