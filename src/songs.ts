// Chart types. Charts are generated offline from MIDI by
// scripts/midi_to_charts.ts and shipped as JSON in public/charts/.

import type { Note } from './audio'

export interface Palette {
  bg: number
  ground: number
  player: number
  accent: number
  spike: number
}

export type ObstacleKind = 'spike' | 'block' | 'bar'

export interface Obstacle {
  time: number
  kind: ObstacleKind
}

export interface Chart {
  id: string
  name: string
  artist?: string
  bpm: number
  duration: number // seconds
  palette: Palette
  music: Note[]
  obstacles: Obstacle[]
}
