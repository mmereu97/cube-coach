import * as THREE from "three";

/**
 * grid.ts — translate a raycast hit (world point + world face normal) into the
 * exact 3x3 cell it landed on: which face, and the row/column as seen looking at
 * that face straight on in the canonical orientation (white up, green front).
 *
 * Pure and deterministic. Reused by:
 *  - the corner gesture (needs the sequence of cells a drag passes through)
 *  - manual color input later (needs which of the 54 stickers was clicked)
 *
 * Row/col convention: looking at the face from outside, row 0 = top, col 0 = left.
 * `index` is the 1..9 number, row-major (row0 = 1,2,3), matching how a person
 * counts stickers on a face.
 */

export type FaceLetter = "U" | "D" | "F" | "B" | "L" | "R";

export interface Cell {
  face: FaceLetter;
  row: 0 | 1 | 2;
  col: 0 | 1 | 2;
  index: number; // 1..9, row-major
}

const SPACING = 1.06; // must match Cube3D

/** Which cube face an (axis-aligned) world normal points out of. */
export function faceFromNormal(n: THREE.Vector3): FaceLetter {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  if (ax >= ay && ax >= az) return n.x > 0 ? "R" : "L";
  if (ay >= ax && ay >= az) return n.y > 0 ? "U" : "D";
  return n.z > 0 ? "F" : "B";
}

/** Round a world coordinate to its lattice index (-1, 0, or 1). */
function lattice(w: number): number {
  return Math.max(-1, Math.min(1, Math.round(w / SPACING)));
}

const clamp02 = (v: number): 0 | 1 | 2 => (v < 0 ? 0 : v > 2 ? 2 : (v as 0 | 1 | 2));

/**
 * Given the grabbed face and the hit point's lattice coordinates, compute
 * (row, col) per the canonical viewing convention derived once and encoded here.
 */
function rowColFor(face: FaceLetter, lx: number, ly: number, lz: number): [0 | 1 | 2, 0 | 1 | 2] {
  let row = 1;
  let col = 1;
  switch (face) {
    case "F": // viewer right = +X, up = +Y
      col = lx + 1;
      row = 1 - ly;
      break;
    case "B": // viewer right = -X, up = +Y
      col = 1 - lx;
      row = 1 - ly;
      break;
    case "R": // viewer right = -Z, up = +Y
      col = 1 - lz;
      row = 1 - ly;
      break;
    case "L": // viewer right = +Z, up = +Y
      col = lz + 1;
      row = 1 - ly;
      break;
    case "U": // looking down; viewer up = -Z (back at top), right = +X
      col = lx + 1;
      row = lz + 1;
      break;
    case "D": // looking up; viewer up = +Z (front at top), right = +X
      col = lx + 1;
      row = 1 - lz;
      break;
  }
  return [clamp02(row), clamp02(col)];
}

export function pointToCell(point: THREE.Vector3, worldNormal: THREE.Vector3): Cell {
  const face = faceFromNormal(worldNormal);
  const lx = lattice(point.x);
  const ly = lattice(point.y);
  const lz = lattice(point.z);
  const [row, col] = rowColFor(face, lx, ly, lz);
  return { face, row, col, index: row * 3 + col + 1 };
}
