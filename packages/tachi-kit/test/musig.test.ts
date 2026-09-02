import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { IndividualPubkey } from "@scure/btc-signer/musig2.js";
import { aggregateKey, createAggSigner, createInProcessExchangePair } from "../src/musig.js";

describe("aggregateKey", () => {
  it("is order-independent — both parties agree on P_agg regardless of input order", () => {
    const pubA = Buffer.from(IndividualPubkey(randomBytes(32)));
    const pubB = Buffer.from(IndividualPubkey(randomBytes(32)));

    const agg1 = aggregateKey([pubA, pubB]);
    const agg2 = aggregateKey([pubB, pubA]);
    expect(agg1.compressed.equals(agg2.compressed)).toBe(true);
    expect(agg1.xOnly.equals(agg2.xOnly)).toBe(true);
  });
});

describe("createAggSigner — interactive 2-party MuSig2", () => {
  it("produces a signature that verifies against the aggregate x-only pubkey", async () => {
    const secretA = randomBytes(32);
    const secretB = randomBytes(32);
    const pubA = Buffer.from(IndividualPubkey(secretA));
    const pubB = Buffer.from(IndividualPubkey(secretB));

    const [exchangeA, exchangeB] = createInProcessExchangePair();
    const signerA = createAggSigner({ localSecret: secretA, remotePub: pubB, exchange: exchangeA });
    const signerB = createAggSigner({ localSecret: secretB, remotePub: pubA, exchange: exchangeB });

    expect(signerA.publicKey.equals(signerB.publicKey)).toBe(true);
    expect(signerA.xOnly.equals(signerB.xOnly)).toBe(true);

    const sighash = Buffer.from(randomBytes(32));
    const [sigFromA] = await Promise.all([signerA.signSchnorr(sighash), signerB.signSchnorr(sighash)]);

    expect(schnorr.verify(sigFromA, sighash, signerA.xOnly)).toBe(true);
  });

  it("rejects ECDSA sign — nothing on Kōsen's taproot paths needs it", async () => {
    const secretA = randomBytes(32);
    const secretB = randomBytes(32);
    const pubB = Buffer.from(IndividualPubkey(secretB));
    const [exchangeA] = createInProcessExchangePair();
    const signerA = createAggSigner({ localSecret: secretA, remotePub: pubB, exchange: exchangeA });
    expect(() => signerA.sign(Buffer.from(randomBytes(32)))).toThrow(/ECDSA is not supported/);
  });

  it("a fresh signature each call still verifies (nonces are never reused)", async () => {
    const secretA = randomBytes(32);
    const secretB = randomBytes(32);
    const pubA = Buffer.from(IndividualPubkey(secretA));
    const pubB = Buffer.from(IndividualPubkey(secretB));

    for (let i = 0; i < 2; i++) {
      const [exchangeA, exchangeB] = createInProcessExchangePair();
      const signerA = createAggSigner({ localSecret: secretA, remotePub: pubB, exchange: exchangeA });
      const signerB = createAggSigner({ localSecret: secretB, remotePub: pubA, exchange: exchangeB });
      const sighash = Buffer.from(randomBytes(32));
      const [sig] = await Promise.all([signerA.signSchnorr(sighash), signerB.signSchnorr(sighash)]);
      expect(schnorr.verify(sig, sighash, signerA.xOnly)).toBe(true);
    }
  });
});
