import * as THREE from "three";
import { CubeModel, parseMove, COLORS } from "./CubeModel";
import { buildFrom, tokenizeAtomic } from "./f2l";

/**
 * pll.ts — Permute Last Layer, 2-look (permute corners, then edges).
 *
 * After OLL the top is all yellow but pieces may sit in the wrong places. PLL
 * cycles them home without disturbing orientation. Same engine as OLL/F2L:
 * signatures are derived from the algorithms and every one is verified.
 *
 * Convention: yellow up, green front. Full PLL (21 cases) can be added later as
 * a higher skill, reusing this.
 */

const YELLOW = COLORS.U;

const FACE_NORMALS: THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
];
const key = (v: THREE.Vector3) => `${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)}`;

const EDGE_POS = ["0,1,1", "1,1,0", "0,1,-1", "-1,1,0"];
const CORNER_POS = ["1,1,1", "-1,1,1", "1,1,-1", "-1,1,-1"];

function pieceAt(model: CubeModel, pos: string): CubeModel["cubies"][number] | null {
  for (const c of model.cubies) if (key(c.pos) === pos) return c;
  return null;
}

// The center color sitting on a given face direction (green at +Z, red at +X...).
function centerColorAtDir(model: CubeModel, dir: string): string {
  for (const c of model.cubies) {
    const zeros = [c.pos.x, c.pos.y, c.pos.z].filter((v) => Math.round(v) === 0).length;
    if (zeros === 2 && key(c.pos) === dir) return c.colors.find((x) => x !== COLORS.inner)!;
  }
  return "";
}

// Side (non-yellow) stickers of a piece and the direction each faces.
function sideStickers(c: CubeModel["cubies"][number]): { color: string; dir: string }[] {
  const out: { color: string; dir: string }[] = [];
  for (let i = 0; i < 6; i++) {
    if (c.colors[i] === COLORS.inner || c.colors[i] === YELLOW) continue;
    const d = FACE_NORMALS[i].clone().applyQuaternion(c.quat);
    out.push({ color: c.colors[i], dir: key(d) });
  }
  return out;
}

function pieceCorrect(model: CubeModel, pos: string): boolean {
  const c = pieceAt(model, pos);
  if (!c) return false;
  return sideStickers(c).every((s) => centerColorAtDir(model, s.dir) === s.color);
}

export const cornersSolved = (m: CubeModel) => CORNER_POS.every((p) => pieceCorrect(m, p));
export const edgesSolved = (m: CubeModel) => EDGE_POS.every((p) => pieceCorrect(m, p));
export const pllDone = (m: CubeModel) => cornersSolved(m) && edgesSolved(m);


// ---- standard 2-look PLL algorithms (exact, from J Perm) ----
const ALGS_CORNER: string[] = [
  "F R U' R' U' R U R' F' R U R' U' R' F R F'", // Diagonal
  "R U R' U' R' F R2 U' R' U' R U R' F'", // Headlights (adjacent)
];
const ALGS_EDGE: string[] = [
  "M2 U M2 U2 M2 U M2", // H
  "R U' R U R U R U' R' U' R2", // Ua
  "R2 U R U R' U' R' U' R' U R'", // Ub
  "M' U M2 U M2 U M' U2 M2", // Z
];

// Labelled algorithm catalogue for the Test bench (name + pretty J Perm text).
export const PLL_CATALOG: { label: string; str: string }[] = [
  { label: "Diagonal (corners)", str: ALGS_CORNER[0] },
  { label: "Headlights (corners)", str: ALGS_CORNER[1] },
  { label: "H (edges)", str: ALGS_EDGE[0] },
  { label: "Ua (edges)", str: ALGS_EDGE[1] },
  { label: "Ub (edges)", str: ALGS_EDGE[2] },
  { label: "Z (edges)", str: ALGS_EDGE[3] },
];

const AUF = ["", "U", "U2", "U'"];


// All candidate applications: each alg across the four AUF alignments, plus bare
// U turns for pure alignment.
function candidates(algs: string[]): { moves: string[]; str: string }[] {
  const out: { moves: string[]; str: string }[] = [
    { moves: ["U"], str: "U" }, { moves: ["U2"], str: "U2" }, { moves: ["U'"], str: "U'" },
  ];
  for (const a of algs) for (const pre of AUF) out.push({ moves: [...tokenizeAtomic(pre), ...tokenizeAtomic(a)], str: a });
  return out;
}

function applySeq(base: CubeModel, seq: string[]): CubeModel {
  const m = base.clone();
  for (const t of seq) { const mv = parseMove(t); if (mv) m.applyMove(mv); }
  return m;
}

/**
 * BFS over algorithm applications; return the FIRST application (moves + its
 * pretty J Perm string) of a shortest path that reaches `goal` while `keep` holds.
 */
function findFirst(
  base: CubeModel,
  algs: string[],
  goal: (m: CubeModel) => boolean,
  keep: (m: CubeModel) => boolean,
  maxDepth: number
): { moves: string[]; str: string } | null {
  const cands = candidates(algs);
  let layer: { model: CubeModel; first: { moves: string[]; str: string } | null }[] = [{ model: base, first: null }];
  for (let d = 0; d < maxDepth; d++) {
    const next: { model: CubeModel; first: { moves: string[]; str: string } | null }[] = [];
    for (const node of layer) {
      for (const c of cands) {
        const m = applySeq(node.model, c.moves);
        if (!keep(m)) continue;
        const first = node.first ?? c;
        if (goal(m)) return first;
        next.push({ model: m, first });
      }
    }
    layer = next;
  }
  return null;
}

export interface PLLStep {
  kind: "corner" | "edge" | "auf";
  moves: string[];
  algString: string; // pretty J Perm text to display
}

/** The next PLL action: permute corners, then edges, then any final alignment. */
export function recognizePLL(moves: string[]): PLLStep | null {
  const base = buildFrom(moves);
  if (pllDone(base)) return null;

  // A single U finishes everything.
  for (const u of ["U", "U2", "U'"]) {
    if (pllDone(applySeq(base, [u]))) return { kind: "auf", moves: [u], algString: u };
  }

  const cornersUpToU = (m: CubeModel) => ["", "U", "U2", "U'"].some((u) => cornersSolved(u ? applySeq(m, [u]) : m));
  const doneUpToU = (m: CubeModel) => ["", "U", "U2", "U'"].some((u) => pllDone(u ? applySeq(m, [u]) : m));

  // 1) Corners not yet permuted → one corner alg (correct up to a final U).
  if (!cornersUpToU(base)) {
    const first = findFirst(base, ALGS_CORNER, cornersUpToU, () => true, 2);
    if (first) return { kind: "corner", moves: first.moves, algString: first.str };
    return null;
  }

  // The corners may be permuted but sitting a quarter turn out. There used to be a separate step
  // here that aligned them with their own AUF — and then the edge algorithm brought an AUF of its
  // own, so you were asked for U and then U2: three quarter turns where a single U' does the job.
  // The edge search below already tries every AUF in front of every algorithm, so it can find the
  // one alignment that serves both. Two alignments in a row is a sign that a step is doing work the
  // next step was going to do anyway.

  // Corners in place (up to a U) → one edge algorithm, its own AUF included.
  const first = findFirst(base, ALGS_EDGE, doneUpToU, cornersUpToU, 2);
  if (first) return { kind: "edge", moves: first.moves, algString: first.str };
  return null;
}
