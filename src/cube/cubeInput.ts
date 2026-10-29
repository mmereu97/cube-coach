import * as THREE from "three";
import { CubeModel, COLORS, type Cubie } from "./CubeModel";
import {
  setSolveBase, buildFrom, inverseAlg, pairSolvedIn, crossSolvedIn, nextF2LStep,
} from "./f2l";
import { planCross } from "./crossSolver";
import { recognizeOLL, ollDone } from "./oll";
import { recognizePLL, pllDone } from "./pll";

/**
 * cubeInput.ts — turn a hand-painted cube into a solvable engine state.
 *
 * We paint directly on the 3D cube with the centers fixed to our convention
 * (yellow up, white down, green front, blue back, red right, orange left). Each
 * painted sticker is the world-facing colour of a cubie's face, so a painted
 * state is just a CubeModel with identity orientation and those colours — no
 * sticker-to-piece conversion needed.
 *
 * Validation has three layers: exactly nine of each colour, every real piece
 * present exactly once, and the state must actually be solvable (checked by
 * running the solver itself, which is the ground truth).
 */

const FN: THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
];
const keyv = (v: THREE.Vector3) => `${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)}`;

// Fixed centre colour for each face direction (our standard hold).
export const CENTER_COLOR: Record<string, string> = {
  "0,1,0": COLORS.U, "0,-1,0": COLORS.D, "0,0,1": COLORS.F,
  "0,0,-1": COLORS.B, "1,0,0": COLORS.R, "-1,0,0": COLORS.L,
};

export const PAINT_COLORS = [COLORS.U, COLORS.D, COLORS.F, COLORS.B, COLORS.R, COLORS.L];
export const UNPAINTED = "#3a3d44";

export interface PaintCubie {
  pos: THREE.Vector3;
  colors: [string, string, string, string, string, string]; // world-facing, +X..-Z
}

/** All 26 cubies with centres coloured and outward faces unpainted. */
export function emptyPaint(): PaintCubie[] {
  const out: PaintCubie[] = [];
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) {
        if (x === 0 && y === 0 && z === 0) continue;
        const pos = new THREE.Vector3(x, y, z);
        const colors = ["", "", "", "", "", ""] as PaintCubie["colors"];
        for (let i = 0; i < 6; i++) {
          const outward = Math.round(pos.dot(FN[i])) === 1; // this face points outward
          if (!outward) colors[i] = COLORS.inner;
          else {
            const isCenter = [x, y, z].filter((v) => v === 0).length === 2;
            colors[i] = isCenter ? CENTER_COLOR[keyv(FN[i])] : UNPAINTED;
          }
        }
        out.push({ pos, colors });
      }
  return out;
}

/** Export a (possibly scrambled) model to painted form — for round-trip / editing. */
export function exportPaint(model: CubeModel): PaintCubie[] {
  return model.cubies.map((c) => {
    const inv = c.quat.clone().invert();
    const colors = ["", "", "", "", "", ""] as PaintCubie["colors"];
    for (let w = 0; w < 6; w++) {
      // Which local face currently points to world direction FN[w]?
      const localDir = FN[w].clone().applyQuaternion(inv);
      const j = FN.findIndex((f) => keyv(f) === keyv(localDir));
      colors[w] = c.colors[j];
    }
    return { pos: c.pos.clone(), colors };
  });
}

// The 24 orientation rotations of a cube.
function orientationQuats(): THREE.Quaternion[] {
  const seen = new Map<string, THREE.Quaternion>();
  const gens = [
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2),
  ];
  const sig = (q: THREE.Quaternion) =>
    FN.map((f) => keyv(f.clone().applyQuaternion(q))).join(";");
  const queue = [new THREE.Quaternion()];
  seen.set(sig(queue[0]), queue[0]);
  while (queue.length) {
    const q = queue.shift()!;
    for (const g of gens) {
      const nq = g.clone().multiply(q);
      const s = sig(nq);
      if (!seen.has(s)) { seen.set(s, nq); queue.push(nq); }
    }
  }
  return [...seen.values()];
}
const ORIENTS = orientationQuats();

/** Build an engine model from painted cubies (birth colours + orientation quat). */
export function buildFromPaint(paint: PaintCubie[]): CubeModel {
  const solved = new CubeModel();
  // colour-set -> a solved cubie's birth colours
  const birthBySet = new Map<string, Cubie["colors"]>();
  for (const c of solved.cubies) {
    const set = c.colors.filter((x) => x !== COLORS.inner).sort().join("|");
    birthBySet.set(set, [...c.colors] as Cubie["colors"]);
  }

  const m = new CubeModel();
  m.cubies = paint.map((p, i): Cubie => {
    const zeros = [p.pos.x, p.pos.y, p.pos.z].filter((v) => Math.round(v) === 0).length;
    if (zeros >= 2) {
      // centre: fixed birth colours, identity orientation
      const solvedC = solved.cubies.find((c) => keyv(c.pos) === keyv(p.pos))!;
      return { id: i, pos: p.pos.clone(), quat: new THREE.Quaternion(), colors: [...solvedC.colors] as Cubie["colors"] };
    }
    const set = p.colors.filter((x) => x !== COLORS.inner).sort().join("|");
    const birth = birthBySet.get(set)!; // piece identity → its birth colours
    // Find the orientation whose world-facing colours reproduce the painted ones.
    let quat = new THREE.Quaternion();
    for (const q of ORIENTS) {
      let match = true;
      for (let f = 0; f < 6; f++) {
        if (birth[f] === COLORS.inner) continue;
        const worldDir = FN[f].clone().applyQuaternion(q);
        const w = FN.findIndex((ff) => keyv(ff) === keyv(worldDir));
        if (p.colors[w] !== birth[f]) { match = false; break; }
      }
      if (match) { quat = q.clone(); break; }
    }
    return { id: i, pos: p.pos.clone(), quat, colors: [...birth] as Cubie["colors"] };
  });
  return m;
}

