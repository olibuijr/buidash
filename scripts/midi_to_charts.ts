// Offline MIDI → BúiDash chart converter.
//
// Builds a multi-section level from each MIDI:
//   - music:     song notes mapped to synth/soundfont voices (MIDI numbers)
//   - sections:  alternating CUBE (jump) and SHIP (fly) stretches
//   - obstacles: CUBE-section jump targets — spike/block (jump), bar (stay down),
//                pad (auto-launch). From riff + kick/snare onsets → on the beat.
//   - gates:     SHIP-section corridor gates whose opening follows the melody
//                pitch, so you fly the tune's contour.
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
const MIN_GAP = 0.62
const BAR_GAP = 2.6
const LEAD_OFFSET = 1.0
const MAX_MUSIC_NOTES = 4500
const CUBE_LEN = 15 // seconds per cube section
const SHIP_LEN = 11 // seconds per ship section
const GATE_DT = 0.55 // spacing of flight gates
const GATE_GAP = 3.4 // vertical opening of a gate (generous)
const Y_LO = 2.0
const Y_HI = 5.8
const MAX_SLOPE = 1.4 // max centre-Y change between gates (flyable)

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
type ObKind = 'spike' | 'block' | 'bar' | 'pad'
type Mode = 'cube' | 'ship'
interface OutNote { time: number; kind: NoteKind; midi?: number; dur?: number; gain?: number }
interface PT { perc: boolean; avg: number; leadScore: number; inst: string; notes: { midi: number; time: number; dur: number; vel: number }[] }

// GM instrument name → soundfont (MusyngKite/gleitz) file name.
const normInst = (name: string) =>
  (name || 'acoustic_grand_piano').toLowerCase().replace(/[()]/g, '').trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

function drumKind(m: number): NoteKind | null {
  if (m === 35 || m === 36) return 'kick'
  if (m === 38 || m === 40 || m === 37) return 'snare'
  if (m === 42 || m === 44 || m === 46 || m === 39 || m >= 49) return 'hat'
  return null
}

function sectionAt(t: number, sections: { start: number; end: number; mode: Mode }[]): Mode {
  for (const s of sections) if (t >= s.start && t < s.end) return s.mode
  return 'cube'
}

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
    tracks.push({ perc, avg, leadScore, inst: normInst(t.instrument?.name ?? ''), notes })
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

  const duration = Math.min(CAP, music[music.length - 1]?.time ?? 30) + 1.5

  // ---- sections: alternate cube / ship across the song ----
  const sections: { start: number; end: number; mode: Mode }[] = []
  let s = LEAD_OFFSET
  let mode: Mode = 'cube'
  while (s < duration - 2) {
    const len = mode === 'cube' ? CUBE_LEN : SHIP_LEN
    const end = Math.min(s + len, duration)
    sections.push({ start: +s.toFixed(3), end: +end.toFixed(3), mode })
    s = end
    mode = mode === 'cube' ? 'ship' : 'cube'
  }

  // lead contour for ship gates
  const leadNotes = (lead ?? bass)?.notes.map((n) => ({ t: n.time - offset, midi: n.midi })).filter((n) => n.t >= 0) ?? []
  const midis = leadNotes.map((n) => n.midi)
  const loMidi = midis.length ? Math.min(...midis) : 55
  const hiMidi = midis.length ? Math.max(...midis) : 79
  const pitchToY = (m: number) => {
    if (hiMidi === loMidi) return (Y_LO + Y_HI) / 2
    return Y_LO + ((m - loMidi) / (hiMidi - loMidi)) * (Y_HI - Y_LO)
  }
  const leadMidiAt = (t: number) => {
    let best = (loMidi + hiMidi) / 2
    for (const n of leadNotes) { if (n.t <= t + 0.05) best = n.midi; else break }
    return best
  }

  // ---- jump obstacles (cube sections only) ----
  const beatHits: number[] = []
  for (const t of perc) for (const n of t.notes) { const k = drumKind(n.midi); if (k === 'kick' || k === 'snare') beatHits.push(n.time - offset) }
  const onsets = [...(lead ?? bass)?.notes.map((n) => n.time - offset) ?? [], ...beatHits]
    .filter((t) => t >= LEAD_OFFSET && t <= CAP && sectionAt(t, sections) === 'cube')
    .sort((a, b) => a - b)
  const jumps: number[] = []
  let last = -Infinity
  for (const t of onsets) if (t - last >= MIN_GAP) { jumps.push(+t.toFixed(4)); last = t }

  const obstacles: { time: number; kind: ObKind }[] = jumps.map((t, i) => ({ time: t, kind: (i % 4 === 3 ? 'block' : 'spike') as ObKind }))
  // bars in cube lulls; pads in wide-open cube stretches
  for (let i = 0; i < jumps.length - 1; i++) {
    const gap = jumps[i + 1] - jumps[i]
    if (gap > BAR_GAP) {
      const mid = jumps[i] + gap / 2
      if (mid - jumps[i] >= 1.6 && jumps[i + 1] - mid >= 1.6) obstacles.push({ time: +mid.toFixed(4), kind: 'bar' })
    } else if (gap > 2.0 && i % 5 === 2) {
      const pt = jumps[i] + 0.7
      if (jumps[i + 1] - pt >= 1.3) obstacles.push({ time: +pt.toFixed(4), kind: 'pad' })
    }
  }
  obstacles.sort((a, b) => a.time - b.time)

  // ---- ship gates (ship sections only) ----
  const gates: { time: number; centerY: number; gap: number }[] = []
  const midY = (Y_LO + Y_HI) / 2
  for (const sec of sections.filter((x) => x.mode === 'ship')) {
    // Enter from the ground: first gates are centred + wider so they're reachable.
    let prevY = midY
    let gi = 0
    for (let gt = sec.start + 0.85; gt < sec.end - 0.4; gt += GATE_DT) {
      let cy = pitchToY(leadMidiAt(gt))
      cy = Math.max(prevY - MAX_SLOPE, Math.min(prevY + MAX_SLOPE, cy))
      // ease the opening for the first two gates of the section
      if (gi === 0) cy = midY
      else if (gi === 1) cy = (cy + midY) / 2
      const gap = gi === 0 ? GATE_GAP + 1.0 : gi === 1 ? GATE_GAP + 0.5 : GATE_GAP
      prevY = cy
      gates.push({ time: +gt.toFixed(4), centerY: +cy.toFixed(3), gap: +gap.toFixed(2) })
      gi++
    }
  }

  const instruments = {
    lead: lead?.inst || 'distortion_guitar',
    bass: bass?.inst || 'electric_bass_finger',
    pad: padTracks[0]?.inst || 'string_ensemble_1',
  }

  const meta = NAMES[id]
  const chart = { id, name: meta.name, artist: meta.artist, bpm, duration: +duration.toFixed(2), palette: PAL[id], instruments, music, sections, obstacles, gates }
  writeFileSync(join(OUT, id + '.json'), JSON.stringify(chart))
  return { ...meta, id, bpm, instruments, notes: music.length, secs: sections.length, ships: sections.filter((x) => x.mode === 'ship').length, obs: obstacles.length, gates: gates.length, dur: chart.duration }
}

const index: any[] = []
for (const id of Object.keys(NAMES)) {
  const r = convert(id)
  index.push({ id: r.id, name: r.name, artist: r.artist, bpm: r.bpm })
  console.log(`${r.artist} - ${r.name}: ${r.secs} sections (${r.ships} ship), ${r.obs} obstacles, ${r.gates} gates, ${r.dur}s`)
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2))
console.log(`\nwrote ${index.length} charts + index.json`)
