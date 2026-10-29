import { Line, Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import type { FaceLetter } from "../cube/grid";

const OUTER = 1.6; // outline, just outside the cube surface (~1.56)
const LABEL_OUT = 1.58; // face labels sit right on the surface
const HALF = 1.62;

const SQUARE: [number, number, number][] = [
  [-HALF, -HALF, 0],
  [HALF, -HALF, 0],
  [HALF, HALF, 0],
  [-HALF, HALF, 0],
  [-HALF, -HALF, 0],
];

const Z = new THREE.Vector3(0, 0, 1);

export interface FaceFrame {
  letter: FaceLetter;
  normal: THREE.Vector3;
  up: THREE.Vector3; // in-plane "up" so the letter reads upright
  position: THREE.Vector3;
  quaternion: THREE.Quaternion; // for the outline square
  labelQuat: THREE.Quaternion; // for the upright label
}

function labelQuaternion(normal: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
  const x = new THREE.Vector3().crossVectors(up, normal).normalize();
  const y = new THREE.Vector3().crossVectors(normal, x).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, normal);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function frame(letter: FaceLetter, normal: THREE.Vector3, up: THREE.Vector3): FaceFrame {
  return {
    letter,
    normal,
    up,
    position: normal.clone().multiplyScalar(OUTER),
    quaternion: new THREE.Quaternion().setFromUnitVectors(Z, normal),
    labelQuat: labelQuaternion(normal, up),
  };
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export const FACES: FaceFrame[] = [
  frame("U", V(0, 1, 0), V(0, 0, -1)),
  frame("D", V(0, -1, 0), V(0, 0, 1)),
  frame("F", V(0, 0, 1), V(0, 1, 0)),
  frame("B", V(0, 0, -1), V(0, 1, 0)),
  frame("R", V(1, 0, 0), V(0, 1, 0)),
  frame("L", V(-1, 0, 0), V(0, 1, 0)),
];



function Pulse({ position, quaternion, color }: {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  color: string;
}) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!ref.current) return;
    const p = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 3.6);
    (ref.current.material as THREE.MeshStandardMaterial).opacity = 0.14 + 0.34 * p;
    const s = 0.8 + 0.22 * p;
    ref.current.scale.set(s, s, 1);
  });
  return (
    <mesh ref={ref} position={position} quaternion={quaternion}>
      <planeGeometry args={[1.5, 1.5]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} transparent opacity={0.4} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  );
}

/**
 * Room-fixed pulse: marks the center the algorithm wants at the FRONT, so the user
 * rotates the whole cube to bring it there. `pulseDir` is computed deterministically
 * (committed frame green=F/yellow=U + the moves done), NOT from the gyro, and this
 * component is mounted OUTSIDE the gyro-rotated cube group so it stays put on screen
 * (e.g. the "bring the top center to front" pulse always sits at screen-top). This is
 * the same room-fixed treatment the move arrow gets.
 */
export function PulseGuide({ pulseDir }: { pulseDir?: [number, number, number] | null }) {
  if (!pulseDir) return null;
  const dir = new THREE.Vector3(...pulseDir);
  return (
    <Pulse
      position={dir.clone().multiplyScalar(1.6)}
      quaternion={new THREE.Quaternion().setFromUnitVectors(Z, dir.clone().normalize())}
      color="#ff5cf0"
    />
  );
}

export function FaceGuides({
  pulseFace,
}: {
  pulseFace: FaceLetter | null;
}) {
  // The F-frame is ROOM-FIXED: mounted OUTSIDE the gyro-rotated cube group, it always marks
  // the FRONT of the screen — "this is your F face; bring the F sticker here". Wide moves
  // never move it; turning the cube physically slides the sticky labels under it, and the
  // letter it frames flips only once a different centre crosses ~45° into the front.
  // (The per-colour labels themselves are sticky and live INSIDE the cube — see StickyLabels.)
  const frontFace = FACES.find((f) => f.letter === "F")!;
  const pulse = pulseFace ? FACES.find((f) => f.letter === pulseFace) : null;

  return (
    <>
      {/* the F-frame marks the front face on screen (bring the wanted centre's label here) */}
      <group position={frontFace.position} quaternion={frontFace.quaternion}>
        <Line points={SQUARE} color="#4cc9ff" lineWidth={2} transparent opacity={0.7} />
      </group>

      {pulse && (
        <group position={pulse.position} quaternion={pulse.quaternion}>
          <Line points={SQUARE} color="#ffffff" lineWidth={4.5} />
        </group>
      )}
    </>
  );
}

/**
 * Sticky face labels: one letter per centre, GLUED to its colour (F on green, U on yellow,
 * …). Mounted INSIDE the gyro-rotated cube group, so each letter rides its own centre —
 * wide moves and physical turns carry the label with the colour. Because a label sits on
 * the centre's face, the letter caught by the room-fixed front frame naturally changes only
 * when you rotate the cube past ~45° and a new centre takes the front. `centers` carries the
 * current world normal + in-plane up of each centre (computed from the live model in Cube3D).
 */
export function StickyLabels({
  centers,
}: {
  centers: { letter: string; normal: THREE.Vector3; up: THREE.Vector3 }[];
}) {
  return (
    <>
      {centers.map((c, i) => (
        <Text
          key={`${c.letter}-${i}`}
          position={c.normal.clone().multiplyScalar(LABEL_OUT)}
          quaternion={labelQuaternion(c.normal, c.up)}
          fontSize={0.62}
          color="#ffffff"
          outlineWidth={0.045}
          outlineColor="#0b0d12"
          anchorX="center"
          anchorY="middle"
        >
          {c.letter}
        </Text>
      ))}
    </>
  );
}

