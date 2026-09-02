import "dotenv/config";
import Fastify from "fastify";
import {
  createWorld,
  listPositions,
  marketView,
  positionView,
  repayOnPosition,
  riskView,
  setPrice,
  sweepLiquidations,
  type World,
} from "./demo-world.js";
import {
  createAggSigner,
  createInProcessExchangePair,
  resolveNetworkConfig,
  createBitcoinRpcClient,
  createTachiClient,
  assertTachiReachable,
  getVaultBalanceSats,
} from "@kosen/tachi-kit";
import { IndividualPubkey } from "@scure/btc-signer/musig2.js";
import { randomBytes } from "node:crypto";
import { WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import { LedgerWorld } from "./ledger-world.js";
import { TachiCollateralPort, type ChannelResources } from "./collateral-tachi.js";
import { supply } from "./shares.js";
import { ledgerMarketView, ledgerPositionView, ledgerRiskView, listLedgerPositions } from "./ledger-world-views.js";

// Dev/demo HTTP surface. Two modes, same route shapes, so the web app never
// needs to know which one is live:
//
//   KOSEN_MODE=sim   (default) — demo-world.ts's in-memory World. No
//                     network, no bitcoind. Fabricated vault ids.
//   KOSEN_MODE=tachi           — a real MuSig2 vault opened on regtest at
//                     startup (docs/DIRECTIVE-02.md Task 4/7), backed by
//                     LedgerWorld + TachiCollateralPort. Needs bitcoind and
//                     a reachable Tachi regtest daemon; fails loudly and
//                     immediately if either is missing rather than silently
//                     falling back to sim, since serving fabricated data
//                     while claiming to be "real" is exactly the dishonesty
//                     docs/DIRECTIVE-02.md's "Do not" section warns against.
const KOSEN_MODE = process.env.KOSEN_MODE === "tachi" ? "tachi" : "sim";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok", kosenMode: KOSEN_MODE }));

if (KOSEN_MODE === "sim") {
  let world: World = createWorld();

  app.get("/markets", async () => [marketView(world)]);

  app.get("/markets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const view = marketView(world);
    if (view.id !== id) return reply.code(404).send({ error: "unknown market" });
    return view;
  });

  app.get("/positions", async () => listPositions(world));

  app.get("/positions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const view = positionView(world, id);
    if (!view) return reply.code(404).send({ error: "unknown position" });
    return view;
  });

  app.post("/positions/:id/repay", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { assets } = req.body as { assets: string };
    try {
      world = repayOnPosition(world, id, BigInt(assets));
      return positionView(world, id);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get("/risk", async () => riskView(world));

  // Demo-only mutators — a real deployment would never expose "set the
  // oracle price" over HTTP. These exist so scripts/demo-liquidate.ts and
  // the web app's staged demo controls can drive the 5-minute demo script.
  app.post("/demo/price", async (req) => {
    const { priceLoanUnitsPerBtc } = req.body as { priceLoanUnitsPerBtc: string };
    world = setPrice(world, BigInt(priceLoanUnitsPerBtc));
    return marketView(world);
  });

  app.post("/demo/sweep-liquidations", async () => {
    world = sweepLiquidations(world);
    return riskView(world);
  });

  app.post("/demo/reset", async () => {
    world = createWorld();
    return marketView(world);
  });

  start();
} else {
  setupTachiMode().catch((err) => {
    app.log.error(err, "KOSEN_MODE=tachi startup failed — is bitcoind running and is the Tachi regtest daemon reachable?");
    process.exit(1);
  });
}

/** DEV/DEMO ONLY: mirrors scripts/05-seed-real-borrower.ts — never for production. */
function devOwnerSigner() {
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

const CSV_BLOCKS = 144;
const SEED_DEPOSIT = 100_000_000n; // 1 BTC
const SEED_PRICE_LOAN_UNITS_PER_BTC = 65_000n;
const SEED_DRAW_ASSETS = 40_000n;
const SEED_BORROWER_ID = "seed-borrower-xonly";
const SEED_POSITION_ID = "seed-borrower-1";

async function setupTachiMode(): Promise<void> {
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);
  app.log.info(`KOSEN_MODE=tachi: connecting to ${config.tachiUrl}...`);
  await assertTachiReachable(tachi, config);

  const mnemonic = process.env.DEMO_MNEMONIC;
  if (!mnemonic) throw new Error("DEMO_MNEMONIC is not set — copy .env.example to .env");
  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "regtest", rpc });
  const funderWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  await funderWallet.sync();

  const collateralPort = new TachiCollateralPort(config, (): ChannelResources => ({
    ownerSigner: devOwnerSigner(),
    funderWallet,
    rpc,
    borrowerReturnAddress: funderWallet.receiveAddress,
    protocolPayoutAddress: funderWallet.changeAddress,
  }));

  const world = new LedgerWorld(collateralPort, 0n);
  const { state: fundedAccounting } = supply(world.market.accounting, 10_000_000n);
  Object.assign(world.market, { accounting: fundedAccounting });

  app.log.info("KOSEN_MODE=tachi: opening a real MuSig2 vault on regtest for the seed borrower...");
  await world.openPosition(SEED_POSITION_ID, SEED_BORROWER_ID, SEED_DEPOSIT, CSV_BLOCKS, 0n);
  await world.draw(SEED_POSITION_ID, SEED_DRAW_ASSETS, SEED_PRICE_LOAN_UNITS_PER_BTC, 10n);
  app.log.info(`KOSEN_MODE=tachi: seeded, ledger root ${world.ledger.root}`);

  let currentPrice = SEED_PRICE_LOAN_UNITS_PER_BTC;
  const viewOptions = {
    collateralPort,
    readL1BalanceSats: (vaultAddress: string) => getVaultBalanceSats(rpc, vaultAddress),
  };

  app.get("/markets", async () => [ledgerMarketView(world)]);

  app.get("/markets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const view = ledgerMarketView(world);
    if (view.id !== id) return reply.code(404).send({ error: "unknown market" });
    return view;
  });

  app.get("/positions", async () => listLedgerPositions(world, currentPrice, viewOptions));

  app.get("/positions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const view = await ledgerPositionView(world, id, currentPrice, viewOptions);
    if (!view) return reply.code(404).send({ error: "unknown position" });
    return view;
  });

  app.post("/positions/:id/repay", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { assets } = req.body as { assets: string };
    try {
      await world.repay(id, BigInt(assets), currentPrice, BigInt(Date.now()));
      return ledgerPositionView(world, id, currentPrice, viewOptions);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get("/risk", async () => ledgerRiskView(world, currentPrice));

  app.post("/demo/price", async (req) => {
    const { priceLoanUnitsPerBtc } = req.body as { priceLoanUnitsPerBtc: string };
    currentPrice = BigInt(priceLoanUnitsPerBtc);
    return ledgerMarketView(world);
  });

  app.post("/demo/sweep-liquidations", async () => {
    await world.sweepLiquidations(currentPrice, BigInt(Date.now()));
    return ledgerRiskView(world, currentPrice);
  });

  // Unlike sim mode, "reset" can't fabricate a new world instantly — it
  // would mean opening another real vault on regtest. Not implemented; the
  // server needs restarting instead.

  start();
}

function start(): void {
  const port = Number(process.env.PORT ?? 4000);
  app
    .listen({ port, host: "0.0.0.0" })
    .then(() => app.log.info(`kosen engine dev server listening on :${port} (KOSEN_MODE=${KOSEN_MODE})`))
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
