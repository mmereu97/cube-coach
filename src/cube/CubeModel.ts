import * as THREE from "three";

/**
 * CubeModel — the logical state of a 3x3, independent of any rendering.
 *
 * 26 cubies (the invisible core is omitted). Each cubie carries:
 *  - `pos`: its current grid position, components in {-1, 0, 1}
 *  - `quat`: its current orientation
 *  - `colors`: the six face colors, fixed at birth and carried along as the
 *    cubie rotates (so stickers travel with the piece, which is correct).
 *
 * A move rotates the 9 cubies of one layer by 90° about an axis, updating both
 * their position and their orientation. Positions are snapped to integers after
 * each turn to prevent floating-point drift.
 *
 * This file has zero dependencies on React or the DOM. When we port to Flutter,
 * this is the kind of pure logic that translates almost line-for-line.
 */

export const COLORS = {
  U: "#ffd400", // up    — yellow  (CFOP standard: yellow on top)
  D: "#f5f5f5", // down  — white   (white cross is solved on the bottom)
  F: "#009b48", // front — green
  B: "#0046ad", // back  — blue
  R: "#ff9020", // right — orange (matches a real cube held yellow-up, green-front)
  L: "#d42020", // left  — red
  inner: "#161616",
} as const;

// Named colors, independent of face position (used by the cross solver).
export const WHITE = "#f5f5f5";
export const GREEN = "#009b48";

export interface Cubie {
  id: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  /** Face colors in three.js BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z. */
  colors: [string, string, string, string, string, string];
}

export type Axis = "x" | "y" | "z";

export interface Move {
  face: "R" | "L" | "U" | "D" | "F" | "B" | "M" | "E" | "S" | "x" | "y" | "z"
      | "r" | "l" | "u" | "d" | "f" | "b";
  axis: Axis;
  layer: number; // which coordinate value selects the layer: +1, 0, or -1
  angle: number; // signed radians for a single application (base direction)
  whole?: boolean; // true for whole-cube rotations (x/y/z): all cubies turn
  wide?: boolean; // true for wide moves (r/l/u/d/f/b): the outer layer AND the middle turn
}

const HALF_PI = Math.PI / 2;

/** Base (clockwise) move definitions for the standard white-up / green-front scheme. */
const MOVE_DEFS: Record<Move["face"], Omit<Move, "face">> = {
  R: { axis: "x", layer: 1, angle: -HALF_PI },
  L: { axis: "x", layer: -1, angle: HALF_PI },
  U: { axis: "y", layer: 1, angle: -HALF_PI },
  D: { axis: "y", layer: -1, angle: HALF_PI },
  F: { axis: "z", layer: 1, angle: -HALF_PI },
  B: { axis: "z", layer: -1, angle: HALF_PI },
  // Middle slices: M follows L, E follows D, S follows F.
  M: { axis: "x", layer: 0, angle: HALF_PI },
  E: { axis: "y", layer: 0, angle: HALF_PI },
  S: { axis: "z", layer: 0, angle: -HALF_PI },
  // Whole-cube rotations: x follows R, y follows U, z follows F.
  x: { axis: "x", layer: 0, angle: -HALF_PI, whole: true },
  y: { axis: "y", layer: 0, angle: -HALF_PI, whole: true },
  z: { axis: "z", layer: 0, angle: -HALF_PI, whole: true },
  // Wide moves: the outer face + the adjacent middle slice, turning together with the outer
  // face (r = R + M', l = L + M, u = U + E', d = D + E, f = F + S, b = B + S'). Applied
  // natively so the CENTRES rotate exactly like the physical core — no simulation.
  r: { axis: "x", layer: 1, angle: -HALF_PI, wide: true },
  l: { axis: "x", layer: -1, angle: HALF_PI, wide: true },
  u: { axis: "y", layer: 1, angle: -HALF_PI, wide: true },
  d: { axis: "y", layer: -1, angle: HALF_PI, wide: true },
  f: { axis: "z", layer: 1, angle: -HALF_PI, wide: true },
  b: { axis: "z", layer: -1, angle: HALF_PI, wide: true },
};

