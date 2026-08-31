import { describe, expect, it } from "vitest";
import { Ledger } from "./ledger.js";

interface DepositEvent {
  type: "deposit";
  account: string;
  amount: bigint;
}

describe("Ledger", () => {
  it("chains entries so each references the prior entry's hash", () => {
    const ledger = new Ledger<DepositEvent>();
    const a = ledger.append({ type: "deposit", account: "alice", amount: 100n }, 0n);
    const b = ledger.append({ type: "deposit", account: "bob", amount: 200n }, 1n);

    expect(a.prevHash).toBe("0".repeat(64));
    expect(b.prevHash).toBe(a.hash);
    expect(ledger.root).toBe(b.hash);
  });

  it("verify() reports no tampering on an untouched chain", () => {
    const ledger = new Ledger<DepositEvent>();
    ledger.append({ type: "deposit", account: "alice", amount: 100n }, 0n);
    ledger.append({ type: "deposit", account: "bob", amount: 200n }, 1n);
    expect(ledger.verify()).toBe(-1);
  });

  it("verify() detects a tampered payload at the point of tampering", () => {
    const ledger = new Ledger<DepositEvent>();
    ledger.append({ type: "deposit", account: "alice", amount: 100n }, 0n);
    ledger.append({ type: "deposit", account: "bob", amount: 200n }, 1n);

    // Simulate tampering by mutating the payload in place after the fact.
    (ledger.at(0) as { payload: DepositEvent }).payload.amount = 999_999n;

    expect(ledger.verify()).toBe(0);
  });

  it("state is a pure fold over the log — replaying gives the same answer every time", () => {
    const ledger = new Ledger<DepositEvent>();
    ledger.append({ type: "deposit", account: "alice", amount: 100n }, 0n);
    ledger.append({ type: "deposit", account: "bob", amount: 200n }, 1n);
    ledger.append({ type: "deposit", account: "alice", amount: 50n }, 2n);

    const foldBalances = (log: Ledger<DepositEvent>) =>
      log.fold<Record<string, bigint>>((balances, entry) => {
        const next = { ...balances };
        next[entry.payload.account] = (next[entry.payload.account] ?? 0n) + entry.payload.amount;
        return next;
      }, {});

    const first = foldBalances(ledger);
    const second = foldBalances(ledger);
    expect(first).toEqual(second);
    expect(first.alice).toBe(150n);
    expect(first.bob).toBe(200n);
  });

  it("empty ledger has the genesis root", () => {
    const ledger = new Ledger<DepositEvent>();
    expect(ledger.root).toBe("0".repeat(64));
    expect(ledger.verify()).toBe(-1);
  });
});
