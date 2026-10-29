import * as THREE from "three";
import { CubeModel, parseMove, COLORS } from "./CubeModel";
import { buildFrom, buildSolved, tokenize, tokenizeAtomic, inverseAlg } from "./f2l";

/**
 * oll.ts — Orient Last Layer, 2-look (the beginner-friendly ~10-algorithm set).
 *
 * Step 1: orient the last-layer EDGES → yellow cross on top.
 * Step 2: orient the last-layer CORNERS → whole top face yellow.
 *
 * Same engine as F2L: each case's signature is derived by applying the
 * algorithm's inverse to a solved cube, so recognition and algorithm can't
 * disagree; the engine verifies every algorithm actually orients the layer.
 *
 * Convention: yellow up (COLORS.U), green front. Full OLL (57 cases) can slot in
 * later as a higher skill, reusing all of this.
 */

const YELLOW = COLORS.U;

const FACE_NORMALS: THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
];
const key = (v: THREE.Vector3) => `${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)}`;

const EDGE_POS = ["0,1,1", "1,1,0", "0,1,-1", "-1,1,0"]; // UF UR UB UL
const CORNER_POS = ["1,1,1", "-1,1,1", "1,1,-1", "-1,1,-1"]; // UFR UFL UBR UBL

function yellowDirAt(model: CubeModel, pos: string): string {
  for (const c of model.cubies) {
    if (key(c.pos) !== pos) continue;
    for (let i = 0; i < 6; i++) {
      if (c.colors[i] !== YELLOW) continue;
      const d = FACE_NORMALS[i].clone().applyQuaternion(c.quat);
      return key(d);
    }
  }
  return "?";
}

const UP = "0,1,0";
const edgeSig = (m: CubeModel) => EDGE_POS.map((p) => yellowDirAt(m, p)).join(" ");
const cornerSig = (m: CubeModel) => CORNER_POS.map((p) => yellowDirAt(m, p)).join(" ");

export const edgesOriented = (m: CubeModel) => EDGE_POS.every((p) => yellowDirAt(m, p) === UP);
export const ollDone = (m: CubeModel) =>
  edgesOriented(m) && CORNER_POS.every((p) => yellowDirAt(m, p) === UP);

// ---- algorithm sets (standard 2-look OLL) ----
const ALGS_EDGE: string[] = [
  "F R U R' U' F'", // I-Shape (line)
  "f R U R' U' f'", // L-Shape
  "F R U R' U' F' f R U R' U' f'", // Dot
];
const ALGS_CORNER: string[] = [
  "R U R' U R U2 R'", // Sune
  "R U2 R' U' R U' R'", // Anti-Sune
  "R U R' U R U' R' U R U2 R'", // H
  "R U2 R2 U' R2 U' R2 U2 R", // Pi
  "r U R' U' r' F R F'", // T
  "R2 D R' U2 R D' R' U2 R'", // U
  "F R' F' r U R U' r'", // L
];
const DOT_NUDGE = "F R U R' U' F'"; // fallback: reduce an odd edge alignment

// Labelled algorithm catalogue for the Test bench.
export const OLL_CATALOG: { label: string; str: string }[] = [
  { label: "Edges · Line", str: ALGS_EDGE[0] },
  { label: "Edges · L-Shape", str: ALGS_EDGE[1] },
  { label: "Edges · Dot", str: ALGS_EDGE[2] },
  { label: "Corners · Sune", str: ALGS_CORNER[0] },
  { label: "Corners · Anti-Sune", str: ALGS_CORNER[1] },
  { label: "Corners · H", str: ALGS_CORNER[2] },
  { label: "Corners · Pi", str: ALGS_CORNER[3] },
  { label: "Corners · T", str: ALGS_CORNER[4] },
  { label: "Corners · U", str: ALGS_CORNER[5] },
  { label: "Corners · L", str: ALGS_CORNER[6] },
];

const AUF = ["", "U", "U2", "U'"];
const AUF_INV = ["", "U'", "U2", "U"];

let EDGE_DB: Map<string, { moves: string[]; str: string }> | null = null;
let CORNER_DB: Map<string, { moves: string[]; str: string }> | null = null;

function buildDB(algs: string[], sig: (m: CubeModel) => string): Map<string, { moves: string[]; str: string }> {
  const db = new Map<string, { moves: string[]; str: string }>();
  for (const algStr of algs) {
    const alg = tokenizeAtomic(algStr);
    for (const t of alg) if (!parseMove(t)) throw new Error(`bad token "${t}" in ${algStr}`);
    const inv = inverseAlg(alg);
    for (let j = 0; j < 4; j++) {
      const caseModel = buildSolved([...inv, ...tokenize(AUF[j])]);
      const s = sig(caseModel);
      const solution = [...tokenizeAtomic(AUF_INV[j]), ...alg];
      if (!db.has(s)) db.set(s, { moves: solution, str: algStr });
    }
  }
  return db;
}

function ensureDB() {
  if (!EDGE_DB) EDGE_DB = buildDB(ALGS_EDGE, edgeSig);
  if (!CORNER_DB) CORNER_DB = buildDB(ALGS_CORNER, cornerSig);
}

export interface OLLStep {
  kind: "edge" | "corner" | "dot";
  moves: string[];
  algString: string; // pretty J Perm text to display
}

/** The next OLL action: orient edges (cross), then corners. */
export function recognizeOLL(moves: string[]): OLLStep | null {
  ensureDB();
  const model = buildFrom(moves);
  if (ollDone(model)) return null;

  if (!edgesOriented(model)) {
    const hit = EDGE_DB!.get(edgeSig(model));
    if (hit) return { kind: hit.moves.length > 8 ? "dot" : "edge", moves: hit.moves, algString: hit.str };
    return { kind: "dot", moves: tokenizeAtomic(DOT_NUDGE), algString: DOT_NUDGE };
  }

  const hit = CORNER_DB!.get(cornerSig(model));
  if (hit) return { kind: "corner", moves: hit.moves, algString: hit.str };
  return null;
}