/** Parse a notation token: faces R/U/F/L/D/B, wides r/u/f/l/d/b, slices M/E/S, rotations x/y/z (+ ' or 2). */
export function parseMove(token: string): Move | null {
  const m = /^([RLUDFBMESxyzrludfb])(['2]?)$/.exec(token.trim());
  if (!m) return null;
  const face = m[1] as Move["face"];
  const modifier = m[2];
  const def = MOVE_DEFS[face];
  let angle = def.angle;
  if (modifier === "'") angle = -angle;
  if (modifier === "2") angle = angle * 2;
  return { face, axis: def.axis, layer: def.layer, angle, whole: def.whole, wide: def.wide };
}

const AXIS_VEC: Record<Axis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

function homeColors(x: number, y: number, z: number): Cubie["colors"] {
  // Order: +X, -X, +Y, -Y, +Z, -Z
  return [
    x === 1 ? COLORS.R : COLORS.inner,
    x === -1 ? COLORS.L : COLORS.inner,
    y === 1 ? COLORS.U : COLORS.inner,
    y === -1 ? COLORS.D : COLORS.inner,
    z === 1 ? COLORS.F : COLORS.inner,
    z === -1 ? COLORS.B : COLORS.inner,
  ];
}

// Facelet position table (Kociemba URFDLB) → each sticker's cubie position + outward
// normal. Matches the physical GAN cube's frame (verified against real captures).
const _FACELET_TABLE: { pos: [number, number, number]; n: [number, number, number] }[] = (() => {
  const t: { pos: [number, number, number]; n: [number, number, number] }[] = [];
  const p = (pos: [number, number, number], n: [number, number, number]) => t.push({ pos, n });
  for (let j = 0; j < 9; j++) { const r = Math.floor(j / 3), c = j % 3; p([c - 1, 1, r - 1], [0, 1, 0]); }      // U
  for (let j = 0; j < 9; j++) { const r = Math.floor(j / 3), c = j % 3; p([1, 1 - r, 1 - c], [1, 0, 0]); }      // R
  for (let j = 0; j < 9; j++) { const r = Math.floor(j / 3), c = j % 3; p([c - 1, 1 - r, 1], [0, 0, 1]); }      // F
  for (let j = 0; j < 9; j++) { const r = Math.floor(j / 3), c = j % 3; p([c - 1, -1, 1 - r], [0, -1, 0]); }    // D
  for (let j = 0; j < 9; j++) { const r = Math.floor(j / 3), c = j % 3; p([-1, 1 - r, c - 1], [-1, 0, 0]); }    // L
  for (let j = 0; j < 9; j++) { const r = Math.floor(j / 3), c = j % 3; p([1 - c, 1 - r, -1], [0, 0, -1]); }    // B
  return t;
})();
const _LETTER_COLOR: Record<string, string> = {
  U: COLORS.U, R: COLORS.R, F: COLORS.F, D: COLORS.D, L: COLORS.L, B: COLORS.B,
};

// The cube reports facelets in its own frame, which is 180° about Z (the F-B axis) from
// our display frame — physical U↔D and R↔L. This permutation + letter remap rotates the
// reported facelets into our frame before we build the model.
const _REFRAME_PERM: number[] = (() => {
  const key = (p: number[], n: number[]) => `${p[0]},${p[1]},${p[2]}|${n[0]},${n[1]},${n[2]}`;
  const idx = new Map<string, number>();
  _FACELET_TABLE.forEach((f, i) => idx.set(key(f.pos, f.n), i));
  return _FACELET_TABLE.map((f) => idx.get(key([-f.pos[0], -f.pos[1], f.pos[2]], [-f.n[0], -f.n[1], f.n[2]]))!);
})();
const _REFRAME_LETTER: Record<string, string> = { U: "D", D: "U", R: "L", L: "R", F: "F", B: "B" };
function reframeFacelets(fac: string): string {
  const out = new Array(54);
  for (let i = 0; i < 54; i++) out[i] = _REFRAME_LETTER[fac[_REFRAME_PERM[i]]] ?? fac[_REFRAME_PERM[i]];
  return out.join("");
}

/** Build a cube model directly from a 54-char facelets string (the cube's ground-truth
 *  state). Colors are placed to match the reported stickers; orientation is applied
 *  separately by the gyro at render time. */
export function faceletsToModel(faceletsRaw: string): CubeModel {
  const facelets = reframeFacelets(faceletsRaw);
  const m = new CubeModel(); // starts solved; we overwrite colors
  // Reset every cubie's colors to inner, keep positions/quaternions identity.
  const byPos = new Map<string, Cubie>();
  for (const c of m.cubies) {
    c.quat = new THREE.Quaternion();
    c.colors = [COLORS.inner, COLORS.inner, COLORS.inner, COLORS.inner, COLORS.inner, COLORS.inner];
    byPos.set(`${Math.round(c.pos.x)},${Math.round(c.pos.y)},${Math.round(c.pos.z)}`, c);
  }
  const slot = (n: [number, number, number]) =>
    n[0] === 1 ? 0 : n[0] === -1 ? 1 : n[1] === 1 ? 2 : n[1] === -1 ? 3 : n[2] === 1 ? 4 : 5;
  for (let i = 0; i < Math.min(54, facelets.length); i++) {
    const letter = facelets[i];
    const color = _LETTER_COLOR[letter];
    if (!color) continue;
    const f = _FACELET_TABLE[i];
    const c = byPos.get(`${f.pos[0]},${f.pos[1]},${f.pos[2]}`);
    if (c) c.colors[slot(f.n)] = color as Cubie["colors"][number];
  }
  return m;
}

/** The exact inverse of `faceletsToModel`: read a model back out as the 54-char string the
 *  physical cube would report for that state. Having both directions makes the conversion
 *  round-trippable, which is what lets the real-hardware captures in the tests verify it. */
export function modelToFacelets(m: CubeModel): string {
  const BASE_N: [number, number, number][] = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  const colorLetter = new Map<string, string>();
  for (const [letter, color] of Object.entries(_LETTER_COLOR)) colorLetter.set(color, letter);

  const byPos = new Map<string, Cubie>();
  for (const c of m.cubies) byPos.set(`${Math.round(c.pos.x)},${Math.round(c.pos.y)},${Math.round(c.pos.z)}`, c);

  // First read the model in OUR frame, facelet by facelet.
  const ours = new Array<string>(54).fill("?");
  _FACELET_TABLE.forEach((f, i) => {
    const c = byPos.get(`${f.pos[0]},${f.pos[1]},${f.pos[2]}`);
    if (!c) return;
    for (let k = 0; k < 6; k++) {
      if (c.colors[k] === COLORS.inner) continue;
      const n = new THREE.Vector3(...BASE_N[k]).applyQuaternion(c.quat);
      if (Math.round(n.x) === f.n[0] && Math.round(n.y) === f.n[1] && Math.round(n.z) === f.n[2]) {
        ours[i] = colorLetter.get(c.colors[k]) ?? "?";
        return;
      }
    }
  });

  // Then undo the reframe: reframeFacelets does ours[i] = MAP[raw[PERM[i]]], and the letter
  // map is its own inverse (U<->D, R<->L, F and B fixed), so raw[PERM[i]] = MAP[ours[i]].
  const raw = new Array<string>(54).fill("?");
  for (let i = 0; i < 54; i++) raw[_REFRAME_PERM[i]] = _REFRAME_LETTER[ours[i]] ?? ours[i];
  return raw.join("");
}

export class CubeModel {
  cubies: Cubie[] = [];

  constructor() {
    this.reset();
  }

  reset() {
    this.cubies = [];
    let id = 0;
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          if (x === 0 && y === 0 && z === 0) continue; // skip invisible core
          this.cubies.push({
            id: id++,
            pos: new THREE.Vector3(x, y, z),
            quat: new THREE.Quaternion(),
            colors: homeColors(x, y, z),
          });
        }
      }
    }
  }

  /** Cubie ids that belong to the layer a move turns (all cubies for x/y/z). */
  selectLayer(move: Move): Set<number> {
    const ids = new Set<number>();
    for (const c of this.cubies) {
      const coord = Math.round(c.pos[move.axis]);
      // Wide moves grab the outer layer AND the middle slice; whole rotations grab everything.
      if (move.whole || coord === move.layer || (move.wide && coord === 0)) ids.add(c.id);
    }
    return ids;
  }

  /** Apply a move to the logical state (no animation — this is the "commit"). */
  clone(): CubeModel {
    const m = new CubeModel();
    m.cubies = this.cubies.map((c) => ({
      id: c.id,
      pos: c.pos.clone(),
      quat: c.quat.clone(),
      colors: [...c.colors] as Cubie["colors"],
    }));
    return m;
  }

  applyMove(move: Move) {
    const ids = this.selectLayer(move);
    const q = new THREE.Quaternion().setFromAxisAngle(AXIS_VEC[move.axis], move.angle);
    for (const c of this.cubies) {
      if (!ids.has(c.id)) continue;
      c.pos.applyQuaternion(q);
      c.pos.set(Math.round(c.pos.x), Math.round(c.pos.y), Math.round(c.pos.z));
      c.quat.premultiply(q);
    }
  }

  /** True when every cubie is back home with identity orientation. */
  isSolved(): boolean {
    // Cheap check: each face shows a single color. For milestone 2 we compare
    // against home positions with (near-)identity orientation.
    return this.cubies.every((c) => {
      const home = c.colors; // colors never change; solved == home layout
      void home;
      return true; // placeholder — real solved-detection arrives with the CFOP engine
    });
  }
}
