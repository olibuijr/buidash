// Offline MIDI → BúiDash chart converter.
//
// For each .mid in midi-src/, parse with @tonejs/midi and emit a chart JSON in
// public/charts/:
//   - music:     song notes mapped onto the synth/soundfont voices (MIDI numbers)
//   - obstacles: riff + kick/snare onsets become JUMP obstacles (spike/block);
//                long gaps get a DON'T-JUMP bar. Both come from the same note
//                data the music is scheduled from, so they stay on the beat.
//
// Only the composition (note data) is used — no master recording is touched.
//
// Run:  bun run scripts/midi_to_charts.ts

import { Midi } from '@tonejs/midi'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'midi-src'
const OUT = 'public/charts'
mkdirSync(OUT, { recursive: true })

const CAP = 105
const MIN_GAP = 0.62 // s between jump obstacles (one fair jump each)
const BAR_GAP = 2.6 // a quiet stretch this long earns a don't-jump bar
const LEAD_OFFSET = 1.0
const MAX_MUSIC_NOTES = 4500

interface Pal { bg: number; ground: number; player: number; accent: number; spike: number }

const PAL: Record<string, Pal> = {
  'metallica-enter-sandman': { bg: 0x06101c, ground: 0x0e1a2c, player: 0x66ccff, accent: 0xffffff, spike: 0x36e0ff },
  'metallica-master-of-puppets': { bg: 0x140707, ground: 0x241010, player: 0xff7a3d, accent: 0xff3d2e, spike: 0xffae42 },
  'metallica-nothing-else-matters': { bg: 0x06120f, ground: 0x0e2220, player: 0x6affc0, accent: 0x36e0ff, spike: 0x9affd2 },
  'muse-hysteria': { bg: 0x0c0716, ground: 0x1a1033, player: 0xb14dff, accent: 0xff3da6, spike: 0xd86bff },
  'muse-uprising': { bg: 0x10081a, ground: 0x1c0f2e, player: 0xff4da6, accent: 0xb14dff, spike: 0xff6ad5 },
  'aphex-avril-14th': { bg: 0x081410, ground: 0x10241c, player: 0x7affd0, accent: 0x36ffd0, spike: 0xa8ffe0 },
  'aphex-kesson-daslef': { bg: 0x140c06, ground: 0x241808, player: 0xffb13d, accent: 0xff6a2e, spike: 0xffd06a },
}
const NAMES: Record<string, { name: string; artist: string }> = {
  'metallica-enter-sandman': { name: 'Enter Sandman', artist: 'Metallica' },
  'metallica-master-of-puppets': { name: 'Master of Puppets', artist: 'Metallica' },
  'metallica-nothing-else-matters': { name: 'Nothing Else Matters', artist: 'Metallica' },
  'muse-hysteria': { name: 'Hysteria', artist: 'Muse' },
  'muse-uprising': { name: 'Uprising', artist: 'Muse' },
  'aphex-avril-14th': { name: 'Avril 14th', artist: 'Aphex Twin' },
  'aphex-kesson-daslef': { name: 'Kesson Daslef', artist: 'Aphex Twin' },
}

type NoteKind = 'bass' | 'sub' | 'lead' | 'pad' | 'kick' | 'snare' | 'hat'
type ObKind = 'spike' | 'block' | 'bar'
interface OutNote { time: number; kind: NoteKind; midi?: number; dur?: number; gain?: number }

function drumKind(m: number): NoteKind | null {
  if (m === 35 || m === 36) return 'kick'
  if (m === 38 || m === 40 || m === 37) return 'snare'
  if (m === 42 || m === 44 || m === 46 || m === 39 || m >= 49) return 'hat'
  return null
}

interface PT { perc: boolean; avg: number; leadScore: number; notes: { midi: number; time: number; dur: number; vel: number }[] }

