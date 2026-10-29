# Architecture

How Cube Coach is put together and, more importantly, *why* — the seams and
decisions that let the CFOP engine, the 3D view, the physical cube and the sensor
work coexist without corrupting each other.

## Guiding principle: separate logic from rendering

Everything under `src/cube/` is **pure TypeScript with no React and no three.js
rendering code**. It manipulates a plain data model and returns plain data. The
React/three.js layer reads that data and draws it.

- The engine is **testable headlessly** (`npm test`, Vitest, no browser).
- The logic **ports** to another platform almost line-for-line.

## The cube model

`src/cube/CubeModel.ts` is the single source of truth for cube state.

- **26 cubies**. Each carries `pos` (components in `{-1,0,1}`), `quat` (its
  orientation), and `colors` — the six face colours in three.js box-material order,
  **fixed at birth** and carried along as the cubie rotates. Stickers travel with
  the piece, as on a real cube.
- A **move** rotates one layer's cubies 90° about an axis, updating position *and*
  orientation. Positions are snapped to integers to prevent drift.

**A piece's orientation lives in its quaternion, not in its colour array.** The
solvers read orientation from the quaternion. This is why painting needs a real
conversion step, and it is also the source of a subtle rendering bug worth
recording:

> The renderer used to pass the quaternion **object** as a prop. Because
> `applyMove` mutates it in place, its identity never changed, so React skipped the
> update — and the cubie only refreshed when its *position* prop changed. That is
> fine for face turns, where anything that rotates also moves. It breaks for whole-
> cube rotations: the pieces **on the axis** (the R and L centres during an `x`)
> turn without moving, never got their new orientation, and ended up showing their
> black insides outward while their colours pointed inward — visible through the
> cracks. The fix is to pass the orientation as four numbers.

### Move vocabulary

Tokens are **atomic and absolute**: `U D R L F B`, `u d r l f b`, `M E S`,
`x y z`, each optionally primed. **A half turn is two tokens.** There is no `R2`
token; algorithm text may write `R2`, but the model receives `R R`. Wides and
slices stay whole rather than being expanded into face+slice, because the algorithm
is what disambiguates them.

## The solver engine

Four modules, each recognising the current state and returning the next step.

- **`crossSolver.ts`** — solves the white cross optimally by BFS over a reduced
  state (≤ 8 moves), plus the whole-cube rotations that put the cube in the
  standard hold.
- **`f2l.ts`** — the largest module: case recognition, all 41 basic cases, the
  look-ahead planner, the trigger vocabulary and the memorability scorer. See
  [CFOP.md](CFOP.md).
- **`oll.ts`** — 2-look OLL.
- **`pll.ts`** — 2-look PLL.

### The base-state seam

The solvers are **move-based**: `buildFrom(moves)` starts from a solved cube and
applies the moves. But a painted cube — or a re-sync from the physical cube's own
reported state — is a state that did *not* come from a known move list.

- `buildFrom(tokens)` starts from an optional module-level **base**
  (`setSolveBase(model)`) if one is set, otherwise from solved.
- `buildSolved(tokens)` **always** starts from solved. Case-database derivation and
  "which slots does this algorithm disturb" use this, because they reason about
  algorithms in the abstract, not about the current state.

With a base set, the pipeline evaluates "base + moves", so it can solve any state.

## Move sources

The 3D layer is fed a `moves` array and knows nothing about where it came from.
Two sources feed that seam:

- `hooks/useVirtualCube.ts` — buttons and keyboard.
- `useCube.ts` — the physical GAN cube over Web Bluetooth. Exposes `moveHistory`,
  `facelets`, `orientation`, plus two refs the sensor work needs:
  `moveQuatHistory` (per move: the move, quaternions before/during/after, timestamp,
  facelets, serial) and `gyroTrail` (a rolling ~3000-sample buffer with timestamps).

Facelets are matched to moves **by serial number**, not by arrival order, because
they arrive asynchronously.

## The two modes

`mode` is `"choose" | "virtual" | "cube"`, decided once on the welcome screen.

The split is not cosmetic. In **cube** mode, on-screen move buttons and Scramble are
hidden: pressing `R` on screen without turning the physical cube would desynchronise
the model from the object in your hand — the exact failure the rest of the
architecture works to prevent. Rotations (`z`/`z'`) *are* offered in both modes,
because they change only which face the model calls "front", never the cube's state,
and so are the correct tool for repairing a frame mismatch.

Disconnecting mid-solve falls back to virtual mode with state intact.

## Guidance

`App.tsx` holds a small **state machine** advancing C → F → O → P → done. It
recomputes the current step only at settled boundaries, never mid-algorithm.

### Mistakes: a deviation stack, not a re-solve

`classifyDone()` walks what you have done against what was expected:

- matches the next expected move → **alg** (white), progress advances
- anything else → **dev** (red), pushed on a stack
- the inverse of the top of the stack → **fix** (green), popped

The next instruction is either the algorithm's next move or the inverse of the top
of the stack. **No solver runs.** Guidance never silently re-plans around your
error; it walks you back out the way you came in.

A wide executed as its two layers (`F` then `S` for `f`) counts as *done*, not as a
mistake — same cube position, so `WIDE_PARTS` accepts either execution.

### Finding the algorithm inside the sequence

