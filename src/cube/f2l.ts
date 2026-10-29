import * as THREE from "three";
import { CubeModel, parseMove, COLORS, WHITE, GREEN, type Cubie } from "./CubeModel";

/**
 * f2l.ts — First Two Layers via recognition + lookup (J Perm's algorithm set).
 *
 * Strategy ("Calea 1"): to solve any pair, rotate the whole cube so that pair's
 * slot sits at front-right (FR), recognize which case we're in, and apply the
 * canonical FR algorithm. One algorithm set, reused for all four slots via a y
 * rotation — exactly how the J Perm sheet is written.
 *
 * Correctness trick: we don't hand-encode each case's geometry. We DERIVE each
 * case's signature by applying the algorithm's inverse to a solved cube. So the
 * recognition key and the algorithm can never disagree by construction; the only
 * possible error is a transcription typo, which the engine catches by verifying
 * that applying the algorithm actually solves the pair.
 */

const RED = COLORS.R;
const ORANGE = COLORS.L;
const BLUE = COLORS.B;

const FACE_NORMALS: THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
];

const key = (v: THREE.Vector3) => `${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)}`;

export type PairId = "FR" | "FL" | "BR" | "BL";

// Cube rotations that bring each slot to the front-right position.
const NORMALIZE: Record<PairId, string[]> = {
  FR: [],
  FL: ["y'"],
  BR: ["y"],
  BL: ["y2"],
};

const SIDE_COLORS: Record<PairId, [string, string]> = {
  FR: [GREEN, RED], FL: [GREEN, ORANGE], BR: [BLUE, RED], BL: [BLUE, ORANGE],
};

export interface Sticker { color: string; dir: THREE.Vector3 }

export function stickersOf(c: Cubie): Sticker[] {
  const out: Sticker[] = [];
  for (let i = 0; i < 6; i++) {
    if (c.colors[i] === COLORS.inner) continue;
    const dir = FACE_NORMALS[i].clone().applyQuaternion(c.quat);
    dir.set(Math.round(dir.x), Math.round(dir.y), Math.round(dir.z));
    out.push({ color: c.colors[i], dir });
  }
  return out;
}

const colorSet = (c: Cubie) => new Set(c.colors.filter((col) => col !== COLORS.inner));

function findPiece(model: CubeModel, wanted: Set<string>): Cubie {
  for (const c of model.cubies) {
    const s = colorSet(c);
    if (s.size !== wanted.size) continue;
    let all = true;
    for (const col of wanted) if (!s.has(col)) { all = false; break; }
    if (all) return c;
  }
  throw new Error("piece not found");
}

// The solvers normally evaluate "solved + moves". To solve a state that didn't
// come from moves (a painted cube, later a physical cube), we can set a base so
// buildFrom evaluates "base + moves" instead. Case-DB derivation must stay on the
// solved cube, so it uses buildSolved.
let SOLVE_BASE: CubeModel | null = null;
export function setSolveBase(model: CubeModel | null) {
  SOLVE_BASE = model;
}
function buildFrom(tokens: string[]): CubeModel {
  const model = SOLVE_BASE ? SOLVE_BASE.clone() : new CubeModel();
  for (const t of tokens) { const mv = parseMove(t); if (mv) model.applyMove(mv); }
  return model;
}
export function buildSolved(tokens: string[]): CubeModel {
  const model = new CubeModel();
  for (const t of tokens) { const mv = parseMove(t); if (mv) model.applyMove(mv); }
  return model;
}

function inverseToken(t: string): string {
  return t.endsWith("2") ? t : t.endsWith("'") ? t[0] : t + "'";
}
function inverseAlg(tokens: string[]): string[] {
  return [...tokens].reverse().map(inverseToken);
}

// Wide moves expanded into base moves on disjoint layers (equivalent net turn).
const WIDE: Record<string, string[]> = {
  r: ["R", "M'"], "r'": ["R'", "M"], r2: ["R2", "M2"],
  l: ["L", "M"], "l'": ["L'", "M'"], l2: ["L2", "M2"],
  f: ["F", "S"], "f'": ["F'", "S'"], f2: ["F2", "S2"],
  u: ["U", "E'"], "u'": ["U'", "E"], u2: ["U2", "E2"],
  d: ["D", "E"], "d'": ["D'", "E'"], d2: ["D2", "E2"],
  b: ["B", "S'"], "b'": ["B'", "S"], b2: ["B2", "S2"],
};

