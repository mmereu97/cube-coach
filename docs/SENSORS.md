# Sensors: reading moves from the cube itself

This document records what the GAN 356 i3 actually does — measured, not assumed —
and how Cube Coach turns those signals into moves.

Almost none of this is documented anywhere. Every fact below was established by
turning a real cube and reading the numbers, and several of them contradict the
obvious guess. They are written down here because rediscovering them is expensive.

---

## The problem

The cube reports **layer events**: "the R layer turned clockwise". That is enough
for face turns, and it is what the guided solve normally uses.

It is *not* enough to tell a **wide** from a **face**, or to see a **slice** for
what it is. To the layer sensors:

- a wide `d` looks exactly like `U'`
- a slice `M` looks like two separate events, `R` and `L'`

The two are physically different moves and leave the cube in different states, so
something has to distinguish them. The layer events alone cannot.

---

## Hardware findings

### The gyroscope axes are permuted

Not the intuitive mapping. Measured:

| Move family | Gyro axis |
| --- | --- |
| R / L | **X** |
| U / D | **Z** |
| F / B | **Y** |

(`FACE_AXIS` in `App.tsx` is keyed by the **raw** cube move for this reason.)

### A wide reports the opposite face

Turn `u` and the cube reports **`D`**. Turn `r` and it reports **`L`**. Turn `f`
and it reports **`B`**.

This is not a bug in the cube. What its sensors see is the far layer turning
*relative to a core that came along for the ride* — which is the opposite face,
turning the other way. The classifier undoes this with `OPPOSITE_FACE`.

### A slice is two events

`M` arrives as `R` + `L'`, `E` as `U` + `D'`, `S` as `B` + `F'` — opposite faces,
opposite directions. They can straggle up to ~700 ms apart when turned slowly
(`SLICE_WINDOW_MS`), so pairing them by identity rather than by a tight time window
is essential.

### Facelets are derived, not observed

**The cube has no optical sensors.** It cannot see its own stickers. It *deduces*
its state by adding up the turns it feels, starting from a known reference.

Two consequences, both of which cost real debugging:

1. **Facelets are useless for telling a wide from a face.** They are computed from
   the same layer events, in the core's frame — where a wide `d` genuinely *is* a
   `U'`. They are not an independent witness.

2. **Scramble the cube while it is off and its facelets are a lie.** It felt
   nothing, so it still believes the old state and reports that belief with
   complete confidence. The app tracks this as `cubeBeliefValid`: false after you
   paint a state via Input cube, true again after a Reset with the cube physically
   solved (which re-anchors it). Re-sync refuses to work from a stale belief rather
   than resynchronising to a fiction.

   Its **move events**, by contrast, are always real — they are measured as they
   happen. Only the derived state can be wrong.

### The gyro lags the layer event

The gyro stream runs at roughly **15 Hz** (~68 ms per sample), and Bluetooth
latency is **variable, ~150–400 ms**, arriving *after* the corresponding layer
event. Any measurement window must therefore extend forward in time from the
event, not backward.

### Rotations are invisible

`x` / `y` / `z` produce **no layer events at all**. They are physically identical
to re-gripping the cube, so no sensor can distinguish them. They are treated as
grip state, never as tokens to detect.

---

## How the classifier works

`classifyLab()` in `App.tsx`. Four ideas, in order:

**1. The core is the discriminator.** On a face turn the core stays put. On a wide
or a slice it rotates ~90°. That difference is the whole signal.

**2. Measure in the cube's own frame.** Raw gyro deltas are contaminated by hand
tilt. Projecting each sample's rotation onto the move's axis **in the cube's
frame** makes the signal nearly binary: alignment ≈ 1.00 for a genuine wide,
scattered for a face. This single change is what made the problem tractable.

**3. Anchor the window to the event.** Not a free-floating burst detector — the
measurement runs from just before the layer event (`WIN_PRE`) forward, clipped so
it never reaches past a neighbouring event (`EDGE_GUARD`).

