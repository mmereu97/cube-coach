import * as THREE from "three";

// The GAN gyro reports orientation in its own axes (+X red, +Y blue, +Z white);
// this change-of-basis maps it into our render frame (yellow up, green front).
const _ganToOurs = new THREE.Matrix4().set(
  -1, 0, 0, 0,
  0, 0, -1, 0,
  0, -1, 0, 0,
  0, 0, 0, 1
);
export const GYRO_M = new THREE.Quaternion().setFromRotationMatrix(_ganToOurs);
export const GYRO_M_INV = GYRO_M.clone().invert();

/** Convert a raw GAN orientation quaternion into our cube's frame. */
export function orientationToQuaternion(o: { x: number; y: number; z: number; w: number }): THREE.Quaternion {
  const q = new THREE.Quaternion(o.x, o.y, o.z, o.w);
  return GYRO_M.clone().multiply(q).multiply(GYRO_M_INV);
}

/** The cube's on-screen world orientation, from the raw gyro plus calibration and
 *  the accumulated slice offset. Shared by the cube and the sticky face guides. */
export function visualQuaternion(
  o: { x: number; y: number; z: number; w: number } | null,
  calib: THREE.Quaternion | null,
  sliceOffset: THREE.Quaternion | null
): THREE.Quaternion | null {
  if (!o) return null;
  let oq = new THREE.Quaternion(o.x, o.y, o.z, o.w);
  if (sliceOffset) oq = oq.multiply(sliceOffset.clone().invert());
  const q = orientationToQuaternion({ x: oq.x, y: oq.y, z: oq.z, w: oq.w });
  if (calib) q.premultiply(calib);
  return q;
}