// Face-only wide expansion: on a center-based cube the physical wide move is reported (via
// facelets, relative to the moved centers) exactly like the OPPOSITE single face — verified
// against real captures: r≡L, l≡R, u≡D, d≡U, f≡B, b≡F. The visual double-arrow still tells
// the solver to turn two layers.
const WIDE_FACE: Record<string, string[]> = {
  r: ["L"], "r'": ["L'"], r2: ["L2"], l: ["R"], "l'": ["R'"], l2: ["R2"],
  f: ["B"], "f'": ["B'"], f2: ["B2"], u: ["D"], "u'": ["D'"], u2: ["D2"],
  d: ["U"], "d'": ["U'"], d2: ["U2"], b: ["F"], "b'": ["F'"], b2: ["F2"],
};
function tokenizeFaceOnly(alg: string): string[] {
  let s = alg.replace(/\(([^)]*)\)(\d)/g, (_m, inner: string, n: string) => (" " + inner + " ").repeat(parseInt(n, 10)));
  s = s.replace(/[()]/g, " ");
  const raw = s.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let tok of raw) {
    tok = tok.replace(/2'$/, "2");
    if (WIDE_FACE[tok]) out.push(...WIDE_FACE[tok]);
    else out.push(tok);
  }
  return out;
}

// Tokenize an algorithm string: drop grouping parens, expand "(...)3" repeats,
// normalize "2'"→"2", and expand wide moves into base moves.
function tokenize(alg: string): string[] {
  // Expand "(seq)3" style repeats first.
  let s = alg.replace(/\(([^)]*)\)(\d)/g, (_m, inner: string, n: string) =>
    (" " + inner + " ").repeat(parseInt(n, 10))
  );
  s = s.replace(/[()]/g, " ");
  const raw = s.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let tok of raw) {
    tok = tok.replace(/2'$/, "2"); // U2' == U2
    if (WIDE[tok]) out.push(...WIDE[tok]);
    else out.push(tok);
  }
  return out;
}
// Like tokenize but keeps wide/slice/rotation tokens ATOMIC (r stays r, not R M'). The model
// applies them natively, so guidance/recording work with the same atomic vocabulary everywhere.
export function tokenizeAtomic(alg: string): string[] {
  let s = alg.replace(/\(([^)]*)\)(\d)/g, (_m, inner: string, n: string) =>
    (" " + inner + " ").repeat(parseInt(n, 10))
  );
  s = s.replace(/[()]/g, " ");
  return s.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/2'$/, "2"));
}

const centerColorAt = (model: CubeModel, pos: string): string => {
  for (const c of model.cubies) {
    const zeros = [c.pos.x, c.pos.y, c.pos.z].filter((v) => Math.round(v) === 0).length;
    if (zeros === 2 && key(c.pos) === pos) {
      return c.colors.find((col) => col !== COLORS.inner)!;
    }
  }
  return "";
};

const stickerDir = (c: Cubie, color: string): THREE.Vector3 =>
  stickersOf(c).find((s) => s.color === color)!.dir;

/**
 * Signature of the FR pair, read purely from geometry (works for any slot once
 * normalized to FR). Captures corner position + white direction, edge position +
 * front-color direction — enough to distinguish every F2L case.
 */
function frSignature(model: CubeModel): string {
  const cf = centerColorAt(model, "0,0,1"); // whatever color is at front now
  const cr = centerColorAt(model, "1,0,0"); // ...and at right
  const corner = findPiece(model, new Set([WHITE, cf, cr]));
  const edge = findPiece(model, new Set([cf, cr]));
  return [
    key(corner.pos), key(stickerDir(corner, WHITE)),
    key(edge.pos), key(stickerDir(edge, cf)),
  ].join(" / ");
}

// ---- case database (derived from algorithms) ----

// Section 1A — both pieces on top, white sticker faces up.
const ALGS_1A_WHITE_UP: string[] = [
  "U2 (R U R') U (R U' R')", "y F R U2 R' F'",
  "y U2 (L' U' L) U' (L' U L)", "F' L' U2 L F",
  "U (R U2 R') U (R U' R')",
  "y U' (L' U2 L) U' (L' U L)",
  "U (R U' R') U' (R U' R' U R U' R')", "U (F R' F' R) U (R U R')",
  "U2 (L F' L' F) (R U R')", "y U L' U' (L2 F' L' F) (L' U L)",
  "y F' (U' L' U L) F (L' U L)", "y' U2 R U' R' U' S R' S'",
  "y U' (L' U L) U (L' U L U' L' U L)", "y U' (F' L F L') U' (L' U' L)",
  "y U2 (R F' R' F) (L' U' L)", "U' R U (R2' F R F') (R U' R')",
  "F (U R U' R') F' (R U' R')", "y2 U2 L' U L U S' L S",
  "(R U2 R') U' (R U R')", "y (L' U2 L) U (L' U' L)",
];