**4. Stop when the turn stops, not when a clock expires.** `netAbout()` keeps
accumulating while the core is still rotating about the axis and stops after
`LULL_MS` of stillness. A fixed window cut slow turns short and reported a
meaningless partial angle; a longer fixed window swallowed the re-grip that
followed. The lull ends the reading correctly in both cases.

### The bands

```
|net| <= 45°           → FACE
55° <= |net| <= 125°   → WIDE / SLICE
anything between       → UNKNOWN
```

`TOL_STILL` is 45°, not 0°, because **re-gripping genuinely swings the core 20–35°
at speed** — measured, repeatedly. That is not noise; the gyro is reading it
correctly. "The core stayed put" has to mean "it did not go anywhere near 90°".

A wide additionally requires `MIN_WIN_MS` (250 ms) of window and `MIN_SAMPLES` (4)
gyro readings before it may be asserted at all. A wide **rewrites the model's
frame** — get it wrong and every later move is mapped wrong too — so it is the one
claim that demands evidence actually exist. Without this guard, a flick of the
wrist at speed read as 50° and invented a wide that never happened.

### Saying "I don't know"

The classifier reports **UNKNOWN** rather than guessing. This is deliberate: a
classifier that is confidently wrong is worse than one that admits uncertainty,
because a wrong wide corrupts the model silently and everything after it is
garbage.

When a move is UNKNOWN, the app still records it — as a plain face, marked visibly
— because *dropping* it would leave the model permanently one turn behind the real
cube.

---

## The limit, stated honestly

At speed you turn every 60–120 ms. The gyro delivers a sample every 68 ms. Between
two fast moves, **one or two samples arrive**. You cannot measure a 90° rotation
from two samples — the information does not exist.

Worse, the two signals converge: a hard re-grip swings the core ~50°, a wide turns
it 90°, and at maximum speed with sloppy grip they meet. This is not a tuning
problem; it is a property of the hardware.

| | Works |
| --- | --- |
| Faces, any speed | yes |
| Wides / slices, deliberate (>300 ms) | yes |
| Wides / slices, very fast (<150 ms) | no — reported as faces, marked uncertain |

In practice this is acceptable: wides and slices appear in OLL and PLL, where you
are being deliberate anyway. And in the grey zone the system does not lie — it
tells you it could not read the core.

**Untried:** the gyro also reports a `velocity` field which is currently unused.
A wide may have a different acceleration signature from a re-grip — a short decisive
impulse versus a softer continuous motion. If so, it could separate the ~50° grey
zone where orientation alone cannot. This is the last unopened box.

---

## The laboratories

Hidden behind `?dev` in the URL — hidden rather than deleted, because they are the
only place this work can be tested and the velocity experiment above still needs
them.

**Sensor Bench** — drives the model *from the sensors alone*, no algorithm, nothing
to follow. Turn the cube freely and it writes down what you did:

```
U  R'  u  M  F  r'  E  b  S'
```

coloured by kind (face white, wide cyan, slice gold, unknown red), with a per-move
log of the core angle, gap, window length, sample count and decision latency.

**Wide Lab** — the raw grouping and measurement, for tuning the bands.

**Measure** — per-move core rotation deltas.

### Fencing

Sensor mode is active only when Sensor Bench is on **and** you are not guiding
**and** not in the test bench. Inside it:

- the normal interpretation pipeline returns early (`sensorModeRef`)
- the model is fed from sensor verdicts on a timer, once each reading has settled
- **facelets are fully disconnected** from the 3D cube

That last one matters. Facelets describe the cube in the *core's* frame; the sensor
tokens describe it in *yours*. Two truths in different frames do not complement each
other — they corrupt the model outright (cubies ended up showing their black
insides). One source of truth, not two.

### Latency

Sensor mode costs about **0.4 s** of latency: a move is shown once its reading is
clear, not when the clock runs out. That delay is irreducible — until you finish
turning, the information that distinguishes `U` from `u` does not yet exist.

So the two methods are complementary rather than competing:

- **Algorithmic** (guided solve): instant, but needs a known algorithm.
- **Sensor** (Sensor Bench): works anywhere, with no algorithm, at ~0.4 s delay.
