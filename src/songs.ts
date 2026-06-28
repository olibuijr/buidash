// Chart types. Charts are generated offline from MIDI by
// scripts/midi_to_charts.ts and shipped as JSON in public/charts/.

import type { Note, Instruments } from './audio'

export interface Palette {
  bg: number
  ground: number
  player: number
  accent: number
  spike: number
}

export type ObstacleKind = 'spike' | 'block' | 'bar' | 'pad'
export type Mode = 'cube' | 'ship'

export interface Obstacle { time: number; kind: ObstacleKind }
export interface Section { start: number; end: number; mode: Mode }
export interface Gate { time: number; centerY: number; gap: number }

export interface Chart {
  id: string
  name: string
  artist?: string
  bpm: number
  duration: number
  palette: Palette
  instruments: Instruments
  music: Note[]
  sections: Section[]
  obstacles: Obstacle[]
  gates: Gate[]
}
