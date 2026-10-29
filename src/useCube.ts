import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { connectGanCube, type GanCubeConnection, type GanCubeEvent } from "gan-web-bluetooth";

/**
 * useCube — the single seam between the hardware/BLE world and the React world.
 *
 * Everything Bluetooth-and-RxJS-shaped lives in here. The rest of the app never
 * imports gan-web-bluetooth or touches an Observable; it just reads plain React
 * state (status, lastMove, moveHistory, facelets). Keep this boundary clean and
 * the CFOP engine / 3D layer stay portable and testable.
 */

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface CubeState {
  status: ConnectionStatus;
  errorMessage: string | null;
  /** Last move as GAN notation, e.g. "R", "U'", "F2". */
  lastMove: string | null;
  /** Rolling list of moves since connection (most recent last). */
  moveHistory: string[];
  /** 54-char Kociemba-style facelets string of the current cube state, if known. */
  facelets: string | null;
  /** Internal move counter reported by the cube — used later to detect dropped BLE packets. */
  lastSerial: number | null;
}

/**
 * Fallback MAC-address provider. Some browsers/OSes don't expose the cube's MAC
 * in the BLE advertisement, and GAN cubes need it to derive the decryption key.
 * When that happens the library calls this; we ask the user once. The MAC is on
 * a sticker inside the cube (pop out a cap) or shown by apps like Cube Station.
 */
const MAC_KEY = "cubeCoach.cubeMac";

async function macAddressProvider(
  _device: BluetoothDevice,
  isFallbackCall?: boolean
): Promise<string | null> {
  if (isFallbackCall) {
    // Reuse a saved MAC if we have one; otherwise ask once and remember it.
    const saved = localStorage.getItem(MAC_KEY);
    if (saved) return saved;
    const entered = window.prompt(
      "Enter your cube's Bluetooth MAC address (format AB:CD:EF:12:34:56):"
    );
    if (entered && /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(entered.trim())) {
      localStorage.setItem(MAC_KEY, entered.trim().toUpperCase().replace(/-/g, ":"));
      return localStorage.getItem(MAC_KEY);
    }
    return entered;
  }
  // Let the library try automatic detection first.
  return null;
}

/** Clear the saved cube MAC (e.g. if you switch cubes). */
export function forgetCubeMac() {
  localStorage.removeItem(MAC_KEY);
}

// The gyro stream LAGS the move event: when a MOVE arrives over BLE, the quaternion has not yet
// caught up with the turn. So a move's core rotation must be measured from just BEFORE the event
// to a little AFTER it, once the rotation has landed in the gyro stream.
const PRE_MOVE_MS = 200;   // look-back: before the turn started
const POST_MOVE_MS = 350;  // look-ahead: after the turn has landed in the gyro stream
const BURST_MS = 200;      // two events this close are one physical move (a slice)

