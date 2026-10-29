import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { CubeModel, faceletsToModel, parseMove, COLORS, type Move, type Cubie } from "../cube/CubeModel";
import { buildFrom } from "../cube/f2l";
import { pointToCell, type Cell } from "../cube/grid";
import { PulseGuide, StickyLabels } from "./FaceHighlight";
import { MoveArrow } from "./MoveArrow";
import type { FaceLetter } from "../cube/grid";
import { orientationToQuaternion, visualQuaternion } from "./gyroMath";
export { orientationToQuaternion };


const SPACING = 1.06;
const TURN_MS = 160;
const DRAG_THRESHOLD = 8; // px before a linear right-drag counts as a turn
const DRAG_INVERT = 1; // flip if linear-drag turns feel reversed
const CORNER_INVERT = 1; // flip if corner-gesture direction feels reversed

const AXIS_VEC: Record<Move["axis"], THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

const FACE_FOR: Record<string, "R" | "L" | "U" | "D" | "F" | "B" | "M" | "E" | "S"> = {
  "x1": "R", "x-1": "L", "y1": "U", "y-1": "D", "z1": "F", "z-1": "B",
  "x0": "M", "y0": "E", "z0": "S",
};
const BASE_SIGN: Record<string, number> = {
  R: -1, L: 1, U: -1, D: 1, F: -1, B: 1, M: 1, E: 1, S: -1,
};

function project(v: THREE.Vector3, cam: THREE.Camera, w: number, h: number) {
  const p = v.clone().project(cam);
  return new THREE.Vector2((p.x * 0.5 + 0.5) * w, (-p.y * 0.5 + 0.5) * h);
}

// --- corner-gesture geometry (operates on the traced cell path) -----------
function isCorner(path: Cell[]): boolean {
  if (path.length !== 3) return false;
  if (!path.every((c) => c.face === path[0].face)) return false;
  const [a, b, c] = path;
  const adj = (p: Cell, q: Cell) => Math.abs(p.row - q.row) + Math.abs(p.col - q.col) === 1;
  if (!adj(a, b) || !adj(b, c)) return false;
  const seg1Row = b.row - a.row !== 0;
  const seg2Row = c.row - b.row !== 0;
  return seg1Row !== seg2Row; // one segment vertical, the other horizontal => L
}

/** Face-turn token from a valid corner path (direction from the turn's winding). */
function cornerToken(path: Cell[]): string {
  const [a, b, c] = path;
  const v1 = { x: b.col - a.col, y: b.row - a.row };
  const v2 = { x: c.col - b.col, y: c.row - b.row };
  const cross = v1.x * v2.y - v1.y * v2.x; // screen-space (y-down) winding
  const clockwise = cross * CORNER_INVERT > 0;
  const face = path[0].face; // U/D/F/B/L/R
  return clockwise ? face : `${face}'`;
}

const GREY = "#2b2d33";
const PINK = "#ff4fa3";

const colorSetOf = (c: Cubie) => c.colors.filter((x) => x !== COLORS.inner).slice().sort().join("|");

