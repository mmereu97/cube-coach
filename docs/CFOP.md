# CFOP, as Cube Coach implements it

CFOP (Cross, F2L, OLL, PLL — the Fridrich method) is the standard speedsolving
method. This document describes how Cube Coach guides each phase, and the teaching
decisions behind it. Algorithms and reference sheets follow **J Perm**.

Standard hold throughout: **yellow up, white down, green front**. The cross is
built on the **bottom**.

## Who this is for

Someone who **already solves the cube** with the beginner method and is learning
CFOP. They know what an algorithm is and how to hold a cube. What is new and hard
for them is:

- the cross on the **bottom** instead of the top — disorienting at first
- **F2L**: corner and edge solved *together*, which is the real conceptual jump
- **recognising** cases quickly, by eye, instead of counting
- turning with `y` rotations in the hand instead of re-orienting the whole cube

A coach does not tell such a person what to do. A coach tells them **what to
notice**. That principle shapes most of what follows.

## 1. Cross

Solve the four white edges around the white centre on the bottom, each aligned with
its side centre.

Cube Coach solves the cross **optimally** by breadth-first search over a reduced
state tracking only the four white edges — always ≤ 8 moves. It first computes the
whole-cube rotations that bring the cube into the standard hold.

## 2. F2L

Fill the four corner + edge slots by pairing each white corner with its matching
edge and inserting them together.

Cube Coach implements **all 41 basic cases** (J Perm Section 1), in six categories:

- **1A — both pieces on top**: white up · white on side/front, top colours differ ·
  white on side/front, top colours match
- **1B — one piece already in a slot**: edge in slot · corner in slot
- **1C — both pieces in the slot**

### Choosing the pair order: look-ahead

This is the part that separates a 30-second solve from a 15-second one, and it is
the one thing an algorithm sheet cannot teach.

A **greedy** planner takes the cheapest-looking pair at each step. That is exactly
how you end up levering pieces back out of slots: solving the pair that looks
cheapest right now can **bury** another pair's pieces, and then you have no choice
but to extract them — moves that teach you nothing.

So `planF2L()` **searches every order**. There are only 4! = 24, so the computer
simply tries them all: play each out, count the moves (extractions included and
penalised extra), keep the cheapest. Depth-4 DFS with pruning — a few dozen
recognitions, instant.

On real scrambles this typically removes extractions entirely where the greedy
planner needed two or three.

`explainPairChoice()` then says the reasoning out loud, because the search already
knows it:

> *FL first — taking BR now would bury a piece in a slot and cost an extraction*

### Choosing which algorithm to teach

Not the shortest. **The most memorable.**

Algorithms are not random letters; they are built from a small vocabulary of
**triggers** — short bursts the hand learns as a single gesture:

| Trigger | Moves |
| --- | --- |
| sexy move | `R U R' U'` |
| sledgehammer | `R' F R F'` |
| hedgeslammer | `F R' F' R` |
| the insert | `R U R'`, `R U' R'`, and mirrors |

An experienced cuber does not memorise `U' R' U R U' R U R'` as eight letters. They
read it as *"U', reverse insert, U', insert"* — two gestures and two alignments.
That is how anyone holds dozens of algorithms in their head: not by memorising more,
but by **recombining the same few**.

`memorability()` scores each variant accordingly:

```
+ covered × 4      how much of it is made of known gestures
+ repeats × 30     the same gesture twice is nearly free to learn
− distinct × 3     fewer different gestures to hold in mind
− loose × 6        moves belonging to no gesture: pure rote memory
+ rightSide × 2    ties go to the right hand, the side this solver works from
− length × 0.2     length is a tiebreaker, never the point
```

Extra turns are a fine price for an algorithm that stays in your fingers.

`segmentAlg()` exposes the same decomposition to the UI, which shows it **alongside**
the letters — never instead of them. The letters *are* the algorithm; the gestures
are how you will actually remember it.

### The official algorithm is sacred

It is never shortened, and its first letter is **never cancelled against the
alignment move in front of it**.

This had to be enforced in the engine, not just the display. Simplification used to
run across the whole sequence, so an AUF of `U` meeting an algorithm beginning with
`U'` quietly ate the algorithm's first letter — and the app then asked for a move the
sheet does not contain. Alignment and tidy-up are now simplified separately; whatever
lies between them is untouched.

A redundant `U U'` at the seam is therefore **not a bug to optimise away**. It is the
price of handing you the algorithm intact. Once the algorithms are in your fingers
you will drop those turns yourself, because you will see they were never needed. An
app that "helpfully" trims your algorithms sabotages the very thing you are trying to
memorise.

### AUF

An **AUF** is only the alignment the app adds: `U` turns and reorientations, nothing
else. It never appears in a J Perm algorithm.

Its purpose: an algorithm is written for one specific orientation of the case, but
the top layer turns freely, so the same case can present in four rotations. The AUF
brings your pattern into the orientation the sheet draws — relative to the **faces**,
which F2L has already fixed. Note the three AUFs mean different things: before OLL it
aligns the yellow *shape*; before PLL, the side *colours*; the final one aligns the
last layer with the rest of the cube.

### Extraction

When no pair can be solved as it stands — a piece is trapped in the wrong slot — a
short **extraction** lifts it out. This is a detour, not an algorithm, and nothing
about it is worth learning, which is why the planner pays a penalty to avoid it and
why the history gives it its own labelled row rather than gluing it onto a pair's
algorithm.

## 3. OLL — 2-look

Make the whole top face yellow, in two steps:

1. **Orient the edges** — the yellow cross (dot → line/L → cross).
2. **Orient the corners** — Sune, Anti-Sune, H, Pi, T, U, L.

## 4. PLL — 2-look

1. **Permute the corners** — diagonal or adjacent (headlights).
2. **Permute the edges** — H, Ua, Ub, Z.

The edge search tries every AUF in front of every algorithm, so it finds the single
alignment that serves both steps. (A separate corner-alignment step used to run
first, and then the edge algorithm brought its own AUF — asking for `U` and then `U2`
where one `U'` does the job. Two alignments in a row is a reliable sign that a step
is doing work the next step would have done anyway.)

## Recognition cues

At each last-layer step, and for each F2L case, the app says what you would look for
if it were not there:

- `headlights on the left`
- `L-shape — it sits in the back-left corner`
- `both on top, white on the side — the friendly case: join them, then insert`
- `the corner is stuck in a slot — lever it out, then pair up on top`

These are **read off your live cube**, in the state after the alignment — not recited
from a table. That matters: a cue only means something next to the algorithm it
belongs with, and an invented one would teach a convention that does not match the
algorithms actually in use here.

## Why 2-look?

About 16 algorithms for the last layer instead of 78, at the cost of a few extra
moves. The standard bridge from beginner to advanced. The engines generalise to the
full sets, so full OLL/PLL are additional algorithm data rather than rewrites.

## A note on move count

A guided solve here runs longer than a competitive one. That is the point. The goal
is to teach the method correctly — intact algorithms, deliberate pair order, cues you
can learn to see — not to minimise turns. Efficiency arrives by itself once the
algorithms are yours.

## Credits

CFOP algorithms and reference sheets are from **J Perm** (https://jperm.net/). See
the Credits section of the main README for the terms under which the images are
included.
