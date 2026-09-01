#!/usr/bin/env -S npx tsx
/**
 * Spike 04 — Track B: does the daemon accept a MuSig2 aggregate key as a
 * vault's owner key? (docs/COLLATERAL-MODEL.md §3.1 + §4,
 * docs/DIRECTIVE-02.md Task 2 acceptance criterion.)
 *
 * Exercises the REAL interactive 2-party protocol from
 * @kosen/tachi-kit's musig.ts (createAggSigner/aggregateKey) — the borrower
 * and protocol signers each hold only their own secret and communicate
 * exclusively through the `exchange` callback, wired here as a same-process
 * loopback standing in for the HTTP round trip a real deployment would use
 * (borrower side in the web app/CLI, protocol side in the engine).
 *
 * Uses fresh, ephemeral MuSig2 keypairs (not the shared demo mnemonic) so
 * this vault's address can never collide with satusd's own concurrent spike
 * of the identical scenario — vault addresses derive from the owner key,
 * and these are freshly random every run.
 *
 * Acceptance: registerVault committed with P_agg; pre-signed exit_tx is
 * REJECTED before the CSV delay and ACCEPTED after it; cosignRefund returns
 * 5 partials; the refund actually broadcasts and mines.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import {
  IndividualPubkey,
  sortKeys,
  keyAggregate,
  keyAggExport,
  nonceGen,
  nonceAggregate,
  Session,
} from "@scure/btc-signer/musig2.js";
import {
  createVault,
  verifyVaultP2tr,
  depositToVault,
  registerVault,
  buildUnilateralExitPsbt,
  signUnilateralExitPsbtAsUser,
  finalizeUnilateralExitPsbt,
  buildToLocalP2trOutput,
  buildRefundPsbt,
  signRefundPsbtAsUser,
  cosignRefund,
  finalizeRefundPsbt,
  RefundCosignError,
  encodeStateHint,
  deriveStateObfuscator,
  quorumAggregateKey,
} from "@tachibtc/taurus-vault-core";
import {
  resolveNetworkConfig,
  createTachiClient,
  createBitcoinRpcClient,
  assertTachiReachable,
  checkQuorum,
  registerDeposit,
  createAggSigner,
  aggregateKey,
  type Exchange,
  type ExchangeRound,
} from "@kosen/tachi-kit";

const CSV_BLOCKS = 144; // demo term (~1 day on mainnet), per COLLATERAL-MODEL.md §3
const DEPOSIT = 300_000n;
const LEDGER_FEE = 10n;
const EXIT_FEE = 1_000n;
const REFUND_FEE = 1_000n;
const REFUND_USER_VALUE = 250_000n;
const REFUND_PROTOCOL_VALUE = 49_000n; // DEPOSIT - REFUND_USER_VALUE - REFUND_FEE

/**
 * Reactive stand-in for the protocol's HTTP endpoint: only the borrower's
 * `createAggSigner` ever actively calls `signSchnorr` (mirroring production,
 * where the borrower's client drives each signature and the engine merely
 * responds). This function computes the protocol's half of the MuSig2
 * session on demand, using nothing but the same public primitives
 * `createAggSigner` itself uses — a real engine's HTTP handler would do
 * exactly this, just across a network hop instead of a function call.
 */
