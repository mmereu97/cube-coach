import { describe, it, expect } from "vitest";
import { scramble, solveCFOP } from "./solve";

describe("full CFOP solve", () => {
  it("solves 200 random scrambles end to end", () => {
    let solved = 0;
    for (let seed = 1; seed <= 200; seed++) {
      if (solveCFOP(scramble(25, seed)).solved) solved++;
    }
    expect(solved).toBe(200);
  }, 30000);

  it("solves an already-solved cube with no moves", () => {
    const r = solveCFOP([]);
    expect(r.solved).toBe(true);
  });

  it("solves short scrambles too", () => {
    for (let seed = 1; seed <= 50; seed++) {
      expect(solveCFOP(scramble(8, seed)).solved).toBe(true);
    }
  });
});
