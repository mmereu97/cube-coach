import { Line } from "@react-three/drei";
import * as THREE from "three";
import { FACES } from "./FaceHighlight";
import type { FaceLetter } from "../cube/grid";

/**
 * MoveArrow — draws, on the face a move turns, a curved arrow showing the turn
 * direction (clockwise for R/U/F..., counter-clockwise for primes), plus a steady
 * amber outline on that face. This is the "do this next" cue for guided solving.
 *
 * Only face turns are cued (R U F L D B). Slices/rotations don't appear in cross
 * solutions, so they aren't handled here.
 */

const ARC_R = 1.15; // arc radius in the face plane
const ARC_OUT = 1.66; // how far outside the surface the arrow floats
const OUTLINE_OUT = 1.61;
const HALF = 1.62;
const AMBER = "#ffb020";

const SQUARE: [number, number, number][] = [
  [-HALF, -HALF, 0], [HALF, -HALF, 0], [HALF, HALF, 0], [-HALF, HALF, 0], [-HALF, -HALF, 0],
];

function arcPoints(cw: boolean, sweepDeg: number): {
  points: [number, number, number][];
  tip: [number, number, number];
  tipAngle: number;
} {
  const startDeg = cw ? 210 : 150;
  const dir = cw ? -1 : 1; // cw = decreasing angle as seen from outside
  const N = 48;
  const points: [number, number, number][] = [];
  let endAng = 0;
  for (let i = 0; i <= N; i++) {
    const deg = startDeg + dir * sweepDeg * (i / N);
    const ang = (deg * Math.PI) / 180;
    endAng = ang;
    points.push([ARC_R * Math.cos(ang), ARC_R * Math.sin(ang), 0]);
  }
  const tip: [number, number, number] = [ARC_R * Math.cos(endAng), ARC_R * Math.sin(endAng), 0];
  // Tangent (motion direction) at the tip.
  const tipAngle = Math.atan2(dir * Math.cos(endAng), -dir * Math.sin(endAng));
  return { points, tip, tipAngle };
}

