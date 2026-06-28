// Offline build: turn each midi-src/*.mid into a curated chart JSON in
// public/charts/, using the shared curation engine (src/chartgen.ts) so custom
// in-browser uploads get the identical level design.
//
// Run:  bun run scripts/midi_to_charts.ts

import { Midi } from '@tonejs/midi'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildChart, type Character, type Fly } from '../src/chartgen'
import type { Palette } from '../src/songs'

const SRC = 'midi-src'
const OUT = 'public/charts'
mkdirSync(OUT, { recursive: true })

const PAL: Record<string, Palette> = {
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
const DESIGN: Record<string, { character: Character; fly: Fly }> = {
  'metallica-enter-sandman': { character: 'standard', fly: 'med' },
  'metallica-master-of-puppets': { character: 'intense', fly: 'high' },
  'metallica-nothing-else-matters': { character: 'gentle', fly: 'low' },
  'muse-hysteria': { character: 'intense', fly: 'high' },
  'muse-uprising': { character: 'standard', fly: 'med' },
  'aphex-avril-14th': { character: 'gentle', fly: 'low' },
  'aphex-kesson-daslef': { character: 'standard', fly: 'med' },
}

const index: any[] = []
for (const id of Object.keys(NAMES)) {
  const midi = new Midi(readFileSync(join(SRC, id + '.mid')))
  const d = DESIGN[id] ?? { character: 'standard' as Character, fly: 'med' as Fly }
  const chart = buildChart(midi, { id, name: NAMES[id].name, artist: NAMES[id].artist, character: d.character, fly: d.fly, palette: PAL[id] })
  writeFileSync(join(OUT, id + '.json'), JSON.stringify(chart))
  index.push({ id, name: NAMES[id].name, artist: NAMES[id].artist, bpm: chart.bpm })
  const ships = chart.sections.filter((s) => s.mode === 'ship').length
  console.log(`${NAMES[id].artist} - ${NAMES[id].name}: ${chart.obstacles.length} obstacles, ${chart.gates.length} gates, ${ships} fly, ${chart.duration}s`)
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2))
console.log(`\nwrote ${index.length} charts + index.json`)
