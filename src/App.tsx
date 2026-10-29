import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Cube3D, orientationToQuaternion, type TraceStep } from "./components/Cube3D";
import { visualQuaternion } from "./components/gyroMath";
import { useVirtualCube } from "./hooks/useVirtualCube";
import { useCube } from "./useCube";
import { CubeModel, faceletsToModel, parseMove, COLORS, WHITE, type Cubie } from "./cube/CubeModel";
import { planCross } from "./cube/crossSolver";
import { nextF2LStep, pairSolvedIn, crossSolvedIn, buildFrom, buildSolved, tokenize, inverseAlg, setSolveBase, segmentAlg, explainPairChoice, SIDE_COLORS, F2L_CATALOG } from "./cube/f2l";
import { recognizeOLL, ollDone, OLL_CATALOG } from "./cube/oll";
import { recognizePLL, pllDone, PLL_CATALOG } from "./cube/pll";
import {
  emptyPaint, solveFromPaint, PAINT_COLORS,
  type PaintCubie,
} from "./cube/cubeInput";
import type { Cell, FaceLetter } from "./cube/grid";
import "./App.css";

// Buttons to drive the virtual cube with no physical cube in hand — for practising while the real
// one is on the charger. The same vocabulary the solver speaks: faces, wides, slices, rotations.
const KEY_GROUPS: { label: string; tokens: string[] }[] = [
  { label: "faces",     tokens: ["U", "D", "R", "L", "F", "B"] },
  { label: "faces \u2032", tokens: ["U'", "D'", "R'", "L'", "F'", "B'"] },
  { label: "wides",     tokens: ["u", "d", "r", "l", "f", "b"] },
  { label: "wides \u2032", tokens: ["u'", "d'", "r'", "l'", "f'", "b'"] },
  { label: "slices",    tokens: ["M", "E", "S"] },
  { label: "slices \u2032", tokens: ["M'", "E'", "S'"] },
  { label: "rotations", tokens: ["x", "y", "z"] },
  { label: "rotations \u2032", tokens: ["x'", "y'", "z'"] },
];
const SCRAMBLE_FACES = ["U", "D", "F", "B", "L", "R"];
const SCRAMBLE_SUFFIX = ["", "'", "2"];

function randomScramble(n = 20): string[] {
  const out: string[] = [];
  let lastFace = "";
  for (let i = 0; i < n; i++) {
    let face = SCRAMBLE_FACES[Math.floor(Math.random() * 6)];
    while (face === lastFace) face = SCRAMBLE_FACES[Math.floor(Math.random() * 6)];
    lastFace = face;
    out.push(face + SCRAMBLE_SUFFIX[Math.floor(Math.random() * 3)]);
  }
  return out;
}

// The GAN cube reports faces in its own frame; relative to our hold (yellow up,
// green front) that frame is rotated 180 degrees about the F axis, which swaps
// U<->D and R<->L while leaving F/B and turn direction unchanged.
const PHYS_FACE_MAP: Record<string, string> = { U: "D", D: "U", R: "L", L: "R", F: "F", B: "B" };
function remapPhysicalMove(move: string): string {
  const face = move[0];
  const mapped = PHYS_FACE_MAP[face];
  return mapped ? mapped + move.slice(1) : move;
}

// Slice moves rotate the cube's CENTERS (which the GAN cube reports moves relative
// to), so after a slice every following face move is reported in a rotated frame.
// These maps say how a face letter is re-reported after the centers rotate; we undo
// the accumulated rotation to recover the true (absolute) move. Derived from live
// cube data: M→x', M'→x, E→y', E'→y, S→z, S'→z'.


// A physical wide `r` and a plain `L` produce the SAME facelets/report — the cube can't tell
// them apart (only the gyro sees the core rotation). In test bench we know the algorithm, so
// this map gives the look-alike face each wide is REPORTED as, letting us match the report and
// then record the true atomic token (`r`, not `L`). Direction is preserved (r→L, r'→L').
const WIDE_LOOK: Record<string, string> = { r: "L", l: "R", u: "D", d: "U", f: "B", b: "F" };
// The GAN cube reports a SLICE as two opposite face turns ~6ms apart (grip frame). When the
// algorithm expects a slice, we recognise that pair and record the slice. All three axes are now
// confirmed from hardware: M' → L,R' · E → U,D' · S → B,F' (inverses are the reverse pair).
const SLICE_PAIR: Record<string, [string, string]> = {
  "M'": ["L", "R'"], M: ["R", "L'"],
  E: ["U", "D'"], "E'": ["D", "U'"],
  S: ["B", "F'"], "S'": ["F", "B'"],
};
// Human-readable case names for the guide-solve progress panel (2-look OLL/PLL + F2L categories).
const OLL_CASE: Record<string, string> = {
  "F R U R' U' F'": "Line", "f R U R' U' f'": "L-Shape", "F R U R' U' F' f R U R' U' f'": "Dot",
  "R U R' U R U2 R'": "Sune", "R U2 R' U' R U' R'": "Anti-Sune", "R U R' U R U' R' U R U2 R'": "H",
  "R U2 R2 U' R2 U' R2 U2 R": "Pi", "r U R' U' r' F R F'": "T", "R2 D R' U2 R D' R' U2 R'": "U", "F R' F' r U R U' r'": "L",
};
const PLL_CASE: Record<string, string> = {
  "F R U' R' U' R U R' F' R U R' U' R' F R F'": "Diagonal", "R U R' U' R' F R2 U' R' U' R U R' F'": "Headlights",
  "M2 U M2 U2 M2 U M2": "H", "R U' R U R U R U' R' U' R2": "Ua", "R2 U R U R' U' R' U' R' U R'": "Ub", "M' U M2 U M2 U M' U2 M2": "Z",
};
const F2L_CAT: Record<string, string> = {
  "1A-up": "white sticker up", "1A-same": "white on side/front — same", "1A-diff": "white on side/front — different",
  "1B-corner": "corner in slot", "1B-edge": "edge in slot", "1C": "both pieces in slot",
};
// Measurement: how much the CORE rotated between two gyro snapshots — angle (deg) and axis. A plain
// face leaves the core still (~0°); a wide/slice/rotation turns it ~90° about some axis.
// The axis is ALSO expressed in the cube's own frame: the cube is held tilted (against the chest,
// head down), so a world-frame axis is meaningless by itself. Rotating it by the inverse of the
// cube's orientation cancels the tilt, letting us ask "did the core turn about the R axis?".
function coreDelta(
  prev: { x: number; y: number; z: number; w: number } | null,
  now: { x: number; y: number; z: number; w: number } | null,
): { angle: number; axis: [number, number, number]; axisCube: [number, number, number] } | null {
  if (!prev || !now) return null;
  const qp = new THREE.Quaternion(prev.x, prev.y, prev.z, prev.w);
  const qn = new THREE.Quaternion(now.x, now.y, now.z, now.w);
  const dq = qn.clone().multiply(qp.clone().invert());
  const angle = 2 * Math.acos(Math.min(1, Math.abs(dq.w))) * (180 / Math.PI);
  const s = Math.sqrt(Math.max(0, 1 - dq.w * dq.w));
  const sign = dq.w < 0 ? -1 : 1;
  const axis: [number, number, number] = s < 1e-4 ? [0, 0, 0] : [sign * dq.x / s, sign * dq.y / s, sign * dq.z / s];
  // Same axis, but seen from the cube: undo the cube's current orientation.
  const v = new THREE.Vector3(axis[0], axis[1], axis[2]).applyQuaternion(qn.clone().invert());
  const axisCube: [number, number, number] = [v.x, v.y, v.z];
  return { angle, axis, axisCube };
}
// The cube-frame axis each RAW face event turns the core about. These are the GAN gyro's own axes,
// measured on hardware (a wide r turned the core about X, u about Z, f about Y) — NOT the intuitive
// U=Y/F=Z guess. Keyed by the cube's raw move letter, before any user-convention remap.
const FACE_AXIS: Record<string, [number, number, number]> = {
  R: [1, 0, 0], L: [-1, 0, 0],
  U: [0, 0, 1], D: [0, 0, -1],
  F: [0, 1, 0], B: [0, -1, 0],
};
// |cos| between the measured core axis (in cube frame) and the raw face's axis. A wide turns the
// core about exactly that axis (→ ~1.0); hand wobble points anywhere (→ scattered).
function axisAlign(axisCube: [number, number, number], rawMove: string): number {
  const f = FACE_AXIS[rawMove[0]];
  if (!f) return -1;
  const d = axisCube[0] * f[0] + axisCube[1] * f[1] + axisCube[2] * f[2];
  const n = Math.hypot(...axisCube) || 1;
  return Math.abs(d / n);
}
// Wide Lab: group the raw layer events into physical MOVES (events in a <200ms burst belong to the
// same move — that's how a slice's two events arrive) and classify each by the rule found on
// hardware: 1 event + core still → FACE · 1 event + core turned → WIDE · 2 events (turned + still)
// → SLICE. (Pure rotations produce 0 layer events and are studied separately.)
const SLICE_WINDOW_MS = 700; // a slice's two events can straggle much further apart when turned slowly

// A slice always reports as a pair of OPPOSITE faces turned in opposite directions (M -> R + L',
// E -> U + D', S -> B + F'). Grouping on that identity — not just on timing — is what lets a slowly
// turned slice still be recognised without gluing together two genuinely separate moves.
const OPPOSITE: Record<string, string> = { R: "L", L: "R", U: "D", D: "U", F: "B", B: "F" };
function isSlicePair(a: string, b: string): boolean {
  if (OPPOSITE[a[0]] !== b[0]) return false;
  const sa = a.slice(1), sb = b.slice(1);
  if (sa === "2" && sb === "2") return true;      // M2 -> R2 + L2
  return (sa === "'" && sb === "") || (sa === "" && sb === "'"); // opposite directions
}
type Gyro = { x: number; y: number; z: number; w: number };
type Trail = { q: Gyro; t: number }[];
type LabEvent = { move: string; t: number; facelets: string | null; quat: Gyro | null; quatBefore: Gyro | null; quatAfter: Gyro | null };
type LabMove = { moves: string[]; angle: number; align: number; kind: string; span: number; facelets: string | null; win: number; samples: number; gapPrev: number; gapNext: number; clipped: boolean; tEnd: number };

// Group raw layer events into physical MOVES (events within a <200ms burst are one move — that's
// how a slice's two events arrive), then read the core rotation each move caused: from the
// orientation captured just BEFORE the turn to the one captured AFTER the gyro caught up (the gyro
// stream lags the move event) — frozen the instant the next move arrives, so a neighbouring turn
// can never leak in. Rule, validated on hardware:
//   1 event + core still           -> FACE
//   1 event + core turned on axis  -> WIDE
//   2 events + core turned on axis -> SLICE
// A move is defined by its LAYER events plus what the core did *at that moment* — never by the gyro
// alone. Hunting for free-floating rotations in the gyro stream was the mistake: it swallowed slow
// hand movement as if it were a turn (one "rotation" spanned 4.1 seconds).
//
// So: anchor to the layer event, and ask one question — how far did the core turn ABOUT THIS MOVE'S
// OWN AXIS while the move happened? Hand wobble points in random directions and cancels out in that
// projection; a wide turns the core a clean 90° about exactly that axis.
// The clean formulation — "how far has the core turned since the previous move?", with intervals
// tiling the timeline end to end — was tried and FAILED on hardware: it assumes the gyro's delay is
// a constant, and it is not. When the real delay ran past the interval, the rotation was missed
// entirely (a wide read as a face — a silent error) and then double counted in the next interval.
//
// So the window is deliberately asymmetric: it opens AT the event (the previous move's rotation has
// landed by then) and stays open long enough to catch this move's rotation whenever it arrives.
// Ugly, but tolerant of the jitter the hardware actually has.
const WIN_PRE = 60;     // barely before the event
const WIN_POST = 1100;  // room for a SLOW turn — the lull above, not the clock, ends the reading
const EDGE_GUARD = 50;  // never reach past a neighbouring event
// Where to put the two bands, read off the hardware rather than guessed: across every run, faces
// projected 0-20° and wides/slices 53-150°. Nothing has ever landed between 20° and 50°, so that gap
// is the real boundary — and the earlier band (60-120°) was needlessly narrow, throwing away good
// readings at 53° or 121° as "unknown".
// Turning at speed, you constantly re-grip: the core genuinely swings 20-35° about the very axis you
// are turning. That is not measurement noise — the gyro is reading it correctly. So "the core stayed
// put" has to mean "it did not go anywhere NEAR 90°", not "it did not move at all". Faces have never
// exceeded ~37°; wides start at 55°.
const TOL_STILL = 45;   // |net| <= this  -> the core stayed put -> FACE
const TOL_TURN = 35;    // |net-90| <= this -> the core came along -> WIDE / SLICE (i.e. 55-125°)
// A wide is the claim that REWRITES the model's frame: get it wrong and every later move is mapped
// wrong too. So it may only be asserted on evidence that actually exists. Turning fast leaves the
// window with a handful of gyro samples (the stream runs at ~15Hz), and a flick of the wrist can
// then read as 50° — enough, under a loose band, to invent a wide that never happened.
const MIN_WIN_MS = 250;  // less room than this and the core simply was not observed
const MIN_SAMPLES = 4;   // ...nor with fewer readings than this

// Net rotation of the core about `axis` (cube frame) between two times, summed from the gyro samples
// in between. Summing projections is what kills hand wobble: random directions cancel, a real turn
// about this axis accumulates.
// Sum the core's rotation about this move's axis across the window. Projecting onto the axis is
// what defeats hand wobble: random directions cancel; a real turn about this axis accumulates.
//
// A speed filter was tried here — keep only the fast "turn" burst, discard slow hand movement — and
// it was a BAD regression: a wide turned slowly produced no qualifying burst, read 0°, and was
// silently called a face. Wrong-with-confidence is the one failure this classifier must never have,
// so the plain sum stays. Out-of-band readings are reported as UNKNOWN instead of guessed.
// Keep adding while the core is still turning about this axis; stop once it goes quiet. A slow turn
// is followed to its end (a fixed window would cut it short and report a meaningless 40°), while a
// re-grip afterwards is left out, because it only starts after a lull.
const LULL_MS = 220;    // this much stillness means the turn is over
const MOVING_DEG = 1.2; // per-sample rotation about the axis that still counts as turning
function netAbout(trail: Trail, tA: number, tB: number, axis: [number, number, number]): { net: number; samples: number } {
  let net = 0;
  let samples = 0;
  let lastMoving = -1;
  for (let k = 1; k < trail.length; k++) {
    if (trail[k].t <= tA || trail[k].t > tB) continue;
    const d = coreDelta(trail[k - 1].q, trail[k].q);
    if (!d) continue;
    const dot = d.axisCube[0] * axis[0] + d.axisCube[1] * axis[1] + d.axisCube[2] * axis[2];
    const contrib = d.angle * dot;
    // Once the turn has begun and then gone quiet for a while, stop: whatever follows is you
    // adjusting your grip, not part of the move.
    if (lastMoving > 0 && trail[k].t - lastMoving > LULL_MS) break;
    samples++;
    net += contrib;
    if (Math.abs(contrib) >= MOVING_DEG) lastMoving = trail[k].t;
  }
  return { net, samples };
}

// Turn a sensor classification back into the move you actually made.
// Measured on hardware: a WIDE reports the OPPOSITE face (u -> the cube reports D, r -> L, f -> B),
// because what the sensors see is the far layer turning against a core that came along for the ride.
const OPPOSITE_FACE: Record<string, string> = { U: "D", D: "U", R: "L", L: "R", F: "B", B: "F" };
const SLICE_FROM_PAIR: Record<string, string> = Object.entries(SLICE_PAIR)
  .reduce((acc, [tok, [a, b]]) => { acc[`${a} ${b}`] = tok; return acc; }, {} as Record<string, string>);
// If the reading is UNKNOWN we must still record SOMETHING: dropping the move would leave the model
// one turn behind the real cube forever after. The layer turn definitely happened — only the core
// reading was unclear — so fall back to the plain face.
function labFaceFallback(mv: LabMove, coreMap?: Record<string, string>): string {
  return mv.moves
    .map(remapPhysicalMove)
    .map((m) => (coreMap ? (coreMap[m[0]] ?? m[0]) + m.slice(1) : m))
    .join(" ");
}
function labToken(mv: LabMove, coreMap?: Record<string, string>): string {
  // The cube reports faces relative to its core, which our model already tracks — so map into the
  // grip frame first, exactly as the main pipeline does, before naming the move.
  const disp = mv.moves
    .map(remapPhysicalMove)
    .map((m) => (coreMap ? (coreMap[m[0]] ?? m[0]) + m.slice(1) : m));
  if (mv.kind === "UNKNOWN") return "?";
  if (mv.kind === "SLICE") return SLICE_FROM_PAIR[disp.join(" ")] ?? "?";
  if (mv.kind === "WIDE") {
    const base = disp[0][0], suffix = disp[0].slice(1);
    return (OPPOSITE_FACE[base] ?? base).toLowerCase() + suffix;
  }
  return disp.join(" "); // FACE, or a "2 FACES" pair that only looked like a slice
}

