import * as THREE from "three";
import { CubeModel, parseMove, COLORS, WHITE, GREEN } from "./CubeModel";
import { buildFrom as buildFromBase } from "./f2l";

/**
 * crossSolver — optimal white-cross solver, CFOP convention: white DOWN, yellow
 * up, green front. The cross is solved on the bottom (D) face.
 *
 * Two stages, mimicking a real solver:
 *  1. orientToStandard — rotate the whole cube (x/y/z) so the white center is
 *     down and the green center is front. This is the "hold the cube right"
 *     step a speedcuber does before starting.
 *  2. solveCross — BFS over the reduced 4-white-edge space to place the cross
 *     around the (now bottom) white center in the fewest moves (<=8).
 */


// 12 edge positions -> posIndex 0..11.
const EDGES: [number, number, number][] = [
  [0, 1, 1], [1, 1, 0], [0, 1, -1], [-1, 1, 0],
  [0, -1, 1], [1, -1, 0], [0, -1, -1], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
];
const POS_INDEX = new Map(EDGES.map((e, i) => [e.join(","), i]));

const DIRS: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
const DIR_INDEX = new Map(DIRS.map((d, i) => [d.join(","), i]));

const encode = (posIdx: number, dirIdx: number) => posIdx * 6 + dirIdx;

const MOVES = ["U", "U'", "U2", "D", "D'", "D2", "F", "F'", "F2",
  "B", "B'", "B2", "L", "L'", "L2", "R", "R'", "R2"];

const AXIS_VEC = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

const key3 = (v: THREE.Vector3) => `${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)}`;

// ---- cross transition tables + distance-to-solved (white cross on D) ----
type Trans = number[];
let TRANS: Record<string, Trans> | null = null;
let DIST: Map<number, number> | null = null;

// White edges, fixed id order, keyed by their non-white side color.
const SIDE_ORDER: string[] = [GREEN, COLORS.R, COLORS.B, COLORS.L]; // green, red, blue, orange
// Solved: white edges home in their D slots, white facing DOWN.
const SOLVED_HOMES: [number, number, number][] = [
  [0, -1, 1], [1, -1, 0], [0, -1, -1], [-1, -1, 0], // DF, DR, DB, DL
];

function buildTransitions() {
  const tables: Record<string, Trans> = {};
  for (const token of MOVES) {
    const mv = parseMove(token)!;
    const q = new THREE.Quaternion().setFromAxisAngle(AXIS_VEC[mv.axis], mv.angle);
    const table: Trans = new Array(72).fill(-1);
    for (let posIdx = 0; posIdx < 12; posIdx++) {
      for (let dirIdx = 0; dirIdx < 6; dirIdx++) {
        const pos = new THREE.Vector3(...EDGES[posIdx]);
        const dir = new THREE.Vector3(...DIRS[dirIdx]);
        if (Math.round(pos[mv.axis]) === mv.layer) {
          pos.applyQuaternion(q);
          dir.applyQuaternion(q);
        }
        const np = POS_INDEX.get(key3(pos));
        const nd = DIR_INDEX.get(key3(dir));
        if (np !== undefined && nd !== undefined) table[encode(posIdx, dirIdx)] = encode(np, nd);
      }
    }
    tables[token] = table;
  }
  return tables;
}

function solvedState(): number[] {
  return SOLVED_HOMES.map((home) => {
    const posIdx = POS_INDEX.get(home.join(","))!;
    const dirIdx = DIR_INDEX.get("0,-1,0")!; // white down
    return encode(posIdx, dirIdx);
  });
}

const stateKey = (s: number[]) => s[0] + 72 * (s[1] + 72 * (s[2] + 72 * s[3]));

function buildDistanceTable(trans: Record<string, Trans>) {
  const dist = new Map<number, number>();
  const start = solvedState();
  dist.set(stateKey(start), 0);
  const queue: number[][] = [start];
  let head = 0;
  while (head < queue.length) {
    const s = queue[head++];
    const d = dist.get(stateKey(s))!;
    for (const token of MOVES) {
      const t = trans[token];
      const s2 = [t[s[0]], t[s[1]], t[s[2]], t[s[3]]];
      const k2 = stateKey(s2);
      if (!dist.has(k2)) {
        dist.set(k2, d + 1);
        queue.push(s2);
      }
    }
  }
  return dist;
}

function ensureTables() {
  if (!TRANS) TRANS = buildTransitions();
  if (!DIST) DIST = buildDistanceTable(TRANS);
}

