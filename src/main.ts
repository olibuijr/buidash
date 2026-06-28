import './style.css'
import { SynthEngine } from './audio'
import type { Chart } from './songs'
import { Game } from './game'

const canvas = document.getElementById('game') as HTMLCanvasElement
const overlay = document.getElementById('overlay')!
const songList = document.getElementById('song-list')!
const hud = document.getElementById('hud')!
const progressFill = document.getElementById('progress-fill')!
const songNameEl = document.getElementById('song-name')!
const comboEl = document.getElementById('combo')!
const pctEl = document.getElementById('pct')!
const countdownEl = document.getElementById('countdown')!
const result = document.getElementById('result')!
const resultTitle = document.getElementById('result-title')!
const resultSub = document.getElementById('result-sub')!
const retryBtn = document.getElementById('retry') as HTMLButtonElement
const menuBtn = document.getElementById('menu-btn') as HTMLButtonElement

const engine = new SynthEngine()
const game = new Game(canvas)
game.setClock(() => engine.time)

// Try Blender-exported assets; silently fall back to procedural geometry.
game.loadAssets('./assets/buidash.glb')

interface SongIndexItem { id: string; name: string; artist: string; bpm: number }
let current: Chart | null = null
const chartCache = new Map<string, Chart>()

function show(el: HTMLElement, on: boolean) { el.classList.toggle('hidden', !on) }

// ---- build the song menu from the charts manifest ----
async function buildMenu() {
  try {
    const index: SongIndexItem[] = await (await fetch('./charts/index.json')).json()
    songList.innerHTML = ''
    for (const s of index) {
      const btn = document.createElement('button')
      btn.className = 'song-btn'
      btn.innerHTML = `<span class="s-name">${s.name}</span><span class="s-meta"><span class="s-bpm">${s.artist}</span> · ${s.bpm} BPM</span>`
      btn.addEventListener('click', () => startSong(s.id))
      songList.appendChild(btn)
    }
  } catch {
    songList.innerHTML = '<p class="hint">Could not load songs.</p>'
  }
}
buildMenu()

async function loadChart(id: string): Promise<Chart> {
  if (chartCache.has(id)) return chartCache.get(id)!
  const chart: Chart = await (await fetch(`./charts/${id}.json`)).json()
  chartCache.set(id, chart)
  return chart
}

async function startSong(id: string) {
  show(overlay, false)
  show(result, false)
  countdownEl.textContent = 'loading…'
  show(countdownEl, true)

  const [chart] = await Promise.all([loadChart(id), engine.loadInstruments()])
  current = chart
  engine.load(current.music)
  game.loadChart(current)
  songNameEl.textContent = current.artist ? `${current.artist} — ${current.name}` : current.name

  show(hud, true)
  await engine.start(2.0)
}

game.on({
  onCountdown: (n) => { countdownEl.textContent = String(n) },
  onStart: () => { show(countdownEl, false) },
  onProgress: (pct, combo) => {
    progressFill.style.width = pct.toFixed(1) + '%'
    pctEl.textContent = Math.floor(pct) + '%'
    comboEl.textContent = String(combo)
  },
  onCrash: (pct) => {
    engine.stop()
    show(hud, false)
    resultTitle.textContent = 'Crashed'
    resultSub.textContent = `${Math.floor(pct)}% through ${current?.name}. The spike was on the riff — be there with it.`
    show(result, true)
  },
  onWin: () => {
    engine.stop()
    show(hud, false)
    resultTitle.textContent = 'Cleared!'
    resultSub.textContent = `${current?.name} — you jumped the whole song.`
    show(result, true)
  },
})

// ---- input ----
function jumpDown(e: Event) {
  if (current && game.state !== 'idle') { e.preventDefault(); game.setJump(true) }
}
function jumpUp() { game.setJump(false) }

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp') jumpDown(e)
})
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp') jumpUp()
})
canvas.addEventListener('pointerdown', jumpDown)
window.addEventListener('pointerup', jumpUp)

retryBtn.addEventListener('click', () => current && startSong(current.id))
menuBtn.addEventListener('click', () => {
  engine.stop()
  show(result, false)
  show(hud, false)
  show(countdownEl, false)
  show(overlay, true)
})
