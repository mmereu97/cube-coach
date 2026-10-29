# Changelog

All notable changes to Cube Coach. Milestone-style entries rather than strict
semantic versioning while this is a personal project.

## Unreleased

### Added — physical cube

- **GAN 356 i3 over Web Bluetooth, fully wired in.** Real turns drive the model,
  the 3D view, and the guidance. `useCube.ts` exposes move history, facelets,
  orientation, a per-move quaternion history and a rolling gyro trail.
- **Two modes with a welcome screen** — *with a smart cube* (hands drive; on-screen
  move buttons hidden so they cannot desynchronise the model from your hand) and
  *without one* (buttons and keyboard). Disconnecting mid-solve falls back to
  virtual with state intact.
- **Re-sync with model repair** — searches for the short move sequence (≤ 3) that
  reconciles the model with the cube's reported state and applies it silently, so
  the same solve continues from the same phase. Falls back to a full re-plan only
  when the gap is too large, and refuses outright when the cube's belief is known to
  be stale.
- **Solve timer** — starts on your first turn (inspection is free), stops
  retroactively at your last turn after five seconds of stillness. Both instants come
  from the cube's own event timestamps, so Bluetooth lag cancels out. Reports time
  and move count.
- **Gyro view** — the on-screen cube follows how you hold the real one.

### Added — sensor-based move classification

- **Sensor Bench** — reads your moves from the gyroscope alone, with no reference to
  the expected algorithm, telling faces, wides and slices apart. Validated 60/60 on
  real turns. Reports **UNKNOWN** rather than guessing when the signal is ambiguous.
- Full hardware characterisation recorded in **[docs/SENSORS.md](docs/SENSORS.md)**:
  permuted gyro axes, wides reporting the opposite face, slices arriving as two
  events, gyro lag, and the fact that the cube has no optical sensors and merely
  deduces its state.
- **Wide Lab** and **Measure** for tuning. All three are behind `?dev` — hidden, not
  deleted.

### Added — guided solve

- **Look-ahead F2L planner.** Replaces the greedy chooser with a full search over all
  4! pair orderings, simulating each to completion and penalising extractions. On real
  scrambles this removes extractions that the greedy planner made unavoidable.
- **Look-ahead explanation** — *"FL first — taking BR now would bury a piece in a slot
  and cost an extraction"*.
- **Memorability-based algorithm selection** — variants ranked by decomposition into
  known triggers and gesture repetition rather than move count, with a right-hand
  preference. Length is a tiebreaker, not the criterion.
- **Gesture breakdown** shown alongside the letters (`sexy move`, `sledgehammer`,
  `insert`…), never instead of them.
- **Recognition cues** read off the live cube — *"headlights on the left"*, *"L-shape
  — it sits in the back-left corner"*, *"both on top, white on the side — the friendly
  case"*.
- **Pulsing current letter** in the algorithm, with executed letters dimmed.
- **F2L pair highlight** — a pulsing halo on the corner and edge being solved, tracked
  by colour set so it follows the pieces through the algorithm; a green flash when the
  pair lands home, on its own clock so the next pair lights up simultaneously.
- **Test bench** — pin any single algorithm and drill it with the full guidance
  machinery.
- **Algorithm sheets** — a full-screen reference screen (F2L / OLL / PLL) opening on
  the current phase.
- **Clickable NOW cell** and **clickable stage chips** (virtual mode) to play a move or
  fast-forward the solve to a phase.
- **Center view** (camera only) and **align z / z'** (rotates the model to match how you
  hold the cube) as two clearly separated tools.

### Changed

- **The official J Perm algorithm is now sacred at the engine level.** Alignment and
  tidy-up moves are simplified separately; the algorithm between them is untouched. A
  redundant `U U'` at the seam is intentional — the price of an intact algorithm.
- **The twin cube was removed** from the guided solve; a single centred cube replaced it.
- **The move history is built from planned steps**, not reconstructed from cube state.
  Rows cannot contain moves belonging to another step. Extractions get their own
  labelled row.
- **The algorithm boundary is found, not derived.** `algStartIn()` locates the official
  algorithm inside the planned sequence instead of counting leading `U` turns.
- **Wides may be executed in two halves** (`F` then `S` for `f`) — same cube position,
  so it counts as done rather than as a mistake. Applied to both live guidance and
  history colouring.
- **PLL no longer emits a separate corner-alignment step**; the edge search already
  tries every AUF and finds one alignment serving both.
- **Left column is tabbed** (Console / Keys); the top button bar was removed, which also
  fixed the layout being crushed by its intrinsic width.
- Toolbar reorganised per mode; `Debug`, `Copy gyro`, `Measure`, `Sensor Bench` and
  `Wide Lab` moved behind `?dev` or removed from the default UI.
- **Vitest** replaced the ad-hoc esbuild test scripts.

### Fixed

- **Cubies rendering their black insides outward** after `x`/`y`/`z`. The orientation
  was passed to the renderer as a mutated-in-place object, so React skipped the update;
  pieces *on* the rotation axis turn without moving and never refreshed. Now passed as
  four numbers.
- **Gyro view double-counting** an auto-applied reorientation — the model's own core
  rotation is now cancelled out of the visual quaternion.
- **Model corruption in sensor mode** caused by facelets (core frame) and sensor tokens
  (grip frame) both driving the model. Facelets are now fully disconnected there.
- **Moves being dropped on UNKNOWN**, which left the model permanently a turn behind.
- **Invented wides at speed** — a wide now requires a minimum window and sample count
  before it may be asserted, since it rewrites the model's frame.
- **A whole T-perm labelled `AUF · align`**, and alignments of three quarter turns —
  both consequences of the inference-based history, now removed.
- **The orbit pivot left at the vanished twin's midpoint**, which made the single cube
  feel off-centre and impossible to align ("the invisible cube").
- Empty algorithm rows, escaped label text, and duplicated `Center view` / `z` controls.
- **The facelets test suite never ran.** It imported a module that does not exist, so the
  file failed to load and its three tests — including checks against real-hardware captures
  — were silently absent. Repointed at `CubeModel`, and its stale assumption that captures
  need an extra U<->D / R<->L remap was corrected: `faceletsToModel` already reframes on
  the way in, which the captures themselves confirm. Added the missing `modelToFacelets`
  as its exact inverse so the round trip is verifiable. Test count 11 -> 14, and
  `tsc --noEmit` is now completely clean.

## Earlier milestones

- **Input cube (paint mode)** — paint a real cube's state on the 3D cube with fixed
  centres, live per-colour counter and full structural validation; **Done** solves it
  and loads it as the current state.
- **Base-state seam** (`setSolveBase` / `buildFrom` vs `buildSolved`) so the solvers can
  work from states that did not come from a move list.
- **All 41 basic F2L cases** (J Perm Section 1A/1B/1C) with every variant, tagged by
  category, with 2-slot markers.
- **Reference sheets** per phase, matching the app's algorithms exactly.
- **CFOP engine** — optimal cross (BFS), F2L recognition, 2-look OLL and PLL.
- **3D virtual cube** — react-three-fiber rendering with turn animation, fed through the
  move seam the physical cube now reuses.
- **Pure cube model** — 26 cubies with quaternion-based move application, no React.
