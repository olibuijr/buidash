// Offline MIDI → BúiDash chart converter.
//
// For each .mid in midi-src/, parse with @tonejs/midi and emit a chart JSON in
// public/charts/:
//   - music:  the song's notes mapped onto the in-browser synth voices
//   - spikes: the lead/riff track's note onsets, thinned to a jumpable cadence
//             so you literally jump the riff — on the beat, since spike times
//             come from the same note data the music is scheduled from.
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

const CAP = 105 // seconds of song to chart
const MIN_SPIKE_GAP = 0.6 // s — keeps spikes one-jump apart (fair, on-beat)
const LEAD_OFFSET = 1.0 // s — first note lands here (trim leading silence)
const MAX_MUSIC_NOTES = 4500

interface Pal { bg: number; ground: number; player: number; accent: number; spike: number }

const PAL: Record<string, Pal> = {
  'metallica-enter-sandman': { bg: 0x06101c, ground: 0x0e1a2c, player: 0x66ccff, accent: 0xffffff, spike: 0x36e0ff },
  'metallica-master-of-puppets': { bg: 0x140707, ground: 0x241010, player: 0xff7a3d, accent: 0xff3d2e, spike: 0xffae42 },
  'metallica-nothing-else-matters': { bg: 0x06120f, ground: 0x0e2220, player: 0x6affc0, accent: 0x36e0ff, spike: 0x9affd2 },
  'muse-hysteria': { bg: 0x0c0716, ground: 0x1a1033, player: 0xb14dff, accent: 0xff3da6, spike: 0xd86bff },
  'muse-uprising': { bg: 0x10081a, ground: 0x1c0f2e, player: 0xff4da6, accent: 0xb14dff, spike: 0xff6ad5 },
}
const NAMES: Record<string, { name: string; artist: string }> = {
  'metallica-enter-sandman': { name: 'Enter Sandman', artist: 'Metallica' },
  'metallica-master-of-puppets': { name: 'Master of Puppets', artist: 'Metallica' },
  'metallica-nothing-else-matters': { name: 'Nothing Else Matters', artist: 'Metallica' },
  'muse-hysteria': { name: 'Hysteria', artist: 'Muse' },
  'muse-uprising': { name: 'Uprising', artist: 'Muse' },
}

type NoteKind = 'bass' | 'sub' | 'lead' | 'pad' | 'kick' | 'snare' | 'hat'
interface OutNote { time: number; kind: NoteKind; freq?: number; dur?: number; gain?: number }

const freq = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

function drumKind(m: number): NoteKind | null {
  if (m === 35 || m === 36) return 'kick'
  if (m === 38 || m === 40 || m === 37) return 'snare'
  if (m === 42 || m === 44 || m === 46 || m === 39 || m >= 49) return 'hat'
  return null
}

interface ParsedTrack {
  perc: boolean
  avg: number
  count: number
  leadScore: number
  notes: { midi: number; time: number; dur: number; vel: number }[]
}

function convert(id: string) {
  const buf = readFileSync(join(SRC, id + '.mid'))
  const midi = new Midi(buf)
  const bpm = Math.round(midi.header.tempos[0]?.bpm ?? 120)

  const tracks: ParsedTrack[] = []
  for (const t of midi.tracks) {
    if (!t.notes.length) continue
    const perc = Boolean(t.instrument?.percussion) || t.channel === 9
    const notes = t.notes.map((n) => ({ midi: n.midi, time: n.time, dur: n.duration, vel: n.velocity }))
    const avg = notes.reduce((s, n) => s + n.midi, 0) / notes.length
    const leadScore = notes.filter((n) => n.midi >= 52 && n.midi <= 88).length
    tracks.push({ perc, avg, count: notes.length, leadScore, notes })
  }

  const melodic = tracks.filter((t) => !t.perc)
  const perc = tracks.filter((t) => t.perc)
  // lead = most notes in lead range; bass = lowest average pitch
  const lead = melodic.slice().sort((a, b) => b.leadScore - a.leadScore)[0]
  const bass = melodic.slice().sort((a, b) => a.avg - b.avg)[0]
  const padTracks = melodic.filter((t) => t !== lead && t !== bass)

  // earliest note across kept tracks → trim leading silence
  let first = Infinity
  for (const t of [lead, bass, ...perc].filter(Boolean)) {
    for (const n of t!.notes) { if (n.time < first) first = n.time; break }
  }
  const offset = Math.max(0, (isFinite(first) ? first : 0) - LEAD_OFFSET)

  const music: OutNote[] = []
  const push = (kind: NoteKind, n: { midi: number; time: number; dur: number; vel: number }) => {
    const time = n.time - offset
    if (time < 0 || time > CAP) return
    music.push({ time: +time.toFixed(4), kind, freq: kind === 'kick' || kind === 'snare' || kind === 'hat' ? undefined : +freq(n.midi).toFixed(2), dur: +Math.min(n.dur, 1.6).toFixed(3), gain: +Math.max(0.4, n.vel).toFixed(2) })
  }

  for (const t of perc) for (const n of t.notes) { const k = drumKind(n.midi); if (k) push(k, n) }
  if (bass) for (const n of bass.notes) push('bass', n)
  if (lead && lead !== bass) for (const n of lead.notes) push('lead', n)
  // pads: only sustained notes, downsampled, to thicken without mush
  for (const t of padTracks) for (const n of t.notes) if (n.dur > 0.35) push('pad', n)

  music.sort((a, b) => a.time - b.time)
  if (music.length > MAX_MUSIC_NOTES) music.length = MAX_MUSIC_NOTES

  // Spikes from the riff onsets, with kick+snare hits filling the gaps so every
  // song gets a dense, beat-aligned, jumpable track. Lead onsets are listed
  // first so they win ties during the greedy min-gap thinning.
  const leadSrc = lead ?? bass
  const beatHits: number[] = []
  for (const t of perc) for (const n of t.notes) {
    const k = drumKind(n.midi)
    if (k === 'kick' || k === 'snare') beatHits.push(n.time - offset)
  }
  const onsets = [
    ...(leadSrc?.notes ?? []).map((n) => n.time - offset),
    ...beatHits,
  ]
    .filter((t) => t >= LEAD_OFFSET && t <= CAP)
    .sort((a, b) => a - b)
  const spikes: number[] = []
  let last = -Infinity
  for (const t of onsets) {
    if (t - last >= MIN_SPIKE_GAP) { spikes.push(+t.toFixed(4)); last = t }
  }

  const duration = Math.min(CAP, (music[music.length - 1]?.time ?? 30)) + 1.5
  const meta = NAMES[id]
  const chart = {
    id,
    name: meta.name,
    artist: meta.artist,
    bpm,
    duration: +duration.toFixed(2),
    palette: PAL[id],
    music,
    spikes,
  }
  writeFileSync(join(OUT, id + '.json'), JSON.stringify(chart))
  return { id, name: meta.name, artist: meta.artist, bpm, notes: music.length, spikes: spikes.length, dur: chart.duration }
}

const ids = Object.keys(NAMES)
const index: any[] = []
for (const id of ids) {
  const r = convert(id)
  index.push({ id: r.id, name: r.name, artist: r.artist, bpm: r.bpm })
  console.log(`${r.artist} - ${r.name}: ${r.notes} notes, ${r.spikes} spikes, ${r.dur}s @ ${r.bpm}bpm`)
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2))
console.log(`\nwrote ${ids.length} charts + index.json`)
