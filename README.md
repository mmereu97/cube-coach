# Cube Coach

A browser-based **CFOP coach and digital twin** for the Rubik's Cube, built around
a physical **GAN 356 i3** smart cube over Web Bluetooth.

It guides you move by move through *your own scramble* using proper CFOP — not the
beginner method — with the official J Perm algorithm set. Your real turns drive the
app; the app tells you what to do next, notices when you go wrong, and explains
what to look for.

It also runs entirely without a smart cube, driven by buttons and the keyboard, so
you can practise while the real one is charging.

> Status: active personal project. The CFOP engine, both input modes, the guided
> solve, the test bench, and the sensor-based move classifier are working and
> tested against real hardware.

---

## Two ways to use it

The app asks once, on the welcome screen, and then shows only the tools that mode
actually needs.

**With a smart cube.** Connect a GAN cube over Bluetooth. Your hands drive
everything — on-screen move buttons are deliberately hidden, because pressing `R`
on screen without turning the cube would immediately put the model out of step with
the thing you are holding.

**Without a smart cube.** Turn the virtual cube with grouped move buttons or the
keyboard. Everything else — guidance, test bench, algorithm sheets — works
identically.

If the cube disconnects mid-solve (battery, Bluetooth), the app falls back to
virtual mode with your state intact, so you can carry on with the buttons instead
of being stranded.

---

## What it does

### Guided solve

- **Full CFOP, phase by phase** — Cross → F2L → OLL → PLL — showing the algorithm,
  which letter you are on, and an arrow on the cube pointing at the face to turn.
- **Mistake detection without a solver.** Wrong moves are stacked and guided back
  out in reverse. History is coloured: white on-algorithm, red deviation, green
  fix-back.
- **Recognition cues**, read off your live cube, the way a coach would say them:
  *"headlights on the left"*, *"L-shape — it sits in the back-left corner"*,
  *"both on top, white on the side — the friendly case"*.
- **Look-ahead explanations** — *"FL first — taking BR now would bury a piece in a
  slot and cost an extraction"*. The planner already searched every ordering; this
  says out loud what it found.
- **Gesture breakdown** shown alongside the letters: `y · U' · [insert] · U2 ·
  [insert]` — because nobody memorises eight letters, they memorise four gestures.
- **F2L pair highlighting** — the corner and edge you are working on wear a pulsing
  halo that follows the pieces (tracked by colour, so it rides them through the
  algorithm), and flash green when the pair lands home.
- **Re-sync** — if the model ever drifts from the cube in your hands, it searches
  for the short move sequence that explains the difference and repairs the model
  silently, so the same solve continues. Only if the gap is too large does it
  re-plan from scratch.

### Sensor-based move recognition

The app can read your moves **from the cube's sensors alone**, with no reference to
the expected algorithm — telling faces, wides and slices apart from gyroscope data.
See **[docs/SENSORS.md](docs/SENSORS.md)** for how, and for the hardware facts it
rests on. Validated at 60/60 on real turns.

### Practice tools

- **Test bench** — pin any single algorithm and drill it with the full guidance
  machinery (arrow, pulsing letter, mistake correction).
- **Algorithm sheets** — a full-screen reference screen (F2L / OLL / PLL), opening
  on whatever you are working on.
- **Solve timer** — starts on your first turn (inspection is free), stops
  retroactively at your last turn once the cube has been still for five seconds.
  Reports time and move count.
- **Input cube** — paint your real cube's state on the 3D cube and solve from it.
- **Fast-forward** — click a stage chip (virtual mode) to have the app play the
  solve up to that phase, so you can drill the OLL or PLL you care about.

---

## Quick start

Requires **Node.js 18+** and a Chromium browser (Chrome or Edge — Web Bluetooth is
Chromium-only).

```bash
npm install
npm run dev
```

Open the printed `http://localhost:5173/`. Hard-refresh with `Ctrl + Shift + R`
after pulling changes.

```bash
npm run build      # tsc type-check + vite build -> dist/
npm run preview    # serve the built bundle locally
npm test           # vitest
```

Add `?dev` to the URL (`http://localhost:5173/?dev`) to reveal the sensor
laboratories — Sensor Bench, Wide Lab, gyro Measure. They are hidden rather than
deleted; see [docs/SENSORS.md](docs/SENSORS.md).

---

## Controls

**Left mouse acts on the cube, right mouse orbits the camera** — everywhere.

| Action | How |
| --- | --- |
| Turn a face (virtual) | Left-drag across a face, or the **Keys** tab, or `R U F L D B` (`Shift` = prime), `M E S` slices |
| Orbit the camera | Right-drag anywhere |
| Zoom | Scroll wheel |
| Paint a sticker (paint mode) | Left-click the sticker |
| Play the next move (virtual) | Click the **NOW** cell |
| Jump to a phase (virtual) | Click a stage chip |

**Center view** points the camera back at the front face — view only, nothing on
the cube changes. **align z / z'** rotate the *model* to match how you are actually
holding the cube; that is the tool for when the screen and your hands disagree.

---

## Conventions

**Standard hold:** yellow up, white down, green front (blue back, red left, orange
right). The white cross is solved on the bottom.

**Notation is absolute and atomic.** The vocabulary is exactly:

```
U D R L F B      faces
u d r l f b      wides (two layers)
M E S            slices
x y z            whole-cube rotations
```

each optionally with `'`. **A half turn is two tokens, not one** — there is no `R2`
token; the algorithm text may write `R2`, but the model receives `R R`. Wides and
slices stay whole in the vocabulary rather than being expanded, because the
algorithm is what disambiguates them in the backend.

