// Authored beatmaps. Each song defines its music AND its spikes on the SAME
// 8th-note grid, so every spike lands on a musical step — Guitar Hero style.
// The builder expands compact per-bar patterns into absolute-time events.

import type { Note } from './audio'

export interface Palette {
  bg: number
  ground: number
  player: number
  accent: number
  spike: number
}

export interface SongDef {
  id: string
  name: string
  bpm: number
  bars: number // total bars (the 8-bar block repeats to fill this)
  chordRoots: number[] // MIDI root per bar, length 8, cycles
  spikeBars: string[] // 8 strings of 8 chars; 'x' = spike on that 8th step
  palette: Palette
}

export interface Chart {
  id: string
  name: string
  bpm: number
  duration: number // seconds
  music: Note[]
  spikes: number[] // absolute times (s)
  palette: Palette
}

const midi = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

// Bright arpeggio shape (semitone offsets from the bar root, one octave up),
// one entry per 8th-note step.
const ARP = [12, 24, 19, 24, 12, 24, 19, 24]

export const SONGS: SongDef[] = [
  {
    id: 'bui-rush',
    name: 'Búi Rush',
    bpm: 132,
    bars: 32,
    // Am F C G feel
    chordRoots: [45, 53, 48, 55, 45, 53, 52, 50],
    // Spikes are >=3 eighth-steps apart so each is a single, fair, on-beat tap.
    spikeBars: [
      '........', // ease-in bar
      'x...x...', // on beats 1 and 3
      'x...x...',
      'x..x....', // beats 1 and the "and" of 2
      'x...x...',
      'x...x...',
      'x...x...',
      'x...x...',
    ],
    palette: { bg: 0x0a0a16, ground: 0x141430, player: 0x36e0ff, accent: 0xff3da6, spike: 0xff3da6 },
  },
  {
    id: 'neon-drift',
    name: 'Neon Drift',
    bpm: 144,
    bars: 32,
    // Em C G D feel
    chordRoots: [40, 48, 55, 50, 40, 48, 43, 45],
    spikeBars: [
      '....x...',
      'x...x...',
      'x...x...',
      'x...x...',
      'x..x....',
      'x...x...',
      'x...x...',
      'x...x...',
    ],
    palette: { bg: 0x07101a, ground: 0x0e2233, player: 0x8cff5a, accent: 0x36e0ff, spike: 0x36e0ff },
  },
  {
    id: 'polar-pulse',
    name: 'Polar Pulse',
    bpm: 120,
    bars: 32,
    // Dm Bb F C feel — chiller
    chordRoots: [50, 46, 41, 48, 50, 46, 45, 43],
    spikeBars: [
      '........',
      'x.......',
      'x...x...',
      'x...x...',
      'x...x...',
      'x...x.x.',
      'x...x...',
      'x...x...',
    ],
    palette: { bg: 0x0c0716, ground: 0x1c1133, player: 0xffd23d, accent: 0xb14dff, spike: 0xb14dff },
  },
]

export function buildChart(def: SongDef): Chart {
  const secPerBeat = 60 / def.bpm
  const stepDur = secPerBeat / 2 // 8th notes
  const stepsPerBar = 8
  const music: Note[] = []
  const spikes: number[] = []

  for (let bar = 0; bar < def.bars; bar++) {
    const barStart = bar * stepsPerBar * stepDur
    const block = bar % 8
    const root = def.chordRoots[block]
    const spikePat = def.spikeBars[block]

    // Bass — root on beats 1 and 3 (steps 0, 4), two octaves down.
    for (const step of [0, 4]) {
      music.push({ time: barStart + step * stepDur, kind: 'bass', freq: midi(root - 12), dur: secPerBeat * 0.9, gain: 1 })
    }

    for (let step = 0; step < stepsPerBar; step++) {
      const t = barStart + step * stepDur

      // Drums
      if (step === 0 || step === 4) music.push({ time: t, kind: 'kick', gain: 1 })
      if (step === 2 || step === 6) music.push({ time: t, kind: 'snare', gain: 1 })
      music.push({ time: t, kind: 'hat', gain: step % 2 === 0 ? 0.5 : 0.32 })

      // Lead arpeggio
      music.push({ time: t, kind: 'lead', freq: midi(root + ARP[step]), dur: stepDur * 0.9, gain: 0.8 })

      // Spike on this step?
      if (spikePat[step] === 'x') spikes.push(t)
    }
  }

  const duration = def.bars * stepsPerBar * stepDur + 1.5
  return { id: def.id, name: def.name, bpm: def.bpm, duration, music, spikes, palette: def.palette }
}