export function useCube(): CubeState & {
  connect: () => Promise<void>;
  disconnect: () => void;
  clearHistory: () => void;
  resetCubeState: () => Promise<void>;
  orientation: React.MutableRefObject<{ x: number; y: number; z: number; w: number } | null>;
  moveQuatHistory: React.MutableRefObject<{ move: string; quat: { x: number; y: number; z: number; w: number } | null; quatBefore: { x: number; y: number; z: number; w: number } | null; quatAfter: { x: number; y: number; z: number; w: number } | null; t: number; facelets: string | null; serial: number }[]>;
  gyroTrail: React.MutableRefObject<{ q: { x: number; y: number; z: number; w: number }; t: number }[]>;
  hasGyro: boolean;
} {
  const [state, setState] = useState<CubeState>({
    status: "disconnected",
    errorMessage: null,
    lastMove: null,
    moveHistory: [],
    facelets: null,
    lastSerial: null,
  });

  // Hold the live connection + subscription across renders without triggering them.
  const connRef = useRef<GanCubeConnection | null>(null);

  // Latest cube orientation (updated very frequently) is kept in a ref so it can
  // drive the 3D view every frame without causing React re-renders.
  const orientationRef = useRef<{ x: number; y: number; z: number; w: number } | null>(null);
  const moveQuatHistoryRef = useRef<{ move: string; quat: { x: number; y: number; z: number; w: number } | null; quatBefore: { x: number; y: number; z: number; w: number } | null; quatAfter: { x: number; y: number; z: number; w: number } | null; t: number; facelets: string | null; serial: number }[]>([]);
  // Rolling gyro samples, used to find the core's orientation just before a move began.
  const gyroTrailRef = useRef<{ q: { x: number; y: number; z: number; w: number }; t: number }[]>([]);
  const [hasGyro, setHasGyro] = useState(false);

  const handleEvent = useCallback((event: GanCubeEvent) => {
    if (event.type === "MOVE") {
      // Snapshot the core's current orientation alongside the layer event, so we can measure how
      // much the CORE rotated during each move (a wide/rotation/slice turns the core; a plain face
      // does not). Used by the measurement tool to study unambiguous wide-vs-face detection.
      // Snapshot the core's orientation AT the move, and also from just BEFORE the move started
      // (looked up in the gyro trail). The delta between those two is the rotation caused by THIS
      // move — free of the re-gripping that happens in the seconds between moves.
      const now = Date.now();
      const trail = gyroTrailRef.current;
      let qBefore: { x: number; y: number; z: number; w: number } | null = null;
      for (let k = trail.length - 1; k >= 0; k--) {
        if (now - trail[k].t >= PRE_MOVE_MS) { qBefore = trail[k].q; break; }
      }
      if (!qBefore && trail.length) qBefore = trail[0].q;
      // Freeze the post-move orientation of any earlier move that is still pending and is NOT a
      // burst partner of this one: the new turn is about to land in the gyro stream, so this is the
      // last moment its rotation is clean. This is what stops a neighbouring turn from leaking in.
      for (const e of moveQuatHistoryRef.current) {
        if (e.quatAfter === null && now - e.t > BURST_MS) e.quatAfter = orientationRef.current;
      }
      const entry = { move: event.move, quat: orientationRef.current, quatBefore: qBefore, quatAfter: null as { x: number; y: number; z: number; w: number } | null, t: now, facelets: null as string | null, serial: event.serial };
      moveQuatHistoryRef.current = [...moveQuatHistoryRef.current, entry].slice(-200);
      // Otherwise the gyro needs a moment to catch up with the turn — sample it then.
      setTimeout(() => { if (entry.quatAfter === null) entry.quatAfter = orientationRef.current; }, POST_MOVE_MS);
      setState((prev) => ({
        ...prev,
        lastMove: event.move,
        moveHistory: [...prev.moveHistory, event.move].slice(-200),
        lastSerial: event.serial,
      }));
      // Ask the cube for its full state after each move, so we can compare our deduced
      // state against the cube's own ground-truth facelets.
      connRef.current?.sendCubeCommand({ type: "REQUEST_FACELETS" }).catch(() => {});
    } else if (event.type === "FACELETS") {
      // Attach ground-truth facelets to the move with the SAME serial (robust at speed); otherwise
      // to the most recent move still missing them. Comparing facelets before/after shows exactly
      // which stickers moved — a witness immune to hand movement, unlike the gyro.
      const h = moveQuatHistoryRef.current;
      let idx = -1;
      for (let k = h.length - 1; k >= 0; k--) {
        if (h[k].serial === event.serial) { idx = k; break; }
      }
      // Fallback: facelets responses arrive in order, so the next one belongs to the OLDEST move
      // that is still waiting — NOT the newest (which would mis-associate at speed).
      if (idx < 0) { for (let k = 0; k < h.length; k++) if (h[k].facelets == null) { idx = k; break; } }
      if (idx >= 0) h[idx].facelets = event.facelets;
      setState((prev) => ({
        ...prev,
        facelets: event.facelets,
        lastSerial: event.serial,
      }));
    } else if (event.type === "GYRO") {
      orientationRef.current = event.quaternion;
      // Rolling buffer (~60Hz): lets us look up the core's orientation from just BEFORE a move
      // started, so we measure the move itself and not the re-gripping that happened before it.
      gyroTrailRef.current.push({ q: event.quaternion, t: Date.now() });
      if (gyroTrailRef.current.length > 3000) gyroTrailRef.current.shift();
      if (!hasGyro) setHasGyro(true);
    }
    // BATTERY / HARDWARE / DISCONNECT events are ignored for now.
  }, [hasGyro]);

  const connect = useCallback(async () => {
    setState((prev) => ({ ...prev, status: "connecting", errorMessage: null }));
    try {
      const conn = await connectGanCube(macAddressProvider);
      connRef.current = conn;
      conn.events$.subscribe(handleEvent);
      // Ask the cube for its current absolute state right away, so the twin
      // starts synced instead of blank.
      await conn.sendCubeCommand({ type: "REQUEST_FACELETS" });
      setState((prev) => ({ ...prev, status: "connected" }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [handleEvent]);

  const disconnect = useCallback(() => {
    connRef.current?.disconnect();
    connRef.current = null;
    setState((prev) => ({ ...prev, status: "disconnected" }));
  }, []);

  // Safety net: if the component unmounts, drop the BLE connection.
  useEffect(() => {
    return () => {
      connRef.current?.disconnect();
      connRef.current = null;
    };
  }, []);

  const clearHistory = useCallback(() => {
    moveQuatHistoryRef.current = [];
    gyroTrailRef.current = [];
    setState((prev) => ({ ...prev, moveHistory: [] }));
  }, []);

  // Tell the cube its current physical state IS solved (call only when it truly is), then
  // ask for fresh facelets. This re-syncs the cube's internal state to reality.
  const resetCubeState = useCallback(async () => {
    try {
      await connRef.current?.sendCubeCommand({ type: "REQUEST_RESET" });
      await connRef.current?.sendCubeCommand({ type: "REQUEST_FACELETS" });
    } catch { /* not connected */ }
  }, []);

  return { ...state, connect, disconnect, clearHistory, resetCubeState, orientation: orientationRef, moveQuatHistory: moveQuatHistoryRef, gyroTrail: gyroTrailRef, hasGyro };
}