export function MoveArrow({ token, fix }: { token: string; fix?: boolean }) {
  const FACE_COLOR = fix ? "#3ddc84" : AMBER;
  // Wide (double-layer) moves: r l u d f b — draw the turn on BOTH the outer face
  // and the adjacent middle layer, so it's clear two layers move together.
  const wide = /^([rludfb])(['2]?)$/.exec(token);
  if (wide) {
    const letter = wide[1];
    const prime = wide[2] === "'";
    const WIDE = "#ffd54a";
    const S = 1.66;   // just above the surface
    const LEN = 0.72; // half-length of each arrow

    // For each wide move: which visible face to draw on, the two layer coordinates,
    // and the in-plane motion direction (unprimed). Both layers get a parallel arrow.
    type Cfg = { plane: "top" | "front"; axis: "x" | "y" | "z"; vals: [number, number]; dir: [number, number, number] };
    const CFG: Record<string, Cfg> = {
      r: { plane: "top", axis: "x", vals: [1, 0], dir: [0, 0, -1] },
      l: { plane: "top", axis: "x", vals: [-1, 0], dir: [0, 0, 1] },
      f: { plane: "top", axis: "z", vals: [1, 0], dir: [1, 0, 0] },
      b: { plane: "top", axis: "z", vals: [-1, 0], dir: [-1, 0, 0] },
      u: { plane: "front", axis: "y", vals: [1, 0], dir: [-1, 0, 0] },
      d: { plane: "front", axis: "y", vals: [-1, 0], dir: [1, 0, 0] },
    };
    const cfg = CFG[letter];
    if (!cfg) return null;
    const dir = new THREE.Vector3(...cfg.dir).multiplyScalar(prime ? -1 : 1);
    const center = (v: number): THREE.Vector3 => {
      if (cfg.plane === "top") {
        return cfg.axis === "x" ? new THREE.Vector3(v, S, 0) : new THREE.Vector3(0, S, v);
      }
      return new THREE.Vector3(0, v, S); // front plane, axis y
    };
    const coneQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone());

    return (
      <>
        {cfg.vals.map((v, i) => {
          const c = center(v);
          const tail = c.clone().addScaledVector(dir, -LEN);
          const head = c.clone().addScaledVector(dir, LEN);
          return (
            <group key={i}>
              <Line points={[[tail.x, tail.y, tail.z], [head.x, head.y, head.z]]} color={WIDE} lineWidth={5} />
              <mesh position={[head.x, head.y, head.z]} quaternion={coneQuat}>
                <coneGeometry args={[0.13, 0.32, 16]} />
                <meshStandardMaterial color={WIDE} emissive={WIDE} emissiveIntensity={0.45} />
              </mesh>
            </group>
          );
        })}
      </>
    );
  }

  const slice = /^M(['2]?)$/.exec(token);
  if (slice) {
    const prime = slice[1] === "'";
    // M follows L: the middle column's front face travels downward; M' upward.
    const down = !prime;
    const SLICE_COLOR = "#7ce0ff";
    const yTop = 1.0, yBot = -1.0, zc = 1.63;
    const tail: [number, number, number] = [0, down ? yTop : yBot, zc];
    const head: [number, number, number] = [0, down ? yBot : yTop, zc];
    const coneQuat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, down ? -1 : 1, 0)
    );
    // outline of the middle vertical slice on the front face
    const band: [number, number, number][] = [
      [-0.55, -1.6, 1.61], [0.55, -1.6, 1.61], [0.55, 1.6, 1.61], [-0.55, 1.6, 1.61], [-0.55, -1.6, 1.61],
    ];
    return (
      <>
        <Line points={band} color={SLICE_COLOR} lineWidth={3} transparent opacity={0.85} />
        <Line points={[tail, head]} color={SLICE_COLOR} lineWidth={5} />
        <mesh position={head} quaternion={coneQuat}>
          <coneGeometry args={[0.16, 0.36, 16]} />
          <meshStandardMaterial color={SLICE_COLOR} emissive={SLICE_COLOR} emissiveIntensity={0.5} />
        </mesh>
      </>
    );
  }

  const eSlice = /^E(['2]?)$/.exec(token);
  if (eSlice) {
    const prime = eSlice[1] === "'";
    // E follows D: the front middle ROW travels left; E' right.
    const left = !prime;
    const SLICE_COLOR = "#7ce0ff";
    const zc = 1.63;
    const tail: [number, number, number] = [left ? 1.0 : -1.0, 0, zc];
    const head: [number, number, number] = [left ? -1.0 : 1.0, 0, zc];
    const coneQuat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), new THREE.Vector3(left ? -1 : 1, 0, 0)
    );
    const band: [number, number, number][] = [
      [-1.6, -0.55, 1.61], [1.6, -0.55, 1.61], [1.6, 0.55, 1.61], [-1.6, 0.55, 1.61], [-1.6, -0.55, 1.61],
    ];
    return (
      <>
        <Line points={band} color={SLICE_COLOR} lineWidth={3} transparent opacity={0.85} />
        <Line points={[tail, head]} color={SLICE_COLOR} lineWidth={5} />
        <mesh position={head} quaternion={coneQuat}>
          <coneGeometry args={[0.16, 0.36, 16]} />
          <meshStandardMaterial color={SLICE_COLOR} emissive={SLICE_COLOR} emissiveIntensity={0.5} />
        </mesh>
      </>
    );
  }

  const sSlice = /^S(['2]?)$/.exec(token);
  if (sSlice) {
    const prime = sSlice[1] === "'";
    // S turns the standing middle slice like F. Draw a smaller curved arrow in the front plane
    // (slice colour, inner radius) so it reads as "turn the middle like F", distinct from F.
    const cw = !prime;
    const SLICE_COLOR = "#7ce0ff";
    const { points, tip, tipAngle } = arcPoints(cw, 250);
    const zc = 1.66;
    const scale = 0.72;
    const at = (p: [number, number, number]): [number, number, number] => [p[0] * scale, p[1] * scale, zc];
    const coneQuat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), new THREE.Vector3(Math.cos(tipAngle), Math.sin(tipAngle), 0)
    );
    return (
      <>
        <Line points={points.map(at)} color={SLICE_COLOR} lineWidth={5} />
        <mesh position={at(tip)} quaternion={coneQuat}>
          <coneGeometry args={[0.16, 0.36, 16]} />
          <meshStandardMaterial color={SLICE_COLOR} emissive={SLICE_COLOR} emissiveIntensity={0.5} />
        </mesh>
      </>
    );
  }

  const m = /^([RLUDFB])(['2]?)$/.exec(token);
  if (!m) return null;
  const faceLetter = m[1] as FaceLetter;
  const prime = m[2] === "'";
  const double = m[2] === "2";
  const frame = FACES.find((f) => f.letter === faceLetter);
  if (!frame) return null;

  const cw = !prime; // unprimed = clockwise as seen from outside
  const sweep = double ? 300 : 250;
  const { points, tip, tipAngle } = arcPoints(cw, sweep);

  // Cone arrowhead oriented along the tangent, in the face's local plane.
  const coneQuat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(Math.cos(tipAngle), Math.sin(tipAngle), 0)
  );

  return (
    <>
      {/* steady highlight on the target face */}
      <group position={frame.normal.clone().multiplyScalar(OUTLINE_OUT)} quaternion={frame.quaternion}>
        <Line points={SQUARE} color={FACE_COLOR} lineWidth={3} transparent opacity={0.9} />
      </group>

      {/* curved direction arrow */}
      <group position={frame.normal.clone().multiplyScalar(ARC_OUT)} quaternion={frame.quaternion}>
        <Line points={points} color={FACE_COLOR} lineWidth={5} />
        <mesh position={tip} quaternion={coneQuat}>
          <coneGeometry args={[0.14, 0.34, 16]} />
          <meshStandardMaterial color={FACE_COLOR} emissive={FACE_COLOR} emissiveIntensity={0.4} />
        </mesh>
      </group>
    </>
  );
}
