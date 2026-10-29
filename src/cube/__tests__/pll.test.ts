import { describe, it, expect } from "vitest";
import { buildFrom } from "../f2l";
import { recognizePLL, cornersSolved, pllDone } from "../pll";
import { parseMove, CubeModel } from "../CubeModel";
import { scramble, solveCFOP } from "./solve";

const tk = (s: string) => s.split(/\s+/).filter(Boolean);
const CORNER = [
  "F R U' R' U' R U R' F' R U R' U' R' F R F'", // Diagonal
  "R U R' U' R' F R2 U' R' U' R U R' F'", // Headlights
];
const AUF = ["", "U", "U2", "U'"];

function apply(seq: string[]): CubeModel {
  const m = new CubeModel();
  for (const t of seq) { const mv = parseMove(t); if (mv) m.applyMove(mv); }
  return m;
}

describe("PLL recognition", () => {
  it("solves every corner case with exactly one corner algorithm", () => {
    // Each corner case = AUF + a corner alg applied to a solved cube.
    const cases: string[][] = [[]];
    for (const a of CORNER) for (const pre of AUF) cases.push([...tk(pre), ...tk(a)]);

    for (const scr of cases) {
      let moves = [...scr];
      let cornerSteps = 0;
      let guard = 0;
      while (guard++ < 12) {
        if (cornersSolved(buildFrom(moves))) break;
        const step = recognizePLL(moves);
        if (!step) break;
        if (step.kind === "corner") cornerSteps++;
        moves.push(...step.moves);
      }
      expect(cornersSolved(buildFrom(moves))).toBe(true);
      // The regression we fixed: never two corner algorithms for one case.
      expect(cornerSteps).toBeLessThanOrEqual(1);
    }
  });

  it("never uses more than 2 algorithms total (1 corner + 1 edge) across many solves", () => {
    let maxAlgs = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = solveCFOP(scramble(25, seed));
      expect(r.solved).toBe(true);
      maxAlgs = Math.max(maxAlgs, r.pllAlgs);
    }
    expect(maxAlgs).toBeLessThanOrEqual(2);
  }, 30000);

  it("recognizes a fully solved last layer as done", () => {
    expect(recognizePLL([])).toBeNull();
    expect(pllDone(apply([]))).toBe(true);
  });
});
