/**
 * The shared ledger reader's declaration — see ledger-read.mjs for why it
 * exists (plain .mjs, no build step, no plugin server imports).
 */

export interface LedgerRead {
  missing?: boolean;
  failed?: unknown;
  corrupt?: string;
  events?: unknown[];
}

export declare function readLedgerEvents(
  path: string,
  options?: { validateEvent?: (event: Record<string, unknown>) => boolean },
): LedgerRead;