---

## Design principles

These are decisions, not accidents, and several of them cost real debugging to
arrive at. They are recorded in the code near the places they constrain.

**The official J Perm algorithm is sacred.** It is never shortened, and its first
letter is never cancelled against the alignment move in front of it. A redundant
`U U'` at the seam is the *price* of handing you the algorithm intact — not a bug
to optimise away. This app exists to teach algorithms, not to solve the cube in the
fewest moves; you will drop those turns yourself once the algorithm is in your
fingers.

**AUF means only alignment.** An AUF is `U` turns and reorientations, nothing else.
If a row contains an `R`, it is not an alignment, whatever the bookkeeping thinks.

**Algorithms are ranked by memorability, not length.** See
[docs/CFOP.md](docs/CFOP.md#choosing-which-algorithm-to-teach).

**The gyroscope is strictly front-end** in the solving backend. Guidance is
deterministic and works with the gyro switched off; the gyro only orients what you
see. (The sensor classifier is a separate, fenced experiment.)

**Mistakes are a deviation stack, not a re-solve.** Wrong moves are pushed on a
stack and inverted back out. No solver runs, so guidance never silently re-plans
around your error.

---

## How it works (short version)

The heart of the app is a **pure, render-free cube model**
(`src/cube/CubeModel.ts`): 26 cubies, each with a position, an orientation
quaternion, and its six birth colours. Moves rotate a layer by 90°. Everything else
— solvers, rendering, paint, sensors — reads that model.

The solvers are **move-based**: they evaluate "solved cube + a list of moves". A
small **base-state seam** (`setSolveBase`) lets them evaluate "base + moves"
instead, which is how a painted state, or a re-sync from the physical cube's own
facelets, enters the pipeline.

For the full tour see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**; for the
method itself **[docs/CFOP.md](docs/CFOP.md)**; for the hardware and signal work
**[docs/SENSORS.md](docs/SENSORS.md)**.

---

## Project structure

```
cube-coach/
├── public/                # optional reference sheets, not included (see Credits)
├── src/
│   ├── cube/                # pure logic (no React) — ports cleanly
│   │   ├── CubeModel.ts     # 26 cubies, move application, colours
│   │   ├── grid.ts          # sticker/cell geometry helpers
│   │   ├── crossSolver.ts   # optimal white-cross solver (BFS)
│   │   ├── f2l.ts           # F2L cases, look-ahead planner, triggers, memorability
│   │   ├── oll.ts           # 2-look OLL
│   │   ├── pll.ts           # 2-look PLL
│   │   ├── cubeInput.ts     # paint model, validation, solve-from-paint
│   │   └── __tests__/       # vitest suites
│   ├── components/
│   │   ├── Cube3D.tsx       # react-three-fiber cube: render, turn, paint, halos
│   │   ├── MoveArrow.tsx    # next-move arrow (faces, and wides as two arrows)
│   │   ├── FaceHighlight.tsx
│   │   └── gyroMath.ts      # quaternion helpers for the gyro view
│   ├── hooks/
│   │   └── useVirtualCube.ts # button/keyboard move source
│   ├── useCube.ts           # physical GAN cube over Web Bluetooth
│   ├── App.tsx              # UI, guidance state machine, sensor classifier
│   ├── App.css
│   └── main.tsx
├── docs/
│   ├── ARCHITECTURE.md
│   ├── CFOP.md
│   └── SENSORS.md
├── index.html
├── package.json
└── vite.config.ts
```

---

## Tech stack

- **React + TypeScript + Vite**
- **three.js** via **@react-three/fiber** and **@react-three/drei**
- **gan-web-bluetooth** + Web Bluetooth API
- **Vitest**

---

## Roadmap

- **Angular velocity for the sensor grey zone** — the gyro reports a `velocity`
  field that is currently unused. A fast wide and an aggressive re-grip converge
  around 50°; velocity may separate them where orientation alone cannot.
- **Look-ahead levels B and C** — level B (explaining the chosen pair order) is
  done; C would choose *extractions that prepare the next pair*.
- **Higher skill levels** — advanced (Section 2/3) F2L, full OLL (57), full PLL
  (21). The engines generalise; it is mostly adding algorithm sets.
- **Solve statistics** — history, averages, per-phase splits.

---

## Testing

`npm test` runs the Vitest suites over the pure `src/cube/` logic: full CFOP solves
over random scrambles, per-phase coverage, PLL completeness, paint round-trip /
corruption tests, and the facelets converter — verified against **captures from a real
synced cube**, one base move each.

The sensor work cannot be unit-tested — it is validated **hardware-in-the-loop**,
by turning a real cube and reading the labelled output. See
[docs/SENSORS.md](docs/SENSORS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Credits

- **Solving method:** the CFOP algorithms are from **J Perm** (https://jperm.net/).
- **Reference sheets are not included.** The app can show J Perm's F2L / OLL / PLL
  sheets next to the cube, but those images are his property, so they are not in
  this repository. To use them locally, download the sheets from jperm.net and save
  them under `public/` with the names listed in `CAT_INFO` (`src/App.tsx`) plus
  `oll-2look.png` and `pll-2look.png`. Without them, the panels are simply hidden.
- Smart-cube protocol via the **gan-web-bluetooth** library.

## How it was built

Built solo with **Claude Code** as my main coding tool: I designed the architecture, ran
the hardware experiments on a real GAN cube and verified every behaviour; the AI wrote
most of the code under my direction.

## License

Source code is released under the **MIT License** — see [LICENSE](LICENSE). The
license does **not** cover the third-party reference images noted above.
