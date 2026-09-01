import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { IndividualPubkey } from "@scure/btc-signer/musig2.js";
import { aggregateKey, createAggSigner, type Exchange, type ExchangeRound } from "../src/musig.js";

/**
 * Wires two `createAggSigner` instances together in-process so a signing
 * round trip can run without a real network — this is the "responder" side
 * of the interactive protocol musig.ts's own doc comment describes: in
 * production this logic lives behind the counterparty's HTTP endpoint
 * (borrower's web app / CLI, or the engine), not inside the signer itself.
 */
function wireLoopback(): { exchangeForA: Exchange; exchangeForB: Exchange } {
  // Each side's pending state, keyed by the message being signed, so a
  // 'nonce' call and the matching 'partial' call for the same signature can
  // find each other regardless of call order.
  const pending = new Map<string, { fromA?: ExchangeRound; fromB?: ExchangeRound }>();
  const waiters = new Map<string, ((round: ExchangeRound) => void)[]>();

  function key(msg: Uint8Array, round: string): string {
    return `${Buffer.from(msg).toString("hex")}:${round}`;
  }

  function post(from: "A" | "B", round: ExchangeRound): Promise<Uint8Array> {
    const k = key(round.msg, round.round);
    const entry = pending.get(k) ?? {};
    if (from === "A") entry.fromA = round;
    else entry.fromB = round;
    pending.set(k, entry);

    const other = from === "A" ? entry.fromB : entry.fromA;
    if (other) return Promise.resolve(other.data);

    // Wait for the counterpart to post the same round.
    return new Promise((resolve) => {
      const list = waiters.get(k) ?? [];
      list.push((r) => resolve(r.data));
      waiters.set(k, list);
    });
  }

  // When a post arrives, wake anyone waiting on the OTHER side's post for this key.
  function notify(from: "A" | "B", round: ExchangeRound): void {
    const k = key(round.msg, round.round);
    const list = waiters.get(k);
    if (list && list.length > 0) {
      for (const resolve of list) resolve(round);
      waiters.delete(k);
    }
  }

  const exchangeForA: Exchange = async (round) => {
    notify("A", round);
    return post("A", round);
  };
  const exchangeForB: Exchange = async (round) => {
    notify("B", round);
    return post("B", round);
  };

  return { exchangeForA, exchangeForB };
}

describe("aggregateKey", () => {
  it("is order-independent — both parties agree on P_agg regardless of input order", () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    const pubA = IndividualPubkey(a);
    const pubB = IndividualPubkey(b);

    const agg1 = aggregateKey([pubA, pubB]);
    const agg2 = aggregateKey([pubB, pubA]);
    expect(agg1.compressed.equals(agg2.compressed)).toBe(true);
    expect(agg1.xOnly.equals(agg2.xOnly)).toBe(true);
  });

  it("rejects fewer than 2 pubkeys", () => {
    expect(() => aggregateKey([IndividualPubkey(randomBytes(32))])).toThrow(/at least 2/);
  });
});

describe("createAggSigner — interactive 2-party MuSig2", () => {
  it("produces a signature that verifies against the aggregate x-only pubkey", async () => {
    const secretA = randomBytes(32);
    const secretB = randomBytes(32);
    const pubA = IndividualPubkey(secretA);
    const pubB = IndividualPubkey(secretB);

    const { exchangeForA, exchangeForB } = wireLoopback();
    const signerA = createAggSigner({ localSecret: secretA, remotePub: pubB, exchange: exchangeForA });
    const signerB = createAggSigner({ localSecret: secretB, remotePub: pubA, exchange: exchangeForB });

    expect(signerA.publicKey.equals(signerB.publicKey)).toBe(true);

    const sighash = randomBytes(32);
    const [sigFromA] = await Promise.all([
      signerA.signSchnorr(sighash),
      signerB.signSchnorr(sighash),
    ]);

    const aggXOnly = signerA.publicKey.subarray(1);
    const valid = schnorr.verify(sigFromA, sighash, aggXOnly);
    expect(valid).toBe(true);
  });

  it("rejects ECDSA sign — nothing on Kōsen's taproot paths needs it", async () => {
    const secretA = randomBytes(32);
    const secretB = randomBytes(32);
    const pubB = IndividualPubkey(secretB);
    const { exchangeForA } = wireLoopback();
    const signerA = createAggSigner({ localSecret: secretA, remotePub: pubB, exchange: exchangeForA });
    await expect(signerA.sign(randomBytes(32))).rejects.toThrow(/ECDSA sign is not supported/);
  });

  it("a different message pair still verifies (fresh nonces every call)", async () => {
    const secretA = randomBytes(32);
    const secretB = randomBytes(32);
    const pubA = IndividualPubkey(secretA);
    const pubB = IndividualPubkey(secretB);

    for (let i = 0; i < 2; i++) {
      const { exchangeForA, exchangeForB } = wireLoopback();
      const signerA = createAggSigner({ localSecret: secretA, remotePub: pubB, exchange: exchangeForA });
      const signerB = createAggSigner({ localSecret: secretB, remotePub: pubA, exchange: exchangeForB });
      const sighash = randomBytes(32);
      const [sig] = await Promise.all([signerA.signSchnorr(sighash), signerB.signSchnorr(sighash)]);
      expect(schnorr.verify(sig, sighash, signerA.publicKey.subarray(1))).toBe(true);
    }
  });
});
