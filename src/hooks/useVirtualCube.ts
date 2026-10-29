import { useCallback, useEffect, useState } from "react";

/**
 * useVirtualCube — a keyboard-driven move source that mirrors the useful shape of
 * useCube (an append-only `moves` list + `lastMove`). This is what lets us build
 * and test the whole 3D twin today, with no Bluetooth hardware. When the dongle
 * arrives, the physical useCube plugs into the same <Cube3D moves={...} /> seam.
 *
 * Keys: R U F L D B turn a face clockwise. Hold Shift for a counter-clockwise
 * (prime) turn. That's the whole vocabulary for now.
 */

const FACE_KEYS: Record<string, string> = {
  r: "R",
  u: "U",
  f: "F",
  l: "L",
  d: "D",
  b: "B",
  m: "M",
  e: "E",
  s: "S",
};

export function useVirtualCube() {
  const [moves, setMoves] = useState<string[]>([]);

  const push = useCallback((move: string) => {
    setMoves((prev) => [...prev, move]);
  }, []);

  const reset = useCallback(() => setMoves([]), []);
  const load = useCallback((ms: string[]) => setMoves(ms), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const face = FACE_KEYS[e.key.toLowerCase()];
      if (!face) return;
      e.preventDefault();
      push(e.shiftKey ? `${face}'` : face);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [push]);

  return {
    moves,
    lastMove: moves.length ? moves[moves.length - 1] : null,
    push, // used by drag-to-turn in the 3D view
    reset,
    load, // set the whole move list at once (used to load a painted scramble)
  };
}