function makeProtocolResponder(protocolSecret: Uint8Array, protocolPub: Uint8Array, borrowerPub: Uint8Array): Exchange {
  const sortedPubs = sortKeys([new Uint8Array(borrowerPub), new Uint8Array(protocolPub)]) as Uint8Array[];
  const agg = keyAggregate(sortedPubs);
  const aggXOnly = Buffer.from(keyAggExport(agg));

  const orderByPubkey = (entries: { pub: Uint8Array; value: Uint8Array }[]): Uint8Array[] =>
    sortedPubs.map((pub) => entries.find((e) => bytesEqual(e.pub, pub))!.value);

  // Per-signature state: the protocol's own secret nonce must survive from
  // the 'nonce' round to the 'partial' round for the same sighash.
  const pending = new Map<string, { secretNonce: Uint8Array; publicNonce: Uint8Array; borrowerPublicNonce: Uint8Array }>();
  const msgKey = (msg: Uint8Array) => Buffer.from(msg).toString("hex");

  return async (round: ExchangeRound): Promise<Uint8Array> => {
    const k = msgKey(round.msg);
    if (round.round === "nonce") {
      const nonces = nonceGen(protocolPub, protocolSecret, aggXOnly, round.msg);
      pending.set(k, { secretNonce: nonces.secret, publicNonce: nonces.public, borrowerPublicNonce: round.data });
      return nonces.public;
    }
    const entry = pending.get(k);
    if (!entry) throw new Error("makeProtocolResponder: got a 'partial' round before the matching 'nonce' round");
    const aggNonce = nonceAggregate(
      orderByPubkey([
        { pub: borrowerPub, value: entry.borrowerPublicNonce },
        { pub: protocolPub, value: entry.publicNonce },
      ]),
    );
    const session = new Session(aggNonce, sortedPubs, round.msg);
    return session.sign(entry.secretNonce, protocolSecret);
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main() {
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  console.log("[musig] quorum:", await checkQuorum(tachi));

  const borrowerSecret = randomBytes(32);
  const protocolSecret = randomBytes(32);
  const borrowerPub = publicKeyOf(borrowerSecret);
  const protocolPub = publicKeyOf(protocolSecret);

  // The borrower's signer actively drives every signature; the protocol
  // side only reacts, exactly as it will once this responder moves behind
  // an HTTP endpoint in the engine.
  const aggSigner = createAggSigner({
    localSecret: borrowerSecret,
    remotePub: protocolPub,
    exchange: makeProtocolResponder(protocolSecret, protocolPub, borrowerPub),
  });

  const agg = aggregateKey([borrowerPub, protocolPub]);
  if (!agg.compressed.equals(aggSigner.publicKey)) {
    throw new Error("standalone aggregateKey() disagrees with createAggSigner()'s P_agg");
  }
  console.log("[musig] P_agg x-only:", agg.xOnly.toString("hex"));
  console.log("[musig] P_agg compressed:", agg.compressed.toString("hex"));

  const vault = await createVault({
    network: "regtest",
    userPubkey: aggSigner.publicKey,
    csvBlocks: CSV_BLOCKS,
    validators: { endpoint: `${config.tachiUrl}/tachi_validators` },
  });
  verifyVaultP2tr(vault.p2tr);
  if (vault.userKey.xOnly.toString("hex") !== agg.xOnly.toString("hex")) {
    throw new Error("vault.userKey.xOnly does not match the MuSig2 aggregate key");
  }
  console.log("[musig] vault ACCEPTED P_agg as owner key:", vault.p2tr.address);
  console.log("[musig] exit leaf csvBlocks:", vault.p2tr.exitLeaf.csvBlocks);

  // Funding wallet is unrelated to the vault's owner key — any P2WPKH
  // source works. Own key index to avoid any UTXO contention with other
  // scripts sharing the demo mnemonic.
  const mnemonic = process.env.DEMO_MNEMONIC!;
  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "regtest", rpc });
  const funderWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  await funderWallet.sync();

  const dep = await depositToVault({ vault, userWallet: funderWallet, rpc, amountSats: DEPOSIT, feeRateSatVb: 2 });
  await rpc.call("generatetoaddress", [1, funderWallet.receiveAddress]);
  const raw = await rpc.call<{ vout: { n: number; scriptPubKey: { hex: string } }[] }>("getrawtransaction", [
    dep.txid,
    true,
  ]);
  const spk = vault.p2tr.output.toString("hex");
  const vout = raw.vout.find((o) => o.scriptPubKey.hex === spk)!.n;
  console.log("[musig] funded", dep.txid, "vout", vout);

  const onboard = await registerDeposit(config, { userSigner: aggSigner, amountSats: DEPOSIT, feeSats: LEDGER_FEE });
  console.log("[musig] ledger VTXO onboarded (agg-signed):", onboard.vtxoId.toString("hex"));

  const reg = await registerVault({
    vault,
    outpoint: { fundingTxid: Buffer.from(dep.txid, "hex").reverse(), fundingVout: vout },
    userSigner: aggSigner,
    inputs: [{ vtxoId: onboard.vtxoId, txid: dep.txid, vout, valueSats: DEPOSIT }],
    outputs: [{ owner: Buffer.from(vault.userKey.xOnly), amount: DEPOSIT - LEDGER_FEE }],
    feeSats: LEDGER_FEE,
    broadcast: { url: `${config.tachiUrl}/tachi_txBroadcastSync` },
    account: { baseUrl: config.tachiUrl },
    confirm: { baseUrl: config.tachiUrl, overallTimeoutMs: 90_000 },
  });
  console.log(
    "[musig] VAULT REGISTERED (agg-signed) id=",
    reg.vaultIdHex,
    "committed=",
    reg.commit?.committed,
    "code=",
    reg.commit?.code,
  );

  // Pre-sign the exit tx BEFORE any loan asset would be released — this is
  // what the borrower holds from the moment the vault opens.
  const funding = { txid: dep.txid, vout, valueSats: DEPOSIT, scriptPubKey: spk };
  const exitBuilt = buildUnilateralExitPsbt({
    vault,
    funding,
    outputs: [{ address: funderWallet.receiveAddress, valueSats: DEPOSIT - EXIT_FEE }],
    feeSats: EXIT_FEE,
  });
  const exitVerify = { maxFeeSats: 5_000n, expectedUserKey: vault.p2tr.exitLeaf.userKey, minCsvBlocks: CSV_BLOCKS };
  await signUnilateralExitPsbtAsUser(exitBuilt.psbt, aggSigner, vault, exitVerify);
  const exitTxHex = finalizeUnilateralExitPsbt(exitBuilt.psbt, vault, exitVerify);
  console.log("[musig] exit_tx pre-signed and held (not broadcast), length", exitTxHex.length, "hex chars");

  const tooEarly = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [
    [exitTxHex],
  ]);
  console.log("[musig] exit_tx accepted before CSV matures?", tooEarly[0].allowed, tooEarly[0]["reject-reason"] ?? "");
  if (tooEarly[0].allowed) throw new Error("exit_tx should NOT be valid before the CSV delay matures");

  await rpc.call("generatetoaddress", [CSV_BLOCKS, funderWallet.receiveAddress]);
  const matured = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [
    [exitTxHex],
  ]);
  console.log("[musig] exit_tx accepted after CSV matures?", matured[0].allowed, matured[0]["reject-reason"] ?? "");
  if (!matured[0].allowed) throw new Error("exit_tx should be valid once the CSV delay has matured");

  // Commit a liquidation refund state — agg-signed, quorum-cosigned.
  const toLocal = buildToLocalP2trOutput({
    network: "regtest",
    nodePubkeys: vault.p2tr.cooperativeLeaf.nodeKeysCompressed,
    threshold: vault.p2tr.cooperativeLeaf.threshold,
    userDelayedPubkey: vault.userKey.xOnly,
    toSelfDelay: vault.p2tr.exitLeaf.csvBlocks,
  });
  const obf = deriveStateObfuscator(
    agg.compressed,
    quorumAggregateKey(vault.p2tr.cooperativeLeaf.nodeKeysCompressed),
  );
  const hint = encodeStateHint(1n, obf);
  const refundBuilt = buildRefundPsbt({
    vault,
    funding,
    toLocal,
    userValueSats: REFUND_USER_VALUE,
    extraOutputs: [{ address: funderWallet.changeAddress, valueSats: REFUND_PROTOCOL_VALUE }],
    feeSats: REFUND_FEE,
    sequence: hint.sequence,
    locktime: hint.locktime,
  });
  const refundVerify = {
    maxFeeSats: 5_000n,
    toLocal,
    expectedUserValueSats: REFUND_USER_VALUE,
    expectedDelayedPubkey: vault.userKey.xOnly,
  };
  await signRefundPsbtAsUser(refundBuilt.psbt, aggSigner, vault, refundVerify);
  let refundHex: string;
  try {
    const res = await cosignRefund(refundBuilt.psbt, vault, {
      url: `${config.tachiUrl}/tachi_signTransaction`,
      timeoutMs: 90_000,
    });
    console.log("[musig] REFUND COSIGNED (agg-signed):", res.attached, "partials");
    refundHex = finalizeRefundPsbt(refundBuilt.psbt, vault, refundVerify);
  } catch (e) {
    if (e instanceof RefundCosignError) throw new Error(`cosign failed: status=${e.status} msg=${e.message}`);
    throw e;
  }

  const acceptRefund = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [
    [refundHex],
  ]);
  console.log("[musig] refund testmempoolaccept:", acceptRefund[0].allowed, acceptRefund[0]["reject-reason"] ?? "");
  if (!acceptRefund[0].allowed) throw new Error("cosigned refund was not accepted by bitcoind");
  const refundTxid = await rpc.call<string>("sendrawtransaction", [refundHex]);
  await rpc.call("generatetoaddress", [1, funderWallet.receiveAddress]);
  console.log("[musig] REFUND BROADCAST + MINED:", refundTxid);

  console.log(
    "[musig] PASS — daemon accepts a MuSig2 aggregate key as vault owner; exit_tx and refund_n both agg-signed (via the real 2-party interactive protocol) and functional",
  );
}

function publicKeyOf(secret: Uint8Array): Uint8Array {
  // Local re-derivation only for wiring remotePub into each side's signer —
  // production code never needs this since each party already knows its own
  // pubkey and learns the counterparty's out of band at vault-open time.
  return IndividualPubkey(secret);
}

main().catch((err) => {
  console.error("[musig] failed:", err);
  process.exit(1);
});
