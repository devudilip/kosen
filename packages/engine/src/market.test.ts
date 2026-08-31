import { describe, expect, it } from "vitest";
import { BTC_TO_BTC_LEVERAGE, BTC_TO_SATUSD, MarketRegistry, marketId } from "./market.js";

describe("marketId", () => {
  it("is deterministic for identical params", () => {
    expect(marketId(BTC_TO_SATUSD)).toBe(marketId({ ...BTC_TO_SATUSD }));
  });

  it("differs when any param differs (isolation is keyed on the full tuple)", () => {
    expect(marketId(BTC_TO_SATUSD)).not.toBe(marketId(BTC_TO_BTC_LEVERAGE));
  });
});

describe("MarketRegistry", () => {
  it("creates and retrieves a market", () => {
    const registry = new MarketRegistry();
    const market = registry.create(BTC_TO_SATUSD, 0n);
    expect(registry.get(market.id)).toEqual(market);
  });

  it("rejects creating the same market twice", () => {
    const registry = new MarketRegistry();
    registry.create(BTC_TO_SATUSD, 0n);
    expect(() => registry.create(BTC_TO_SATUSD, 0n)).toThrow(/already exists/);
  });

  it("throws on unknown market lookups", () => {
    const registry = new MarketRegistry();
    expect(() => registry.get("nonexistent")).toThrow(/unknown market/);
  });

  it("keeps two markets' accounting fully isolated", () => {
    const registry = new MarketRegistry();
    const a = registry.create(BTC_TO_SATUSD, 0n);
    const b = registry.create(BTC_TO_BTC_LEVERAGE, 0n);

    registry.update(a.id, { ...a.accounting, totalSupplyAssets: 1_000_000n });

    expect(registry.get(a.id).accounting.totalSupplyAssets).toBe(1_000_000n);
    expect(registry.get(b.id).accounting.totalSupplyAssets).toBe(0n);
  });
});
