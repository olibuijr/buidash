import './style.css'
import { Midi } from '@tonejs/midi'
import { SynthEngine } from './audio'
import type { Chart } from './songs'
import { Game, type Difficulty } from './game'
import { buildChart, pickPalette } from './chartgen'

const $ = (id: string) => document.getElementById(id)!
const canvas = $('game') as HTMLCanvasElement
const overlay = $('overlay')
const songList = $('song-list')
const hud = $('hud')
const progressFill = $('progress-fill')
const songNameEl = $('song-name')
const comboEl = $('combo')
const pctEl = $('pct')
const countdownEl = $('countdown')
const loadingEl = $('loading')
const loadingText = $('loading-text')
const topbar = $('topbar')
const pauseBtn = $('pause-btn') as HTMLButtonElement
const muteBtn = $('mute-btn') as HTMLButtonElement
const pausedEl = $('paused')
const resumeBtn = $('resume-btn') as HTMLButtonElement
const pauseMenuBtn = $('pause-menu-btn') as HTMLButtonElement
const result = $('result')
const resultTitle = $('result-title')
const resultSub = $('result-sub')
const resultBest = $('result-best')
const retryBtn = $('retry') as HTMLButtonElement
const menuBtn = $('menu-btn') as HTMLButtonElement
const difficultyEl = $('difficulty')
const loadMidiBtn = $('load-midi') as HTMLButtonElement
const fileInput = $('file-input') as HTMLInputElement

const engine = new SynthEngine()
const game = new Game(canvas)
game.setClock(() => engine.time)
game.loadAssets('./assets/buidash.glb')

interface SongIndexItem { id: string; name: string; artist: string; bpm: number }
let current: Chart | null = null
let index: SongIndexItem[] = []
const chartCache = new Map<string, Chart>()
let paused = false
let difficulty: Difficulty = ((localStorage.getItem('buidash.diff') as Difficulty) || 'normal')

const show = (el: HTMLElement, on: boolean) => el.classList.toggle('hidden', !on)

// ---- best scores ----
const bestKey = (id: string) => `buidash.best.${id}`
const getBest = (id: string) => Number(localStorage.getItem(bestKey(id)) || 0)
const setBest = (id: string, v: number) => localStorage.setItem(bestKey(id), String(Math.round(v)))

// ---- difficulty selector ----
function applyDifficultyUI() {
  difficultyEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b as HTMLButtonElement).dataset.d === difficulty))
}
difficultyEl.querySelectorAll('button').forEach((b) =>
  b.addEventListener('click', () => {
    difficulty = (b as HTMLButtonElement).dataset.d as Difficulty
    localStorage.setItem('buidash.diff', difficulty)
    applyDifficultyUI()
  }),
)
applyDifficultyUI()

// ---- menu ----
async function buildMenu() {
  try {
    index = await (await fetch('./charts/index.json')).json()
    renderMenu()
  } catch {
    songList.innerHTML = '<p class="hint">Could not load songs.</p>'
  }
}
function renderMenu() {
  songList.innerHTML = ''
  for (const s of index) {
    const best = getBest(s.id)
    const btn = document.createElement('button')
    btn.className = 'song-btn'
    btn.innerHTML = `<span><span class="s-name">${s.name}</span>${best ? `<span class="s-best">best ${best}%</span>` : ''}</span><span class="s-meta"><span class="s-bpm">${s.artist}</span> · ${s.bpm} BPM</span>`
    btn.addEventListener('click', () => startSong(s.id))
    songList.appendChild(btn)
  }
}
buildMenu()

async function loadChart(id: string): Promise<Chart> {
  if (chartCache.has(id)) return chartCache.get(id)!
  const c: Chart = await (await fetch(`./charts/${id}.json`)).json()
  chartCache.set(id, c)
  return c
}

async function startSong(id: string) {
  await startChart(await loadChart(id))
}

async function startChart(chart: Chart) {
  current = chart
  show(overlay, false)
  show(result, false)
  show(pausedEl, false)
  loadingText.textContent = `loading ${chart.name}…`
  show(loadingEl, true)

  await engine.loadInstruments(chart.instruments)
  engine.load(chart.music)
  game.loadChart(chart, difficulty)
  songNameEl.textContent = chart.artist ? `${chart.artist} — ${chart.name}` : chart.name

  show(loadingEl, false)
  show(hud, true)
  show(topbar, true)
  setPaused(false)
  await engine.start(2.0)
}

