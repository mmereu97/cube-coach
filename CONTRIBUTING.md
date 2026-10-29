# Contributing / Development

This is a personal learning project, but it is organised so it is easy to extend.

## Setup

Requires **Node.js 18+** and a Chromium browser (Chrome or Edge — Web Bluetooth is
Chromium-only).

```bash
npm install
npm run dev        # http://localhost:5173/  (hard-refresh with Ctrl+Shift+R)
```

## Scripts

```bash
npm run dev        # dev server with hot reload
npm run build      # tsc type-check + production build to dist/
npm run preview    # serve the production build locally
npm test           # vitest, one pass
npm run test:watch # vitest, watching
```

Add `?dev` to the URL to reveal the sensor laboratories (Sensor Bench, Wide Lab,
Measure).

## Where things live

- **Pure logic** in `src/cube/` — no React, no rendering imports. Put new solving or
  validation logic here so it stays testable and portable.
- **Rendering** in `src/components/` and `src/App.tsx`.
- **Move sources** are the seam feeding the 3D layer: `hooks/useVirtualCube.ts`
  (buttons/keyboard) and `useCube.ts` (Bluetooth). Both expose a plain `moves` array.

Read `docs/ARCHITECTURE.md` first. The non-obvious parts are the base-state seam, the
paint conversion, the history-from-planned-steps, and the sensor fencing.

## Conventions that are load-bearing

Breaking any of these will look like it works and then fail subtly, so they are worth
reading before changing engine code.

**Atomic, absolute tokens.** `U D R L F B` · `u d r l f b` · `M E S` · `x y z`, plus
`'`. **A half turn is two tokens** — there is no `R2` token. Wides and slices stay
whole in the vocabulary.

**The official algorithm is never altered.** Do not simplify across the boundary
between the alignment and the algorithm; a redundant `U U'` there is intentional. See
[docs/CFOP.md](docs/CFOP.md#the-official-algorithm-is-sacred).

**The gyroscope is front-end only** in the solving backend. Guidance must remain
deterministic with the gyro off. The sensor classifier is a separate, fenced
experiment and must stay fenced.

**Never infer where you can record.** The history is built from what was planned, not
deduced from cube state; the algorithm boundary is *found*, not derived from counting.
Both of these replaced inference-based versions that produced a long tail of
misplaced-move bugs.

**One source of truth per frame.** Facelets are reported in the cube's **core** frame;
the model lives in the **grip** frame. Mixing them corrupts the model — this is not
theoretical, it produced cubies rendering their black insides outward.

**Left mouse acts, right mouse orbits** — everywhere.

**Prefer the right hand.** When two algorithms are otherwise equal, `R` beats `L`.

## Testing the logic

```bash
npm test
```

Vitest suites live in `src/cube/__tests__/`. They cover full CFOP solves over random
scrambles, per-phase coverage, PLL completeness, paint round-trip / corruption cases,
and the facelets converter — the last of which is checked against **captures from a
real synced cube**, one base move each, plus a model-to-facelets round trip.

When adding algorithms, note that `f2l.ts` and `oll.ts` **verify every variant by
running it**, so a mistyped algorithm is dropped automatically rather than silently
breaking recognition.

## Testing the sensor work

This cannot be unit-tested. It is validated **hardware-in-the-loop**: connect a real
cube, open `?dev`, turn deliberately, and read the labelled output against what you
actually did.

Two lessons from doing this, both learned the hard way:

**Count, do not estimate.** A run was once reported as "60/60, no errors" without
being counted; it contained five silent misclassifications. If you claim an accuracy
figure, count the lines.

**Instrument before tuning.** When the classifier misfired, the per-move log showed
*two opposite causes* — signal being cut short, and noise being added — which no
single threshold change could fix. Without the log, threshold-fiddling would have gone
on indefinitely.

The relevant constants are `TOL_STILL`, `TOL_TURN`, `MIN_WIN_MS`, `MIN_SAMPLES`,
`WIN_PRE`, `WIN_POST`, `LULL_MS` in `App.tsx`, all documented in
[docs/SENSORS.md](docs/SENSORS.md).

## Restoring a delivered archive

`node_modules` is excluded from archives. Run `npm install` again before building or
type-checking, otherwise `tsc` / `vite build` will fail on missing type definitions —
including a spurious `web-bluetooth` type-library error that disappears once the dev
dependencies are present.

With dependencies installed, `npx tsc --noEmit` is expected to be **completely clean**
and `npm test` to be **all green**. If either is not, it is a real problem, not
background noise.

## Roadmap ideas

See the Roadmap in the main README. The most interesting open problem is using the
gyro's unused **angular velocity** field to separate the ~50° grey zone where a fast
wide and an aggressive re-grip currently converge.