// Section 1A — white faces side/front, U-face stickers different.
const ALGS_1A_DIFF: string[] = [
  "(R U R')", "y (L' U' L)",
  "U' (R U R') U (R U R')", "U2 (R U' R') U' (R U R')", "R' U R2 U R'",
  "y U (L' U' L) U' (L' U' L)", "y U2 (L' U L) U (L' U' L)", "y L U' L2' U' L",
  "R' U2 R2 U R2' U R", "(R U' R') U (R U' R') U2 (R U' R')", "R' U2 R2 U R'", "y U L' U2 L U' y' R U R'",
  "y L U2 L2' U' L2 U' L'", "y (L' U L) U' (L' U L) U2 (L' U L)", "y L U2 L2' U' L", "U' (R U2 R') U y (L' U' L)",
  "U' (R U' R') U (R U R')", "y U (L' U L) U' (L' U' L)",
];

// Section 1A — white faces side/front, U-face stickers the same.
const ALGS_1A_SAME: string[] = [
  "y U' (L' U L)", "U (R U' R')",
  "y U (L' U2 L) U2 (L' U L)", "r' U2 R2 U R2' U r",
  "U' (R U2 R') U2 (R U' R')", "y l U2 L2' U' L2 U' l'",
  "U' (R U R') U2 (R U' R')", "y U l' U L U' L' U' l",
  "y U (L' U' L) U2 (L' U L)", "U' r U' R' U R U r'",
  "M U (L F' L') U' M'", "U' (R' U R) U' (R U R')", "y (L' U L) y' U2 (R U R')",
  "y' (R2' F R F' R) U2 (R' U R)", "y2 (f' L f) U2 (L U L')",
  "y M U' (R' F R) U M'", "y U (L U' L') U (L' U' L)",
  "(R U' R') y U2 (L' U' L)", "y2 (L2 F' L' F L') U2 (L U' L')", "y' (f R' f') U2 R' U' R",
];

// Section 1B — one piece already in a slot: edge in the slot.
const ALGS_1B_EDGE: string[] = [
  "U (R U R') U2 (R U R')", "U' (R U2 R') U (R U R')", "y U (L' U L) U2 (L' U L)",
  "U (F' U' F) U' (R U R')", "y U2 (L' U' L) (F' L F L')", "y U' M' (U' L' U l) (L' U L)",
  "y U' (L U F' L' F) (L' U L)", "y' U2 (R' U' R) y U (R U' R')", "y' U2 R' U' M U' R U M'",
  "y2 U (f' L' f) U' (L U L')", "(U R U' R')3",
  "y U' (L' U' L) U2 (L' U' L)", "y U (L' U2 L) U' (L' U' L)", "U' R U' R' U2 R U' R'",
  "y U' (F U F') U (L' U' L)", "U2 (R U R') (F R' F' R)", "U M' (U R U' r') (R U' R')",
  "U (R' U' F R F') (R U' R')", "y2 U2 (L U L') y' U' (L' U L)", "y2 U2 L U M U L' U' M'",
  "y' U' (f R f') U (R' U' R)", "U' (R' F R F') (R U' R')", "(R U' R') (F' U2 F)",
  "y' R' U R' F R F' R", "y' U' (R' U2 R) (f R f')",
];

// Section 1B — one piece already in a slot: corner in the slot.
const ALGS_1B_CORNER: string[] = [
  "(R U R') U' (R U R')", "y M' (U' L' U L) (U' L' U l)", "y (L F' L' F)2",
  "(R U' R') U (R U' R')", "U' (R' F R F') (R U R')", "(R' F' R) (U R U' R') F",
  "U' F' (R U R' U') (R' F R)", "y U' (L' U L) (F' L F L')", "y2 U' M U L U' M' U L'",
  "y' U' R' U M U' R U M'",
  "y (L' U' L) U (L' U' L)", "M' (U R U' R') (U R U' r')", "(R' F R F')2",
  "y (L' U L) U' (L' U L)", "y U (L F' L' F) (L' U' L)", "y (L F L') (U' L' U L) F'",
  "y U F (L' U' L U) (L F' L')", "U (R U' R') (F R' F' R)", "y' U M U' R' U M' U' R",
  "y2 U L U' M U L' U' M'",
];

// Section 1C — both pieces in the correct slot (misoriented).
const ALGS_1C: string[] = [
  "(R U' R') U (R U2 R' U R U' R')", "y' (L' U L) U (L' U' L U2' L' U L)",
  "(R U' R') (F' L' U2 L F)", "y (F R U2' R' F') (L' U' L)",
  "y2 L2 F U F' U' L' U L'", "y' R' U R' U' F' U F R2",
  "R2' U2' F R2 F' U2' R' U R'", "y L2 U2 F' L2' F U2 L U' L",
  "y' (f R' f') U (R' U2' R) U (R' U2' R)", "y2 (f' L f) U' (L U2 L') U' (L U2 L')",
  "y' (L' U L) U' (L' U2' L U' L' U L)", "(R U' R') U' (R U R' U2 R U' R')",
  "y (L' U L) (F R U2' R' F')", "(F' L' U2 L F) (R U R')",
  "y' R2' F' U' F U R U' R", "y2 L U' L U F U' F' L2'",
];

