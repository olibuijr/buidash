import './style.css'
import { SynthEngine } from './audio'
import { SONGS, buildChart, type Chart } from './songs'
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

let current: Chart | null = null

// ---- build the song menu ----
for (const def of SONGS) {
  const btn = document.createElement('button')
  btn.className = 'song-btn'
  btn.innerHTML = `<span class="s-name">${def.name}</span><span class="s-meta"><span class="s-bpm">${def.bpm}</span> BPM · ${def.bars} bars</span>`
  btn.addEventListener('click', () => startSong(def.id))
  songList.appendChild(btn)
}

function show(el: HTMLElement, on: boolean) { el.classList.toggle('hidden', !on) }

async function startSong(id: string) {
  const def = SONGS.find((s) => s.id === id)!
  current = buildChart(def)
  engine.load(current.music)
  game.loadChart(current)
  songNameEl.textContent = current.name

  show(overlay, false)
  show(result, false)
  show(hud, true)
  show(countdownEl, true)
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
    resultSub.textContent = `You reached ${Math.floor(pct)}% of ${current?.name}. The spike was on beat — be there with it.`
    show(result, true)
  },
  onWin: () => {
    engine.stop()
    show(hud, false)
    resultTitle.textContent = 'Cleared!'
    resultSub.textContent = `${current?.name} — perfect run on the beat.`
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
