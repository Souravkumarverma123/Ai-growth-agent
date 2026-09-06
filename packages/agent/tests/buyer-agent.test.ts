import { describe, expect, it } from "vitest";

import { BuyerAgent, type BuyerConstraints, type MerchantOfferView } from "../buyer";

/**
 * TICKET-206 — the buyer agent's decision behaviour and the "reservation
 * price never leaves this object" guarantee. Asserts external behaviour: what
 * the buyer decides and what it says, never how it is implemented.
 */

const CONSTRAINTS: BuyerConstraints = {
  budgetMinor: 200_000,
  goal: "Buy serum and cleanser without overpaying.",
  latitude: "Push back a bit, then decide.",
};

const offer = (totalMinor: number): MerchantOfferView => ({ totalMinor, currency: "INR" });

describe("BuyerAgent decisions", () => {
  it("accepts an offer at or below its hidden budget", () => {
    const buyer = new BuyerAgent(CONSTRAINTS);
    expect(buyer.reactToOffer(offer(200_000)).kind).toBe("ACCEPT");
    expect(new BuyerAgent(CONSTRAINTS).reactToOffer(offer(150_000)).kind).toBe("ACCEPT");
  });

  it("declines an over-budget offer, then walks once its patience runs out", () => {
    const buyer = new BuyerAgent(CONSTRAINTS, { patience: 2 });
    expect(buyer.reactToOffer(offer(300_000)).kind).toBe("DECLINE");
    expect(buyer.reactToOffer(offer(280_000)).kind).toBe("DECLINE");
    expect(buyer.reactToOffer(offer(260_000)).kind).toBe("WALK_AWAY");
  });

  it("still accepts a good offer that arrives after earlier push-backs", () => {
    const buyer = new BuyerAgent(CONSTRAINTS, { patience: 2 });
    buyer.reactToOffer(offer(300_000));
    expect(buyer.reactToOffer(offer(190_000)).kind).toBe("ACCEPT");
  });
});

describe("BuyerAgent never reveals its reservation price", () => {
  it("no message it can emit contains a digit", () => {
    const buyer = new BuyerAgent(CONSTRAINTS, { patience: 1 });
    const messages = [
      buyer.openingMessage(),
      buyer.reactToOffer(offer(300_000)).message,
      buyer.reactToOffer(offer(280_000)).message, // walk-away message
    ];
    const accepting = new BuyerAgent(CONSTRAINTS).reactToOffer(offer(100_000)).message;
    for (const message of [...messages, accepting]) {
      expect(message).not.toMatch(/\d/);
      expect(message).not.toContain(String(CONSTRAINTS.budgetMinor));
    }
  });

  it("its reaction carries only a decision kind and a text message — no numeric field", () => {
    const action = new BuyerAgent(CONSTRAINTS).reactToOffer(offer(999_999));
    expect(Object.keys(action).sort()).toEqual(["kind", "message"]);
  });
});

describe("BuyerAgent is deterministic for a (constraints, seed) pair", () => {
  function messagesFor(seed: number): string[] {
    const buyer = new BuyerAgent(CONSTRAINTS, { seed, patience: 3 });
    return [
      buyer.openingMessage(),
      buyer.reactToOffer(offer(300_000)).message,
      buyer.reactToOffer(offer(300_000)).message,
      buyer.reactToOffer(offer(300_000)).message,
    ];
  }

  it("same seed → identical wording", () => {
    expect(messagesFor(206)).toEqual(messagesFor(206));
  });

  it("different seed → the decisions are the same even if wording differs", () => {
    const a = new BuyerAgent(CONSTRAINTS, { seed: 1, patience: 2 });
    const b = new BuyerAgent(CONSTRAINTS, { seed: 2, patience: 2 });
    for (const total of [300_000, 280_000, 260_000]) {
      expect(a.reactToOffer(offer(total)).kind).toBe(b.reactToOffer(offer(total)).kind);
    }
  });
});
