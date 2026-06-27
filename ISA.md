---
project: BuiDash
task: Build a three.js beat-matched rhythm runner and deploy to dash.olibuijr.com
effort: E3
phase: observe
progress: 0/24
mode: algorithm
started: 2026-06-27
updated: 2026-06-27
---

# BúiDash — ISA

## Problem

Óli wants a Geometry Dash–style game ("BúiDash") that is browser-based in three.js, but with a Guitar Hero twist: obstacles must **always correlate with the beat of the song**. No popular three.js GD clone exists to fork, and a real GD fork is the wrong base — GD levels are hand-drawn and only loosely music-synced. The core has to be beat-driven from the ground up.

## Vision

A neon GD cube auto-runs through a pulsing world. Every spike sits exactly on a musical beat, so jumping *is* playing the rhythm — like Guitar Hero where the gameplay is the chart. The whole scene pulses on the beat. It must FEEL musically tight: the player should never be able to tell whether the music drives the spikes or the spikes drive the music, because they share one clock. Deployed and playable at dash.olibuijr.com.

## Out of Scope

- Forking/rebranding an existing GD codebase (investigated — none forkable in three.js).
- Live audio beat-detection (Óli chose authored beatmaps for frame-accuracy).
- Copyrighted music or external audio/asset fetching — music is synthesized in-browser.
- Level editor, online levels, multiplayer, accounts, leaderboards (later, not v1).
- Mobile-native app — browser only (touch supported).

## Principles

- **One clock or it drifts.** Both music and obstacle positions derive from a single `AudioContext` clock. Never two timelines.
- **Position from time, not from accumulated frame deltas.** Obstacle world-x = chart-time × speed; player world-x = audio-time × speed. Sync is structural, not best-effort.
- **Self-contained.** No runtime CDN, no external assets — deploys as static files.

## Constraints

- three.js, TypeScript, built with bun (never npm). Static output served by nginx.
- Deploy on the existing EC2 VM (mail.olibuijr.com / 3.94.46.219) as a new nginx vhost dash.olibuijr.com. DNS already resolves there.
- No app port needed (pure static site).

## Goal

Ship a playable three.js rhythm runner where authored-beatmap spikes arrive on the exact musical beat (shared AudioContext clock), with synthesized in-browser music, GD visuals, and a live HTTPS deployment at dash.olibuijr.com.

## Criteria

- [ ] ISC-1: `~/Projects/BuiDash` is a Vite+TS+three project; `bun install` succeeds.
- [ ] ISC-2: `bunx vite build` produces a `dist/` with `index.html` and bundled JS.
- [ ] ISC-3: A `SynthEngine` exists exposing a single audio-clock `time` getter.
- [ ] ISC-4: Music is synthesized in-browser via scheduled oscillators (no audio files).
- [ ] ISC-5: A `Chart` type holds `bpm`, `spikes[]`, and `music[]` for an authored beatmap.
- [ ] ISC-6: Each spike's world-x = `spike.time * SPEED`; player world-x = `audioTime * SPEED`.
- [ ] ISC-7: Spike times are generated on the same grid as musical events (beat-correlated).
- [ ] ISC-8: three.js scene renders a player cube, ground, and spike obstacles.
- [ ] ISC-9: Jump on Space / click / touch; gravity returns the cube to ground.
- [ ] ISC-10: Collision with a spike triggers crash → restart from song start (GD-style).
- [ ] ISC-11: The scene/accent pulses visibly on each beat (beat is felt, not just heard).
- [ ] ISC-12: A start screen lists ≥2 songs; selecting one starts that beatmap.
- [ ] ISC-13: HUD shows progress % and combo; win screen on song complete.
- [ ] ISC-14: At least 2 authored songs ship, each with distinct bpm and spike pattern.
- [ ] ISC-15: Lead-in countdown so the first spike is reachable (not instant-death).
- [ ] ISC-16: Anti: no two clocks — obstacle motion never uses `requestAnimationFrame` delta as the source of truth.
- [ ] ISC-17: Anti: no copyrighted track or external asset URL referenced anywhere.
- [ ] ISC-18: Antecedent: on a correct first play, spikes visibly align with kick/snare hits.
- [ ] ISC-19: nginx vhost `dash.olibuijr.com` exists on EC2 with a static root.
- [ ] ISC-20: TLS cert covers dash.olibuijr.com (certbot or existing wildcard).
- [ ] ISC-21: `dist/` is rsynced to the EC2 web root for the vhost.
- [ ] ISC-22: `curl -I https://dash.olibuijr.com` returns 200 and serves the game HTML.
- [ ] ISC-23: The deployed JS bundle is reachable (200) from the live site.
- [ ] ISC-24: Local git repo committed with the source.

## Test Strategy

| isc | type | check | threshold | tool |
|-----|------|-------|-----------|------|
| 1-2 | build | install + build exit 0, dist exists | exit 0 | Bash |
| 3-7 | code | grep symbols / read ranges | present | Grep/Read |
| 8-15 | code | read game.ts logic for each behavior | present | Read |
| 16-17 | anti | grep for forbidden patterns absent | 0 hits | Grep |
| 19-21 | deploy | ssh checks vhost + files on EC2 | present | Bash/ssh |
| 22-23 | live | curl status + body | 200 | Bash curl |
| 24 | git | git log shows commit | ≥1 | Bash |

## Features

| name | satisfies | depends_on | parallelizable |
|------|-----------|------------|----------------|
| project-scaffold | ISC-1,2 | — | no |
| synth-engine | ISC-3,4 | scaffold | no |
| beatmap-songs | ISC-5,7,14 | synth-engine | no |
| game-core | ISC-6,8,9,10,11,15 | synth+beatmap | no |
| ui-shell | ISC-12,13 | game-core | no |
| deploy-ec2 | ISC-19,20,21,22,23 | build | no |

## Decisions

- 2026-06-27: No forkable three.js GD clone exists (searched GitHub by stars — all results are tools/renderers/APIs). Building fresh. Rationale surfaced to user and accepted.
- 2026-06-27: User chose authored beatmaps over live beat-detection for frame-accuracy ("always correlates with the beat").
- 2026-06-27: Music synthesized in-browser (Web Audio oscillators) — removes copyright risk and external-asset dependency, and shares the AudioContext clock with the game for structural sync.
- 2026-06-27: Delegation soft-floor (E3 ≥2) relaxed to 0. Show-my-math: the game is a single cohesive context where a synth engine, beatmap grid, and render loop must agree on one clock — splitting across agents would fracture that shared invariant (per localai-single-gpu-no-agent-decomposition). Deploy is a short sequential ops step done directly via akurai-ec2/ssh.

## Changelog

## Verification
