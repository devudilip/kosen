/**
 * MuSig2 signer for Kōsen's joint-key TAURUS vault (docs/COLLATERAL-MODEL.md
 * §3-4, docs/DIRECTIVE-02.md Task 2).
 *
 * satusd hasn't shipped musig.ts yet as of this writing (checked: only
 * net/vault/vtxo/collateral/health exist in their tachi-kit). Per Directive
 * 02 — "if they are behind, implement against the §6 contract and hand it
 * back to them" — this implements exactly that contract:
 *
 *   createAggSigner({ localSecret, remotePub, exchange }) → TaprootSigner
 *   aggregateKey(pubs) → { xOnly, compressed }
 *
 * Do not diverge these names or shapes; satusd vendors this back once they
 * see it, or Kōsen vendors theirs if they land it first — whichever happens,
 * both sides must agree on this exact surface.
 *
 * Why a joint key: docs/COLLATERAL-MODEL.md §1 verified that a single-key
 * borrower vault lets the borrower cosign a refund paying 100% to
 * themselves at any time — a single key cannot secure a lender. The owner
 * key of a Kōsen collateral vault must instead be P_agg = MuSig2(borrower,
 * protocol), so every cooperative spend (including a "refund to myself")
 * needs the protocol's partial signature too.
 */
import {
  IndividualPubkey,
  sortKeys,
  keyAggregate,
  keyAggExport,
  nonceGen,
  nonceAggregate,
  Session,
} from "@scure/btc-signer/musig2.js";

/** BIP-340 Schnorr-capable signer shape @tachibtc/taurus-vault-core expects everywhere. */
export interface TaprootSigner {
  publicKey: Buffer;
  sign(hash: Uint8Array): Promise<Uint8Array>;
  signSchnorr(hash: Uint8Array): Promise<Uint8Array>;
}

export interface AggregateKeyResult {
  /** 32-byte x-only aggregate pubkey — what gets embedded in tapscript leaves. */
  readonly xOnly: Buffer;
  /** 33-byte compressed aggregate pubkey — what `createVault({ userPubkey })` wants. */
  readonly compressed: Buffer;
}

/**
 * Deterministically aggregates a set of participant pubkeys into the MuSig2
 * key both parties' vault leaves are built against. `sortKeys` first, so both
 * parties independently computing this from the same two pubkeys always
 * agree on the same P_agg regardless of the order they were supplied in.
 */
export function aggregateKey(pubs: readonly Uint8Array[]): AggregateKeyResult {
  if (pubs.length < 2) throw new Error("aggregateKey: need at least 2 participant pubkeys");
  const sorted = sortKeys(pubs as Uint8Array[]);
  const ctx = keyAggregate(sorted);
  // keyAggExport returns the 32-byte BIP-340 x-only key directly (verified:
  // it is NOT a 33-byte compressed key with the leading byte stripped off).
  // The compressed form — needed for `createVault({ userPubkey })` — comes
  // from the aggregate point itself, which carries the Y parity x-only
  // export throws away.
  const xOnly = Buffer.from(keyAggExport(ctx));
  const compressed = Buffer.from((ctx.aggPublicKey as { toBytes(isCompressed: boolean): Uint8Array }).toBytes(true));
  return { xOnly, compressed };
}

/** One round of the interactive 2-party MuSig2 protocol. */
export interface ExchangeRound {
  readonly round: "nonce" | "partial";
  /** The sighash being signed — the remote party must verify this is what it agreed to before contributing. */
  readonly msg: Uint8Array;
  /** This party's contribution for the round (a public nonce, or a partial signature). */
  readonly data: Uint8Array;
}

/**
 * Transport for the 2-party MuSig2 round trip: send this party's
 * contribution for a round, get back the counterparty's contribution for
 * the same round. In production this is one HTTP call each way — the
 * borrower's side runs in the web app/CLI, the protocol's side runs in the
 * engine (docs/COLLATERAL-MODEL.md §4). For spikes, both parties can live in
 * one process with `exchange` wired directly between two local signers.
 */
export type Exchange = (round: ExchangeRound) => Promise<Uint8Array>;

export interface CreateAggSignerArgs {
  /** This party's own secret key. Never leaves this function. */
  readonly localSecret: Uint8Array;
  /** The counterparty's compressed public key. */
  readonly remotePub: Uint8Array;
  /** Interactive transport to the counterparty (see {@link Exchange}). */
  readonly exchange: Exchange;
}

/** Reorders per-party contributions into the same order as `sortKeys([localPub, remotePub])` gave the session. */
function orderByPubkey<T>(
  sortedPubs: readonly Uint8Array[],
  entries: readonly { pub: Uint8Array; value: T }[],
): T[] {
  return sortedPubs.map((pub) => {
    const match = entries.find((e) => bytesEqual(e.pub, pub));
    if (!match) throw new Error("orderByPubkey: no contribution for one of the sorted pubkeys");
    return match.value;
  });
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Builds a {@link TaprootSigner} backed by an interactive 2-party MuSig2
 * session. `publicKey` is P_agg (compressed) — hand this signer to any
 * `@tachibtc/taurus-vault-core` sign* function exactly like a normal wallet
 * signer; every `signSchnorr` call runs the full nonce-exchange +
 * partial-sign + aggregate round trip underneath.
 *
 * SECURITY: a fresh nonce pair is generated per `signSchnorr` call and is
 * never reused — see @scure/btc-signer/musig2.js's `nonceGen` doc. `sign`
 * (ECDSA) is not supported: nothing on Kōsen's taproot paths needs it.
 */
export function createAggSigner({ localSecret, remotePub, exchange }: CreateAggSignerArgs): TaprootSigner {
  const localPub = Buffer.from(IndividualPubkey(localSecret));
  const sortedPubs = sortKeys([new Uint8Array(localPub), new Uint8Array(remotePub)]);
  const agg = keyAggregate(sortedPubs);
  const aggXOnly = Buffer.from(keyAggExport(agg)); // 32 bytes — nonceGen's aggPublicKey param wants this form
  const aggPubCompressed = Buffer.from(
    (agg.aggPublicKey as { toBytes(isCompressed: boolean): Uint8Array }).toBytes(true),
  );

  return {
    publicKey: aggPubCompressed,
    async sign(): Promise<Uint8Array> {
      throw new Error("createAggSigner: ECDSA sign is not supported — every Kōsen taproot path uses signSchnorr");
    },
    async signSchnorr(sighash: Uint8Array): Promise<Uint8Array> {
      const msg = new Uint8Array(sighash);

      // Round 1: each party generates a fresh nonce pair and exchanges the public half.
      const localNonces = nonceGen(localPub, localSecret, aggXOnly, msg);
      const remoteNonce = await exchange({ round: "nonce", msg, data: localNonces.public });
      const aggNonce = nonceAggregate(
        orderByPubkey(sortedPubs, [
          { pub: localPub, value: localNonces.public },
          { pub: remotePub, value: remoteNonce },
        ]),
      );

      // Round 2: each party computes and exchanges its partial signature.
      const session = new Session(aggNonce, sortedPubs, msg);
      const localPartial = session.sign(localNonces.secret, localSecret);
      const remotePartial = await exchange({ round: "partial", msg, data: localPartial });

      const finalSig = session.partialSigAgg(
        orderByPubkey(sortedPubs, [
          { pub: localPub, value: localPartial },
          { pub: remotePub, value: remotePartial },
        ]),
      );
      return finalSig;
    },
  };
}