A planned sequence is `[reorientation] [alignment] [official algorithm]`. Several
features need to know where the algorithm *starts*: the pulsing letter, the AUF
split in the history, the wide-vs-atom display.

Deriving that offset by counting leading `U` turns is wrong, and was wrong twice in
opposite directions: it swallows the algorithm's own first move when that is a `U`,
producing an "alignment" of three quarter turns, which cannot exist. Because the
official algorithm is kept **verbatim** in the sequence, the honest method is to
**find it** — `algStartIn()` searches for its atomic moves as a contiguous run.
Everything before that index is alignment; everything from it on is the algorithm.

A clean principle produced a simpler implementation, which is usually how it goes.

### History, built from planned steps

The move history used to be reconstructed from the **cube's state** — "when did this
pair become solved?" — and then matched up against the points where the app had
planned each step. Two sources that could never agree exactly, and every
disagreement stranded moves in the wrong row. A whole T-perm once appeared labelled
`AUF · align`.

It is now built **directly from the planned steps**. `phaseInfoRef` records, at
planning time, everything a row needs: the expected sequences, the official
algorithm strings, the phase, whether it is an extraction, the pair, and the OLL/PLL
kind. A row runs from one step's start to the next one's. **Nothing is inferred**, so
a move cannot land in a row that is not its own.

An AUF row additionally may contain only `U` turns and reorientations — a validation
that is now merely belt-and-braces, since the mechanism that misplaced moves is gone.

## The 3D layer

`src/components/Cube3D.tsx` renders a `CubeModel` and animates turns. Notable props:

- `moves`, `snapOnMount`
- `glowSets` — pieces to highlight, named by **colour set**, not by id. Ids are not
  stable: when the model is rebuilt from facelets they belong to *slots*, so an
  id-based highlight sits on the destination slot instead of following the piece you
  need to watch.
- `flashSets` — the celebratory blink when a pair lands home. Deliberately separate
  from `glowSets` and on its own clock, so the next pair lights up simultaneously
  and a fast solver never waits for an animation.
- `faceletsState` — the physical cube's reported state, used to correct drift.
- `gyroView` — orient the on-screen cube from the gyro.

### The gyro view double-count

When `gyroView` is on, the visual quaternion is multiplied by the **inverse of the
core rotation the model already carries**. Without this, an auto-applied `y` rotates
the model instantly while the cube in your hand has not moved yet; then when you *do*
turn it, the gyro rotates the view again — the same rotation counted twice, which is
the teleport-and-desync you would see at phase transitions.

This is renderer-only. The solving backend never reads the gyro.

### Safety net

`isBroken()` checks after each commit whether any cubie shows its inner (black) face
outward — a state that applying moves to a valid cube can never produce. If it ever
happens, the model is rebuilt from the move list, which is the source of truth.

## Re-sync and model repair

If the on-screen cube drifts from the one in your hands, **your cube is not wrong** —
it is a physical object in a valid state. What broke is the program's *belief*.

`resyncFromCube()` therefore tries the gentle thing first:

1. **Repair.** `findRepair()` searches for a short sequence (≤ 3 moves) that
   reconciles the model with the cube's reported facelets, comparing states via
   `stateKey` in the grip frame (`coreQuatOf`). If found, it is applied silently and
   **the same solve continues** — same phase, same algorithm, nothing lost. Sitting
   at OLL and being sent back to the white cross would be absurd.
2. **Re-plan.** Only if the gap is too large: take the cube's state as a new base
   (`setSolveBase`), clear the move list, plan afresh.
3. **Refuse.** If `cubeBeliefValid` is false — the cube was scrambled while
   disconnected, so its facelets are a stale belief — it says so rather than
   resynchronising to a fiction. See [SENSORS.md](SENSORS.md#facelets-are-derived-not-observed).

## The paint feature (Input cube)

`src/cube/cubeInput.ts` plus paint UI in `App.tsx` / `Cube3D.tsx`. Centres are fixed,
so each painted sticker is just a cubie face's world-facing colour.

`validateStructure()` checks three layers: nine of each colour, nothing unpainted,
and every real piece present exactly once.

**The subtle part:** the solvers read orientation from the quaternion, but a freshly
painted state only knows world-facing colours. `buildFromPaint()` reconstructs the
proper representation — identify each piece by its colour set, look up its birth
colours, find which of the 24 orientations reproduces the painted stickers.

`solveFromPaint()` then validates, sets the base, runs the CFOP pipeline, confirms
the result is solved, and returns the **inverse of the solution as a scramble** —
which `App.tsx` loads so the cube snaps to the painted state and normal move-based
flow resumes. Painting also sets `cubeBeliefValid = false`, because the app now knows
better than the cube does.

## Sensor mode

Fenced, and documented separately in **[SENSORS.md](SENSORS.md)**. The architectural
points:

- Active only when Sensor Bench is on, not guiding, and not in the test bench.
- Inside it the normal interpretation effect returns early; the model is fed from
  classified sensor verdicts on a timer.
- **Facelets are fully disconnected** from the 3D cube — two truths in different
  frames corrupt the model rather than complementing each other.

## Testing

`npm test` runs Vitest over the pure `src/cube/` logic. The sensor work is validated
**hardware-in-the-loop** instead — see [CONTRIBUTING.md](../CONTRIBUTING.md).