// Each case is tagged with the J Perm sub-category it belongs to.
export type CategoryId = "1A-up" | "1A-diff" | "1A-same" | "1B-edge" | "1B-corner" | "1C";
const CATEGORIES: { id: CategoryId; algs: string[] }[] = [
  { id: "1A-up", algs: ALGS_1A_WHITE_UP },
  { id: "1A-diff", algs: ALGS_1A_DIFF },
  { id: "1A-same", algs: ALGS_1A_SAME },
  { id: "1B-edge", algs: ALGS_1B_EDGE },
  { id: "1B-corner", algs: ALGS_1B_CORNER },
  { id: "1C", algs: ALGS_1C },
];

interface CaseEntry {
  variants: string[][];
  origStrs: string[];
  /** How many leading tokens of each variant are the app's alignment (AUF). Everything after that is
   *  the official J Perm algorithm, and must be handed to you exactly as written. */
  aufLens: number[];
  category: CategoryId;
}

// Labelled algorithm catalogue for the Test bench, grouped by category.
export const F2L_CATALOG: { label: string; str: string }[] = CATEGORIES.flatMap((cat) =>
  cat.algs.map((str, i) => ({ label: `${cat.id} #${i + 1}`, str }))
);
let CASE_DB: Map<string, CaseEntry> | null = null;

const AUF = ["", "U", "U2", "U'"];
const AUF_INV = ["", "U'", "U2", "U"];

function buildCaseDB(): Map<string, CaseEntry> {
  const db = new Map<string, CaseEntry>();
  for (const cat of CATEGORIES) {
    for (const algStr of cat.algs) {
      const alg = tokenize(algStr);
      for (const t of alg) if (!parseMove(t)) throw new Error(`bad token "${t}" in: ${algStr}`);
      const inv = inverseAlg(alg);
      for (let j = 0; j < 4; j++) {
        const caseModel = buildSolved([...inv, ...tokenize(AUF[j])]);
        const sig = frSignature(caseModel);
        const aufToks = tokenize(AUF_INV[j]);
        const solution = [...aufToks, ...alg];
        const entry = db.get(sig) ?? { variants: [], origStrs: [], aufLens: [], category: cat.id };
        if (!entry.variants.some((g) => g.join(" ") === solution.join(" "))) {
          entry.variants.push(solution);
          entry.origStrs.push(algStr); // the pretty J Perm text this came from
          entry.aufLens.push(aufToks.length); // where the AUF ends and the ALGORITHM begins
        }
        db.set(sig, entry);
      }
    }
  }
  return db;
}

// Solved-check helpers (color-based) for verifying a recognition really works.
// Frame-invariant solved-check: a piece is solved when each of its stickers points the same way
// as that colour's CENTRE (not a fixed absolute direction). So it stays correct no matter how the
// whole cube is turned — the anchor is the centres (the F-you-hold), exactly like the isolated algs.
function centerDirOf(model: CubeModel, color: string): string {
  for (const c of model.cubies) {
    const cs = c.colors.filter((x) => x !== COLORS.inner);
    if (cs.length === 1 && cs[0] === color) return key(stickersOf(c)[0].dir);
  }
  return "";
}
function pieceSolvedByColors(model: CubeModel, colors: string[]): boolean {
  for (const c of model.cubies) {
    const cs = c.colors.filter((x) => x !== COLORS.inner);
    if (cs.length !== colors.length || !colors.every((col) => cs.includes(col))) continue;
    return stickersOf(c).every((s) => centerDirOf(model, s.color) === key(s.dir));
  }
  return false;
}
const crossSolvedIn = (m: CubeModel) =>
  [[WHITE, GREEN], [WHITE, RED], [WHITE, BLUE], [WHITE, ORANGE]].every((cc) =>
    pieceSolvedByColors(m, cc)
  );
const pairSolvedIn = (m: CubeModel, id: PairId) =>
  pieceSolvedByColors(m, [WHITE, ...SIDE_COLORS[id]]) &&
  pieceSolvedByColors(m, SIDE_COLORS[id]);

function ensureDB() {
  if (!CASE_DB) CASE_DB = buildCaseDB();
}

// Tokens that rotate the cube back to standard hold (green front), assuming
// white is already down — F2L algorithms only ever y-rotate the cube.
function standardizeTokens(model: CubeModel): string[] {
  const g = centerColorAt2(model, GREEN);
  if (g === "0,0,1") return [];
  if (g === "1,0,0") return ["y"];
  if (g === "-1,0,0") return ["y'"];
  if (g === "0,0,-1") return ["y2"];
  return [];
}
function centerColorAt2(model: CubeModel, color: string): string {
  for (const c of model.cubies) {
    const zeros = [c.pos.x, c.pos.y, c.pos.z].filter((v) => Math.round(v) === 0).length;
    if (zeros === 2 && c.colors.includes(color)) return key(c.pos);
  }
  return "";
}