function CubieMesh({
  cubie,
  onPick,
  grey,
  pink,
  glow,
  flash,
}: {
  cubie: Cubie;
  onPick: (e: ThreeEvent<PointerEvent>, cubie: Cubie) => void;
  grey?: boolean;
  pink?: boolean;
  glow?: boolean;  // steady halo — the pair you are working on
  flash?: boolean; // quick celebratory blink — the pair that just went home
}) {
  const faceColor = (color: string) => {
    if (color === "#161616") return color; // inner stays inner
    if (pink) return PINK;
    if (grey) return GREY;
    return color;
  };
  // A glow on the stickers alone was far too easy to miss. Instead the piece gets a bright halo
  // shell around it — a slightly larger, glowing box that breathes. It reads instantly, from any
  // angle, and it does not hide the piece's real colours (which are exactly what you need to see).
  const halo = useRef<THREE.Mesh>(null);
  const haloMat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    if ((!glow && !flash) || !halo.current || !haloMat.current) return;
    if (flash) {
      // Fast, bright, unmistakable — a piece coming home should feel like it landed.
      const t = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 22);
      haloMat.current.opacity = 0.25 + 0.75 * t;
      const sc = 1.10 + 0.13 * t;
      halo.current.scale.set(sc, sc, sc);
      return;
    }
    const t = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 3.6);
    haloMat.current.opacity = 0.30 + 0.35 * t;
    const sc = 1.10 + 0.05 * t;
    halo.current.scale.set(sc, sc, sc);
  });
  return (
    <group
      position={[cubie.pos.x * SPACING, cubie.pos.y * SPACING, cubie.pos.z * SPACING]}
      // Pass the orientation as NUMBERS, not as the quaternion object. The object is mutated in
      // place by applyMove, so its identity never changes and the renderer would skip updating it —
      // it only refreshed a cubie when its POSITION prop changed. That is exactly why whole-cube
      // rotations broke: the pieces sitting ON the axis of rotation (the R and L centres during an
      // x) turn in place without moving, so their new orientation was never applied. Their colours
      // kept pointing the old way — inward, visible through the cracks — leaving the black inside
      // facing out.
      quaternion={[cubie.quat.x, cubie.quat.y, cubie.quat.z, cubie.quat.w]}
      onPointerDown={(e) => onPick(e, cubie)}
    >
      {(glow || flash) && (
        <mesh ref={halo} renderOrder={3}>
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial
            ref={haloMat}
            color={flash ? "#7cff9e" : "#ff5ec8"}
            transparent
            opacity={0.4}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      )}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
        {cubie.colors.map((color, i) => (
          <meshStandardMaterial
            key={i}
            attach={`material-${i}`}
            color={faceColor(color)}
            emissive={pink && color !== "#161616" ? PINK : "#000000"}
            emissiveIntensity={pink && color !== "#161616" ? 0.35 : 0}
            roughness={0.32}
            metalness={0.05}
          />
        ))}
      </mesh>
    </group>
  );
}

interface Animation {
  move: Move;
  movingIds: Set<number>;
  start: number;
  snapTo?: Cubie[]; // when set, the model becomes exactly this after the turn (facelets truth)
}
const _FN: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
// The orientation of a model's centres — the core's rotation, derived purely from the move
// stream (no gyro). Used to bring the core-frame facelet truth into your grip frame.
function centerQuat(m: CubeModel): THREE.Quaternion {
  const dirOf = (color: string) => {
    for (const c of m.cubies) {
      if (c.colors.filter((x) => x !== COLORS.inner).length !== 1) continue;
      for (let i = 0; i < 6; i++) if (c.colors[i] === color) return new THREE.Vector3(..._FN[i]).applyQuaternion(c.quat);
    }
    return new THREE.Vector3();
  };
  const M = new THREE.Matrix4().makeBasis(dirOf(COLORS.R), dirOf(COLORS.U), dirOf(COLORS.F));
  return new THREE.Quaternion().setFromRotationMatrix(M);
}

// Sticky labels: the in-plane "up" (in the solved frame) that keeps each centre's letter
// upright. Applied to the centre cubie's current quaternion, it tracks the colour wherever
// wide moves / turns push it, so the letter reads correctly when U (yellow) is up.
const COLOR_UP: Record<string, [number, number, number]> = {
  [COLORS.F]: [0, 1, 0], [COLORS.B]: [0, 1, 0], [COLORS.U]: [0, 0, -1],
  [COLORS.D]: [0, 0, 1], [COLORS.R]: [0, 1, 0], [COLORS.L]: [0, 1, 0],
};

// Which SCREEN face a world-space (gyro-rotated) normal points at (nearest axis), as a
// committed-frame letter: +Z→F (toward you), +Y→U, +X→R, and their opposites. The centre
// facing the front reads F; the letter flips only when a centre crosses 45° into the next
// axis. Fed the centre's on-screen normal, so real moves relabel faces but a small tilt
// doesn't — after a wide r the white centre now at the front reads F.
function screenFaceLetter(v: THREE.Vector3): string {
  const ax: [string, number][] = [["R", v.x], ["L", -v.x], ["U", v.y], ["D", -v.y], ["F", v.z], ["B", -v.z]];
  ax.sort((a, b) => b[1] - a[1]);
  return ax[0][0];
}