function classifyLab(hist: LabEvent[], trail: Trail): LabMove[] {
  const out: LabMove[] = [];
  // First pass: cut the event stream into physical moves. One event = one move, EXCEPT a slice,
  // which the cube can only report as its two neighbouring faces turning opposite ways (it has no
  // sensor on the middle layer). Two same-face events are always two moves, never one.
  const groups: LabEvent[][] = [];
  let i = 0;
  while (i < hist.length) {
    if (i + 1 < hist.length && isSlicePair(hist[i].move, hist[i + 1].move) && hist[i + 1].t - hist[i].t <= SLICE_WINDOW_MS) {
      groups.push([hist[i], hist[i + 1]]);
      i += 2;
    } else {
      groups.push([hist[i]]);
      i += 1;
    }
  }

  for (let g = 0; g < groups.length; g++) {
    const grp = groups[g];
    const first = grp[0], last = grp[grp.length - 1];
    const prev = g > 0 ? groups[g - 1][groups[g - 1].length - 1] : null;
    const next = g + 1 < groups.length ? groups[g + 1][0] : null;
    const tA = Math.max(first.t - WIN_PRE, prev ? prev.t + EDGE_GUARD : -Infinity);
    const tB = Math.min(last.t + WIN_POST, next ? next.t + EDGE_GUARD : Infinity);
    const axis = FACE_AXIS[first.move[0]] ?? [0, 0, 0];
    const meas = netAbout(trail, tA, tB, axis);
    const net = Math.abs(meas.net);
    // Diagnostics: how much room the window actually had, and how much gyro data landed in it.
    const wantedB = last.t + WIN_POST;
    const clipped = tB < wantedB - 1;

    const paired = grp.length === 2;
    const observed = tB - tA >= MIN_WIN_MS && meas.samples >= MIN_SAMPLES;
    let kind: string;
    if (net <= TOL_STILL) kind = paired ? "2 FACES" : "FACE";       // core stayed -> plain face(s)
    else if (Math.abs(net - 90) <= TOL_TURN && observed) kind = paired ? "SLICE" : "WIDE";
    else kind = "UNKNOWN";                                          // no clean reading — say so

    out.push({
      moves: grp.map((h) => h.move),
      angle: net, align: 1, kind,
      span: last.t - first.t,
      facelets: last.facelets,
      tEnd: last.t,
      win: Math.round(tB - tA),
      samples: meas.samples,
      gapPrev: prev ? first.t - prev.t : -1,
      gapNext: next ? next.t - last.t : -1,
      clipped,
    });
  }
  return out;
}

// How many of the 54 stickers differ between two facelet strings.
function faceletDiff(a: string | null, b: string | null): number {
  if (!a || !b || a.length !== b.length) return -1;
  let n = 0;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) n++;
  return n;
}
function lookAlikeFace(tok: string): string {
  const w = /^([rludfb])(['2]?)$/.exec(tok);
  if (w) return WIDE_LOOK[w[1]] + w[2];
  return tok; // plain faces (and slices) report as themselves
}
// Split an algorithm string into ATOMIC tokens, keeping wides/rotations/slices intact and
// normalising "2'"→"2". No simulation, no expansion into R M'.
function atomicTokens(algStr: string): string[] {
  return algStr
    .replace(/\(([^)]*)\)\s*(\d+)/g, (_m, g: string, n: string) => Array(+n).fill(g.trim()).join(" "))
    .replace(/[()]/g, " ")
    .trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/2'$/, "2"));
}
// The physical turns an algorithm expects, one per quarter-turn the cube will report. Each
// entry says the token to RECORD (`rec`, atomic) and the face it will be REPORTED as (`look`).
// Doubles expand into two quarters; whole-cube rotations are flagged (they produce no turn —
// the guidance moves the F pulse and the solver reorients).
function expectedPhysical(algStr: string): { rec: string; look: string; rot?: boolean }[] {
  const out: { rec: string; look: string; rot?: boolean }[] = [];
  for (const t of atomicTokens(algStr)) {
    if (/^[xyz]/.test(t)) { out.push({ rec: t, look: "", rot: true }); continue; }
    if (t.endsWith("2")) {
      const base = t.slice(0, -1);
      out.push({ rec: base, look: lookAlikeFace(base) });
      out.push({ rec: base, look: lookAlikeFace(base) });
    } else {
      out.push({ rec: t, look: lookAlikeFace(t) });
    }
  }
  return out;
}
// The current orientation of the cube's CORE, read straight off the model's centres (which
// rotate natively when we record a real wide/rotation). Maps each committed face letter to the
// face its centre now points at — exactly what a reported face must be corrected THROUGH to get
// the grip-frame move: gripFace = coreFaceMap[reportedFace].
const _CTR_COLOR_FACE: Record<string, string> = {
  [COLORS.U]: "U", [COLORS.D]: "D", [COLORS.F]: "F", [COLORS.B]: "B", [COLORS.R]: "R", [COLORS.L]: "L",
};
function coreFaceMap(m: CubeModel): Record<string, string> {
  const dirFace = (v: THREE.Vector3): string => {
    const ax: [string, number][] = [["R", v.x], ["L", -v.x], ["U", v.y], ["D", -v.y], ["F", v.z], ["B", -v.z]];
    ax.sort((a, b) => b[1] - a[1]);
    return ax[0][0];
  };
  const map: Record<string, string> = { U: "U", D: "D", F: "F", B: "B", R: "R", L: "L" };
  for (const c of m.cubies) {
    let idx = -1, seen = 0;
    for (let i = 0; i < 6; i++) if (c.colors[i] !== COLORS.inner) { idx = i; seen++; }
    if (seen !== 1) continue;
    const f = _CTR_COLOR_FACE[c.colors[idx]];
    if (!f) continue;
    map[f] = dirFace(new THREE.Vector3(..._FN[idx]).applyQuaternion(c.quat));
  }
  return map;
}

// Fold whole-cube rotations (x/y/z) into absolute moves. A physical/virtual turn
// is always reported absolutely (green face = F, etc.), so we match against these.
// Rotations are absorbed: "y R U R'" executes as the absolute faces you'd actually
// turn, and the rotation auto-completes when the next move arrives. Works for
// slice moves (M/E/S) too, via conjugation.
const _FN: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
function _sig(m: CubeModel): string {
  const o: string[] = [];
  for (const c of m.cubies)
    for (let i = 0; i < 6; i++) {
      if (c.colors[i] === COLORS.inner) continue;
      const d = new THREE.Vector3(..._FN[i]).applyQuaternion(c.quat);
      o.push(`${Math.round(c.pos.x)},${Math.round(c.pos.y)},${Math.round(c.pos.z)}:${Math.round(d.x)},${Math.round(d.y)},${Math.round(d.z)}:${c.colors[i]}`);
    }
  return o.sort().join("|");
}
const _BASE = [
  "R", "R'", "R2", "L", "L'", "L2", "U", "U'", "U2", "D", "D'", "D2",
  "F", "F'", "F2", "B", "B'", "B2", "M", "M'", "M2", "E", "E'", "E2", "S", "S'", "S2",
];
let _BASESIG: Map<string, string> | null = null;
const isRotationToken = (t: string) => /^[xyz]/.test(t);
// A physical cube can only report face turns, not slices. Each slice equals two
// face turns plus a whole-cube rotation (which is absorbed like a y). Expanding
// them lets the physical cube execute algorithms that contain M/E/S (and the wide
// moves that tokenize into them).
// E/S slices have no physical tracker yet, so translate them to faces. The M
// family IS tracked on the physical cube, so keep it as slices (M2 = two M's) and
// let the guidance arrow show a slice turn.
const SLICE_EXPAND: Record<string, string[]> = {
  M2: ["M", "M"], "M2'": ["M", "M"],
  E: ["U", "D'", "y'"], "E'": ["U'", "D", "y"], E2: ["U2", "D2", "y2"],
  S: ["F'", "B", "z"], "S'": ["F", "B'", "z'"], S2: ["F2", "B2", "z2"],
};
function expandSlices(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) out.push(...(SLICE_EXPAND[t] ?? [t]));
  return out;
}

const _invRot = (r: string[]) =>
  [...r].reverse().map((t) => (t.endsWith("2") ? t : t.endsWith("'") ? t[0] : t + "'"));

// ---- Model repair -----------------------------------------------------------------------------
// Your cube is never "wrong" — it is a physical object in a valid state, and it reports every
// sticker. What breaks is the PROGRAM's belief about it (a misread move, a dropped one). So when the
// two disagree, the thing to fix is the model, not you: find the short sequence of moves that
// explains the difference, apply it internally, and let the solve carry on. Restarting from the
// white cross when you are sitting at OLL would be absurd.
const REPAIR_TOKENS = (() => {
  const bases = ["U", "D", "R", "L", "F", "B", "u", "d", "r", "l", "f", "b", "M", "E", "S"];
  const out: string[] = [];
  for (const b of bases) { out.push(b, b + "'"); }
  return out;
})();
// The core's orientation, from the model alone (same idea the renderer uses to bring the cube's
// core-frame facelets into your grip frame).
function coreQuatOf(m: CubeModel): THREE.Quaternion {
  const dirOf = (color: string) => {
    for (const c of m.cubies) {
      if (c.colors.filter((x) => x !== COLORS.inner).length !== 1) continue;
      for (let i = 0; i < 6; i++) if (c.colors[i] === color) return new THREE.Vector3(..._FN[i]).applyQuaternion(c.quat);
    }
    return new THREE.Vector3();
  };
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(dirOf(COLORS.R), dirOf(COLORS.U), dirOf(COLORS.F))
  );
}
// A signature of the cube as it appears in a given frame: every sticker, at every position.
function stateKey(m: CubeModel, rot?: THREE.Quaternion): string {
  const parts: string[] = [];
  for (const c of m.cubies) {
    const p = c.pos.clone();
    if (rot) p.applyQuaternion(rot);
    const cell: string[] = [];
    for (let i = 0; i < 6; i++) {
      if (c.colors[i] === COLORS.inner) continue;
      const n = new THREE.Vector3(..._FN[i]).applyQuaternion(c.quat);
      if (rot) n.applyQuaternion(rot);
      cell.push(`${Math.round(n.x)}${Math.round(n.y)}${Math.round(n.z)}:${c.colors[i]}`);
    }
    parts.push(`${Math.round(p.x)}${Math.round(p.y)}${Math.round(p.z)}|${cell.sort().join(",")}`);
  }
  return parts.sort().join(";");
}
// Search for up to `maxDepth` moves that reconcile our model with what the cube reports.
function findRepair(moves: string[], facelets: string, maxDepth = 3): string[] | null {
  const truthCore = faceletsToModel(facelets);
  const matches = (seq: string[]): boolean => {
    const m = buildFrom([...moves, ...seq]);
    return stateKey(m) === stateKey(truthCore, coreQuatOf(m));
  };
  if (matches([])) return [];
  const walk = (seq: string[], depth: number): string[] | null => {
    if (depth === 0) return null;
    for (const t of REPAIR_TOKENS) {
      const next = [...seq, t];
      if (matches(next)) return next;
    }
    for (const t of REPAIR_TOKENS) {
      const found = walk([...seq, t], depth - 1);
      if (found) return found;
    }
    return null;
  };
  return walk([], maxDepth);
}


// ---- Recognition cues --------------------------------------------------------------------------
// The cue you would use if the app were not here: "headlights on the left", "the L sits in the
// back-left". These are READ OFF THE CUBE, after the alignment the app worked out — not recited from
// a list. That matters: a cue only means anything next to the algorithm it belongs with, and an
// invented one would teach you a habit that does not fit the algorithms you are actually learning.
const SIDES: { name: string; dir: [number, number, number] }[] = [
  { name: "front", dir: [0, 0, 1] },
  { name: "right", dir: [1, 0, 0] },
  { name: "back", dir: [0, 0, -1] },
  { name: "left", dir: [-1, 0, 0] },
];
function stickerFacing(c: Cubie, dir: [number, number, number]): string | null {
  for (let i = 0; i < 6; i++) {
    if (c.colors[i] === COLORS.inner) continue;
    const n = new THREE.Vector3(..._FN[i]).applyQuaternion(c.quat);
    if (Math.round(n.x) === dir[0] && Math.round(n.y) === dir[1] && Math.round(n.z) === dir[2]) return c.colors[i];
  }
  return null;
}
function centreColour(m: CubeModel, dir: [number, number, number]): string | null {
  for (const c of m.cubies) {
    if (c.colors.filter((x) => x !== COLORS.inner).length !== 1) continue;
    if (Math.round(c.pos.x) === dir[0] && Math.round(c.pos.y) === dir[1] && Math.round(c.pos.z) === dir[2]) {
      return stickerFacing(c, dir);
    }
  }
  return null;
}
// What a coach would say if they were watching you stare at the cube: where the two pieces are, and
// what that means for what you are about to do. Someone coming from the beginner method knows how to
// solve a cube — what they have not built yet is the EYE for an F2L case.
function f2lCue(m: CubeModel, pair: string): string | null {
  const sides = SIDE_COLORS[pair as keyof typeof SIDE_COLORS];
  if (!sides) return null;
  const cornerSet = [WHITE, ...sides].slice().sort().join("|");
  const edgeSet = [...sides].slice().sort().join("|");
  const setOf = (c: Cubie) => c.colors.filter((x) => x !== COLORS.inner).slice().sort().join("|");
  const corner = m.cubies.find((c) => setOf(c) === cornerSet);
  const edge = m.cubies.find((c) => setOf(c) === edgeSet);
  if (!corner || !edge) return null;

  const cornerUp = Math.round(corner.pos.y) === 1;
  const edgeUp = Math.round(edge.pos.y) === 1;
  const whiteUp = stickerFacing(corner, [0, 1, 0]) === WHITE;

  if (!cornerUp && !edgeUp) return "both pieces are down in slots \u2014 one has to come out before you can pair them";
  if (!cornerUp) return "the corner is stuck in a slot \u2014 lever it out, then pair up on top";
  if (!edgeUp) return "the edge is stuck in a slot \u2014 lever it out, then pair up on top";
  if (whiteUp) return "both on top, white facing UP \u2014 the awkward one: separate them before inserting";
  return "both on top, white on the side \u2014 the friendly case: join them, then insert";
}

function recognitionCue(m: CubeModel, phase: string, kind?: string): string | null {
  const top = m.cubies.filter((c) => Math.round(c.pos.y) === 1);
  const yellow = COLORS.U;

  if (phase === "O" && kind !== "corner") {
    // Yellow cross: which edges already point up, and where they sit.
    const lit = SIDES.filter((s) =>
      top.some(
        (c) =>
          c.colors.filter((x) => x !== COLORS.inner).length === 2 &&
          Math.round(c.pos.x) === s.dir[0] && Math.round(c.pos.z) === s.dir[2] &&
          stickerFacing(c, [0, 1, 0]) === yellow
      )
    );
    if (lit.length === 0) return "dot \u2014 no edge is up yet; any angle works";
    if (lit.length === 4) return "the cross is already there";
    if (lit.length === 2) {
      const [a, b] = lit;
      const opposite = a.dir[0] === -b.dir[0] && a.dir[2] === -b.dir[2];
      return opposite
        ? `line \u2014 it runs ${a.name}\u2013${b.name}`
        : `L-shape \u2014 it sits in the ${a.name}-${b.name} corner`;
    }
    return null;
  }

  if (phase === "O" && kind === "corner") {
    const up = top.filter(
      (c) => c.colors.filter((x) => x !== COLORS.inner).length === 3 && stickerFacing(c, [0, 1, 0]) === yellow
    );
    if (up.length === 0) return "no corner is up yet";
    if (up.length === 4) return "the corners are already oriented";
    const where = up
      .map((c) => {
        const ns = Math.round(c.pos.z) === 1 ? "front" : "back";
        const ew = Math.round(c.pos.x) === 1 ? "right" : "left";
        return `${ns}-${ew}`;
      })
      .join(" and ");
    return `${up.length} corner${up.length > 1 ? "s" : ""} already up \u2014 ${where}`;
  }

  if (phase === "P" && kind === "corner") {
    // Headlights: a side showing the same colour on both of its top corners.
    for (const s of SIDES) {
      const corners = top.filter(
        (c) =>
          c.colors.filter((x) => x !== COLORS.inner).length === 3 &&
          (s.dir[0] !== 0 ? Math.round(c.pos.x) === s.dir[0] : Math.round(c.pos.z) === s.dir[2])
      );
      if (corners.length !== 2) continue;
      const a = stickerFacing(corners[0], s.dir);
      const b = stickerFacing(corners[1], s.dir);
      if (a && a === b) return `headlights on the ${s.name}`;
    }
    return "no headlights \u2014 the corners swap diagonally";
  }

  if (phase === "P" && kind !== "corner") {
    // The side whose top edge already matches its centre.
    for (const s of SIDES) {
      const edge = top.find(
        (c) =>
          c.colors.filter((x) => x !== COLORS.inner).length === 2 &&
          Math.round(c.pos.x) === s.dir[0] && Math.round(c.pos.z) === s.dir[2]
      );
      if (!edge) continue;
      if (stickerFacing(edge, s.dir) === centreColour(m, s.dir)) return `the finished side is at the ${s.name}`;
    }
    return "no side is finished yet";
  }
  return null;
}

