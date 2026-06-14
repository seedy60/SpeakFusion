import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { kickThreshold } from "./kick-util.js";

describe("kickThreshold", () => {
  it("is disabled below three people (no majority possible with two)", () => {
    assert.equal(kickThreshold(0), Infinity);
    assert.equal(kickThreshold(1), Infinity);
    assert.equal(kickThreshold(2), Infinity);
  });

  it("needs two votes with three people", () => {
    assert.equal(kickThreshold(3), 2);
  });

  it("needs at least half with four or more people", () => {
    assert.equal(kickThreshold(4), 2);
    assert.equal(kickThreshold(5), 3);
    assert.equal(kickThreshold(6), 3);
    assert.equal(kickThreshold(7), 4);
    assert.equal(kickThreshold(10), 5);
  });
});
