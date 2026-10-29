// Test helper: drive a full CFOP solve with the same engine the app uses, so tests
// exercise the real cross/F2L/OLL/PLL recognizers rather than a parallel copy.
import { buildFrom, nextF2LStep, pairSolvedIn } from "../f2l";
import { planCross } from "../crossSolver";
import { recognizeOLL, ollDone } from "../oll";
import { recognizePLL, pllDone } from "../pll";

const FACES = ["U", "D", "F", "B", "L", "R"] as const;
const SUFFIX = ["", "'", "2"] as const;
const PAIRS = ["FR", "FL", "BR", "BL"] as const;

/** A deterministic pseudo-random scramble of `n` moves (seeded, so tests are stable). */
export function scramble(n: number, seed: number): string[] {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(FACES[Math.floor(rnd() * 6)] + SUFFIX[Math.floor(rnd() * 3)]);
  }
  return out;
}

export interface SolveResult {
  solved: boolean;
  moves: string[];
  f2lSteps: number;
  ollAlgs: number;
  pllAlgs: number;
}

/** Run the full CFOP pipeline on a scramble and report what happened. */
export function solveCFOP(scrambleMoves: string[]): SolveResult {
  const cp = planCross(scrambleMoves);
  const moves = [...scrambleMoves, ...cp.reorient, ...cp.cross];

  let f2lSteps = 0;
  let guard = 0;
  while (guard++ < 120) {
    if (PAIRS.every((id) => pairSolvedIn(buildFrom(moves), id))) break;
    const st = nextF2LStep(moves);
    if (!st) break;
    moves.push(...st.moves);
    f2lSteps++;
  }

  let ollAlgs = 0;
  guard = 0;
  while (guard++ < 20) {
    if (ollDone(buildFrom(moves))) break;
    const st = recognizeOLL(moves);
    if (!st) break;
    moves.push(...st.moves);
    ollAlgs++;
  }

  let pllAlgs = 0;
  guard = 0;
  while (guard++ < 12) {
    if (pllDone(buildFrom(moves))) break;
    const st = recognizePLL(moves);
    if (!st) break;
    if (st.kind === "corner" || st.kind === "edge") pllAlgs++;
    moves.push(...st.moves);
  }

  return { solved: pllDone(buildFrom(moves)), moves, f2lSteps, ollAlgs, pllAlgs };
}
