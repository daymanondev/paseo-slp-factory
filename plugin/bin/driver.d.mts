/**
 * The driver's declaration — see driver.mjs for why it exists (plain .mjs,
 * no build step, no plugin server imports). test/driver.test.ts runs the
 * pure pieces; the daemon-RPC half is proven live on the trial home.
 */

export declare const POLL_MS: number;
export declare const STAGGER_MS: number;
export declare const STALL_WARN_MS: number;

export declare function renderBrief(task: string, pathValue: string): string;
export declare function splitProvider(value: string): { provider: string; model: string | undefined };

export declare function readDriverLedger(stateDir: string): Record<string, unknown>[];
export declare function contractFromLedger(events: readonly Record<string, unknown>[], task: string): Record<string, unknown> | undefined;
export interface DriverOutcome {
  attempt: number;
  verdict: string | undefined;
  sha: string | undefined;
  reportPath: string | undefined;
  allowed: number;
  denied: number;
  blocked: number;
  accepted: boolean;
}
export declare function taskOutcome(events: readonly Record<string, unknown>[], task: string): DriverOutcome;

export declare function prepareWorkspace(
  workspace: string,
  task: string,
): { ok: true; branchExisted: boolean } | { ok: false; reason: string };

export declare class DaemonConnectionError extends Error {}
export declare class DaemonRpc {
  constructor(home: string);
  readonly features: Record<string, unknown> | null;
  get connected(): boolean;
  connect(timeoutMs?: number): Promise<void>;
  request(
    message: Record<string, unknown>,
    options: { responseType: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
  deliver(msg: Record<string, unknown>): void;
  rejectAllPending(err: Error): void;
  close(): void;
}

export declare function createTaskAgent(
  rpc: DaemonRpc,
  input: { task: string; provider: string; model?: string; cwd: string; brief: string },
): Promise<string>;

export interface AgentFate {
  terminal: boolean;
  fate?: "finished" | "died" | "closed";
  reason?: string;
}
export declare function agentFate(agent: Record<string, unknown>): AgentFate;

export interface ObserveEntry {
  task: string;
  agentId: string;
}
export declare function observeTasks(
  rpc: DaemonRpc,
  entries: ObserveEntry[],
  options?: { pollMs?: number; log?: (message: string) => void },
): Promise<void>;

export interface RunDriverInput {
  home: string;
  stateDir: string;
  spoolRoot: string;
  tasks: string[];
  provider: string;
  waitSecs?: number;
  pollMs?: number;
  staggerMs?: number;
  log?: (message: string) => void;
}
export declare function runDriver(input: RunDriverInput): Promise<number>;