function readCrossState(model: CubeModel): number[] {
  const down = new THREE.Vector3(0, -1, 0);
  const state = [0, 0, 0, 0];
  for (const c of model.cubies) {
    const zeros = [c.pos.x, c.pos.y, c.pos.z].filter((v) => Math.round(v) === 0).length;
    if (zeros !== 1) continue; // edges only
    if (!c.colors.includes(WHITE)) continue; // white edges only
    const side = c.colors.find((col) => col !== WHITE && col !== COLORS.inner);
    const id = SIDE_ORDER.indexOf(side ?? "");
    if (id < 0) continue;
    const posIdx = POS_INDEX.get(key3(c.pos))!;
    const wd = down.clone().applyQuaternion(c.quat); // white sticker born on -Y
    const dirIdx = DIR_INDEX.get(key3(wd))!;
    state[id] = encode(posIdx, dirIdx);
  }
  return state;
}

export function isCrossSolved(model: CubeModel): boolean {
  ensureTables();
  return DIST!.get(stateKey(readCrossState(model))) === 0;
}

function solveCrossModel(model: CubeModel): string[] {
  ensureTables();
  let state = readCrossState(model);
  const tokens: string[] = [];
  let guard = 0;
  while (DIST!.get(stateKey(state)) !== 0 && guard < 20) {
    const d = DIST!.get(stateKey(state))!;
    let advanced = false;
    for (const token of MOVES) {
      const t = TRANS![token];
      const s2 = [t[state[0]], t[state[1]], t[state[2]], t[state[3]]];
      if (DIST!.get(stateKey(s2)) === d - 1) {
        state = s2;
        tokens.push(token);
        advanced = true;
        break;
      }
    }
    if (!advanced) break;
    guard++;
  }
  return tokens;
}

// ---- orientation: bring white center down, green center front ----
const CUBE_ROTS = ["x", "x'", "y", "y'", "z", "z'"];

function centerDir(model: CubeModel, color: string): THREE.Vector3 {
  for (const c of model.cubies) {
    const zeros = [c.pos.x, c.pos.y, c.pos.z].filter((v) => Math.round(v) === 0).length;
    if (zeros === 2 && c.colors.includes(color)) {
      return new THREE.Vector3(Math.round(c.pos.x), Math.round(c.pos.y), Math.round(c.pos.z));
    }
  }
  return new THREE.Vector3(0, 0, 0);
}

/** Cube-rotation tokens that put white down and (if possible) green front. */
function orientTokens(model: CubeModel): string[] {
  const white0 = centerDir(model, WHITE);
  const green0 = centerDir(model, GREEN);
  const DOWN = "0,-1,0";
  const FRONT = "0,0,1";

  // BFS over cube orientations reachable by whole-cube rotations.
  interface Node { w: THREE.Vector3; g: THREE.Vector3; path: string[] }
  const startKey = key3(white0) + "|" + key3(green0);
  const seen = new Set([startKey]);
  const queue: Node[] = [{ w: white0.clone(), g: green0.clone(), path: [] }];
  let head = 0;
  let best: { path: string[]; score: number } | null = null;

  const scoreOf = (w: THREE.Vector3, g: THREE.Vector3) =>
    (key3(w) === DOWN ? 2 : 0) + (key3(g) === FRONT ? 1 : 0);

  while (head < queue.length) {
    const n = queue[head++];
    const sc = scoreOf(n.w, n.g);
    if (!best || sc > best.score || (sc === best.score && n.path.length < best.path.length)) {
      if (!best || sc > best.score || n.path.length < best.path.length) best = { path: n.path, score: sc };
    }
    if (sc === 3) break; // perfect: white down + green front
    if (n.path.length >= 3) continue;
    for (const token of CUBE_ROTS) {
      const mv = parseMove(token)!;
      const q = new THREE.Quaternion().setFromAxisAngle(AXIS_VEC[mv.axis], mv.angle);
      const w = n.w.clone().applyQuaternion(q);
      const g = n.g.clone().applyQuaternion(q);
      w.set(Math.round(w.x), Math.round(w.y), Math.round(w.z));
      g.set(Math.round(g.x), Math.round(g.y), Math.round(g.z));
      const k = key3(w) + "|" + key3(g);
      if (!seen.has(k)) {
        seen.add(k);
        queue.push({ w, g, path: [...n.path, token] });
      }
    }
  }
  return best ? best.path : [];
}

function buildModel(moves: string[]): CubeModel {
  return buildFromBase(moves);
}

export interface CrossPlan {
  reorient: string[]; // cube rotations to standard hold
  cross: string[]; // face moves that build the white cross on the bottom
}

/** Full "hold it like a pro, then solve the cross" plan for a move history. */
export function planCross(moves: string[]): CrossPlan {
  const model = buildModel(moves);
  const reorient = orientTokens(model);
  const cross = solveCrossModel(buildModel([...moves, ...reorient]));
  return { reorient, cross };
}

export function crossSolvedFromMoves(moves: string[]): boolean {
  return isCrossSolved(buildModel(moves));
}