export interface Recognition {
  pair: PairId;
  rotation: string[];
  variants: string[][]; // each = rotation + alg + standardize, shortest first
  algStrings: string[]; // the pretty J Perm text for each variant (what to display)
  variantSlots: PairId[][]; // extra slots each variant disturbs (empty = clean 1-slot)
  category: CategoryId;
}

// Which OTHER slots a full solution touches: apply it to a solved cube and see
// which non-target pairs it leaves disturbed. This is the "affects >1 slot" mark.
function affectedSlots(full: string[], target: PairId): PairId[] {
  const m = buildSolved(full);
  const out: PairId[] = [];
  for (const id of ["FR", "FL", "BR", "BL"] as PairId[]) {
    if (id === target) continue;
    if (!pairSolvedIn(m, id)) out.push(id);
  }
  return out;
}

/** Cancel adjacent inverses and combine same-token turns (U U → U2, B' B → nothing, y' y2 → y).
 * Works for faces, wides, slices and rotations — the "base" is the token without its ' or 2. */
function simplifyMoves(moves: string[]): string[] {
  const st: { base: string; amt: number }[] = [];
  for (const m of moves) {
    const base = m.replace(/['2]$/, "");
    const amt = m.endsWith("2") ? 2 : m.endsWith("'") ? 3 : 1;
    const top = st[st.length - 1];
    if (top && top.base === base) {
      const t = (top.amt + amt) % 4;
      st.pop();
      if (t !== 0) st.push({ base, amt: t });
    } else st.push({ base, amt });
  }
  return st.map(({ base, amt }) => base + (amt === 2 ? "2" : amt === 3 ? "'" : ""));
}


// ---- Memorability ------------------------------------------------------------------------------
// When a case has several official algorithms, the shortest is NOT the one to hand a learner. What
// makes an algorithm stick is not its length but its SHAPE: experienced cubers do not memorise
// "U' R' U R U' R U R'" as eight letters — they see "U', then the reverse insert, U', then the
// insert". A handful of short gestures ("triggers") that the hand learns as single motions, and that
// recombine endlessly. Learn the vocabulary once and every new case is mostly things you can already
// do.
//
// So rank the variants by how much of each one is built from those gestures — and reward REPETITION
// most of all, because an algorithm that uses the same trigger twice is barely harder than using it
// once. A few extra turns are a price worth paying for that.
const TRIGGERS: { name: string; toks: string[] }[] = [
  // The four-move workhorses.
  { name: "sexy", toks: ["R", "U", "R'", "U'"] },
  { name: "sexy (left)", toks: ["L'", "U'", "L", "U"] },
  { name: "reverse sexy", toks: ["U", "R", "U'", "R'"] },
  { name: "reverse sexy (left)", toks: ["U'", "L'", "U", "L"] },
  { name: "sledgehammer", toks: ["R'", "F", "R", "F'"] },
  { name: "hedgeslammer", toks: ["F", "R'", "F'", "R"] },
  // The three-move inserts — the bread and butter of F2L.
  { name: "insert", toks: ["R", "U", "R'"] },
  { name: "insert (back)", toks: ["R", "U'", "R'"] },
  { name: "insert (left)", toks: ["L'", "U'", "L"] },
  { name: "insert (left, back)", toks: ["L'", "U", "L"] },
  { name: "insert (front)", toks: ["F'", "U'", "F"] },
  { name: "insert (front, back)", toks: ["F'", "U", "F"] },
  { name: "insert (right-back)", toks: ["R'", "U'", "R"] },
  { name: "insert (right-back, other way)", toks: ["R'", "U", "R"] },
  // The same inserts with a half turn in the middle — very common in the J Perm F2L set.
  { name: "insert (U2)", toks: ["R", "U2", "R'"] },
  { name: "insert (U2, right-back)", toks: ["R'", "U2", "R"] },
  { name: "insert (U2, left)", toks: ["L'", "U2", "L"] },
  { name: "insert (U2, front)", toks: ["F'", "U2", "F"] },
];

/** The algorithm, cut into the gestures it is actually made of — including the loose moves between
 *  them. This is how a cuber READS an algorithm: not as eight letters, but as "align, insert, align,
 *  insert". Showing that structure alongside the letters is the difference between memorising and
 *  understanding. */
export function segmentAlg(algStr: string): { name: string | null; toks: string[] }[] {
  const toks = tokenizeAtomic(algStr.replace(/[()]/g, " "));
  const out: { name: string | null; toks: string[] }[] = [];
  let i = 0;
  while (i < toks.length) {
    let hit: { name: string; toks: string[] } | null = null;
    for (const t of TRIGGERS) {
      if (hit && t.toks.length <= hit.toks.length) continue;
      if (t.toks.every((x, k) => toks[i + k] === x)) hit = t;
    }
    if (hit) {
      out.push({ name: hit.name, toks: hit.toks });
      i += hit.toks.length;
    } else {
      const last = out[out.length - 1];
      if (last && last.name === null) last.toks.push(toks[i]);   // group loose moves together
      else out.push({ name: null, toks: [toks[i]] });
      i++;
    }
  }
  return out;
}

/** Break an algorithm into the gestures it is made of — the way you would actually learn it. */
export function triggersOf(algStr: string): { name: string; toks: string[] }[] {
  const toks = tokenizeAtomic(algStr.replace(/[()]/g, " "));
  const found: { name: string; toks: string[] }[] = [];
  let i = 0;
  while (i < toks.length) {
    let hit: { name: string; toks: string[] } | null = null;
    for (const t of TRIGGERS) {                       // longest first
      if (hit && t.toks.length <= hit.toks.length) continue;
      if (t.toks.every((x, k) => toks[i + k] === x)) hit = t;
    }
    if (hit) { found.push(hit); i += hit.toks.length; }
    else i++;
  }
  return found;
}

/** How easy is this algorithm to REMEMBER? Higher is better. */
function memorability(algStr: string): number {
  const toks = tokenizeAtomic(algStr.replace(/[()]/g, " "));
  if (!toks.length) return 0;
  const found = triggersOf(algStr);
  const covered = found.reduce((n, t) => n + t.toks.length, 0);
  const names = new Set(found.map((t) => t.name));
  const repeats = found.length - names.size; // the same gesture used again — nearly free to learn
  const loose = toks.length - covered;       // moves that belong to no gesture: pure rote memory
  // When two algorithms are otherwise equally learnable, prefer the RIGHT-hand one: that is the side
  // this solver works from, and keeping to one side is itself a memory aid.
  const rSide = toks.filter((t) => /^[Rr]/.test(t)).length - toks.filter((t) => /^[Ll]/.test(t)).length;
  return covered * 4 + repeats * 30 - names.size * 3 - loose * 6 + rSide * 2 - toks.length * 0.2;
}


/** Apply tokens to a copy of a model — cheap, and it never re-walks the move history. */
function withMoves(model: CubeModel, toks: string[]): CubeModel {
  const m = model.clone();
  for (const t of toks) { const mv = parseMove(t); if (mv) m.applyMove(mv); }
  return m;
}

/** Recognize a pair's case; return every canonical solution (variants). */
export function recognizePair(moves: string[], pair: PairId): Recognition | null {
  return recognizePairIn(buildFrom(moves), pair);
}

/**
 * The same recognition, starting from a MODEL rather than a move list. The search below asks this
 * hundreds of times; rebuilding the cube from the whole history on every question made it fifteen
 * times slower than it needed to be (and timed the tests out). The cube in hand is all it needs.
 */
export function recognizePairIn(model: CubeModel, pair: PairId): Recognition | null {
  ensureDB();
  const norm = withMoves(model, NORMALIZE[pair]);
  const sig = frSignature(norm);
  const entry = CASE_DB!.get(sig);
  if (!entry) return null;
  const rotation = NORMALIZE[pair];
  const pairs: { full: string[]; str: string }[] = [];
  entry.variants.forEach((algVar, idx) => {
    const afterAlg = withMoves(model, [...rotation, ...algVar]);
    const std = standardizeTokens(afterAlg);
    // The official J Perm algorithm is SACRED. This app exists to TEACH those algorithms, not to
    // solve the cube in as few moves as possible — so the algorithm must be executed exactly as
    // written, and never shortened. In particular its first letter must not be cancelled against the
    // alignment move in front of it (an AUF of U meeting an algorithm beginning with U' used to eat
    // that U', and the app then asked for a move the sheet does not contain — teaching the wrong
    // thing).
    //
    // A redundant U U' at the seam is therefore NOT a bug to be optimised away: it is the price of
    // handing you the algorithm intact. Once the algorithms are in your fingers you will drop those
    // moves yourself, because you will see they were never needed. An app that "helpfully" trims
    // your algorithms sabotages the very thing you are trying to memorise.
    //
    // So: simplify the alignment and the tidy-up moves on their own, and leave everything between
    // them untouched.
    const aufLen = entry.aufLens?.[idx] ?? 0;
    const auf = algVar.slice(0, aufLen);
    const official = algVar.slice(aufLen);
    const full = [...simplifyMoves([...rotation, ...auf]), ...official, ...simplifyMoves(std)];
    const result = withMoves(model, full);
    if (!pairSolvedIn(result, pair) || !crossSolvedIn(result)) return; // drop bad transcriptions
    if (!pairs.some((p) => p.full.join(" ") === full.join(" "))) pairs.push({ full, str: entry.origStrs[idx] });
  });
  if (!pairs.length) return null;
  // Easiest to REMEMBER first — not shortest. This app teaches algorithms; a couple of extra turns
  // in exchange for an algorithm built out of gestures you already own is a good trade.
  pairs.sort((a, b) => {
    const d = memorability(b.str) - memorability(a.str);
    return d !== 0 ? d : a.full.length - b.full.length; // equally memorable → take the shorter one
  });
  const variants = pairs.map((p) => p.full);
  const algStrings = pairs.map((p) => p.str);
  const variantSlots = variants.map((v) => affectedSlots(v, pair));
  return { pair, rotation, variants, algStrings, variantSlots, category: entry.category };
}

// ---- orchestration: cheapest pair first (mode A, no lookahead) ----
export interface F2LStep {
  pair: PairId;
  moves: string[]; // the default (shortest) variant: rotation + alg + standardize
  variants: string[][]; // all canonical variants for this case, shortest first
  algStrings: string[]; // pretty J Perm text for each variant (what to display)
  variantSlots: PairId[][]; // extra slots each variant disturbs (empty = clean)
  category?: CategoryId; // J Perm sub-category (absent for extraction nudges)
  isExtraction?: boolean; // true when this is a "push a stuck piece up" nudge
}

const ALL_PAIRS: PairId[] = ["FR", "FL", "BR", "BL"];

function solvedPairs(model: CubeModel): Set<PairId> {
  const s = new Set<PairId>();
  for (const id of ALL_PAIRS) if (pairSolvedIn(model, id)) s.add(id);
  return s;
}

/**
 * Plan the whole of F2L — by SEARCHING every order the four pairs could be solved in, not by
 * greedily grabbing the cheapest one at each step.
 *
 * Why it matters: greedy is exactly how you end up levering pieces back out of slots. Solving the
 * pair that looks cheapest right now can BURY another pair's pieces in a slot, and then there is no
 * choice but to extract them — moves that teach you nothing and that a better order would never have
 * needed. Looking at all four pairs together is the skill real cubers call look-ahead, and it is the
 * difference between a 30-second solve and a 15-second one.
 *
 * There are only 4! = 24 orders, so a computer can simply try them all: play each one out, count the
 * moves (extractions included, and they are expensive), and keep the cheapest. The search is depth 4
 * with sharing, so it costs a few dozen recognitions — nothing.
 */
function searchPlan(moves: string[], forceFirst?: PairId): { steps: F2LStep[]; cost: number } | null {
  const start = [...moves];
  const solved0 = solvedPairs(buildFrom(start));
  const MAX_EXTRACTIONS = 2; // if it needs more than this, the order is hopeless anyway

  type Plan = { steps: F2LStep[]; cost: number };
  const found: { best: Plan | null } = { best: null };

  const dfs = (acc: string[], model: CubeModel, solved: Set<PairId>, steps: F2LStep[], cost: number, exts: number, depth = 0) => {
    if (found.best && cost >= found.best.cost) return;   // this order is already worse — abandon it
    if (solved.size === 4) {
      if (!found.best || cost < found.best.cost) found.best = { steps: steps.slice(), cost };
      return;
    }
    let anySolvable = false;
    for (const id of ALL_PAIRS) {
      if (solved.has(id)) continue;
      if (forceFirst && steps.length === 0 && id !== forceFirst) continue; // "what if I began with X?"
      const rec = recognizePairIn(model, id);
      if (!rec) continue;
      // Only variants that leave the pairs you have already built alone.
      // Only the FIRST step of the plan is ever handed to you — deeper steps exist purely to price
      // the order. So keep every variant at the root (the guidance offers them), and beyond that stop
      // at the first one that works.
      const ok = (v: string[]) => {
        const after = withMoves(model, v);
        return [...solved].every((k) => pairSolvedIn(after, k));
      };
      const all = rec.variants.map((v, i) => ({ v, str: rec.algStrings[i], slots: rec.variantSlots[i] }));
      const keep = depth === 0 ? all.filter(({ v }) => ok(v)) : (() => {
        const hit = all.find(({ v }) => ok(v));
        return hit ? [hit] : [];
      })();
      if (!keep.length) continue;
      anySolvable = true;
      const step: F2LStep = {
        pair: id,
        moves: keep[0].v,
        variants: keep.map((k) => k.v),
        algStrings: keep.map((k) => k.str),
        variantSlots: keep.map((k) => k.slots),
        category: rec.category,
      };
      steps.push(step);
      dfs([...acc, ...keep[0].v], withMoves(model, keep[0].v), new Set([...solved, id]), steps, cost + keep[0].v.length, exts, depth + 1);
      steps.pop();
    }
    // Nothing can be solved as it stands: a piece is trapped, so it has to be levered out. This is
    // the branch a good ORDER avoids ever reaching — which is the whole point of searching.
    if (!anySolvable) {
      if (exts >= MAX_EXTRACTIONS) return;
      const ext = extractionStep(acc);
      if (!ext) return;
      steps.push(ext);
      dfs([...acc, ...ext.moves], withMoves(model, ext.moves), solved, steps, cost + ext.moves.length + 4, exts + 1, depth + 1); // +4: an
      // extraction costs more than its moves — it is a detour, and nothing about it is worth learning
      steps.pop();
    }
  };

  dfs(start, buildFrom(start), solved0, [], 0, 0);
  return found.best;
}

export function planF2L(moves: string[]): F2LStep[] {
  return searchPlan(moves)?.steps ?? [];
}

/**
 * Why this pair, and not one of the others? The search already knows — it played every order out.
 * Saying it out loud is the point: choosing the pair that keeps the rest of the cube workable is the
 * skill (look-ahead), and it is the one thing an algorithm sheet can never teach you.
 */
export function explainPairChoice(moves: string[]): string | null {
  const best = searchPlan(moves);
  if (!best || !best.steps.length) return null;
  const first = best.steps[0];
  if (first.isExtraction || !first.pair) return null;

  let worstAlt: { pair: PairId; extra: number; traps: boolean } | null = null;
  for (const id of ALL_PAIRS) {
    if (id === first.pair) continue;
    const alt = searchPlan(moves, id);
    if (!alt) continue;                                   // that order cannot be finished at all
    const traps = alt.steps.some((st) => st.isExtraction);
    const extra = alt.cost - best.cost;
    if (extra <= 0 && !traps) continue;                   // just as good — nothing to say about it
    if (!worstAlt || extra > worstAlt.extra) worstAlt = { pair: id, extra, traps };
  }
  if (!worstAlt) return null;
  return worstAlt.traps
    ? `${first.pair} first \u2014 taking ${worstAlt.pair} now would bury a piece in a slot and cost an extraction`
    : `${first.pair} first \u2014 taking ${worstAlt.pair} now would cost about ${worstAlt.extra} more moves`;
}

// ---- extraction: push a stuck piece up to the yellow layer ----
// When no pair has both pieces on top (no 1A case), a human does a small R U R'
// to eject a stuck piece into the working layer, then solves it as a 1A case.
const EXTRACTIONS = ["R U R'", "R U' R'", "R U2 R'", "R' U' R", "R' U R", "F' U' F", "F' U F"];

function slotOf(pos: THREE.Vector3): PairId {
  const x = Math.round(pos.x), z = Math.round(pos.z);
  if (x > 0 && z > 0) return "FR";
  if (x < 0 && z > 0) return "FL";
  if (x > 0 && z < 0) return "BR";
  return "BL";
}

function pieceAtTop(model: CubeModel, colors: string[]): boolean {
  const c = findPiece(model, new Set(colors));
  return Math.round(c.pos.y) === 1;
}

/** Find a safe extraction that lifts a stuck piece into the top layer. */
export function extractionStep(moves: string[]): F2LStep | null {
  const model = buildFrom(moves);
  const solved = solvedPairs(model);

  for (const id of ALL_PAIRS) {
    if (solved.has(id)) continue;
    const [c1, c2] = SIDE_COLORS[id];
    const corner = findPiece(model, new Set([WHITE, c1, c2]));
    const edge = findPiece(model, new Set([c1, c2]));
    const cornerStuck = Math.round(corner.pos.y) === -1; // in a bottom slot
    const edgeStuck = Math.round(edge.pos.y) === 0; // in a middle slot

    const targets: { slot: PairId; colors: string[] }[] = [];
    if (cornerStuck) targets.push({ slot: slotOf(corner.pos), colors: [WHITE, c1, c2] });
    if (edgeStuck) targets.push({ slot: slotOf(edge.pos), colors: [c1, c2] });

    for (const target of targets) {
      for (const ex of EXTRACTIONS) {
        const rot = NORMALIZE[target.slot];
        const afterAlg = buildFrom([...moves, ...rot, ...tokenize(ex)]);
        const std = standardizeTokens(afterAlg);
        const full = [...rot, ...tokenize(ex), ...std];
        const result = buildFrom([...moves, ...full]);
        // Safe: cross intact, no solved pair disturbed, and the piece is now up.
        if (!crossSolvedIn(result)) continue;
        if (![...solved].every((k) => pairSolvedIn(result, k))) continue;
        if (!pieceAtTop(result, target.colors)) continue;
        return { pair: id, moves: full, variants: [full], algStrings: [full.join(" ")], variantSlots: [[]], isExtraction: true };
      }
    }
  }
  return null;
}

/** The immediate next F2L step: solve a 1A pair, or nudge a stuck piece up. */
export function nextF2LStep(moves: string[]): F2LStep | null {
  const plan = planF2L(moves);
  if (plan.length) return plan[0];
  return extractionStep(moves);
}

export {
  buildFrom, inverseAlg, tokenize, tokenizeFaceOnly, frSignature, NORMALIZE, SIDE_COLORS,
  findPiece, pairSolvedIn, crossSolvedIn,
};
