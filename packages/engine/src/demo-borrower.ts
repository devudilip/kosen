// DEV/DEMO ONLY — never for production. Builds a composite AggSigner that
// drives BOTH the borrower's and the protocol's real MuSig2 signer instances
// concurrently, in one process (docs/DIRECTIVE-02.md Task 4: "seed one real
// borrower on startup in dev"). A live deployment splits these across an
// HTTP round trip (borrower's client vs. the engine) — see musig.ts's own
// doc comment on `createInProcessExchangePair`. This exists purely so a dev
// server or a seed script can open one real channel on regtest without
// standing up that HTTP layer first.
import { randomBytes } from "node:crypto";
import { IndividualPubkey } from "@scure/btc-signer/musig2.js";
import { createAggSigner, createInProcessExchangePair, type AggSigner } from "@kosen/tachi-kit";

export function createDemoOwnerSigner(): AggSigner {
  const borrowerSecret = randomBytes(32);
  const protocolSecret = randomBytes(32);
  const borrowerPub = Buffer.from(IndividualPubkey(borrowerSecret));
  const protocolPub = Buffer.from(IndividualPubkey(protocolSecret));

  const [exchangeForBorrower, exchangeForProtocol] = createInProcessExchangePair();
  const borrowerSigner = createAggSigner({ localSecret: borrowerSecret, remotePub: protocolPub, exchange: exchangeForBorrower });
  const protocolSigner = createAggSigner({ localSecret: protocolSecret, remotePub: borrowerPub, exchange: exchangeForProtocol });

  return {
    publicKey: borrowerSigner.publicKey,
    xOnly: borrowerSigner.xOnly,
    sign(): never {
      throw new Error("ECDSA is not supported on a MuSig2 owner key — Taproot script-path spends only");
    },
    async signSchnorr(sighash: Buffer): Promise<Buffer> {
      const [sig] = await Promise.all([borrowerSigner.signSchnorr(sighash), protocolSigner.signSchnorr(sighash)]);
      return sig;
    },
  };
}