// ---- validation ----
const OPP: Record<string, string> = {
  [COLORS.U]: COLORS.D, [COLORS.D]: COLORS.U, [COLORS.F]: COLORS.B,
  [COLORS.B]: COLORS.F, [COLORS.R]: COLORS.L, [COLORS.L]: COLORS.R,
};

function validCornerSets(): Set<string> {
  const s = new Set<string>();
  for (const ud of [COLORS.U, COLORS.D])
    for (const a of [COLORS.F, COLORS.B])
      for (const b of [COLORS.R, COLORS.L]) s.add([ud, a, b].sort().join("|"));
  return s;
}
function validEdgeSets(): Set<string> {
  const s = new Set<string>();
  const all = [COLORS.U, COLORS.D, COLORS.F, COLORS.B, COLORS.R, COLORS.L];
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      if (OPP[all[i]] !== all[j]) s.add([all[i], all[j]].sort().join("|"));
  return s;
}

export interface Validation { ok: boolean; error?: string }

/** Structural checks: 9 of each colour, and every real piece present once. */
export function validateStructure(paint: PaintCubie[]): Validation {
  // any unpainted sticker?
  for (const p of paint)
    for (const c of p.colors)
      if (c === UNPAINTED) return { ok: false, error: "Some stickers are still unpainted." };

  // colour counts
  const count: Record<string, number> = {};
  for (const p of paint)
    for (const c of p.colors)
      if (c !== COLORS.inner) count[c] = (count[c] ?? 0) + 1;
  for (const col of PAINT_COLORS)
    if ((count[col] ?? 0) !== 9)
      return { ok: false, error: `Colour count off: expected 9 of each, got ${count[col] ?? 0} of one.` };

  // piece bijection
  const cornerSets = validCornerSets(), edgeSets = validEdgeSets();
  const seenC = new Set<string>(), seenE = new Set<string>();
  for (const p of paint) {
    const cols = p.colors.filter((c) => c !== COLORS.inner);
    if (cols.length === 3) {
      const k = [...cols].sort().join("|");
      if (!cornerSets.has(k)) return { ok: false, error: "An impossible corner piece was painted." };
      if (seenC.has(k)) return { ok: false, error: "A corner piece appears twice." };
      seenC.add(k);
    } else if (cols.length === 2) {
      const k = [...cols].sort().join("|");
      if (!edgeSets.has(k)) return { ok: false, error: "An impossible edge piece was painted." };
      if (seenE.has(k)) return { ok: false, error: "An edge piece appears twice." };
      seenE.add(k);
    }
  }
  if (seenC.size !== 8) return { ok: false, error: "Corner pieces are not all present." };
  if (seenE.size !== 12) return { ok: false, error: "Edge pieces are not all present." };
  return { ok: true };
}

const IDS = ["FR", "FL", "BR", "BL"] as const;

/**
 * Validate a painted state and, if solvable, return the scramble that produces it
 * (the inverse of a full CFOP solution). Loading that scramble makes the painted
 * cube the current state, from which the app can guide or free-play as usual.
 */
export function solveFromPaint(
  paint: PaintCubie[]
): { ok: true; scramble: string[] } | { ok: false; error: string } {
  const v = validateStructure(paint);
  if (!v.ok) return { ok: false, error: v.error ?? "Invalid state." };

  const base = buildFromPaint(paint);
  setSolveBase(base);
  try {
    let moves: string[] = [];
    const cp = planCross([]);
    moves.push(...cp.reorient, ...cp.cross);

    let g = 0;
    while (g++ < 80) {
      if (IDS.every((id) => pairSolvedIn(buildFrom(moves), id))) break;
      const st = nextF2LStep(moves);
      if (!st) break;
      moves.push(...st.moves);
    }
    g = 0;
    while (g++ < 20) {
      if (ollDone(buildFrom(moves))) break;
      const st = recognizeOLL(moves);
      if (!st) break;
      moves.push(...st.moves);
    }
    g = 0;
    while (g++ < 12) {
      if (pllDone(buildFrom(moves))) break;
      const st = recognizePLL(moves);
      if (!st) break;
      moves.push(...st.moves);
    }

    const final = buildFrom(moves);
    const solved =
      crossSolvedIn(final) && IDS.every((id) => pairSolvedIn(final, id)) &&
      ollDone(final) && pllDone(final);
    if (!solved) return { ok: false, error: "This state isn't solvable \u2014 check your colours." };
    return { ok: true, scramble: inverseAlg(moves) };
  } finally {
    setSolveBase(null);
  }
}
