import { describe, it, expect } from "vitest";
import { faceletsToModel, modelToFacelets, COLORS } from "../CubeModel";
import { buildSolved } from "../f2l";
import * as THREE from "three";

const FN = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
function sig(m: ReturnType<typeof buildSolved>): string {
  const o: string[] = [];
  for (const c of m.cubies) {
    for (let i = 0; i < 6; i++) {
      if (c.colors[i] === COLORS.inner) continue;
      const d = new THREE.Vector3(...(FN[i] as [number, number, number])).applyQuaternion(c.quat);
      o.push(`${Math.round(c.pos.x)},${Math.round(c.pos.y)},${Math.round(c.pos.z)}:${Math.round(d.x)},${Math.round(d.y)},${Math.round(d.z)}:${c.colors[i]}`);
    }
  }
  return o.sort().join("|");
}

// Captured from a real synced GAN cube, one base move from solved each time.
// The cube reports facelets in ITS OWN frame (180 degrees about F from ours), but
// `faceletsToModel` already reframes them on the way in — so a capture of a physical U
// must come out as our U, with no further remapping here. Verified against the captures
// themselves rather than assumed: each one matches exactly one of our moves, the
// same-named one.
const CAPTURES: Record<string, string> = {
  solved: "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB",
  U: "UUUUUUUUURRRRRRFFFFFFFFFLLLDDDDDDDDDLLLLLLBBBBBBBBBRRR",
  D: "UUUUUUUUUBBBRRRRRRRRRFFFFFFDDDDDDDDDFFFLLLLLLLLLBBBBBB",
  R: "BUUBUUBUURRRRRRRRRUFFUFFUFFFDDFDDFDDLLLLLLLLLBBDBBDBBD",
  L: "UUFUUFUUFRRRRRRRRRFFDFFDFFDDDBDDBDDBLLLLLLLLLUBBUBBUBB",
  F: "UUUUUULLLURRURRURRFFFFFFFFFRRRDDDDDDLLDLLDLLDBBBBBBBBB",
  B: "RRRUUUUUURRDRRDRRDFFFFFFFFFDDDDDDLLLULLULLULLBBBBBBBBB",
};

describe("facelets converter", () => {
  it("round-trips the solved model to the standard solved string", () => {
    expect(modelToFacelets(buildSolved([])))
      .toBe("UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB");
  });

  it("matches the real cube state for every base move", () => {
    for (const [mv, fc] of Object.entries(CAPTURES)) {
      const fromFacelets = sig(faceletsToModel(fc));
      const fromModel = sig(mv === "solved" ? buildSolved([]) : buildSolved([mv]));
      expect(fromFacelets, `move ${mv}`).toBe(fromModel);
    }
  });

  it("produces a legal state (every sticker colour appears 9 times)", () => {
    for (const fc of Object.values(CAPTURES)) {
      const counts: Record<string, number> = {};
      for (const ch of fc) counts[ch] = (counts[ch] ?? 0) + 1;
      for (const n of Object.values(counts)) expect(n).toBe(9);
    }
  });
});