interface Gesture {
  startX: number;
  startY: number;
  normal: THREE.Vector3;
  hit: THREE.Vector3;
  pos: THREE.Vector3;
  path: Cell[];
  diag: TraceStep[];
}

export interface TraceStep {
  index: number;
  face: string;
  px: number;
  py: number;
  pz: number;
  nx: number;
  ny: number;
  nz: number;
}

export function Cube3D({
  moves,
  faceletsState,
  onMove,
  onCellPick,
  onPath,
  displayOnly,
  greyIds,
  pinkIds,
  glowSets,
  flashSets,
  offsetX = 0,
  snapOnMount,
  paint,
  onPaintFace,
  orientationRef,
  calibRef,
  gyroView,
  pulseDir,
  nextMove,
  fixMove,
  showGuides,
}: {
  moves: string[];
  faceletsState?: string | null;
  onMove?: (token: string) => void;
  onCellPick?: (cell: Cell) => void;
  onPath?: (steps: TraceStep[] | null) => void;
  displayOnly?: boolean;
  greyIds?: Set<number>;
  pinkIds?: Set<number>;
  // Pieces to highlight, named by their COLOUR SET ("sorted|colours"). A cubie's id is not stable —
  // when the model is rebuilt from the cube's facelets, ids belong to SLOTS, not to pieces — so an
  // id-based highlight would sit on the destination slot and never follow the piece you must watch.
  glowSets?: Set<string>;
  // Pieces that just landed home: a quick, bright flash. Separate from glowSets on purpose — the
  // celebration and the next pair's highlight run at the same time, so a fast solver never waits.
  flashSets?: Set<string>;
  offsetX?: number;
  snapOnMount?: boolean;
  paint?: { pos: THREE.Vector3; colors: string[] }[];
  onPaintFace?: (index: number, dir: [number, number, number]) => void;
  orientationRef?: React.MutableRefObject<{ x: number; y: number; z: number; w: number } | null>;
  calibRef?: React.MutableRefObject<THREE.Quaternion | null>;
  gyroView?: boolean; // FRONTEND ONLY: when true, the gyro orients the on-screen cube (mirrors how
  // you hold it). Off by default — the cube sits in a fixed grip frame. Never touches the backend.
  pulseFace?: FaceLetter | null;
  pulseDir?: [number, number, number] | null;
  nextMove?: string | null;
  fixMove?: boolean;
  showGuides?: boolean;
}) {
  // For the twin (snapOnMount), build the model already at the current state and
  // start the cursor at the end — done synchronously at construction so the frame
  // loop never races the snap and double-applies the first move.
  const model = useMemo(() => {
    const m = new CubeModel();
    if (snapOnMount) {
      for (const t of moves) { const mv = parseMove(t); if (mv) m.applyMove(mv); }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [, forceRender] = useState(0);
  const bump = () => forceRender((n) => n + 1);

  // A cubie can never legitimately show its black inside on an outward face — applying moves to a
  // valid cube always keeps the stickers out. If we ever see that, the renderer's model has drifted
  // from the move list (not the move list itself: that is provably fine). Rather than leave you
  // staring at a broken cube, rebuild the model from the moves, which is the source of truth.
  const FACE_N: [number, number, number][] = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  const isBroken = (m: CubeModel) => {
    for (const c of m.cubies) {
      for (let i = 0; i < 6; i++) {
        if (c.colors[i] !== COLORS.inner) continue;
        const n = new THREE.Vector3(...FACE_N[i]).applyQuaternion(c.quat);
        const out =
          (Math.round(n.x) === 1 && Math.round(c.pos.x) === 1) ||
          (Math.round(n.x) === -1 && Math.round(c.pos.x) === -1) ||
          (Math.round(n.y) === 1 && Math.round(c.pos.y) === 1) ||
          (Math.round(n.y) === -1 && Math.round(c.pos.y) === -1) ||
          (Math.round(n.z) === 1 && Math.round(c.pos.z) === 1) ||
          (Math.round(n.z) === -1 && Math.round(c.pos.z) === -1);
        if (out) return true;
      }
    }
    return false;
  };
  const rebuild = () => {
    const fresh = new CubeModel();
    for (const t of movesRef.current) { const mv = parseMove(t); if (mv) fresh.applyMove(mv); }
    model.cubies = fresh.cubies;
    cursor.current = movesRef.current.length;
    anim.current = null;
    if (pivot.current) pivot.current.quaternion.identity();
    console.warn("[Cube3D] model had drifted (inside-out cubies) — rebuilt from the move list", [...movesRef.current]);
    bump();
  };

  // When the physical cube reports its true state (facelets), snap the model to it — this
  // is the ground truth and handles wide moves and any desync the move stream can't.
  useEffect(() => {
    if (!faceletsState) return;
    const truth = faceletsToModel(faceletsState);
    // Facelets are reported in the CORE frame (a wide r looks like L there — green stays on F).
    // Rotate the truth by the core orientation (derived from the moves — NO gyro) so it lands in
    // YOUR grip frame: after a wide r, white sits on F and green on U, exactly what you hold.
    const cq = centerQuat(buildFrom(movesRef.current));
    if (Math.abs(cq.x) > 1e-6 || Math.abs(cq.y) > 1e-6 || Math.abs(cq.z) > 1e-6) {
      for (const c of truth.cubies) {
        c.pos.applyQuaternion(cq);
        c.pos.set(Math.round(c.pos.x), Math.round(c.pos.y), Math.round(c.pos.z));
        c.quat.premultiply(cq);
      }
    }
    // Try to find a single quarter/half turn (or wide) that takes the current model to the truth,
    // so we can animate it. If none matches (a jump/desync), snap instantly — facelets is truth.
    const sigOf = (m: CubeModel) => {
      const o: string[] = [];
      for (const c of m.cubies)
        for (let i = 0; i < 6; i++) {
          if (c.colors[i] === "#161616") continue;
          const d = new THREE.Vector3(..._FN[i]).applyQuaternion(c.quat);
          o.push(`${Math.round(c.pos.x)},${Math.round(c.pos.y)},${Math.round(c.pos.z)}:${Math.round(d.x)},${Math.round(d.y)},${Math.round(d.z)}:${c.colors[i]}`);
        }
      return o.sort().join("|");
    };
    const target = sigOf(truth);
    if (sigOf(model) === target) { cursor.current = movesRef.current.length; return; }
    const CANDS = ["U", "U'", "D", "D'", "R", "R'", "L", "L'", "F", "F'", "B", "B'",
      "r", "r'", "l", "l'", "u", "u'", "d", "d'", "f", "f'", "b", "b'",
      "U2", "D2", "R2", "L2", "F2", "B2"];
    let picked: Move | null = null;
    for (const tok of CANDS) {
      const mv = parseMove(tok);
      if (!mv) continue;
      const trial = model.clone();
      trial.applyMove(mv);
      if (sigOf(trial) === target) { picked = mv; break; }
    }
    if (picked && !anim.current) {
      anim.current = { move: picked, movingIds: model.selectLayer(picked), start: performance.now(), snapTo: truth.cubies };
      cursor.current = movesRef.current.length;
      bump();
    } else {
      model.cubies = truth.cubies;
      cursor.current = movesRef.current.length;
      bump();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faceletsState, moves.length]);

  const cursor = useRef(snapOnMount ? moves.length : 0);
  const anim = useRef<Animation | null>(null);
  const pivot = useRef<THREE.Group>(null);
  const root = useRef<THREE.Group>(null);
  const movesRef = useRef(moves);
  movesRef.current = moves;
  const faceletsRef = useRef(faceletsState);
  faceletsRef.current = faceletsState;

  const { camera, size, gl } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const gesture = useRef<Gesture | null>(null);

  // Which committed letter each centre colour wears. It's decided from the on-screen
  // orientation, but FROZEN between real moves: we only recompute when the facelets (a real
  // move) change — never on a bare gyro change (inspection). So a wide r relabels the white
  // centre that comes to the front as F. Letters are computed directly in render (centerLabels).

  useEffect(() => {
    if (moves.length < cursor.current) {
      model.reset();
      cursor.current = 0;
      anim.current = null;
      bump();
    }
  }, [moves, model]);

  // --- raycast the pointer against the cube, return cell + raw hit data ---
  const cellAt = (
    clientX: number,
    clientY: number
  ): { cell: Cell; point: THREE.Vector3; normal: THREE.Vector3 } | null => {
    if (!root.current) return null;
    const rect = gl.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(root.current.children, true);
    const hit = hits.find((h) => h.face);
    if (!hit || !hit.face) return null;
    const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    return { cell: pointToCell(hit.point, worldNormal), point: hit.point.clone(), normal: worldNormal };
  };

  const onDragMove = (ev: PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const res = cellAt(ev.clientX, ev.clientY);
    if (!res) return;
    // A corner is drawn on a single face. Any hit on a different face than the
    // one we started on is the ray escaping through a gap to a sticker behind —
    // reject it. This is the fix for the phantom-cell bug.
    if (res.cell.face !== g.path[0].face) return;
    const last = g.path[g.path.length - 1];
    if (!last || last.index !== res.cell.index || last.face !== res.cell.face) {
      g.path.push(res.cell);
      g.diag.push({
        index: res.cell.index,
        face: res.cell.face,
        px: +res.point.x.toFixed(2),
        py: +res.point.y.toFixed(2),
        pz: +res.point.z.toFixed(2),
        nx: Math.round(res.normal.x),
        ny: Math.round(res.normal.y),
        nz: Math.round(res.normal.z),
      });
      onPath?.([...g.diag]);
    }
  };

  const linearTurn = (g: Gesture, endX: number, endY: number) => {
    if (!onMove) return;
    const drag = new THREE.Vector2(endX - g.startX, endY - g.startY);
    if (drag.length() < DRAG_THRESHOLD) return;
    const n = g.normal;
    const nIdx = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)].indexOf(
      Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z))
    );
    const axisLetters: Array<Move["axis"]> = ["x", "y", "z"];
    const candidates = axisLetters.filter((_, i) => i !== nIdx);
    let best: { axis: Move["axis"]; sign: number; score: number } | null = null;
    for (const ax of candidates) {
      const tangent = new THREE.Vector3().crossVectors(AXIS_VEC[ax], n).normalize();
      const s0 = project(g.hit, camera, size.width, size.height);
      const s1 = project(g.hit.clone().add(tangent.multiplyScalar(0.5)), camera, size.width, size.height);
      const screenT = s1.sub(s0);
      if (screenT.lengthSq() < 1e-6) continue;
      const dot = drag.dot(screenT.normalize());
      if (!best || Math.abs(dot) > Math.abs(best.score)) {
        best = { axis: ax, sign: Math.sign(dot) * DRAG_INVERT, score: dot };
      }
    }
    if (!best) return;
    const layer = Math.round(g.pos[best.axis]);
    const face = FACE_FOR[`${best.axis}${layer}`];
    if (!face) return;
    onMove(best.sign === BASE_SIGN[face] ? face : `${face}'`);
  };

  const finishGesture = (endX: number, endY: number) => {
    const g = gesture.current;
    gesture.current = null;
    onPath?.(null);
    if (!g || !onMove) return;

    if (isCorner(g.path)) {
      onMove(cornerToken(g.path)); // precise 3-cell L -> face turn
    } else if (g.path.length >= 4) {
      return; // messy path (often a semi-rotated corner attempt) -> ignore
    } else {
      linearTurn(g, endX, endY); // short swipe -> R/U/L/D/M/E/S as before
    }
  };

  const onPick = (e: ThreeEvent<PointerEvent>, cubie: Cubie) => {
    if (e.intersections[0]?.object !== e.object) return; // front sticker only
    if (!e.face) return;
    const worldNormal = e.face.normal.clone().transformDirection(e.object.matrixWorld);
    const startCell = pointToCell(e.point, worldNormal);
    onCellPick?.(startCell);

    if (e.nativeEvent.button !== 0) return;
    const startStep: TraceStep = {
      index: startCell.index,
      face: startCell.face,
      px: +e.point.x.toFixed(2),
      py: +e.point.y.toFixed(2),
      pz: +e.point.z.toFixed(2),
      nx: Math.round(worldNormal.x),
      ny: Math.round(worldNormal.y),
      nz: Math.round(worldNormal.z),
    };
    gesture.current = {
      startX: e.nativeEvent.clientX,
      startY: e.nativeEvent.clientY,
      normal: worldNormal,
      hit: e.point.clone(),
      pos: cubie.pos.clone(),
      path: [startCell],
      diag: [startStep],
    };
    onPath?.([startStep]);
    const move = (ev: PointerEvent) => onDragMove(ev);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      finishGesture(ev.clientX, ev.clientY);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // The inverse of the core rotation the model has baked in (recomputed only when the moves change).
  const coreQInv = useRef(new THREE.Quaternion());
  useEffect(() => {
    coreQInv.current = centerQuat(buildFrom(moves)).invert();
  }, [moves]);

  useFrame(() => {
    // FRONTEND-ONLY view orientation. The backend draws the cube in a fixed grip frame (facelet
    // truth rotated into grip by the core orientation). When gyroView is ON, the gyro additionally
    // orients the whole cube on screen to mirror how you physically hold it — a pure camera-style
    // rotation, no compensation, that never feeds back into the backend. When OFF (default), the
    // cube stays in the fixed grip frame (the camera gives the 3/4 view). Sticky letters are
    // computed in render from the model (see centerLabels) — independent of this.
    if (gyroView && orientationRef?.current && root.current) {
      const q = visualQuaternion(orientationRef.current, calibRef?.current ?? null, null);
      if (q) {
        // The model already carries the core's rotation: an auto-applied y turns the model's centres
        // the instant it is planned, while the cube in your hand has not moved yet — and when you
        // then DO turn it, the gyro rotates the view again, counting the same rotation twice. That
        // is the teleport-and-desync. Undoing the model's own core rotation here leaves the view
        // showing the cube exactly as you hold it, and a reorientation no longer jumps the screen.
        root.current.quaternion.slerp(q.multiply(coreQInv.current), 0.35);
      }
    }

    // When facelets are the source of truth, the model is snapped from them — never also
    // animate the move stream, or the turn would be applied twice.
    if (!faceletsRef.current && !anim.current && cursor.current < movesRef.current.length) {
      const mv = parseMove(movesRef.current[cursor.current]);
      if (!mv) {
        cursor.current++;
        return;
      }
      if (mv.whole) {
        // Whole-cube rotation (x/y/z): apply instantly. Animating it would fight
        // the gyro (which already shows the physical turn) and cause a visual jump.
        model.applyMove(mv);
        cursor.current++;
        if (isBroken(model)) { rebuild(); return; }
        bump();
        return;
      }
      anim.current = { move: mv, movingIds: model.selectLayer(mv), start: performance.now() };
      bump();
      return;
    }
    if (anim.current && pivot.current) {
      const { move, start } = anim.current;
      const t = Math.min(1, (performance.now() - start) / TURN_MS);
      pivot.current.quaternion.setFromAxisAngle(AXIS_VEC[move.axis], move.angle * ease(t));
      if (t >= 1) {
        if (anim.current.snapTo) {
          model.cubies = anim.current.snapTo; // land exactly on the cube's reported state
        } else {
          model.applyMove(move);
          cursor.current++;
        }
        anim.current = null;
        pivot.current.quaternion.identity();
        if (isBroken(model)) { rebuild(); return; }
        bump();
      }
    }
  });

  const moving = anim.current?.movingIds;
  const pick = displayOnly ? () => {} : onPick;

  // Sticky labels: each label sits ON its centre's sticker (position + orientation from the
  // centre cubie, so it rides the colour as the cube turns). The LETTER is screen-relative
  // (faceLetters) — the centre you're facing reads F, the one on top U, etc. After a wide r
  // the white centre now at the front reads F (the former D became the new F). While we walk
  // the centres we also record each labelled face's model normal, to build the grip frame the
  // sticky pulse/arrows are drawn in.
  const gripNormals: Record<string, THREE.Vector3> = {};
  const centerLabels = showGuides
    ? model.cubies.flatMap((c) => {
        const slots = c.colors
          .map((col, i) => ({ col, i }))
          .filter((s) => s.col !== COLORS.inner);
        if (slots.length !== 1) return []; // centres only
        const { col, i } = slots[0];
        const normal = new THREE.Vector3(..._FN[i]).applyQuaternion(c.quat);
        // Read the letter straight from the model's grip frame (no gyro, no frozen state): the
        // centre facing +Z is F, +Y is U, +X is R, etc. The facelet truth is already rotated into
        // your grip frame, so after a y the orange centre is at +Z and reads F.
        const letter = screenFaceLetter(normal);
        if (!letter) return [];
        gripNormals[letter] = normal.clone();
        const up = new THREE.Vector3(...(COLOR_UP[col] ?? [0, 1, 0])).applyQuaternion(c.quat);
        return [{ letter, normal, up }];
      })
    : [];

  // Grip frame: the orientation, in model space, of the current F/U/R centres. Drawing the
  // pulse and arrows inside a group rotated by this puts them on the right centres (F on the
  // centre you face, U on top, …) AND — since it lives inside the gyro-rotated cube — makes
  // them sticky: they ride the faces as you turn the cube, instead of floating in space.
  const gripQuat = (() => {
    const nF = gripNormals["F"], nU = gripNormals["U"], nR = gripNormals["R"];
    if (!nF || !nU || !nR) return null;
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(nR, nU, nF));
  })();

  // Paint mode: render the painted cubies statically; left-click colours a face.
  if (paint) {
    return (
      <group ref={root} position={[offsetX, 0, 0]}>
        {paint.map((c, i) => (
          <group key={i} position={[c.pos.x * SPACING, c.pos.y * SPACING, c.pos.z * SPACING]}>
            <mesh
              castShadow
              receiveShadow
              onPointerDown={(e) => {
                if (e.intersections[0]?.object !== e.object) return;
                if (!e.face || e.nativeEvent.button !== 0) return;
                const n = e.face.normal.clone().transformDirection(e.object.matrixWorld);
                onPaintFace?.(i, [Math.round(n.x), Math.round(n.y), Math.round(n.z)]);
              }}
            >
              <boxGeometry args={[1, 1, 1]} />
              {c.colors.map((col, fi) => (
                <meshStandardMaterial
                  key={fi}
                  attach={`material-${fi}`}
                  color={col}
                  roughness={0.32}
                  metalness={0.05}
                />
              ))}
            </mesh>
          </group>
        ))}
      </group>
    );
  }

  return (
    <>
      <group ref={root} position={[offsetX, 0, 0]}>
        {model.cubies
          .filter((c) => !moving || !moving.has(c.id))
          .map((c) => (
            <CubieMesh key={c.id} cubie={c} onPick={pick} grey={greyIds?.has(c.id)} pink={pinkIds?.has(c.id)} glow={glowSets?.has(colorSetOf(c))} flash={flashSets?.has(colorSetOf(c))} />
          ))}
        <group ref={pivot}>
          {moving &&
            model.cubies
              .filter((c) => moving.has(c.id))
              .map((c) => <CubieMesh key={c.id} cubie={c} onPick={pick} grey={greyIds?.has(c.id)} pink={pinkIds?.has(c.id)} glow={glowSets?.has(colorSetOf(c))} flash={flashSets?.has(colorSetOf(c))} />)}
        </group>
        {/* Sticky labels live INSIDE the cube so each letter rides its own colour centre. */}
        {showGuides && <StickyLabels centers={centerLabels} />}
        {/* Pulse + move arrows are drawn in the grip frame and INSIDE the cube, so they sit on
            the right centres (pulse on the F face you execute on, arrow on the turning face)
            and stay stuck to those faces as you turn the cube — no longer floating in space. */}
        {showGuides && gripQuat && (
          <group quaternion={gripQuat}>
            <PulseGuide pulseDir={pulseDir ?? [0, 0, 1]} />
            {nextMove && <MoveArrow token={nextMove} fix={fixMove} />}
          </group>
        )}
      </group>
    </>
  );
}
