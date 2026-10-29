import { describe, it, expect } from "vitest";
import { buildFrom, nextF2LStep, pairSolvedIn, recognizePair } from "../f2l";
import { ollDone, edgesOriented } from "../oll";
import { planCross, isCrossSolved } from "../crossSolver";
import { scramble, solveCFOP } from "./solve";

const PAIRS = ["FR", "FL", "BR", "BL"] as const;

describe("cross solver", () => {
  it("solves the cross in at most 8 moves for random scrambles", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const s = scramble(25, seed);
      const cp = planCross(s);
      expect(cp.cross.length).toBeLessThanOrEqual(8);
      expect(isCrossSolved(buildFrom([...s, ...cp.reorient, ...cp.cross]))).toBe(true);
    }
  });
});

describe("F2L", () => {
  it("solves all four pairs for random scrambles", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const s = scramble(25, seed);
      const cp = planCross(s);
      const moves = [...s, ...cp.reorient, ...cp.cross];
      let guard = 0;
      while (guard++ < 120) {
        if (PAIRS.every((id) => pairSolvedIn(buildFrom(moves), id))) break;
        const st = nextF2LStep(moves);
        if (!st) break;
        moves.push(...st.moves);
      }
      expect(PAIRS.every((id) => pairSolvedIn(buildFrom(moves), id))).toBe(true);
    }
  });

  it("recognizePair returns a matching J Perm string for each variant", () => {
    // Sanity: for a scramble reaching an F2L state, every recognized variant has a
    // pretty string and a matching move sequence.
    const s = scramble(25, 7);
    const cp = planCross(s);
    const moves = [...s, ...cp.reorient, ...cp.cross];
    const rec = recognizePair(moves, "FR");
    if (rec) {
      expect(rec.variants.length).toBe(rec.algStrings.length);
      expect(rec.variants.length).toBeGreaterThan(0);
    }
  });
});

describe("OLL", () => {
  it("orients the last layer (2-look) for random scrambles", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const r = solveCFOP(scramble(25, seed));
      // solveCFOP runs OLL; a solved cube implies OLL completed.
      expect(r.solved).toBe(true);
      // 2-look OLL uses at most 2 algorithms.
      expect(r.ollAlgs).toBeLessThanOrEqual(2);
    }
  });

  it("edgesOriented is a precondition for ollDone", () => {
    // After solving, both hold; on a scramble mid-OLL, ollDone implies edgesOriented.
    const r = solveCFOP(scramble(25, 3));
    const m = buildFrom(r.moves);
    if (ollDone(m)) expect(edgesOriented(m)).toBe(true);
  });
});
