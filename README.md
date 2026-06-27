# BúiDash

A Geometry Dash–style rhythm runner in **three.js** — with a Guitar Hero twist: **every spike lands exactly on the beat.**

🎮 Live: **https://dash.olibuijr.com**

## The idea

Geometry Dash levels are hand-drawn and only loosely synced to the music. Guitar Hero is the opposite — the gameplay *is* the chart. BúiDash takes the GD look (neon auto-running cube, jump the spikes) and makes the obstacles **beat-matched** via authored beatmaps.

## How the sync works

The whole guarantee reduces to **one clock**. Both the music and the obstacle positions read `AudioContext.currentTime`:

- music is scheduled against the audio clock (Web Audio oscillators — no audio files),
- `player.x = audioTime × SPEED`,
- `spike.x  = spikeTime × SPEED`.

So the player reaches every spike at *exactly* its chart time, independent of frame rate or lag. `requestAnimationFrame` deltas are used only for the vertical jump arc — never for anything that decides where a spike is.

## Music & beatmaps

There are no audio files and no external assets. Each song is **synthesized in the browser** (bass + lead arpeggio + kick/snare/hat) and its spikes are authored on the **same 8th-note grid** as the music — so a spike is always on a musical step.

Songs live in [`src/songs.ts`](src/songs.ts). Add one by appending a `SongDef`.

## Stack

- **three.js** + **TypeScript**, built with **Vite** (via `bun`)
- **Web Audio API** for synthesis and the master clock
- Static build — deploys as plain files behind nginx
- Optional Blender-exported `public/assets/buidash.glb` (meshes named `player` / `spike`) — auto-loaded if present, otherwise procedural geometry is used

## Develop

```bash
bun install
bun run dev      # local dev server
bun run build    # → dist/
```

## Controls

**Space · Click · Tap** to jump. Hold to bounce (GD-style).

---

Built by Óli (AkurAI) with Jeeves.