// The order of an algorithm: how many repetitions return the cube to solved. Returns -1
// if larger than the cap (those algorithms get an undo path instead of repetition).
function algOrder(str: string): number {
  const expanded = str.replace(/\(([^)]*)\)\s*(\d+)/g, (_m, g: string, n: string) => Array(+n).fill(g.trim()).join(" ")).replace(/[()]/g, " ");
  const toks = atomicTokens(expanded);
  if (!toks.length) return 1;
  const solved = _sig(buildSolved([]));
  const seq: string[] = [];
  for (let n = 1; n <= 24; n++) {
    seq.push(...toks);
    if (_sig(buildSolved(seq)) === solved) return n;
  }
  return -1;
}
// Collapse adjacent turns of the same face (e.g. F F' → nothing, R R2 → R'),
// which removes the redundant pairs that slice/wide expansion can introduce.
function simplifyFaces(moves: string[]): string[] {
  const st: { face: string; amt: number }[] = [];
  for (const m of moves) {
    const face = m[0];
    const amt = m.endsWith("2") ? 2 : m.endsWith("'") ? 3 : 1;
    const top = st[st.length - 1];
    if (top && top.face === face) {
      const t = (top.amt + amt) % 4;
      st.pop();
      if (t !== 0) st.push({ face, amt: t });
    } else st.push({ face, amt });
  }
  return st.map(({ face, amt }) => face + (amt === 2 ? "2" : amt === 3 ? "'" : ""));
}
// Invert a single atomic token (U→U', U'→U, U2→U2; wides/rotations too since suffix logic is the same).
function _invTok(t: string): string { return t.endsWith("2") ? t : t.endsWith("'") ? t.slice(0, -1) : t + "'"; }
// Walk the moves you've actually done against the expected algorithm, keeping a stack of
// deviations. On-algorithm moves advance and are "alg" (white). Any move that isn't the next
// expected one gets PUSHED on the deviation stack and is "dev" (red). A move that is the inverse
// of the top of the stack POPS it and is "fix" (green) — so N mistakes are undone in reverse
// order, one by one, back to the point where you left the algorithm, then it continues.
// Guidance (`next`) is: while the stack is non-empty, undo its top; otherwise the next alg move.
// A wide move can legitimately be executed as its two layers: f IS F + S. Turning them separately
// puts the cube in exactly the same place — so it must count as having done the wide, not as a
// mistake. Without this, someone turning the outer face and the slice one at a time (which is all a
// mouse drag or the letter keys can produce) gets told to undo a move that was perfectly correct,
// and there is no way out of the loop except to find the wide button.
const WIDE_PARTS: Record<string, [string, string]> = {
  r: ["R", "M'"], "r'": ["R'", "M"],
  l: ["L", "M"], "l'": ["L'", "M'"],
  u: ["U", "E'"], "u'": ["U'", "E"],
  d: ["D", "E"], "d'": ["D'", "E'"],
  f: ["F", "S"], "f'": ["F'", "S'"],
  b: ["B", "S'"], "b'": ["B'", "S"],
};
function classifyDone(done: string[], expected: string[]): {
  cls: ("alg" | "dev" | "fix")[]; next: string | null; correcting: boolean; progress: number;
} {
  const cls: ("alg" | "dev" | "fix")[] = [];
  const stack: string[] = [];
  let prog = 0;
  let half: string | null = null; // the first half of a wide, executed on its own
  for (let i = 0; i < done.length; i++) {
    const m = done[i];
    // Mid-wide: the other half completes it.
    if (half && stack.length === 0) {
      const parts = WIDE_PARTS[expected[prog]];
      if (parts && m === parts.find((p) => p !== half)) {
        cls.push("alg"); prog++; half = null; continue;
      }
      // Not the completion — the half-move was a deviation after all.
      cls[cls.length - 1] = "dev";
      stack.push(half);
      half = null;
    }
    if (stack.length > 0) {
      if (m === _invTok(stack[stack.length - 1])) { cls.push("fix"); stack.pop(); }
      else { cls.push("dev"); stack.push(m); }
    } else if (prog < expected.length && m === expected[prog]) {
      cls.push("alg"); prog++;
    } else if (prog < expected.length && WIDE_PARTS[expected[prog]]?.includes(m)) {
      // Half of the wide we are waiting for: accept it and wait for the other half.
      cls.push("alg"); half = m;
    } else {
      cls.push("dev"); stack.push(m);
    }
  }
  const correcting = stack.length > 0;
  let next: string | null;
  if (correcting) next = _invTok(stack[stack.length - 1]);
  else if (half) {
    const parts = WIDE_PARTS[expected[prog]];
    next = parts ? (parts.find((p) => p !== half) ?? null) : null; // finish the wide
  } else next = expected[prog] ?? null;
  return { cls, next, correcting, progress: prog };
}
// Like classifyDone but for the history: also returns splitIdx = the move index at which the AUF
// (alignment) is finished (algorithm progress reached aufEnd with an empty deviation stack), so a
// completed phase can be shown as a separate "AUF" row followed by the algorithm row.
// The history is coloured by the SAME rules as the live guidance — including the wide-in-two-halves
// acceptance. They drifted apart once (guidance accepted F + S as f while the history still painted
// it red), which is worse than either being wrong on its own: the app was telling you two different
// stories about the same moves.
// Where does the official algorithm begin inside a planned sequence? Not "after the leading U
// turns" — that greedy guess swallows the algorithm's OWN first move when it happens to be a U, and
// then the history claims an alignment of three U turns (impossible: an AUF is at most a half turn).
// The algorithm is in there verbatim (we never alter it), so simply FIND it. Everything before it is
// the reorientation and the alignment; everything from it on is the algorithm you are learning.
function algStartIn(expected: string[], algStr: string): number {
  if (!algStr) return 0;
  let algAtomic: string[];
  try { algAtomic = expectedPhysical(algStr.replace(/[()]/g, " ")).map((e) => e.rec); } catch { return 0; }
  if (!algAtomic.length) return 0;
  for (let i = 0; i + algAtomic.length <= expected.length; i++) {
    let hit = true;
    for (let k = 0; k < algAtomic.length; k++) {
      if (expected[i + k] !== algAtomic[k]) { hit = false; break; }
    }
    if (hit) return i;
  }
  return 0;
}

function classifyPhase(done: string[], expected: string[], aufEnd: number): {
  cls: ("alg" | "dev" | "fix")[]; splitIdx: number;
} {
  const cls: ("alg" | "dev" | "fix")[] = [];
  const stack: string[] = [];
  let prog = 0;
  let half: string | null = null;
  let splitIdx = aufEnd > 0 ? done.length : 0;
  for (let i = 0; i < done.length; i++) {
    const m = done[i];
    if (half && stack.length === 0) {
      const parts = WIDE_PARTS[expected[prog]];
      if (parts && m === parts.find((p) => p !== half)) {
        cls.push("alg"); prog++; half = null;
        if (aufEnd > 0 && splitIdx === done.length && prog >= aufEnd && stack.length === 0) splitIdx = i + 1;
        continue;
      }
      cls[cls.length - 1] = "dev";
      stack.push(half);
      half = null;
    }
    if (stack.length > 0) {
      if (m === _invTok(stack[stack.length - 1])) { cls.push("fix"); stack.pop(); }
      else { cls.push("dev"); stack.push(m); }
    } else if (prog < expected.length && m === expected[prog]) {
      cls.push("alg"); prog++;
    } else if (prog < expected.length && WIDE_PARTS[expected[prog]]?.includes(m)) {
      cls.push("alg"); half = m;
    } else {
      cls.push("dev"); stack.push(m);
    }
    if (aufEnd > 0 && splitIdx === done.length && prog >= aufEnd && stack.length === 0 && !half) splitIdx = i + 1;
  }
  return { cls, splitIdx };
}
function absolutize(rawTokens: string[]): { exec: string[]; execIdx: number[] } {
  if (!_BASESIG) {
    _BASESIG = new Map();
    for (const b of _BASE) _BASESIG.set(_sig(buildSolved([b])), b);
  }
  const tokens = expandSlices(rawTokens);
  const rot: string[] = [];
  const exec: string[] = [];
  const execIdx: number[] = [];
  tokens.forEach((t, i) => {
    if (isRotationToken(t)) { rot.push(t); return; }
    if (rot.length === 0) { exec.push(t); execIdx.push(i); return; }
    const target = _sig(buildSolved([...rot, t, ..._invRot(rot)]));
    exec.push(_BASESIG!.get(target) ?? t);
    execIdx.push(i);
  });
  // The physical cube reports a 180° turn as two quarter turns, and a single "R2"
  // arrow flips direction confusingly. Expand doubles into two identical quarter
  // turns (same direction) so the arrow is consistent and each quarter matches.
  const simplified = simplifyFaces(exec);
  const quarters: string[] = [];
  for (const m of simplified) {
    if (m.endsWith("2")) { quarters.push(m[0], m[0]); }
    else quarters.push(m);
  }
  return { exec: quarters, execIdx };
}

const _COLNAME: Record<string, string> = {
  [COLORS.U]: "Y", [COLORS.D]: "W", [COLORS.F]: "G", [COLORS.B]: "Bl", [COLORS.R]: "O", [COLORS.L]: "R",
};
function centerColorAt(model: CubeModel, p: [number, number, number]): string {
  const c = model.cubies.find(
    (cu) => Math.round(cu.pos.x) === p[0] && Math.round(cu.pos.y) === p[1] && Math.round(cu.pos.z) === p[2]
  );
  if (!c) return "?";
  const col = c.colors.find((x) => x !== COLORS.inner);
  return _COLNAME[col ?? ""] ?? "?";
}

// The J Perm reference sheets are not part of the public repo (see README > Credits).
// When an image is missing, hide it instead of showing a broken-image icon.
const hideMissingImage = (e: React.SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.style.display = "none";
};

const CAT_INFO: Record<string, { file: string; title: string }> = {
  "1A-up": { file: "section1a_White Sticker Faces Up.png", title: "1A \u00b7 White sticker faces up" },
  "1A-diff": { file: "section1a_White Sticker Faces Side Front different.png", title: "1A \u00b7 White on side/front \u2014 top colours differ" },
  "1A-same": { file: "section1a_White Sticker Faces Side Front same.png", title: "1A \u00b7 White on side/front \u2014 top colours match" },
  "1B-edge": { file: "section1b_Edge in the slot.png", title: "1B \u00b7 Edge already in the slot" },
  "1B-corner": { file: "section1b_Corner in the slot.png", title: "1B \u00b7 Corner already in the slot" },
  "1C": { file: "section1c_Both pieces are in the correct slot.png", title: "1C \u00b7 Both pieces in the slot" },
};