// ---- load your own MIDI ----
loadMidiBtn.addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0]
  fileInput.value = ''
  if (!f) return
  show(overlay, false)
  loadingText.textContent = `reading ${f.name}…`
  show(loadingEl, true)
  try {
    const midi = new Midi(await f.arrayBuffer())
    const name = f.name.replace(/\.(mid|midi)$/i, '')
    const chart = buildChart(midi, { id: 'custom-' + name, name, artist: 'Your MIDI', palette: pickPalette(name) })
    await startChart(chart)
  } catch {
    show(loadingEl, false)
    show(overlay, true)
    flashBanner("couldn't read that MIDI")
  }
})

let bannerTimer = 0
function flashBanner(text: string) {
  countdownEl.style.fontSize = 'clamp(28px, 9vh, 90px)'
  countdownEl.textContent = text
  show(countdownEl, true)
  window.clearTimeout(bannerTimer)
  bannerTimer = window.setTimeout(() => show(countdownEl, false), 1100)
}

game.on({
  onCountdown: (n) => { countdownEl.style.fontSize = ''; countdownEl.textContent = String(n) },
  onStart: () => show(countdownEl, false),
  onMode: (m) => flashBanner(m === 'ship' ? '✈ HOLD TO FLY' : '⬆ JUMP'),
  onProgress: (pct, combo) => {
    progressFill.style.width = pct.toFixed(1) + '%'
    pctEl.textContent = Math.floor(pct) + '%'
    comboEl.textContent = String(combo)
  },
  onCrash: (pct) => endRun(false, pct),
  onWin: () => endRun(true, 100),
})

function endRun(won: boolean, pct: number) {
  engine.stop()
  show(hud, false)
  show(topbar, false)
  show(pausedEl, false)
  const id = current!.id
  const prevBest = getBest(id)
  const isNewBest = pct > prevBest
  if (isNewBest) setBest(id, pct)
  resultTitle.textContent = won ? 'Cleared!' : 'Crashed'
  resultSub.textContent = won ? `${current?.name} — you jumped the whole song.` : `${Math.floor(pct)}% through ${current?.name}.`
  resultBest.textContent = isNewBest ? `★ NEW BEST — ${Math.round(pct)}%` : `best ${Math.max(prevBest, Math.round(pct))}%`
  show(result, true)
  renderMenu()
}

// ---- pause / mute ----
function setPaused(p: boolean) {
  paused = p
  game.setPaused(p)
  if (p) { engine.pause(); show(pausedEl, true); pauseBtn.textContent = '▶' }
  else { engine.resume(); show(pausedEl, false); pauseBtn.textContent = '❙❙' }
}
function togglePause() { if (game.state === 'playing') setPaused(!paused) }
function toggleMute() { const m = !engine.isMuted; engine.setMuted(m); muteBtn.textContent = m ? '🔇' : '🔊' }

// ---- input ----
function jumpDown(e: Event) { if (current && game.state !== 'idle' && !paused) { e.preventDefault(); game.setJump(true) } }
function jumpUp() { game.setJump(false) }
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp') jumpDown(e)
  else if (e.code === 'Escape') togglePause()
  else if (e.key === 'm' || e.key === 'M') toggleMute()
})
window.addEventListener('keyup', (e) => { if (e.code === 'Space' || e.code === 'ArrowUp') jumpUp() })
canvas.addEventListener('pointerdown', jumpDown)
window.addEventListener('pointerup', jumpUp)

muteBtn.addEventListener('click', toggleMute)
pauseBtn.addEventListener('click', togglePause)
resumeBtn.addEventListener('click', () => setPaused(false))
pauseMenuBtn.addEventListener('click', toMenu)
retryBtn.addEventListener('click', () => current && startChart(current))
menuBtn.addEventListener('click', toMenu)

function toMenu() {
  engine.stop()
  setPaused(false)
  show(result, false)
  show(hud, false)
  show(topbar, false)
  show(countdownEl, false)
  show(pausedEl, false)
  show(overlay, true)
}

// ---- PWA ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}
