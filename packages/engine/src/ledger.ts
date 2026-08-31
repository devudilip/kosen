import { createHash } from "node:crypto";

// Append-only, hash-chained event log. State is always a fold over this log —
// never mutate state directly. This is what "replayable" and "tamper-evident"
// mean concretely: anyone can recompute state from genesis and get the same
// answer, and any edit to history breaks the hash chain from that point on.
export interface LedgerEntry<TPayload = unknown> {
  seq: number;
  prevHash: string;
  hash: string;
  timestamp: bigint;
  payload: TPayload;
}

const GENESIS_HASH = "0".repeat(64);

// JSON.stringify chokes on bigints (common in payloads carrying sat amounts),
// so stringify them explicitly rather than losing precision through Number.
function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

function computeHash(seq: number, prevHash: string, timestamp: bigint, payload: unknown): string {
  const canonical = canonicalStringify({ seq, prevHash, timestamp: timestamp.toString(), payload });
  return createHash("sha256").update(canonical).digest("hex");
}

export class Ledger<TPayload = unknown> {
  private entries: LedgerEntry<TPayload>[] = [];

  append(payload: TPayload, timestamp: bigint): LedgerEntry<TPayload> {
    const seq = this.entries.length;
    const prevHash = seq === 0 ? GENESIS_HASH : this.entries[seq - 1].hash;
    const hash = computeHash(seq, prevHash, timestamp, payload);
    const entry: LedgerEntry<TPayload> = { seq, prevHash, hash, timestamp, payload };
    this.entries.push(entry);
    return entry;
  }

  all(): readonly LedgerEntry<TPayload>[] {
    return this.entries;
  }

  at(seq: number): LedgerEntry<TPayload> | undefined {
    return this.entries[seq];
  }

  get length(): number {
    return this.entries.length;
  }

  // The latest entry's hash is the state root anchored externally (to the
  // Tachi ledger, per the architecture). Genesis root for an empty ledger.
  get root(): string {
    return this.entries.length === 0 ? GENESIS_HASH : this.entries[this.entries.length - 1].hash;
  }

  // Recompute every hash from scratch and compare to what's stored. Returns
  // the index of the first corrupted/tampered entry, or -1 if the chain is
  // intact.
  verify(): number {
    let prevHash = GENESIS_HASH;
    for (const entry of this.entries) {
      const expected = computeHash(entry.seq, prevHash, entry.timestamp, entry.payload);
      if (expected !== entry.hash || entry.prevHash !== prevHash) return entry.seq;
      prevHash = entry.hash;
    }
    return -1;
  }

  // Fold the log into a state value with a reducer, from genesis or from a
  // given starting state — this is the only sanctioned way to derive state.
  fold<TState>(reducer: (state: TState, entry: LedgerEntry<TPayload>) => TState, initial: TState): TState {
    return this.entries.reduce(reducer, initial);
  }
}
