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

// Dev/demo HTTP surface over the in-memory World (see demo-world.ts). This is
// deliberately not the production ledger service — no auth, no persistence,
// mutation routes exist only so the web app and demo scripts can drive a
// price drop or a repay live. The route shapes mirror what Phase 7's web app
// pages need (docs/PLAN.md): markets list, position detail, risk dashboard.
let world: World = createWorld();

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok" }));

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
// oracle price" over HTTP. These exist so scripts/demo-liquidate.ts and the
// web app's staged demo controls can drive the 5-minute demo script.
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

const port = Number(process.env.PORT ?? 4000);

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`kosen engine dev server listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