export default function App() {
  const cube = useVirtualCube();
  // Two ways to use this app, and they want different tools:
  //   virtual — no smart cube (a plain cube, or yours is charging): moves come from the buttons.
  //   cube    — a Bluetooth cube: moves come from your hands, so on-screen move buttons would only
  //             desync the model from the thing you are holding. They are hidden.
  const [mode, setMode] = useState<"choose" | "virtual" | "cube">("choose");
  // The experiments (sensor classification, wide lab, gyro measure) are hidden, not deleted — they
  // are a day's work and the angular-velocity idea is still untried. Add ?dev to the URL for them.
  const DEV = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("dev");

  const phys = useCube();
  // Gyro calibration: Q = calib * converted, so at calibration the cube shows
  // identity. Captured on first gyro reading and re-settable by the user.
  const calibRef = useRef<THREE.Quaternion | null>(null);
  const calibrateGyro = () => {
    const o = phys.orientation.current;
    if (o) calibRef.current = orientationToQuaternion(o).invert();
  };
  useEffect(() => {
    if (phys.hasGyro && !calibRef.current) calibrateGyro();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phys.hasGyro]);
  // Mirror physical-cube moves. Slices move the centers (which the cube reports
  // moves relative to), so we track an accumulated center rotation and undo it on
  // each following face move. Slices arrive as a pair of opposite-face quarters
  // (M = R L', M' = L R'); we buffer one move to spot the pair.
  const physConsumed = useRef(0);
  // Slice pairing: a slice arrives as two face events in separate batches, so buffer the first
  // across effect runs. Armed only when the algorithm expects a slice (deterministic).
  const sliceBuf = useRef<{ second: string; slice: string; firstGrip: string } | null>(null);
  const sliceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Test bench only: the physical turns the current sequence expects (atomic token to record +
  // the look-alike face it's reported as) and where in cube.moves the sequence starts. Set
  // during render, read in the move effect to disambiguate wides via the algorithm.
  const expectedPhysRef = useRef<string[] | null>(null); // atomic expected alg tokens (quarters)
  const guideStartRef = useRef(0);
  // Per-phase expected algorithm + AUF bounds (keyed by the phase's start index in cube.moves),
  // so the history can colour mistakes and split the AUF on EVERY phase, not just the current one.
  // Everything the history needs to know about a planned step, recorded AT THE MOMENT it is planned.
// The history used to be reconstructed from the cube's state ("when did the pair become solved?")
// and then matched up against these keys — two sources that could never line up exactly, so moves
// fell through the cracks and landed in whatever row happened to be adjacent (a whole T-perm once
// showed up labelled "AUF · align"). Recording the truth once, here, removes the guesswork entirely.
type PhaseInfo = {
  expecteds: string[][];
  algStrings?: string[]; // the official J Perm text — lets us find exactly where the algorithm starts
  phase: string;
  extract?: boolean;
  pair?: string;
  ollKind?: "edge" | "corner" | "dot";
  pllKind?: "corner" | "edge" | "auf";
};
const phaseInfoRef = useRef<Map<number, PhaseInfo>>(new Map());
  const [dbgLog, setDbgLog] = useState<string[]>([]);
  const showDebug = true; // the console stays on while we are building — no toggle needed
  // FRONTEND ONLY: when on, the gyro orients the on-screen cube to mirror how you hold it. Off by
  // default (fixed grip-frame view). Purely visual — the backend is identical either way.
  const [gyroView, setGyroView] = useState(false);
  const [showMeasure, setShowMeasure] = useState(false); // gyro measurement tool (wide-vs-face study)
  const [showWideLab, setShowWideLab] = useState(false); // isolated wide-vs-face classification lab
  const [showSensorBench, setShowSensorBench] = useState(false); // reads moves from sensors alone
  const sensorPushed = useRef(0); // lab moves already fed to the model in sensor mode
  const [sensorLog, setSensorLog] = useState<
    { tok: string; kind: string; net: number; gap: number; win: number; samples: number; lag: number; guessed: boolean }[]
  >([]);
  const dbg = (s: string) => setDbgLog((l) => [...l, s].slice(-10));
  const [virtualBase, setVirtualBase] = useState(0);
  const clearAll = () => { phys.clearHistory(); setVirtualBase(cube.moves.length); setDbgLog([]); };
  // Hard reset: the cube is solved at reference (green front, yellow up). Clears the
  // virtual cube, the physical stream, all slice/center tracking, guidance, and
  // re-baselines the gyro. Always available, even mid-solve.
  const testMode = useRef(false); // Test bench: guidance is pinned to a chosen algorithm
  const testReps = useRef<{ mode: "repeat" | "undo"; done: number; total: number; phase: "F" | "O" | "P"; undone: boolean }>({ mode: "repeat", done: 0, total: 1, phase: "P", undone: false });
  const hardReset = () => {
    cube.reset();
    testMode.current = false;
    setTestInfo(null);
    setTestSegs([]);
    phys.clearHistory();
    physConsumed.current = 0;
    setVirtualBase(0);
    setDbgLog([]);
    setGuiding(false);
    setSeq(null);
    setGuideStart(null);
    phaseInfoRef.current.clear();
    sensorPushed.current = 0;
    setSensorLog([]);
    setCompletedPairs(new Set());
    setPainting(false);
    setPaintMsg(null);
    setCell(null);
    setPath(null);
    setCubeKey((k) => k + 1); // remount so the cube snaps to solved
    if (phys.hasGyro) setTimeout(calibrateGyro, 60); // re-baseline gyro to reference
    phys.resetCubeState(); // tell the cube it's solved now, so facelets re-sync to reality
    setCubeBeliefValid(true);
  };
  // Test bench: reset to solved, then pin the guidance to a chosen algorithm so you can
  // watch the pulse / arrows / HUD for exactly that case (starting from green front).
  const startTest = (phase: "F" | "O" | "P", str: string, label: string) => {
    hardReset();
    setTimeout(() => {
      testMode.current = true;
      const order = algOrder(str);
      if (order >= 1 && order <= 6) {
        testReps.current = { mode: "repeat", done: 0, total: order, phase, undone: false };
      } else {
        testReps.current = { mode: "undo", done: 0, total: 1, phase, undone: false };
      }
      setTestInfo({ label, str });
      setTestSegs([{ kind: "rep", n: 1, start: 0 }]);
      setGuideStart(0);
      setGuiding(true);
      setSeq({ phase, variants: [atomicTokens(str)], algStrings: [str], start: 0 });
    }, 90);
  };
  useEffect(() => {
    if (phys.status !== "connected") { physConsumed.current = phys.moveHistory.length; return; }
    if (physConsumed.current > phys.moveHistory.length) physConsumed.current = 0;
    const fresh = phys.moveHistory.slice(physConsumed.current);
    physConsumed.current = phys.moveHistory.length;

    // FENCED: in free play with Sensor Bench on, the model is driven by the SENSOR reading instead
    // (see the effect below). The gyro needs ~400ms to reveal whether that was U or u, so the model
    // is fed a little later — deliberately, and only here. Guide solve and test bench are untouched.
    if (sensorModeRef.current) return;

    const exp = expectedPhysRef.current; // atomic expected sequence (test bench) or null
    const start = guideStartRef.current;
    // Track pushes locally: React state (cube.moves) doesn't update mid-effect, so build the
    // model from cube.moves + what we've pushed this pass.
    const pushed: string[] = [];
    const allMoves = () => (pushed.length ? [...cube.moves, ...pushed] : cube.moves);
    const push = (tok: string) => { cube.push(tok); pushed.push(tok); };

    // Flatten the raw reports to quarter turns (a reported "2" is two quarters).
    const events: string[] = [];
    for (const raw of fresh) {
      const b = remapPhysicalMove(raw);
      if (b.endsWith("2")) { events.push(b[0], b[0]); } else events.push(b);
    }

    for (const base of events) {
      // Correct the reported face into the GRIP frame using the core orientation read straight
      // off the model's centres — which rotate natively when we record real wides/rotations,
      // so there's no separate compensation to drift out of sync.
      const coreMap = coreFaceMap(buildFrom(allMoves()));
      const gripFace = (coreMap[base[0]] ?? base[0]) + base.slice(1);

      // A slice's first face is buffered across batches: does this event complete the pair?
      if (sliceBuf.current) {
        const buf = sliceBuf.current;
        if (sliceTimer.current) { clearTimeout(sliceTimer.current); sliceTimer.current = null; }
        sliceBuf.current = null;
        if (gripFace === buf.second) { dbg(`slice \u2192 ${buf.slice}`); push(buf.slice); continue; }
        push(buf.firstGrip); // pair broken: the buffered face was a real move; record it, handle this below
      }

      if (exp) {
        const done = allMoves().slice(start);
        const next = classifyDone(done, exp).next;
        // If the expected next move is a SLICE and this is its first face, buffer it and wait for
        // the second (arrives ~6ms later in the next batch). Deterministic — only when expected.
        const pair = next ? SLICE_PAIR[next] : undefined;
        if (pair && gripFace === pair[0]) {
          sliceBuf.current = { second: pair[1], slice: next!, firstGrip: gripFace };
          if (sliceTimer.current) clearTimeout(sliceTimer.current);
          sliceTimer.current = setTimeout(() => {
            if (sliceBuf.current) { cube.push(sliceBuf.current.firstGrip); sliceBuf.current = null; }
          }, 200);
          continue;
        }
        // Disambiguate wides against the move that's actually expected NEXT, taking your
        // deviation stack into account (a correction, or the next algorithm move) — NOT the raw
        // position. If your turn matches that expected move's look-alike face, record the atomic
        // token (r, not L; f' not B'). Otherwise it's a deviation — record the plain grip face.
        if (next && gripFace === lookAlikeFace(next)) { dbg(`in ${gripFace} \u2192 ${next}`); push(next); }
        else { dbg(`in ${gripFace} (deviation)`); push(gripFace); }
      } else {
        // Outside test bench there's no algorithm to disambiguate wides; record the grip face.
        dbg(`in ${gripFace}`);
        push(gripFace);
      }
    }
  }, [phys.moveHistory, phys.status, cube]);

  const [cell, setCell] = useState<Cell | null>(null);
  const [path, setPath] = useState<TraceStep[] | null>(null);
  const [pulseFace, setPulseFace] = useState<FaceLetter | null>(null);
  const [guiding, setGuiding] = useState(false);
  const [showTestBench, setShowTestBench] = useState(false);
  const [testInfo, setTestInfo] = useState<{ label: string; str: string } | null>(null);
  const [testSegs, setTestSegs] = useState<{ kind: "rep" | "undo"; n: number; start: number }[]>([]);
  const [cubeKey, setCubeKey] = useState(0);
  const [guideStart, setGuideStart] = useState<number | null>(null);
  const [completedPairs, setCompletedPairs] = useState<Set<string>>(new Set());
  // A pair that just landed home gets a quick flash. It runs on its OWN clock, so a fast solver is
  // never made to wait for a celebration: the next pair lights up at the same moment.
  const [celebrateSets, setCelebrateSets] = useState<Set<string> | null>(null);
  const controlsRef = useRef<any>(null);
  const solvedRef = useMemo(() => new CubeModel(), []);

  // --- paint (input cube) mode ---
  const [painting, setPainting] = useState(false);
  const [paint, setPaint] = useState<PaintCubie[]>([]);
  const [paintColor, setPaintColor] = useState<string>(PAINT_COLORS[0]);
  const [paintMsg, setPaintMsg] = useState<string | null>(null);

  const FACE_INDEX = (dir: [number, number, number]) => {
    const [x, y, z] = dir;
    if (x === 1) return 0;
    if (x === -1) return 1;
    if (y === 1) return 2;
    if (y === -1) return 3;
    if (z === 1) return 4;
    return 5;
  };

  const startPaint = () => {
    setGuiding(false);
    setPainting(true);
    setPaint(emptyPaint());
    setPaintMsg(null);
  };
  const cancelPaint = () => {
    setPainting(false);
    setPaintMsg(null);
  };
  const paintFace = (index: number, dir: [number, number, number]) => {
    const p = paint[index];
    if (!p) return;
    // Ignore centres (fixed) — a centre cubie has two zero coordinates.
    const zeros = [p.pos.x, p.pos.y, p.pos.z].filter((v) => Math.round(v) === 0).length;
    if (zeros >= 2) return;
    // Only the outward face is paintable (this cubie sits on that side).
    if (Math.round(p.pos.x * dir[0] + p.pos.y * dir[1] + p.pos.z * dir[2]) !== 1) return;
    const fi = FACE_INDEX(dir);
    if (p.colors[fi] === COLORS.inner) return; // internal face — never paint
    setPaint((prev) => {
      const next = prev.map((c) => ({ pos: c.pos, colors: [...c.colors] as PaintCubie["colors"] }));
      next[index].colors[fi] = paintColor;
      return next;
    });
    setPaintMsg(null);
  };
  const paintRemaining = useMemo(() => {
    const painted: Record<string, number> = {};
    for (const cu of paint) {
      const zeros = [cu.pos.x, cu.pos.y, cu.pos.z].filter((v) => Math.round(v) === 0).length;
      if (zeros >= 2) continue; // skip fixed centres
      for (const col of cu.colors)
        if ((PAINT_COLORS as readonly string[]).includes(col)) painted[col] = (painted[col] ?? 0) + 1;
    }
    const r: Record<string, number> = {};
    for (const col of PAINT_COLORS) {
      const n = painted[col] ?? 0; // 0..8 paintable facelets
      r[col] = n >= 8 ? 0 : 9 - n; // start 9, finish 0
    }
    return r;
  }, [paint]);
  const donePaint = () => {
    const res = solveFromPaint(paint);
    if (!res.ok) { setPaintMsg(res.error); return; }
    // We now know the real state and the cube does not — so its facelets must not be believed.
    setCubeBeliefValid(false);
    // The painted state becomes the current cube (loaded instantly, not animated).
    cube.load(res.scramble);
    setCubeKey((k) => k + 1); // remount the real cube so it snaps to the loaded state
    setPainting(false);
    setPaintMsg(null);
    setGuiding(false);
    setSeq(null);
    setGuideStart(null);
    phaseInfoRef.current.clear();
  };

  // Once an F2L pair is finished, keep it coloured on the twin permanently — even
  // while a later pair's algorithm momentarily disturbs it.
  useEffect(() => {
    if (!guiding) return;
    const live = buildFrom(cube.moves);
    setCompletedPairs((prev) => {
      let next = prev;
      for (const id of ["FR", "FL", "BR", "BL"] as const) {
        if (pairSolvedIn(live, id) && !prev.has(id)) {
          if (next === prev) next = new Set(prev);
          next.add(id);
          // Celebrate the pair that just went home — by colour, so the flash rides the pieces.
          const sides = SIDE_COLORS[id];
          const sets = new Set([
            [WHITE, ...sides].slice().sort().join("|"),
            [...sides].slice().sort().join("|"),
          ]);
          setCelebrateSets(sets);
          setTimeout(() => setCelebrateSets(null), 1100);
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guiding, cube.moves]);

  // Recenter the view on the midpoint of both cubes while guiding, and back on
  // the single cube otherwise; pull the camera back a little when the twin shows.
  const gyroActive = phys.status === "connected" && phys.hasGyro;
  const [gyroReadout, setGyroReadout] = useState<string>("");
  useEffect(() => {
    if (!gyroActive) { setGyroReadout(""); return; }
    const id = setInterval(() => {
      const o = phys.orientation.current;
      if (o) setGyroReadout(`x ${o.x.toFixed(3)}  y ${o.y.toFixed(3)}  z ${o.z.toFixed(3)}  w ${o.w.toFixed(3)}`);
    }, 200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gyroActive]);
  useEffect(() => {
    const c = controlsRef.current;
    if (!c) return;
    const cam = c.object;
    if (gyroActive && !guiding && !painting) {
      // Look straight at the front face so the cube reads as a flat square —
      // makes it obvious whether the gyro orientation is aligned.
      c.target.set(0, 0, 0);
      cam.position.set(0, 0, 7.5);
      c.update();
      return;
    }
    // Orbit around the cube itself. This used to be offset to x=3.2 — the midpoint between the cube
    // and its twin — so with the twin gone the view still pivoted around empty space beside it, which
    // is the "invisible cube" that made turning feel wrong.
    c.target.set(0, 0, 0);
    cam.position.set(4.2, 4.2, 5.4);
    c.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guiding, painting, gyroActive]);

  const pulseTimer = useRef<number | null>(null);

  // Guidance runs as a committed SEQUENCE per stage. For the cross this is the
  // remaining cross moves; for F2L it's one pair's full algorithm (rotation +
  // alg + return-to-standard). We only replan at settled boundaries — never in
  // the middle of an F2L algorithm, where a cube rotation would confuse phase
  // detection. Deviating from the sequence triggers a replan.
  type Seq = {
    phase: "C" | "F" | "O" | "P" | "done" | "stuck";
    variants: string[][]; // full (wrapped) sequences — used for matching via absolutize
    algStrings?: string[]; // pretty J Perm text — what we display, untouched
    variantSlots?: string[][];
    start: number;
    pair?: string;
    isExtraction?: boolean;
    category?: string;
    ollKind?: "edge" | "corner" | "dot";
    pllKind?: "corner" | "edge" | "auf";
  };
  const [seq, setSeq] = useState<Seq | null>(null);
  // Record this phase's expected algorithm + AUF end so the history can colour and split it later.
  useEffect(() => {
    if (!guiding || !seq || !seq.variants.length || seq.phase === "done" || seq.phase === "stuck") return;
    const expecteds = seq.variants.map((v) => expectedPhysical((v ?? []).join(" ")).map((e) => e.rec));
    phaseInfoRef.current.set(seq.start, {
      expecteds,
      algStrings: seq.algStrings,
      phase: seq.phase,
      extract: !!seq.isExtraction,
      pair: seq.pair,
      ollKind: seq.ollKind,
      pllKind: seq.pllKind,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, guiding]);
  // Test bench: a whole-cube rotation (x/y/z) in the algorithm produces NO turn on the cube, so
  // apply it deterministically the moment it becomes the next expected move — the model frame
  // rotates, the F letter/pulse jump to the new front centre, and you reorient to match. No gyro,
  // no waiting for a physical move. One rotation per render until the next real move.
  useEffect(() => {
    if (!guiding || !seq || seq.phase === "done" || seq.phase === "stuck") return;
    const exp = expectedPhysRef.current;
    if (!exp) return;
    const { next, correcting } = classifyDone(cube.moves.slice(seq.start), exp);
    if (!correcting && next && /^[xyz]/.test(next)) {
      dbg(`rotate ${next} (auto)`);
      cube.push(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guiding, cube.moves.length, seq]);
  // Keep the physical-move effect's disambiguation table in sync with the CURRENT active
  // sequence (the algorithm, or its wide inverse during undo) and its start offset — so a wide
  // in the undo is disambiguated too, and the undo actually reverses the physical wides.
  if (guiding && seq && seq.phase !== "done" && seq.phase !== "stuck" && seq.variants.length) {
    // ONE pipeline: the current step's atomic variant (reorientation + official alg) disambiguates
    // wides/slices and drives auto-applied rotations. Test bench and guide solve are identical here.
    expectedPhysRef.current = expectedPhysical((seq.variants[0] ?? []).join(" ")).map((e) => e.rec);
    guideStartRef.current = seq.start;
  } else {
    expectedPhysRef.current = null;
  }
  const IDS = ["FR", "FL", "BR", "BL"] as const;

  useEffect(() => {
    if (!guiding) {
      if (seq) setSeq(null);
      return;
    }
    if (testMode.current) {
      if (!seq || seq.phase === "done") return;
      const expected = expectedPhysical(seq.algStrings?.[0] ?? seq.variants[0].join(" ")).map((e) => e.rec);
      const startState = buildFrom(cube.moves.slice(0, seq.start));
      const endState = startState.clone();
      for (const mv of expected) { const p = parseMove(mv); if (p) endState.applyMove(p); }
      const repComplete = _sig(buildFrom(cube.moves)) === _sig(endState);
      if (repComplete) {
        const t = testReps.current;
        const solvedNow = _sig(buildFrom(cube.moves)) === _sig(buildSolved([]));
        // The undo is the wide inverse of the drilled algorithm (shows r/r', the disambiguation
        // works during it, and — because we now record the true expanded wide in cube.moves —
        // it actually reverses the physical wides back to a real solved, not a look-alike.
        const undoAll = () => {
          const rawWide = testInfo ? atomicTokens(testInfo.str) : cube.moves;
          const invStr = inverseAlg(rawWide).join(" ");
          setTestSegs((s) => [...s, { kind: "undo", n: 1, start: cube.moves.length }]);
          // Atomic throughout: the variant keeps the wides (r), matching how cube.moves records
          // them, so the undo physically reverses the real wides back to a true solved.
          setSeq({ phase: t.phase, variants: [atomicTokens(invStr)], algStrings: [invStr], start: cube.moves.length });
        };
        if (t.mode === "repeat") {
          if (solvedNow) {
            setSeq({ ...seq, phase: "done", start: cube.moves.length });
          } else if (t.done + 1 < 10) {
            t.done++;
            setTestSegs((s) => [...s, { kind: "rep", n: t.done + 1, start: cube.moves.length }]);
            setSeq({ ...seq, start: cube.moves.length });
          } else {
            t.mode = "undo"; t.undone = true;
            undoAll();
          }
        } else {
          if (solvedNow) {
            setSeq({ ...seq, phase: "done", start: cube.moves.length });
          } else {
            // run the algorithm once (undone=false) then undo everything to solved.
            t.undone = true;
            undoAll();
          }
        }
      }
      return;
    }
    if (seq && seq.phase !== "done" && seq.phase !== "stuck") {
      const doneMoves = cube.moves.slice(seq.start);
      let anyComplete = false;
      for (const v of seq.variants) {
        const exp = expectedPhysical(v.join(" ")).map((e) => e.rec);
        const r = classifyDone(doneMoves, exp);
        if (!r.correcting && r.progress >= exp.length && doneMoves.length >= exp.length) anyComplete = true;
      }
      // Stay on this stage until a variant is fully executed. Progress can dip back to 0 while you
      // undo mistakes — that is NOT "finished", so we must not re-plan (which would reset the stage
      // and loop forever). Only a genuinely complete variant advances to the next stage.
      if (!anyComplete) return;
    } else if (seq && (seq.phase === "done" || seq.phase === "stuck")) {
      return;
    }
    // Recompute at a settled boundary.
    const model = buildFrom(cube.moves);
    if (!crossSolvedIn(model)) {
      setSeq({ phase: "C", variants: [planCross(cube.moves).cross], algStrings: [planCross(cube.moves).cross.join(" ")], start: cube.moves.length });
      return;
    }
    if (!IDS.every((id) => pairSolvedIn(model, id))) {
      const s = nextF2LStep(cube.moves);
      if (s) {
        setSeq({
          phase: "F", variants: s.variants, algStrings: s.algStrings, variantSlots: s.variantSlots,
          start: cube.moves.length, pair: s.pair, isExtraction: s.isExtraction,
          category: s.category,
        });
      } else {
        setSeq({ phase: "stuck", variants: [], start: cube.moves.length });
      }
      return;
    }
    if (!ollDone(model)) {
      const o = recognizeOLL(cube.moves);
      if (o) {
        setSeq({ phase: "O", variants: [o.moves], algStrings: [o.algString], start: cube.moves.length, ollKind: o.kind });
      } else {
        setSeq({ phase: "stuck", variants: [], start: cube.moves.length });
      }
      return;
    }
    if (!pllDone(model)) {
      const p = recognizePLL(cube.moves);
      if (p) {
        setSeq({ phase: "P", variants: [p.moves], algStrings: [p.algString], start: cube.moves.length, pllKind: p.kind });
      } else {
        setSeq({ phase: "stuck", variants: [], start: cube.moves.length });
      }
      return;
    }
    setSeq({ phase: "done", variants: [], start: cube.moves.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guiding, cube.moves]);

  const doneMoves = seq ? cube.moves.slice(seq.start) : [];
  const doneCount = doneMoves.length;
  const activeEntries = seq
    ? seq.variants
        .map((v, i) => ({
          v, // raw tokenized variant (includes any reorientation prefix)
          str: seq.algStrings?.[i] ?? v.join(" "), // pretty J Perm text — displayed as-is
          // ONE pipeline for test bench AND guide solve: match the atomic moves of the full
          // variant (reorientation + official alg, kept atomic). Auto-applied x/y/z land here too.
          abs: expectedPhysical(v.join(" ")).map((e) => e.rec),
          slots: seq.variantSlots?.[i] ?? [],
        }))
        .filter((e) => doneMoves.every((mv, i) => e.abs[i] === mv))
    : [];
  const activeVariants = activeEntries.map((e) => e.abs);
  // Mistake handling (both modes): deviations are stacked and undone in reverse (see classifyDone).
  let testCorrecting = false;
  let testExecProgress = -1;
  let testNext: string | null = null;
  if (guiding && seq && seq.phase !== "done" && seq.phase !== "stuck" && seq.variants.length) {
    const expected = activeEntries[0]?.abs ?? expectedPhysical(seq.variants[0].join(" ")).map((e) => e.rec);
    const done = cube.moves.slice(seq.start);
    const r = classifyDone(done, expected);
    testNext = r.next;
    testCorrecting = r.correcting;
    testExecProgress = r.progress;
  }
  // Arrow uses the absolute next move, so it points at the real face to turn.
  // Always guide with the first (top) variant's next move, so there's always an
  // arrow to follow even when several algorithms are still possible.
  const nextMove = testNext;
  // Everything keys off the DISPLAYED J Perm text, not the internal variant: its leading
  // rotation says which center to bring to the front (the pulse), and its letters are what
  // you read and do. This keeps pulse + HUD + sheet perfectly in agreement.
  // Expand J Perm repeat notation like "(U R U' R')3" so the HUD can track each move.
  const expandRepeats = (s: string) =>
    s.replace(/\(([^)]*)\)\s*(\d+)/g, (_m, grp: string, n: string) => Array(+n).fill(grp.trim()).join(" "));
  // The reorientation that brings this pair into the J Perm (front-right) frame lives at
  // the START of the variant. The pulse asks you to bring that center to the front; once
  // you do, the J Perm letters apply literally — so the HUD shows them verbatim.
  const leadRot = (() => {
    const v = activeEntries[0]?.v ?? seq?.variants?.[0];
    if (!v) return [] as string[];
    const r: string[] = [];
    for (const t of v) { if (/^[xyz]['2]?$/.test(t)) r.push(t); else break; }
    return r;
  })();
  // (slice-aware arrow token is computed after the HUD below)
  // HUD: the literal J Perm letters (rotations stripped — handled by the pulse), synced to
  // progress via cumulative absolute-move counts, with any AUF prefix surfaced.
  // testNext is the next ATOMIC move — which for a wide is a bare slice (f -> S then F). But the arrow
  // can only draw face turns, the pulsing letter above shows the wide (f), and the sheet says f. So
  // when the atom we are waiting for is the first half of a wide the current algorithm calls for,
  // present the WHOLE wide instead. The recogniser already accepts the wide done in one or in two, so
  // nothing downstream breaks — this only fixes what you are ASKED to do.
  const wideNow = (() => {
    if (!seq || testNext == null || testExecProgress < 0) return null;
    const exp = activeEntries[0]?.abs;
    const jperm = activeEntries[0]?.v; // the atomic JPerm tokens, wides kept whole
    if (!exp || !jperm) return null;
    // Walk the JPerm tokens, counting how many atoms each expands to, to see which token we are on.
    let atom = 0;
    for (const tok of jperm) {
      let n = 1;
      try { n = expectedPhysical(tok).length || 1; } catch { n = 1; }
      if (testExecProgress < atom + n) {
        // We are inside this token. If it is a wide and we're at its first atom, show the wide.
        if (WIDE_PARTS[tok] && testExecProgress === atom) return tok;
        return null;
      }
      atom += n;
    }
    return null;
  })();
  const displayNow = wideNow ?? testNext;
  const hud = (() => {
    if (!seq) return null;
    // Correction (either mode): guide the undo move and flag fix (green), same as test bench.
    if (testCorrecting) return { past: cube.lastMove ?? "\u2014", now: testNext ?? "\u2014", next: "\u2014", fix: true };
    return {
      past: cube.lastMove ?? "\u2014",
      now: displayNow ?? "\u2713",
      next: "\u2014",
      fix: false,
    };
  })();
  const jpermWideNow = testNext; // kept for the debug readout
  // The arrow already knows how to draw a wide — two parallel arrows for r/l/u/d/f/b. Feed it the
  // wide token (displayNow), not the bare slice atom, so it can. A slice atom like S matches no arrow
  // and left the cue blank (or drew a stray face arrow), which is what looked broken.
  const arrowToken = displayNow;
  const pulseCol = (() => {
    if (!seq) return null;
    try { return centerColorAt(buildSolved(leadRot), [0, 0, 1]); } catch { return "err"; }
  })();
  const pulseDir = (() => {
    if (!seq) return null;
    // Guiding (test bench OR guide solve): rotations are auto-applied, so F is always on the front.
    // The pulse is your orientation anchor — always the front face; F lands on whatever centre is
    // there (after a y, the new front centre). Never points at a back/side centre.
    if (guiding) return [0, 0, 1] as [number, number, number];
    if (!pulseCol || pulseCol === "err") return null;
    const DIR: Record<string, [number, number, number]> = {
      G: [0, 0, 1], Bl: [0, 0, -1], Y: [0, 1, 0], W: [0, -1, 0], O: [1, 0, 0], R: [-1, 0, 0],
    };
    return DIR[pulseCol] ?? [0, 0, 1];
  })();
  // Human-readable pulse status for the debug panel.
  const pulseDebug = (() => {
    if (!seq) return "no active step";
    const NAME: Record<string, string> = { G: "green", Bl: "blue", Y: "yellow", W: "white", O: "orange", R: "red" };
    if (!pulseDir) return `NO PULSE — could not resolve center (col=${pulseCol}, leadRot=${leadRot.join(" ") || "\u2205"})`;
    return `${NAME[pulseCol!] ?? pulseCol} center \u2192 bring to front (leadRot ${leadRot.join(" ") || "\u2205"})`;
  })();
  // Guide-solve progress: which CFOP stage you're on, the recognised case, and the chosen J Perm
  // algorithm — shown in a panel above the cube (not just in debug).
  const guideProgress = (() => {
    if (!guiding || testMode.current || !seq) return null;
    const base = ["Cross", "F2L 1", "F2L 2", "F2L 3", "F2L 4", "OLL 1/2", "OLL 2/2", "PLL 1/2", "PLL 2/2"];
    const model = buildFrom(cube.moves);
    const pairs = IDS.filter((id) => pairSolvedIn(model, id)).length;
    const alg = seq.algStrings?.[0] ?? "";
    // Stage list, with AUF shown as its own chip when the current step has one.
    const stages = [...base];
    let cur: number;
    let sub = "";
    let caseName = "";
    if (seq.phase === "C") {
      cur = 0;
      sub = "cross";
    } else if (seq.phase === "F") {
      cur = 1 + Math.min(pairs, 3);
      sub = `${seq.pair ?? ""} pair`;
      caseName = seq.category ? (F2L_CAT[seq.category] ?? seq.category) : "";
    } else if (seq.phase === "O") {
      // Two-look OLL: edges first, then corners.
      cur = seq.ollKind === "edge" || seq.ollKind === "dot" ? 5 : 6;
      sub = "OLL";
      caseName = OLL_CASE[alg] ?? "";
    } else {
      // Two-look PLL: corners first, then edges.
      cur = seq.pllKind === "corner" ? 7 : 8;
      sub = "PLL";
      caseName = PLL_CASE[alg] ?? "";
    }
    // AUF = the alignment the app adds in front of the official algorithm. It ends exactly where the
    // algorithm begins — found by locating the algorithm, not by counting leading U turns. Counting
    // greedily swallowed the algorithm's own first move whenever that was a U, and then claimed an
    // alignment of three U turns, which cannot exist (an AUF is at most a half turn).
    const varAtomic = expectedPhysical((seq.variants[0] ?? []).join(" ")).map((e) => e.rec);
    let aufStart = 0;
    while (aufStart < varAtomic.length && /^[xyz]/.test(varAtomic[aufStart])) aufStart++; // reorientation
    const p = Math.max(aufStart, algStartIn(varAtomic, alg));
    const auf = varAtomic.slice(aufStart, p).join(" ");
    const inAuf = !!auf && testExecProgress >= aufStart && testExecProgress < p;
    // Which letter of the official algorithm are you on?
    // Do not try to DERIVE the offset between the letters shown and the moves counted — I tried
    // twice (assume the AUF is included; assume it is not) and each guess broke the other case.
    // Now that the official algorithm is kept intact inside the tracked sequence, simply FIND it
    // there: its atomic moves appear as a contiguous run, and where that run begins is exactly the
    // point where letter 1 of the algorithm starts.
    const algToks = alg ? alg.replace(/[()]/g, " ").split(/\s+/).filter(Boolean) : [];
    const cum: number[] = [];
    const len: number[] = [];
    for (const t of algToks) {
      let n = 1;
      try { n = expectedPhysical(t).length || 1; } catch { n = 1; }
      cum.push(cum.length ? cum[cum.length - 1] + len[len.length - 1] : 0);
      len.push(n);
    }
    const algAtomic = alg ? expectedPhysical(alg.replace(/[()]/g, " ")).map((e) => e.rec) : [];
    let algStart = 0;
    for (let i = 0; i + algAtomic.length <= varAtomic.length; i++) {
      let hit = algAtomic.length > 0;
      for (let k = 0; k < algAtomic.length; k++) {
        if (varAtomic[i + k] !== algAtomic[k]) { hit = false; break; }
      }
      if (hit) { algStart = i; break; }
    }
    const atomicIdx = testExecProgress - algStart;
    let algIdx = -1;
    for (let k = 0; k < algToks.length; k++) {
      if (atomicIdx >= cum[k] && atomicIdx < cum[k] + len[k]) { algIdx = k; break; }
    }
    // The cue describes the cube AS IT WILL BE once the alignment is done — that is the position the
    // algorithm was written for, and the position you would have to recognise on your own.
    let cue: string | null = null;
    let why: string | null = null;
    if (seq.phase === "O" || seq.phase === "P") {
      const upToAlg = (seq.variants[0] ?? []).slice(0, p); // reorientation + AUF
      cue = recognitionCue(buildFrom([...cube.moves, ...upToAlg]), seq.phase, seq.ollKind ?? seq.pllKind);
    } else if (seq.phase === "F" && seq.pair && !seq.isExtraction) {
      cue = f2lCue(buildFrom(cube.moves), seq.pair);
      why = explainPairChoice(cube.moves); // the look-ahead, said out loud
    }
    return { stages, idx: cur, sub, caseName, alg, auf, inAuf, algToks, algIdx, cue, why };
  })();
  // FENCED sensor mode: free play only (no guiding, no test bench). Feed the model from what the
  // sensors say the move WAS — face vs wide vs slice — once each move's measurement window has
  // closed. Nothing else in the app changes.
  const sensorMode = showSensorBench && !guiding && !testMode.current;
  const sensorModeRef = useRef(false);
  sensorModeRef.current = sensorMode;
  // In sensor mode the model is driven by the sensor verdict ALONE. The cube's own facelets must not
  // also drive it: they are reported in the CORE frame (a wide d looks like a plain U' there), so the
  // two sources describe different frames and fight each other — which corrupted the model outright
  // (cubies ended up showing their black insides). One source of truth, not two.
  useEffect(() => {
    if (!sensorMode) return;
    // Show the move as soon as the reading is CLEAR, rather than always waiting out the longest
    // possible window. A normal turn is settled in ~400ms; only a slow one needs the extra patience,
    // and only then do we keep waiting. Waiting the full window every time made everything laggy.
    const SETTLE_MS = 380;
    const id = setInterval(() => {
      const groups = classifyLab(phys.moveQuatHistory.current, phys.gyroTrail.current);
      const now = Date.now();
      for (let i = sensorPushed.current; i < groups.length; i++) {
        const g = groups[i];
        const age = now - g.tEnd;
        if (age < SETTLE_MS) break;                                  // too early to tell
        if (g.kind === "UNKNOWN" && age < WIN_POST + 150) break;     // still turning — give it time
        const coreMap = coreFaceMap(buildFrom(cube.moves));
        let tok = labToken(g, coreMap);
        const guessed = tok === "?";
        if (guessed) tok = labFaceFallback(g, coreMap); // never lose the move
        for (const t of tok.split(" ")) if (t) cube.push(t);
        sensorPushed.current = i + 1;
        setSensorLog((L) => [
          ...L,
          { tok, kind: g.kind, net: Math.round(g.angle), gap: g.gapPrev, win: g.win, samples: g.samples, lag: Math.round(age), guessed },
        ].slice(-40));
      }
    }, 50);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sensorMode, cube.moves.length]);

  // The two pieces this F2L pair is about — the corner and its edge. Highlighting them turns the
  // algorithm from a list of letters into something you can see happening to specific pieces.
  const pairPieceSets = useMemo<Set<string> | undefined>(() => {
    if (!guiding || !seq || seq.phase !== "F" || !seq.pair) return undefined;
    const sides = SIDE_COLORS[seq.pair as keyof typeof SIDE_COLORS];
    if (!sides) return undefined;
    // Name the two pieces by their colours: that identity travels with the piece wherever the
    // algorithm throws it, which is exactly what you want to follow with your eyes.
    return new Set([
      [WHITE, ...sides].slice().sort().join("|"), // the corner
      [...sides].slice().sort().join("|"),        // its edge
    ]);
  }, [guiding, seq]);

  // Kept for a possible return of the twin cube (removed from guide solve — it was distracting).
  // Fast-forward: click a stage chip and the app plays the solve for you up to that phase, so you can
  // get to the OLL or PLL you actually want to drill without turning the whole cube by hand. It plays
  // ONE move per tick — the plan is recomputed after every move, so it must go a step at a time.
  const [jumpTo, setJumpTo] = useState<number | null>(null);

  // ---- Solve timer -----------------------------------------------------------------------------
  // Inspection is free: turn the cube over, study it, take as long as you like. The clock starts on
  // your FIRST layer turn — nothing else counts as starting. It stops when the cube goes properly
  // still (you put it down), and the finish time is taken as the moment that stillness BEGAN, not
  // when we noticed it: you finished the solve when you stopped turning, not five seconds later.
  const STILL_MS = 5000;      // this much stillness means the solve is over
  const STILL_DEG = 2.5;      // per-sample rotation below this counts as "not moving"
  const [timerPhase, setTimerPhase] = useState<"off" | "armed" | "running" | "done">("off");
  const [timerNow, setTimerNow] = useState(0);          // live milliseconds, for the display
  const [timerResult, setTimerResult] = useState<{ ms: number; moves: number } | null>(null);
  const timerStart = useRef<number | null>(null);
  const timerFrom = useRef(0);                          // where in the move history the solve began
  const stillSince = useRef<number | null>(null);
  const lastQ = useRef<{ x: number; y: number; z: number; w: number } | null>(null);

  const armTimer = () => {
    timerStart.current = null;
    timerFrom.current = phys.moveHistory.length;
    stillSince.current = null;
    lastQ.current = null;
    setTimerNow(0);
    setTimerResult(null);
    setTimerPhase("armed");
  };
  const stopTimer = () => { setTimerPhase("off"); setTimerResult(null); };

  const timerMoves =
    timerPhase === "running" || timerPhase === "armed"
      ? Math.max(0, phys.moveHistory.length - timerFrom.current)
      : 0;

  useEffect(() => {
    if (timerPhase !== "armed" && timerPhase !== "running") return;
    const id = setInterval(() => {
      const now = Date.now();

      // Armed: waiting for the first turn. Looking at the cube does not start the clock.
      if (timerPhase === "armed") {
        if (phys.moveHistory.length > timerFrom.current) {
          timerStart.current = now;
          stillSince.current = null;
          setTimerPhase("running");
        }
        return;
      }

      setTimerNow(timerStart.current ? now - timerStart.current : 0);

      // Running: watch for the cube coming to rest.
      const q = phys.orientation.current;
      if (!q) return;
      const prev = lastQ.current;
      lastQ.current = q;
      if (!prev) return;
      const dot = Math.abs(prev.x * q.x + prev.y * q.y + prev.z * q.z + prev.w * q.w);
      const deg = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
      if (deg > STILL_DEG) { stillSince.current = null; return; }
      if (stillSince.current == null) { stillSince.current = now; return; }
      if (now - stillSince.current >= STILL_MS) {
        // You finished when you stopped turning — which is when the stillness began.
        const ms = Math.max(0, (stillSince.current ?? now) - (timerStart.current ?? now));
        setTimerResult({ ms, moves: Math.max(0, phys.moveHistory.length - timerFrom.current) });
        setTimerPhase("done");
      }
    }, 100);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timerPhase, phys.moveHistory.length]);

  const fmt = (ms: number) => {
    const t = Math.max(0, ms);
    const m = Math.floor(t / 60000);
    const sec = (t % 60000) / 1000;
    return m > 0 ? `${m}:${sec.toFixed(2).padStart(5, "0")}` : sec.toFixed(2);
  };
  useEffect(() => {
    if (jumpTo == null || mode !== "virtual" || !guiding) { return; }
    if (!guideProgress || guideProgress.idx >= jumpTo) { setJumpTo(null); return; }
    const mv = hud?.now;
    if (!mv) { setJumpTo(null); return; }
    const t = setTimeout(() => tokenize(mv).forEach((k) => cube.push(k)), 45);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo, mode, guiding, cube.moves.length, hud?.now]);

  // Slots the current (first active) variant will disturb — highlighted pink on the twin.
  const pinkIds = useMemo<Set<number> | undefined>(() => {
    if (!guiding || !seq || seq.phase !== "F") return undefined;
    const dm = cube.moves.slice(seq.start);
    const first = seq.variants
      .map((v, i) => ({ v, slots: seq.variantSlots?.[i] ?? [] }))
      .filter((e) => dm.every((mv, i) => absolutize(e.v).exec[i] === mv))[0];
    if (!first || !first.slots.length) return undefined;
    const colsOf = (c: (typeof solvedRef.cubies)[number]) =>
      c.colors.filter((x) => x !== COLORS.inner);
    const pink = new Set<number>();
    for (const slot of first.slots) {
      const [a, b] = SIDE_COLORS[slot as keyof typeof SIDE_COLORS];
      for (const c of solvedRef.cubies) {
        const cols = colsOf(c);
        if (cols.includes(a) && cols.includes(b) && (cols.length === 2 || cols.includes(WHITE)))
          pink.add(c.id);
      }
    }
    return pink;
  }, [guiding, seq, cube.moves, solvedRef]);
  const activePhase = seq?.phase ?? null;
  const phaseFlags = guiding
    ? {
        C: !!seq && seq.phase !== "C",
        F: !!seq && (seq.phase === "O" || seq.phase === "P" || seq.phase === "done"),
        O: !!seq && (seq.phase === "P" || seq.phase === "done"),
        P: !!seq && seq.phase === "done",
      }
    : null;

  const scramble = () => {
    setGuiding(false);
    setGuideStart(null);
    setCompletedPairs(new Set());
    randomScramble(20).forEach(cube.push);
  };
  const startGuiding = () => {
    testMode.current = false; // full CFOP walkthrough, not a pinned test-bench algorithm
    setTestInfo(null);
    setGuideStart(cube.moves.length);
    setCompletedPairs(new Set());
    planCross(cube.moves).reorient.forEach(cube.push);
    setGuiding(true);
  };

  // If the cube drops out mid-solve (battery, Bluetooth), don't strand the person: fall back to the
  // virtual mode so they can carry on from exactly where they are, using the buttons.
  useEffect(() => {
    if (mode === "cube" && phys.status !== "connected" && phys.status !== "connecting") {
      setMode("virtual");
      setLeftTab("keys");
    }
  }, [mode, phys.status]);

  // Center view: nothing but the camera. Look straight at the model's front face, its up-face up.
  // It does not touch the cube, the colours, or which face is F — it only puts the view back where
  // you can read it. (The z / z' buttons are the separate thing: those turn the MODEL.)
  const centerView = () => {
    const c = controlsRef.current;
    if (!c) return;
    c.target.set(0, 0, 0);
    c.object.up.set(0, 1, 0);
    c.object.position.set(0, 0, 7.6);
    c.object.lookAt(0, 0, 0);
    c.update();
  };

  // Re-sync: if the on-screen cube ever drifts from the one in your hands, the physical cube still
  // knows its own state — it reports every sticker. So take that as the new starting point, throw
  // away the move history that led us astray, and plan a fresh solve from where you actually are.
  const [resyncMsg, setResyncMsg] = useState<string | null>(null);
  const [zoomImg, setZoomImg] = useState<string | null>(null); // an algorithm sheet, blown up to read
  // The cube has no eyes: it cannot see its stickers. It DEDUCES its state by adding up the turns it
  // feels, starting from a known reference. Scramble it while it is off and it feels nothing — so it
  // still believes the old state, and the "facelets" it reports are that belief, not reality.
  // Its MOVE events are always real (they are measured as they happen); only the derived state can be
  // a lie. So when we know its belief is stale, we keep listening to its moves and stop trusting its
  // facelets — until a Reset (with the cube physically solved) re-anchors it to the truth.
  const [cubeBeliefValid, setCubeBeliefValid] = useState(true);
  const [sheetView, setSheetView] = useState(false); // a screen of its own, just for the algorithm sheets
  const [sheetPick, setSheetPick] = useState<"F" | "O" | "P">("O");
  const [leftTab, setLeftTab] = useState<"console" | "keys">("console");
  // Two ways to use this app, and they want different tools:
  //   virtual — no smart cube (a plain cube, or yours is charging): moves come from the buttons.
  //   cube    — a Bluetooth cube: moves come from your hands, so on-screen move buttons would only
  //             desync the model from the thing you are holding. They are hidden.
  const resyncFromCube = () => {
    if (!phys.facelets) return;
    if (!cubeBeliefValid) {
      setResyncMsg("the cube's own state is stale — solve it and press Reset, or use Input cube");
      setTimeout(() => setResyncMsg(null), 5000);
      return;
    }
    // First, try to simply REPAIR the model: your cube is fine, our belief about it drifted. If a
    // couple of moves explain the gap, apply them and carry on — same solve, same phase, no restart.
    const fix = findRepair(cube.moves, phys.facelets, 3);
    if (fix) {
      if (fix.length) fix.forEach(cube.push);
      setResyncMsg(fix.length ? `model repaired (${fix.join(" ")}) — carry on` : "already in sync");
      setTimeout(() => setResyncMsg(null), 4000);
      return;
    }
    // Too far gone to reconcile — take the cube's own state as a fresh starting point.
    setResyncMsg("too far apart — planning a fresh solve from your cube");
    setTimeout(() => setResyncMsg(null), 4000);
    const base = faceletsToModel(phys.facelets);
    setSolveBase(base);        // the solver now reasons from THIS state, not from solved + moves
    cube.load([]);             // no moves on top of it yet
    setCubeKey((k) => k + 1);  // remount so the 3D cube snaps to it
    physConsumed.current = phys.moveHistory.length; // don't re-consume moves already made
    setGuiding(false);
    setSeq(null);
    setGuideStart(null);
    phaseInfoRef.current.clear();
    sensorPushed.current = 0;
    setSensorLog([]);
    setCompletedPairs(new Set());
    // Plan the new solve from the state the cube says it is in.
    setTimeout(() => {
      testMode.current = false;
      setTestInfo(null);
      setGuideStart(0);
      planCross([]).reorient.forEach(cube.push);
      setGuiding(true);
    }, 60);
  };
  const stopGuiding = () => { testMode.current = false; setTestInfo(null); setGuiding(false); };

  // Grey mask for the twin cube: colour only the pieces the current phase is
  // about, grey the rest, so the user sees exactly what we're working on.
  const greyIds = useMemo<Set<number> | undefined>(() => {
    if (!guiding || !seq) return undefined;
    const YELLOW = COLORS.U;
    const colsOf = (c: (typeof solvedRef.cubies)[number]) =>
      c.colors.filter((x) => x !== COLORS.inner);
    const idsWhere = (pred: (cols: string[]) => boolean) => {
      const s = new Set<number>();
      for (const c of solvedRef.cubies) if (pred(colsOf(c))) s.add(c.id);
      return s;
    };
    const crossIds = idsWhere((cols) => cols.includes(WHITE) && cols.length <= 2);
    // Face centers (single-colour pieces), excluding the yellow one — useful
    // orientation references while building the cross.
    const centerIds = idsWhere((cols) => cols.length === 1 && cols[0] !== COLORS.U);
    const yellowIds = idsWhere((cols) => cols.includes(YELLOW));
    const pairIds = (id: keyof typeof SIDE_COLORS) => {
      const [a, b] = SIDE_COLORS[id];
      // The F2L pair is the white corner (a,b,white) and the a-b edge — NOT the
      // yellow corner that happens to also carry colours a and b.
      return idsWhere(
        (cols) =>
          cols.includes(a) &&
          cols.includes(b) &&
          (cols.length === 2 || cols.includes(WHITE))
      );
    };
    let relevant = new Set<number>();
    if (seq.phase === "C") relevant = new Set([...crossIds, ...centerIds]);
    else if (seq.phase === "F") {
      relevant = new Set([...crossIds, ...centerIds]);
      for (const id of completedPairs) pairIds(id as keyof typeof SIDE_COLORS).forEach((x) => relevant.add(x));
      if (seq.pair) pairIds(seq.pair as keyof typeof SIDE_COLORS).forEach((x) => relevant.add(x));
    } else if (seq.phase === "O" || seq.phase === "P") relevant = yellowIds;
    else relevant = new Set(solvedRef.cubies.map((c) => c.id)); // done/stuck: colour all
    const grey = new Set<number>();
    for (const c of solvedRef.cubies) if (!relevant.has(c.id)) grey.add(c.id);
    return grey;
  }, [guiding, seq, cube.moves, solvedRef, completedPairs]);
  void greyIds; void pinkIds; // the twin cube was removed from the view; kept in case it returns

  // Pulse the outer face of whatever move was just made (button, key, or drag).
  useEffect(() => {
    const last = cube.lastMove;
    if (!last) return;
    const f = last[0];
    if ("URFDLB".includes(f)) {
      setPulseFace(f as FaceLetter);
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
      pulseTimer.current = window.setTimeout(() => setPulseFace(null), 350);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cube.moves.length]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__eyebrow">Digital twin</span>
          <h1 className="brand__title">Cube Coach</h1>
        </div>
        <div className="source">
          <span className="dot dot--virtual" />
          keyboard
        </div>
      </header>

      <div className="stage" onContextMenu={(e) => e.preventDefault()}>
        <div className="col-mid">
        {guideProgress && (
          <div className="guide-progress" aria-label="Solve progress">
            <div className="gp-stages">
              {guideProgress.stages.map((s, i) => (
                <span
                  key={i}
                  className={`gp-stage${s === "AUF" ? " gp-aufchip" : ""}${i === guideProgress.idx ? " gp-current" : ""}${i < guideProgress.idx ? " gp-done" : ""}${mode === "virtual" && i > guideProgress.idx ? " gp-jump" : ""}`}
                  onClick={() => { if (mode === "virtual" && i > guideProgress.idx) setJumpTo(i); }}
                  title={mode === "virtual" && i > guideProgress.idx ? "Play the solve up to here" : undefined}
                >
                  {s}
                </span>
              ))}
            </div>
            <div className="gp-detail">
              <span className="gp-case">
                {guideProgress.sub}
                {guideProgress.caseName ? <b> · {guideProgress.caseName}</b> : null}
              </span>
              {guideProgress.auf ? (
                <span className={`gp-auf${guideProgress.inAuf ? " gp-step-active" : ""}`}>
                  align · AUF: {guideProgress.auf}
                </span>
              ) : null}
              {guideProgress.cue ? (
                <div className="gp-cue">
                  <span className="gp-cue-label">how you'd spot it</span>
                  <span className="gp-cue-text">{guideProgress.cue}</span>
                </div>
              ) : null}
              {guideProgress.why ? (
                <div className="gp-cue gp-why">
                  <span className="gp-cue-label">why this pair</span>
                  <span className="gp-cue-text">{guideProgress.why}</span>
                </div>
              ) : null}
              {guideProgress.algToks.length ? (
                <span className={`gp-alg${!guideProgress.inAuf ? " gp-step-active" : ""}`}>
                  {guideProgress.algToks.map((t, i) => (
                    <span key={i} className={i === guideProgress.algIdx ? "gp-now" : i < guideProgress.algIdx ? "gp-past" : undefined}>
                      {t}{i < guideProgress.algToks.length - 1 ? " " : ""}
                    </span>
                  ))}
                </span>
              ) : null}
              {/* The same algorithm, read as GESTURES rather than letters. You do not memorise
                  "U' R U2 R' U2 R U' R'" — you memorise "align, insert, align, insert". */}
              {guideProgress.alg ? (
                <div className="gp-gestures">
                  {segmentAlg(guideProgress.alg).map((g, i) => (
                    <span key={i} className={g.name ? "gp-gest" : "gp-loose"}>
                      {g.name ? (
                        <>
                          <span className="gp-gest-name">{g.name}</span>
                          <span className="gp-gest-toks">{g.toks.join(" ")}</span>
                        </>
                      ) : (
                        g.toks.join(" ")
                      )}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        )}
        <div className="canvas-wrap">
        {mode === "cube" && timerPhase !== "off" && (
          <div className="solve-timer" aria-live="polite">
            {timerPhase === "armed" && (
              <div className="solve-timer__wait">inspect freely — the clock starts on your first turn</div>
            )}
            {timerPhase === "running" && (
              <>
                <div className="solve-timer__time">{fmt(timerNow)}</div>
                <div className="solve-timer__sub">{timerMoves} moves · set the cube down to stop</div>
              </>
            )}
            {timerPhase === "done" && timerResult && (
              <>
                <div className="solve-timer__time solve-timer__time--done">{fmt(timerResult.ms)}</div>
                <div className="solve-timer__sub">
                  {timerResult.moves} moves · {(timerResult.moves / Math.max(0.001, timerResult.ms / 1000)).toFixed(1)}/sec
                </div>
              </>
            )}
          </div>
        )}
        <Canvas shadows camera={{ position: [4.2, 4.2, 5.4], fov: 42 }}>
          <color attach="background" args={["#0e1014"]} />
          <ambientLight intensity={0.55} />
          <directionalLight
            position={[6, 9, 6]}
            intensity={1.5}
            castShadow
            shadow-mapSize={[1024, 1024]}
          />
          <directionalLight position={[-6, 3, -4]} intensity={0.4} />
          {painting ? (
            <Cube3D moves={[]} paint={paint} onPaintFace={paintFace} />
          ) : (
            <>
              <Cube3D key={cubeKey} moves={cube.moves} onMove={cube.push} onCellPick={setCell} onPath={setPath} snapOnMount orientationRef={phys.orientation} calibRef={calibRef} gyroView={gyroView} showGuides glowSets={pairPieceSets} flashSets={celebrateSets ?? undefined} pulseFace={pulseFace} nextMove={arrowToken} fixMove={hud?.fix} pulseDir={pulseDir} faceletsState={phys.status === "connected" && !sensorMode && cubeBeliefValid ? phys.facelets : null} />
            </>
          )}
          <OrbitControls
            ref={controlsRef}
            enablePan={false}
            minDistance={5}
            maxDistance={22}
            dampingFactor={0.12}
            mouseButtons={{ LEFT: undefined, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }}
          />
        </Canvas>

        {gyroReadout && <div className="gyro-readout">gyro {gyroReadout}</div>}
        {guiding && seq && testMode.current && (
          <div className="test-badge">
            {seq.phase === "done"
              ? "\u2713 back to solved"
              : testReps.current.mode === "repeat"
                ? `TEST · repeat (rep ${testReps.current.done + 1})`
                : testReps.current.undone
                  ? "TEST · undo (returning to solved)"
                  : "TEST · run once, then undo"}
          </div>
        )}
        {guiding && seq ? (
          <div className="hud-ppf" aria-live="polite">
            <div className="hud-cell hud-past">
              <span className="hud-label">past</span>
              <span className="hud-move">{hud?.past ?? "\u2014"}</span>
            </div>
            {/* Click NOW to have the app make the move for you — a fast way to walk a solve forward
                and reach the OLL/PLL you actually want to practise. Only with no cube connected: with
                one in your hand, moving the model alone would put the two out of step immediately. */}
            <div
              className={`hud-cell hud-present${hud?.fix ? " hud-fix" : ""}${mode === "virtual" && hud?.now ? " hud-clickable" : ""}`}
              onClick={() => {
                if (mode !== "virtual" || !hud?.now) return;
                tokenize(hud.now).forEach((t) => cube.push(t));
              }}
              title={mode === "virtual" && hud?.now ? "Click to play this move" : undefined}
            >
              <span className="hud-label">{hud?.fix ? "\u21A9 fix" : "now"}</span>
              <span className="hud-move">{hud?.now ?? "\u2713"}</span>
            </div>
            <div className="hud-cell hud-future">
              <span className="hud-label">next</span>
              <span className="hud-move">{hud?.next ?? "\u2014"}</span>
            </div>
          </div>
        ) : (
          <div className="lastmove" aria-live="polite">
            {cube.lastMove ?? "\u2014"}
          </div>
        )}
        </div>

        <div className="controls">
          {showTestBench && (
            <div className="testbench">
              <div className="testbench-head">
                <span>Test bench — pick an algorithm, then run it on the physical cube (starts from solved)</span>
                <button className="btn" onClick={() => setShowTestBench(false)}>Close</button>
              </div>
              <div className="testbench-cols">
                <div className="testbench-col">
                  <h4>F2L</h4>
                  {F2L_CATALOG.map((a, i) => (
                    <button key={i} className="tb-alg" onClick={() => { startTest("F", a.str, a.label); setShowTestBench(false); }}>
                      <span className="tb-label">{a.label}</span>
                      <span className="tb-str">{a.str}</span>
                    </button>
                  ))}
                </div>
                <div className="testbench-col">
                  <h4>OLL (2-look)</h4>
                  {OLL_CATALOG.map((a, i) => (
                    <button key={i} className="tb-alg" onClick={() => { startTest("O", a.str, a.label); setShowTestBench(false); }}>
                      <span className="tb-label">{a.label}</span>
                      <span className="tb-str">{a.str}</span>
                    </button>
                  ))}
                </div>
                <div className="testbench-col">
                  <h4>PLL (2-look)</h4>
                  {PLL_CATALOG.map((a, i) => (
                    <button key={i} className="tb-alg" onClick={() => { startTest("P", a.str, a.label); setShowTestBench(false); }}>
                      <span className="tb-label">{a.label}</span>
                      <span className="tb-str">{a.str}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          <button className="btn" onClick={hardReset}>
            Reset
          </button>
          <button className="btn" onClick={centerView} title="Put the camera back on the front face — view only, nothing on the cube changes">
            Center view
          </button>
          {mode === "cube" && (
            <button
              className={`btn${timerPhase !== "off" ? " btn--accent" : ""}`}
              onClick={() => (timerPhase === "off" ? armTimer() : timerPhase === "done" ? armTimer() : stopTimer())}
              title="Time a solve: the clock starts on your first turn and stops when you set the cube down"
            >
              {timerPhase === "off" ? "Start solve" : timerPhase === "done" ? "Again" : "Cancel"}
            </button>
          )}
          {/* Realign the MODEL with the cube in your hands. If the screen shows green in rows and your
              cube has it in columns, the two are a quarter turn apart — a rotation fixes that. It only
              changes which way the cube is held, never its state, so it is always safe to press. */}
          <span className="align-group" title="Turn the on-screen cube to match how you are holding yours">
            <span className="align-group__label">align</span>
            {["z", "z'"].map((t) => (
              <button key={t} className="movebtn movebtn--align" onClick={() => tokenize(t).forEach((m) => cube.push(m))}>
                {t}
              </button>
            ))}
          </span>
          {mode === "virtual" && (
            <button className="btn" onClick={scramble}>
              Scramble
            </button>
          )}
          <button className={`btn${guiding && !testMode.current ? " btn--accent" : ""}`} onClick={startGuiding}>
            Guide solve
          </button>
          <button className={`btn${showTestBench || testMode.current ? " btn--accent" : ""}`} onClick={() => setShowTestBench((v) => !v)}>
            Test bench
          </button>
          {!painting && (
            <button className="btn" onClick={startPaint}>
              Input cube
            </button>
          )}
          {mode === "cube" && phys.status === "connected" ? (
            <button className="btn btn--live" onClick={phys.disconnect} title="Cube connected — click to disconnect">
              {"\u25CF Cube connected"}
            </button>
          ) : mode === "virtual" ? (
            <button
              className="btn"
              onClick={async () => { await phys.connect(); setMode("cube"); setLeftTab("console"); }}
              disabled={phys.status === "connecting"}
              title="Connect a GAN smart cube over Bluetooth"
            >
              {phys.status === "connecting" ? "Connecting\u2026" : "Connect cube"}
            </button>
          ) : null}
          {phys.status === "connected" && phys.hasGyro && (
            <button className="btn" onClick={calibrateGyro} title="Hold the cube yellow-up, green-front and click to align the on-screen orientation">
              Set orientation
            </button>
          )}
          {DEV && gyroActive && gyroReadout && (
            <button
              className="btn"
              onClick={() => navigator.clipboard?.writeText(gyroReadout)}
              title="Copy the current gyro reading to the clipboard"
            >
              Copy gyro
            </button>
          )}
          {guiding && (
            <button className="btn" onClick={stopGuiding}>
              Stop
            </button>
          )}
          <button
            className={`btn${sheetView ? " btn--accent" : ""}`}
            onClick={() => {
              // Open on whatever you are working on right now.
              if (seq?.phase === "F" || seq?.phase === "O" || seq?.phase === "P") setSheetPick(seq.phase);
              setSheetView((v) => !v);
            }}
            title="The JPerm algorithm sheets, full screen and readable"
          >
            Algorithms
          </button>
          {resyncMsg && <span style={{ color: "#4fd18b", fontSize: "0.8rem", alignSelf: "center" }}>{resyncMsg}</span>}
          {phys.status === "connected" && phys.facelets && (
            <button
              className="btn"
              onClick={resyncFromCube}
              title="Lost sync? The cube knows its own state — read it and start a fresh solve from exactly where you are."
            >
              Re-sync
            </button>
          )}
          {DEV && phys.hasGyro && (
            <button
              className={`btn${showMeasure ? " btn--accent" : ""}`}
              onClick={() => setShowMeasure((m) => !m)}
              title="Gyro measurement: shows how much the core rotates per move (wide-vs-face study)"
            >
              Measure
            </button>
          )}
          {DEV && phys.hasGyro && (
            <button
              className={`btn${showSensorBench ? " btn--accent" : ""}`}
              onClick={() => setShowSensorBench((m) => !m)}
              title="Reads your moves from the sensors alone — no algorithm, nothing to follow. Just turn the cube."
            >
              Sensor Bench
            </button>
          )}
          {DEV && phys.hasGyro && (
            <button
              className={`btn${showWideLab ? " btn--accent" : ""}`}
              onClick={() => setShowWideLab((m) => !m)}
              title="Isolated lab: classifies each move as face/wide/slice/rotation from layer events + core rotation. Does not affect solving."
            >
              Wide Lab
            </button>
          )}
          {phys.hasGyro && (
            <button
              className={`btn${gyroView ? " btn--accent" : ""}`}
              onClick={() => setGyroView((g) => !g)}
              title="Frontend only: let the gyro orient the on-screen cube to mirror how you hold it. Does not affect solving."
            >
              Gyro view
            </button>
          )}
          {phaseFlags && (
            <div className="phases" aria-label="CFOP progress">
              {(["C", "F", "O", "P"] as const).map((p) => {
                const done = phaseFlags[p];
                const active = activePhase === p;
                return (
                  <span
                    key={p}
                    className={`phase${active ? " phase--active" : ""}${done ? " phase--done" : ""}`}
                    title={{ C: "Cross", F: "First two layers", O: "Orient last layer", P: "Permute last layer" }[p]}
                  >
                    {done ? "\u2713" : p}
                  </span>
                );
              })}
            </div>
          )}
          <span className="count">{cube.moves.length} moves</span>
          {phys.status === "error" && phys.errorMessage && (
            <span className="conn-error" title={phys.errorMessage}>
              {"cube: " + phys.errorMessage.slice(0, 60)}
            </span>
          )}
        </div>
        </div>

        {(cell || (path && path.length > 0)) && (
          <div className="side-readout">
            {cell && (
              <div className="cell-readout">
                picked <b>{cell.face}</b> · r{cell.row} c{cell.col} · #{cell.index}
              </div>
            )}
            {path && path.length > 0 && (
              <div className="trace-readout">
                <div className="trace-readout__head">
                  trace: {path.map((s) => s.index).join(" \u2192 ")}
                </div>
                {path.map((s, i) => (
                  <div key={i} className="trace-readout__row">
                    #{s.index} · face <b>{s.face}</b> · pt({s.px}, {s.py}, {s.pz}) · n({s.nx},{" "}
                    {s.ny}, {s.nz})
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="col-left">
        <div className="lefttabs">
          <button className={`btn${leftTab === "console" ? " btn--accent" : ""}`} onClick={() => setLeftTab("console")}>Console</button>
          {mode === "virtual" && (
            <button className={`btn${leftTab === "keys" ? " btn--accent" : ""}`} onClick={() => setLeftTab("keys")}>Keys</button>
          )}
        </div>

        {leftTab === "keys" && mode === "virtual" && (
          <div className="keys-panel">
            <div className="keys-panel__hint">Drive the virtual cube — no physical cube needed.</div>
            {KEY_GROUPS.map((g) => (
              <div key={g.label} className="keys-row">
                <span className="keys-row__label">{g.label}</span>
                <div className="keys-row__btns">
                  {g.tokens.map((token) => (
                    <button
                      key={token}
                      className="movebtn"
                      onClick={() => tokenize(token).forEach((t) => cube.push(t))}
                    >
                      {token}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {leftTab === "console" && showSensorBench && phys.status === "connected" && (
          <div className="debug-console">
            <div className="debug-title">sensor bench <button className="debug-clear" onClick={clearAll}>clear</button></div>
            <div className="debug-abs" style={{ color: "#8fa" }}>turn the cube freely — no algorithm, no checking</div>
            {(() => {
              const COL: Record<string, string> = { FACE: "#e8edf5", WIDE: "#7ce0ff", SLICE: "#ffd479", UNKNOWN: "#ff8a8a", "2 FACES": "#e8edf5" };
              if (!sensorLog.length) return <div className="debug-abs">— waiting for a move —</div>;
              return (
                <>
                  <div className="test-rep-moves" style={{ fontSize: "1.15rem", lineHeight: 1.9 }}>
                    {sensorLog.map((e, i) => (
                      <span key={i} style={{ color: e.guessed ? "#ff8a8a" : COL[e.kind] ?? "#fff", fontWeight: 700, marginRight: "0.5rem" }}>
                        {e.tok}{e.guessed ? "?" : ""}
                      </span>
                    ))}
                  </div>
                  <div className="debug-abs" style={{ color: "#8fa", marginTop: 6 }}>
                    token · kind · core° · gap to prev · window · samples · shown after
                  </div>
                  {sensorLog.slice(-18).map((e, i) => (
                    <div key={i} className="debug-abs" style={{ color: e.guessed ? "#ff8a8a" : "#9aa7bd" }}>
                      <b style={{ color: COL[e.kind] ?? "#fff" }}>{e.tok}</b>
                      {" · "}{e.kind}{e.guessed ? " (GUESSED — core unreadable)" : ""}
                      {" · "}{e.net}{"\u00b0"}
                      {" · gap "}{e.gap < 0 ? "\u2014" : e.gap + "ms"}
                      {" · win "}{e.win}{"ms"}
                      {e.win < 300 ? " (SHORT!)" : ""}
                      {" · "}{e.samples}{" samples"}
                      {" · +"}{e.lag}{"ms"}
                    </div>
                  ))}
                </>
              );
            })()}
          </div>
        )}
        {leftTab === "console" && showWideLab && phys.status === "connected" && (
          <div className="debug-console">
            <div className="debug-title">wide lab <span style={{ color: "#7ce0ff", fontWeight: 700 }}>v27 grip</span> <button className="debug-clear" onClick={clearAll}>clear</button></div>
            <div className="debug-abs" style={{ color: "#8fa" }}>grouped moves (rule: events + core):</div>
            {(() => {
              const moves = classifyLab(phys.moveQuatHistory.current, phys.gyroTrail.current);
              if (!moves.length) return <div className="debug-abs">— do a test alg: U D R L F B u d r l f b M E S —</div>;
              const COL: Record<string, string> = { FACE: "#9aa7bd", WIDE: "#7ce0ff", SLICE: "#ffd479", "?2-still": "#ff8a8a", UNKNOWN: "#ff8a8a" };
              return moves.slice(-90).map((mv, idx, arr) => {
                const prevF = idx > 0 ? arr[idx - 1].facelets : null;
                const diff = faceletDiff(prevF, mv.facelets);
                return (
                  <div key={idx} className="debug-abs" style={{ color: COL[mv.kind] ?? "#fff", fontWeight: 700 }}>
                    {mv.kind}
                    <span style={{ color: "#5a6a88", fontWeight: 400 }}>
                      {" · "}{mv.moves.map(remapPhysicalMove).join("+")}
                      {" · "}{mv.angle.toFixed(0)}{"\u00b0 / al "}{mv.align < 0 ? "?" : mv.align.toFixed(2)}
                      {" · "}{mv.span}{"ms · \u0394"}{diff < 0 ? "?" : diff}
                    </span>
                    <div style={{ color: mv.kind === "UNKNOWN" ? "#ff8a8a" : "#4a5568", fontSize: "0.78em", fontWeight: 400 }}>
                      window {mv.win}ms{mv.clipped ? " (CLIPPED by next move)" : ""} · {mv.samples} gyro samples
                      {" · prev "}{mv.gapPrev < 0 ? "\u2014" : mv.gapPrev + "ms"}
                      {" · next "}{mv.gapNext < 0 ? "\u2014" : mv.gapNext + "ms"}
                    </div>
                  </div>
                );
              });
            })()}
            <div className="debug-abs" style={{ color: "#8fa", marginTop: 4 }}>raw events:</div>
            {phys.moveQuatHistory.current.length === 0 ? (
              <div className="debug-abs">— do a test alg: U D R L F B u d r l f b M E S —</div>
            ) : (
              phys.moveQuatHistory.current.slice(-40).map((e, i, arr) => {
                const prev = i > 0 ? arr[i - 1] : null;
                const dt = prev ? e.t - prev.t : 0;
                const d = coreDelta(e.quatBefore, e.quatAfter ?? e.quat);
                const moved = !!d && d.angle > 20;
                const ax = d ? `[${d.axis.map((a) => a.toFixed(2)).join(",")}]` : "";
                const axc = d ? `[${d.axisCube.map((a) => a.toFixed(2)).join(",")}]` : "";
                const al = d ? axisAlign(d.axisCube, e.move) : -1;
                const df = faceletDiff(prev?.facelets ?? null, e.facelets);
                return (
                  <div key={i} className="debug-abs" style={{ color: moved ? "#ffd479" : "#9aa7bd" }}>
                    <b>{remapPhysicalMove(e.move)}</b><span style={{ color: "#5a6a88" }}>({e.move}) s{e.serial}</span>
                    {" · +"}{dt}{"ms · "}
                    {d ? `${d.angle.toFixed(0)}\u00b0` : "\u2014"}
                    {" · "}{moved ? "CORE" : "still"}
                    {" · \u0394"}{df < 0 ? "?" : df}
                    <div style={{ color: "#8fa", fontSize: "0.82em" }}>
                      cube-axis {axc} · align <b style={{ color: al > 0.9 ? "#7ce0ff" : "#ff8a8a" }}>{al < 0 ? "?" : al.toFixed(2)}</b>
                      <span style={{ color: "#4a5568" }}> · world {ax}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
        {leftTab === "console" && showMeasure && phys.status === "connected" && (
          <div className="debug-console">
            <div className="debug-title">gyro measure <button className="debug-clear" onClick={clearAll}>clear</button></div>
            <div className="debug-abs" style={{ color: "#8fa" }}>move · core rotation Δ (angle · axis)</div>
            {phys.moveQuatHistory.current.length === 0 ? (
              <div className="debug-abs">— do isolated moves: U' , d , y' , M , r , S —</div>
            ) : (
              phys.moveQuatHistory.current.slice(-16).map((e, i, arr) => {
                const prev = i > 0 ? arr[i - 1].quat : null;
                const d = coreDelta(prev, e.quat);
                const ax = d ? `[${d.axis.map((a) => a.toFixed(2)).join(", ")}]` : "";
                const big = d && d.angle > 30;
                return (
                  <div key={i} className="debug-abs" style={{ color: big ? "#ffd479" : "#9aa7bd" }}>
                    {remapPhysicalMove(e.move)}<span style={{ color: "#5a6a88" }}> ({e.move})</span>
                    {" · "}{d ? `${d.angle.toFixed(0)}\u00b0 ${ax}` : "—"}
                    {big ? "  \u2190 core turned" : ""}
                  </div>
                );
              })
            )}
          </div>
        )}
        {leftTab === "console" && (
          <div className="debug-console">
            <div className="debug-title">cube moves <button className="debug-clear" onClick={clearAll}>clear</button></div>
            <div className="debug-hist">
              {phys.moveHistory.length
                ? phys.moveHistory.map((m, i) => (
                    <span key={i}>{remapPhysicalMove(m)}<span className="debug-raw"> ({m})</span> </span>
                  ))
                : "(turn the cube)"}
            </div>
            <div className="debug-abs" style={{ color: "#6ee7a8" }}>virtual: {cube.moves.slice(virtualBase).join(" ") || "—"}</div>
            <div style={{ color: "#7fd6ff", fontSize: "0.78rem", marginTop: 2 }}>
              raw GAN (last 8): {phys.moveHistory.slice(-8).join(" ") || "—"}
            </div>
            <div style={{ color: "#ffd479", fontSize: "0.72rem", marginTop: 2, wordBreak: "break-all" }}>
              facelets (cube-reported state): {phys.facelets ?? "— (not reported)"}
            </div>
            {(() => {
              const mdl = buildFrom(cube.moves);
              return (
                <div className="debug-abs" style={{ color: "#ffd479" }}>
                  model centers → F:{centerColorAt(mdl, [0, 0, 1])} U:{centerColorAt(mdl, [0, 1, 0])} R:{centerColorAt(mdl, [1, 0, 0])} D:{centerColorAt(mdl, [0, -1, 0])}
                </div>
              );
            })()}
            <div className="debug-abs" style={{ color: "#c98" }}>
              {dbgLog.length ? dbgLog.map((l, i) => <div key={i}>{l}</div>) : "log: —"}
            </div>
            <div className="debug-abs">raw count: {phys.moveHistory.length}{phys.hasGyro ? " · gyro ✓" : ""}</div>
          </div>
        )}
        {painting && (
          <div className="paint-panel">
            <div className="paint-panel__title">Paint your cube</div>
            <div className="paint-panel__hint">
              Pick a colour, then click the stickers. Orbit (left-drag) to reach every face. Centres are fixed.
            </div>
            <div className="palette">
              {PAINT_COLORS.map((col) => (
                <button
                  key={col}
                  className={`swatch${paintColor === col ? " swatch--on" : ""}`}
                  style={{ background: col }}
                  onClick={() => setPaintColor(col)}
                  title={`${paintRemaining[col] ?? 9}/9 left`}
                >
                  <span className="swatch__count">{paintRemaining[col] ?? 9}/9</span>
                </button>
              ))}
            </div>
            {paintMsg && <div className="paint-panel__msg">{paintMsg}</div>}
            <div className="paint-panel__actions">
              <button className="btn btn--accent" onClick={donePaint}>Done</button>
              <button className="btn" onClick={cancelPaint}>Cancel</button>
            </div>
          </div>
        )}
        {!painting && (
          <>
        {seq && (
          <div className="cross-panel">
            {seq.phase === "done" ? (
              <div className="cross-panel__done">{"solved! \u{1F389}"}</div>
            ) : seq.phase === "stuck" ? (
              <div className="cross-panel__label">no 1A pair available yet</div>
            ) : activeVariants.length === 0 ? (
              <div className="cross-panel__done">
                {seq.phase === "C" ? "cross complete \u2713" : "done \u2713"}
              </div>
            ) : (
              <>
                <div className="cross-panel__label">
                  {seq.phase === "C"
                    ? `Cross \u00b7 ${activeEntries[0].abs.length - doneCount} moves left`
                    : seq.phase === "O"
                    ? seq.ollKind === "corner"
                      ? "OLL \u00b7 orient the corners"
                      : seq.ollKind === "dot"
                      ? "OLL \u00b7 make the yellow cross"
                      : "OLL \u00b7 orient the edges (yellow cross)"
                    : seq.phase === "P"
                    ? seq.pllKind === "corner"
                      ? "PLL \u00b7 permute the corners"
                      : seq.pllKind === "auf"
                      ? "PLL \u00b7 final turn"
                      : "PLL \u00b7 permute the edges"
                    : seq.isExtraction
                    ? `F2L \u00b7 push a piece up (${seq.pair})`
                    : activeVariants.length > 1
                    ? `F2L \u00b7 ${seq.pair} pair \u00b7 pick an algorithm`
                    : `F2L \u00b7 solving ${seq.pair} pair`}
                </div>
                <div className="variants">
                  {activeEntries.map((entry, vi) => (
                    <div key={vi} className="variant-row">
                      <span className="alg-text">{entry.str}</span>
                      {entry.slots.length > 0 && (
                        <span className="slot-badge" title={`Also affects the ${entry.slots.join(", ")} slot`}>
                          ● {entry.slots.join(",")}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {showDebug && guiding && seq && (
          <div className="debug-console">
            <div className="debug-title">debug</div>
            <div>phase <b>{seq.phase}</b> · start {seq.start} · moves {cube.moves.length} · done {doneCount}</div>
            <div>active variants: {activeEntries.length} / {seq.variants.length}</div>
            <div>done: [{doneMoves.join(" ")}]</div>
            <div>next → <b>{hud?.now ?? "—"}</b> <span style={{ color: "#5a6a88" }}>(abs {nextMove ?? "—"})</span></div>
            <div style={{ color: "#7fd6ff", marginTop: 4, fontSize: "0.72rem", lineHeight: 1.5 }}>
              <div>arrow token: <b>{arrowToken ?? "—"}</b>{hud?.fix ? " (FIX)" : ""}</div>
              <div>jperm wide now: {jpermWideNow ?? "—"} · exec progress: {testMode.current ? testExecProgress : doneCount}</div>
              <div style={{ color: "#7a8699" }}>planned steps: [{[...phaseInfoRef.current.keys()].sort((a, b) => a - b).join(", ")}]</div>
              <div>test: {testMode.current ? `${testReps.current.mode}${testCorrecting ? " · CORRECTING" : ""} · next=${testNext ?? "—"}` : "off"}</div>
              <div style={{ color: "#ffd479" }}>variant[0]: {seq.variants?.[0]?.join(" ") || "—"}</div>
              <div style={{ color: "#ffd479" }}>algStr[0]: {seq.algStrings?.[0] ?? "—"} · exp[0]: {(() => { try { return expectedPhysical(seq.algStrings?.[0] ?? seq.variants[0].join(" ")).map((e) => e.rec).slice(0, 3).join(" "); } catch { return "?"; } })()}</div>
              <div>pulseDir: {pulseDir ? `[${pulseDir.map((v) => v.toFixed(0)).join(",")}]` : "null"} · facelets: {phys.status === "connected" && phys.facelets ? "live" : "off"}</div>
              <div>gyro q: {phys.orientation?.current ? `[${[phys.orientation.current.x, phys.orientation.current.y, phys.orientation.current.z, phys.orientation.current.w].map((v) => v.toFixed(2)).join(",")}]` : "—"}</div>
              {(() => {
                if (!(phys.status === "connected" && phys.facelets && phys.orientation?.current)) return null;
                const q = visualQuaternion(phys.orientation.current, calibRef.current, null);
                if (!q) return null;
                const model = faceletsToModel(phys.facelets);
                const L: Record<string, string> = { [COLORS.U]: "U", [COLORS.R]: "R", [COLORS.F]: "F", [COLORS.D]: "D", [COLORS.L]: "L", [COLORS.B]: "B" };
                // For each cubie+sticker, rotate its position and normal by q; bucket by screen face.
                const faces: Record<string, { key: string; letter: string }[]> = { U: [], D: [], F: [], B: [], L: [], R: [] };
                const which = (v: THREE.Vector3): string | null => {
                  const ax: [string, number][] = [["R", v.x], ["L", -v.x], ["U", v.y], ["D", -v.y], ["F", v.z], ["B", -v.z]];
                  ax.sort((a, b) => b[1] - a[1]);
                  return ax[0][1] > 0.8 ? ax[0][0] : null;
                };
                for (const c of model.cubies) {
                  const rp = c.pos.clone().applyQuaternion(q);
                  for (let i = 0; i < 6; i++) {
                    if (c.colors[i] === COLORS.inner) continue;
                    const rn = new THREE.Vector3(..._FN[i]).applyQuaternion(c.quat).applyQuaternion(q);
                    const face = which(rn);
                    if (!face) continue;
                    // 2D key within the face for ordering (rough grid position)
                    faces[face].push({ key: `${Math.round(rp.x)},${Math.round(rp.y)},${Math.round(rp.z)}`, letter: L[c.colors[i]] ?? "?" });
                  }
                }
                const grid = (f: string) => faces[f].sort((a, b) => a.key.localeCompare(b.key)).map((s) => s.letter).join("");
                return (
                  <div style={{ color: "#7fd6ff", marginTop: 4, lineHeight: 1.4 }}>
                    <div style={{ color: "#ffd479" }}>ON SCREEN (what you see):</div>
                    <div>UP(top): {grid("U")}</div>
                    <div>FRONT: {grid("F")}</div>
                    <div>RIGHT: {grid("R")}</div>
                    <div>LEFT: {grid("L")} · DOWN: {grid("D")} · BACK: {grid("B")}</div>
                  </div>
                );
              })()}
            </div>
            {activeEntries.length && (() => {
              const e0 = activeEntries[0];
              const rot: string[] = [];
              for (const t of e0.v) { if (/^[xyz]['2]?$/.test(t)) rot.push(t); else break; }
              let col = "?";
              try { col = centerColorAt(buildSolved(rot), [0, 0, 1]); } catch { col = "err"; }
              return (
                <div style={{ color: "#ff9ae0", marginTop: 4 }}>
                  <div>pulse ← reorient[{rot.length}]: {rot.join(" ") || "∅"} → bring F:{col} to front</div>
                  <div style={{ color: pulseDir ? "#ff9ae0" : "#ff6a6a" }}>pulse now: {pulseDebug}</div>
                  <div>str (do literally): {e0.str}</div>
                  <div>v: {e0.v.join(" ")}</div>
                  <div style={{ color: "#7fd4ff", marginTop: 4 }}>
                    <div>SOLVER · phase {seq.phase} · case {seq.ollKind ?? seq.pllKind ?? (seq.phase === "F" ? `${seq.pair}${seq.category ? " / " + seq.category : ""}` : "\u2014")}</div>
                    <div>official alg: {e0.str}</div>
                    <div>reorient: {rot.join(" ") || "none"} \u2192 new F = {col} centre (F must always pulse on the FRONT, never B)</div>
                    <div>atomic expected: {(() => { try { return expectedPhysical(e0.v.join(" ")).map((e) => e.rec).join(" "); } catch { return "?"; } })()}</div>
                    <div>{IDS.map((id) => `${id}:${pairSolvedIn(buildFrom(cube.moves), id) ? "\u2713" : "\u00b7"}`).join(" ")} · cross:{crossSolvedIn(buildFrom(cube.moves)) ? "\u2713" : "\u00b7"}</div>
                  </div>
                </div>
              );
            })()}
            {activeEntries.slice(0, 4).map((e, i) => (
              <div key={i} className="debug-var">
                <span className="debug-str">{e.str}</span>
                <div className="debug-abs">
                  exec: {e.abs.map((mv, j) => (
                    <span key={j} className={j === doneCount ? "debug-cur" : j < doneCount ? "debug-past" : ""}>{mv} </span>
                  ))}
                </div>
              </div>
            ))}
            <div className="debug-hist">last: {cube.moves.slice(-12).join(" ")}</div>
          </div>
        )}

        <div className="history" aria-label="Move history by CFOP phase">
          {testMode.current && testInfo ? (
            <div className="test-history">
              <div className="test-alg">
                <span className="test-alg-label">{testInfo.label}</span>
                <span className="test-alg-str">{testInfo.str}</span>
              </div>
              {testSegs.map((seg, i) => {
                const end = i + 1 < testSegs.length ? testSegs[i + 1].start : cube.moves.length;
                const mv = cube.moves.slice(seg.start, end);
                // Classify each move with the SAME deviation-stack logic as the guidance, so the
                // colours match what NEXT tells you: white = on the algorithm, red = a mistake
                // (pushed on the stack), green = a repair (inverse of the last mistake, pops it).
                const expSeq = seg.kind === "undo"
                  ? inverseAlg(cube.moves.slice(0, seg.start))
                  : expectedPhysical(expandRepeats(testInfo.str)).map((e) => e.rec);
                const cls = classifyDone(mv, expSeq).cls;
                return (
                  <div key={i} className={`test-rep test-rep--${seg.kind}`}>
                    <span className="test-rep-label">{seg.kind === "undo" ? "Undo" : `Rep ${seg.n}`}</span>
                    <span className="test-rep-moves">
                      {mv.length === 0 ? "\u2026" : mv.map((m, j) => (
                        <span key={j} className={cls[j] === "dev" ? "tb-dev" : cls[j] === "fix" ? "tb-fix" : ""}>{m}</span>
                      ))}
                    </span>
                  </div>
                );
              })}
              {seq?.phase === "done" && <div className="test-done">{"\u2713 back to solved"}</div>}
            </div>
          ) : guiding && phaseInfoRef.current.size ? (
            // The history is built STRAIGHT FROM THE PLANNED STEPS — nothing is inferred. Each step
            // recorded, when it was planned, where it starts, what algorithm it is, and what it is
            // called. So a row runs from one step's start to the next one's, and cannot contain a
            // move that belongs somewhere else. (This replaces a scheme that derived the boundaries
            // from the cube's state — "when did the pair become solved?" — and then tried to line
            // those up with the planning keys. The two could never agree exactly, and every
            // disagreement left moves stranded in the wrong row.)
            (() => {
              const keys = [...phaseInfoRef.current.keys()].sort((a, b) => a - b);
              const rows: JSX.Element[] = [];
              let pairNo = 0;
              let lastPair: string | undefined;
              keys.forEach((k, i) => {
                const info = phaseInfoRef.current.get(k)!;
                const from = i === 0 ? Math.min(k, guideStart ?? k) : k; // sweep up any lead-in
                const to = i + 1 < keys.length ? keys[i + 1] : cube.moves.length;
                const mv = cube.moves.slice(from, to);
                if (!mv.length) return;

                // Which of this step's variants did you actually follow? The one you deviated from
                // least.
                let bestV = 0;
                let bestExp = info.expecteds[0] ?? [];
                let bestCls = classifyPhase(mv, bestExp, algStartIn(bestExp, info.algStrings?.[0] ?? ""));
                let bestDev = bestCls.cls.filter((c) => c === "dev").length;
                for (let v = 1; v < info.expecteds.length; v++) {
                  const exp = info.expecteds[v];
                  const r = classifyPhase(mv, exp, algStartIn(exp, info.algStrings?.[v] ?? ""));
                  const dev = r.cls.filter((c) => c === "dev").length;
                  if (dev < bestDev) { bestV = v; bestExp = exp; bestCls = r; bestDev = dev; }
                }
                // The alignment is exactly what comes BEFORE the official algorithm — no more.
                const aufEnd = algStartIn(bestExp, info.algStrings?.[bestV] ?? "");
                const { cls, splitIdx } = bestCls;
                const meta = { end: aufEnd, hasU: bestExp.slice(0, aufEnd).some((m) => /^U/.test(m)) };

                // Label the step from what it IS, not from where it landed.
                let label: string;
                let phaseCls: string;
                if (info.extract) { label = "F2L · extract"; phaseCls = "X"; }
                else if (info.phase === "C") { label = "cross"; phaseCls = "C"; }
                else if (info.phase === "F") {
                  if (info.pair !== lastPair) { pairNo++; lastPair = info.pair; }
                  label = `F2L pair ${pairNo}`;
                  phaseCls = "F";
                } else if (info.phase === "O") {
                  label = info.ollKind === "corner" ? "OLL · corners" : "OLL · yellow cross";
                  phaseCls = "O";
                } else {
                  label = info.pllKind === "corner" ? "PLL · corners" : "PLL · edges";
                  phaseCls = "P";
                }

                const colour = (list: string[], base: number) =>
                  list.map((m, j) => (
                    <span key={j} className={cls[base + j] === "dev" ? "tb-dev" : cls[base + j] === "fix" ? "tb-fix" : ""}>{m} </span>
                  ));

                // An AUF is, by definition, U turns and reorientations only. Anything else in there
                // means it is not an alignment, whatever the arithmetic says.
                const isAlign = (m: string) => /^(U|y|x|z)/.test(m);
                const hasAuf = meta.hasU && splitIdx > 0 && mv.slice(0, splitIdx).every(isAlign);
                if (hasAuf) {
                  rows.push(
                    <div key={`${k}-auf`} className="hist-group hist-auf">
                      <span className="hist-label">AUF · align</span>
                      <span className="hist-moves">{colour(mv.slice(0, splitIdx), 0)}</span>
                    </div>
                  );
                }
                // If the whole step was alignment, the AUF row already said everything — don't add an
                // empty row underneath it claiming an algorithm was executed.
                const body = hasAuf ? mv.slice(splitIdx) : mv;
                if (!body.length) return;
                rows.push(
                  <div key={k} className={`hist-group hist-${phaseCls}`}>
                    <span className="hist-label">{label}</span>
                    <span className="hist-moves">{colour(body, hasAuf ? splitIdx : 0)}</span>
                  </div>
                );
              });
              return rows;
            })()
          ) : (
            <span className="hist-hint">
              {"Right-drag a corner to turn the front face \u00b7 keys R U F L D B M E S \u00b7 Shift = prime \u00b7 left-drag to orbit"}
            </span>
          )}
        </div>
        </>
        )}
        </div>

        {seq && seq.phase === "F" && !seq.isExtraction && seq.category && CAT_INFO[seq.category] ? (
          <div className="cat-col">
            <img onError={hideMissingImage}
              className="cat-panel__img"
              src={`/f2l-cats/${encodeURIComponent(CAT_INFO[seq.category].file)}`}
              alt={CAT_INFO[seq.category].title}
              onClick={() => setZoomImg(`/f2l-cats/${encodeURIComponent(CAT_INFO[seq.category!].file)}`)}
            />
            <div className="cat-panel__title">{CAT_INFO[seq.category].title}</div>
          </div>
        ) : seq && seq.phase === "O" ? (
          <div className="cat-col">
            <img onError={hideMissingImage} className="cat-panel__img" src="/oll-2look.png" alt="2-look OLL algorithms" onClick={() => setZoomImg("/oll-2look.png")} />
            <div className="cat-panel__title">{"OLL \u00b7 orient the last layer (2-look)"}</div>
          </div>
        ) : seq && seq.phase === "P" ? (
          <div className="cat-col">
            <img onError={hideMissingImage} className="cat-panel__img" src="/pll-2look.png" alt="2-look PLL algorithms" onClick={() => setZoomImg("/pll-2look.png")} />
            <div className="cat-panel__title">{"PLL \u00b7 permute the last layer (2-look)"}</div>
          </div>
        ) : (
          <div className="cat-col" />
        )}
      </div>

      {zoomImg && (
        <div className="cat-zoom" onClick={() => setZoomImg(null)}>
          <img src={zoomImg} alt="algorithm sheet" />
        </div>
      )}

      {mode === "choose" && (
        <div className="welcome">
          <div className="welcome__card">
            <h2>Cube Coach</h2>
            <p className="welcome__sub">How are you solving today?</p>
            <div className="welcome__opts">
              <button
                className="welcome__opt"
                onClick={() => { setMode("virtual"); setLeftTab("keys"); }}
              >
                <span className="welcome__opt-title">Without a smart cube</span>
                <span className="welcome__opt-desc">
                  Practise on screen — turn the cube with the buttons or the keyboard. Works with any
                  cube in your hands, or none at all.
                </span>
              </button>
              <button
                className="welcome__opt welcome__opt--primary"
                onClick={async () => {
                  await phys.connect();
                  setMode("cube");
                  setLeftTab("console");
                }}
                disabled={phys.status === "connecting"}
              >
                <span className="welcome__opt-title">
                  {phys.status === "connecting" ? "Connecting\u2026" : "With a smart cube"}
                </span>
                <span className="welcome__opt-desc">
                  Connect a GAN cube over Bluetooth. Your real turns drive the app — solve with your
                  hands and it follows.
                </span>
              </button>
            </div>
            {phys.errorMessage && <p className="welcome__err">{phys.errorMessage}</p>}
          </div>
        </div>
      )}

      {sheetView && (
        <div className="sheet-screen">
          <div className="sheet-screen__bar">
            <div className="sheet-screen__tabs">
              {(["F", "O", "P"] as const).map((k) => (
                <button
                  key={k}
                  className={`btn${sheetPick === k ? " btn--accent" : ""}`}
                  onClick={() => setSheetPick(k)}
                >
                  {k === "F" ? "F2L" : k === "O" ? "OLL" : "PLL"}
                </button>
              ))}
              {seq && guideProgress?.caseName && (
                <span className="sheet-screen__now">now: {guideProgress.caseName}</span>
              )}
            </div>
            <button className="btn" onClick={() => setSheetView(false)}>Close</button>
          </div>
          <div className="sheet-screen__body">
            {sheetPick === "F" ? (
              seq?.category && CAT_INFO[seq.category] ? (
                <img onError={hideMissingImage} src={`/f2l-cats/${encodeURIComponent(CAT_INFO[seq.category].file)}`} alt="F2L case" />
              ) : (
                <div className="sheet-screen__empty">F2L sheets appear while you are solving a pair.</div>
              )
            ) : sheetPick === "O" ? (
              <img onError={hideMissingImage} src="/oll-2look.png" alt="2-look OLL algorithms" />
            ) : (
              <img onError={hideMissingImage} src="/pll-2look.png" alt="2-look PLL algorithms" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