function convert(id: string) {
  const buf = readFileSync(join(SRC, id + '.mid'))
  const midi = new Midi(buf)
  const bpm = Math.round(midi.header.tempos[0]?.bpm ?? 120)

  const tracks: PT[] = []
  for (const t of midi.tracks) {
    if (!t.notes.length) continue
    const perc = Boolean(t.instrument?.percussion) || t.channel === 9
    const notes = t.notes.map((n) => ({ midi: n.midi, time: n.time, dur: n.duration, vel: n.velocity }))
    const avg = notes.reduce((s, n) => s + n.midi, 0) / notes.length
    const leadScore = notes.filter((n) => n.midi >= 52 && n.midi <= 88).length
    tracks.push({ perc, avg, leadScore, notes })
  }

  const melodic = tracks.filter((t) => !t.perc)
  const perc = tracks.filter((t) => t.perc)
  const lead = melodic.slice().sort((a, b) => b.leadScore - a.leadScore)[0]
  const bass = melodic.slice().sort((a, b) => a.avg - b.avg)[0]
  const padTracks = melodic.filter((t) => t !== lead && t !== bass)

  let first = Infinity
  for (const t of [lead, bass, ...perc].filter(Boolean)) if (t!.notes.length) first = Math.min(first, t!.notes[0].time)
  const offset = Math.max(0, (isFinite(first) ? first : 0) - LEAD_OFFSET)

  const music: OutNote[] = []
  const push = (kind: NoteKind, n: { midi: number; time: number; dur: number; vel: number }) => {
    const time = n.time - offset
    if (time < 0 || time > CAP) return
    const isDrum = kind === 'kick' || kind === 'snare' || kind === 'hat'
    music.push({ time: +time.toFixed(4), kind, midi: isDrum ? undefined : n.midi, dur: +Math.min(n.dur, 1.6).toFixed(3), gain: +Math.max(0.4, n.vel).toFixed(2) })
  }
  for (const t of perc) for (const n of t.notes) { const k = drumKind(n.midi); if (k) push(k, n) }
  if (bass) for (const n of bass.notes) push('bass', n)
  if (lead && lead !== bass) for (const n of lead.notes) push('lead', n)
  for (const t of padTracks) for (const n of t.notes) if (n.dur > 0.35) push('pad', n)
  music.sort((a, b) => a.time - b.time)
  if (music.length > MAX_MUSIC_NOTES) music.length = MAX_MUSIC_NOTES

  // jump-obstacle source: riff onsets + kick/snare, thinned to a jumpable cadence
  const beatHits: number[] = []
  for (const t of perc) for (const n of t.notes) { const k = drumKind(n.midi); if (k === 'kick' || k === 'snare') beatHits.push(n.time - offset) }
  const onsets = [...(lead ?? bass)?.notes.map((n) => n.time - offset) ?? [], ...beatHits]
    .filter((t) => t >= LEAD_OFFSET && t <= CAP)
    .sort((a, b) => a - b)
  const jumps: number[] = []
  let last = -Infinity
  for (const t of onsets) if (t - last >= MIN_GAP) { jumps.push(+t.toFixed(4)); last = t }

  const obstacles: { time: number; kind: ObKind }[] = jumps.map((t, i) => ({ time: t, kind: (i % 4 === 3 ? 'block' : 'spike') as ObKind }))
  // don't-jump bars in the quiet stretches
  for (let i = 0; i < jumps.length - 1; i++) {
    const gap = jumps[i + 1] - jumps[i]
    if (gap > BAR_GAP) {
      const bt = jumps[i] + gap / 2
      if (bt - jumps[i] >= 1.6 && jumps[i + 1] - bt >= 1.6) obstacles.push({ time: +bt.toFixed(4), kind: 'bar' })
    }
  }
  obstacles.sort((a, b) => a.time - b.time)

  const duration = Math.min(CAP, music[music.length - 1]?.time ?? 30) + 1.5
  const meta = NAMES[id]
  const chart = { id, name: meta.name, artist: meta.artist, bpm, duration: +duration.toFixed(2), palette: PAL[id], music, obstacles }
  writeFileSync(join(OUT, id + '.json'), JSON.stringify(chart))
  const bars = obstacles.filter((o) => o.kind === 'bar').length
  return { ...meta, id, bpm, notes: music.length, jumps: jumps.length, bars, dur: chart.duration }
}

const index: any[] = []
for (const id of Object.keys(NAMES)) {
  const r = convert(id)
  index.push({ id: r.id, name: r.name, artist: r.artist, bpm: r.bpm })
  console.log(`${r.artist} - ${r.name}: ${r.notes} notes, ${r.jumps} jumps + ${r.bars} bars, ${r.dur}s @ ${r.bpm}bpm`)
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2))
console.log(`\nwrote ${index.length} charts + index.json`)
