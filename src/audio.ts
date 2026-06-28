// SynthEngine — the single clock for the game, plus the sound.
//
// Music and obstacle positions both read AudioContext.currentTime (minus output
// latency), which keeps spikes frame-accurately on the beat (ISA ISC-16).
//
// SOUND: each song's melodic voices play their REAL instruments (the MIDI knows
// them — distortion guitar, steel guitar, grand piano, sawtooth synth…) using
// high-quality MusyngKite samples loaded on demand. Drums are synthesised. A
// convolver reverb gives it space. Any voice that fails to load falls back to a
// synth so the song still plays.

import Soundfont from 'soundfont-player'

export type NoteKind = 'bass' | 'sub' | 'lead' | 'pad' | 'kick' | 'snare' | 'hat'

export interface Note {
  time: number
  kind: NoteKind
  midi?: number
  dur?: number
  gain?: number
}

export interface Instruments { lead: string; bass: string; pad: string }

const CDN = 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/MusyngKite'
const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

export class SynthEngine {
  readonly ctx: AudioContext
  private master: GainNode
  private comp: DynamicsCompressorNode
  private wet: GainNode
  private notes: Note[] = []
  private nextIdx = 0
  private startTime = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly lookahead = 0.12
  private readonly tickMs = 25
  private epoch = 0

  private cache = new Map<string, any>()
  private cur: { lead: any; bass: any; pad: any } = { lead: null, bass: null, pad: null }

  started = false

  constructor() {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    this.ctx = new Ctx()
    this.master = this.ctx.createGain()
    this.master.gain.value = 0.9
    this.comp = this.ctx.createDynamicsCompressor()
    this.comp.threshold.value = -16
    this.comp.ratio.value = 3.5
    // reverb send for space
    const conv = this.ctx.createConvolver()
    conv.buffer = this.impulse(1.8, 2.6)
    this.wet = this.ctx.createGain()
    this.wet.gain.value = 0.16
    this.master.connect(this.comp) // dry
    this.master.connect(conv)
    conv.connect(this.wet).connect(this.comp)
    this.comp.connect(this.ctx.destination)
  }

  /** Load this song's real instruments (cached across songs). Never blocks on resume. */
  async loadInstruments(instruments: Instruments): Promise<void> {
    const ensure = async (name: string) => {
      if (this.cache.has(name)) return this.cache.get(name)
      try {
        const p = await Soundfont.instrument(this.ctx, name as any, {
          destination: this.master,
          format: 'mp3',
          soundfont: 'MusyngKite',
          nameToUrl: (n: string) => `${CDN}/${n}-mp3.js`,
        } as any)
        this.cache.set(name, p)
        return p
      } catch (e) {
        console.warn('[buidash] instrument load failed:', name, e)
        this.cache.set(name, null)
        return null
      }
    }
    const [lead, bass, pad] = await Promise.all([ensure(instruments.lead), ensure(instruments.bass), ensure(instruments.pad)])
    this.cur = { lead, bass, pad }
  }

  load(notes: Note[]) {
    this.notes = notes.slice().sort((a, b) => a.time - b.time)
    this.nextIdx = 0
  }

  async start(leadIn = 2.0): Promise<void> {
    await this.ctx.resume()
    this.epoch++
    this.startTime = this.ctx.currentTime + leadIn
    this.nextIdx = 0
    this.started = true
    this.master.gain.cancelScheduledValues(this.ctx.currentTime)
    this.master.gain.setValueAtTime(0.9, this.ctx.currentTime)
    if (this.timer) clearInterval(this.timer)
    const myEpoch = this.epoch
    this.tick(myEpoch)
    this.timer = setInterval(() => this.tick(myEpoch), this.tickMs)
  }

  stop() {
    this.epoch++
    this.started = false
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.master.gain.cancelScheduledValues(this.ctx.currentTime)
    this.master.gain.setValueAtTime(0.0001, this.ctx.currentTime)
  }

  get time(): number {
    const lat = (this.ctx as any).outputLatency ?? this.ctx.baseLatency ?? 0
    return this.ctx.currentTime - this.startTime - lat
  }

  private tick(myEpoch: number) {
    if (myEpoch !== this.epoch) return
    const horizon = this.time + this.lookahead
    while (this.nextIdx < this.notes.length && this.notes[this.nextIdx].time < horizon) {
      const n = this.notes[this.nextIdx++]
      this.play(n, this.startTime + n.time)
    }
  }

  private play(n: Note, when: number) {
    when = Math.max(when, this.ctx.currentTime + 0.001)
    const midi = String(n.midi ?? 60)
    switch (n.kind) {
      case 'kick': return this.kick(when, n.gain ?? 1)
      case 'snare': return this.snare(when, n.gain ?? 1)
      case 'hat': return this.hat(when, n.gain ?? 0.5)
      case 'lead':
        if (this.cur.lead) { this.cur.lead.play(midi, when, { duration: Math.min(n.dur ?? 0.4, 2.4), gain: (n.gain ?? 1) * 0.9 }); return }
        return this.synth(n, when, 'sawtooth', 0.16)
      case 'bass':
        if (this.cur.bass) { this.cur.bass.play(midi, when, { duration: Math.min(n.dur ?? 0.5, 2.4), gain: (n.gain ?? 1) * 0.95 }); return }
        return this.synth(n, when, 'triangle', 0.4)
      case 'pad':
        if (this.cur.pad) { this.cur.pad.play(midi, when, { duration: Math.min(n.dur ?? 0.8, 2.4), gain: (n.gain ?? 1) * 0.45 }); return }
        return this.synth(n, when, 'sine', 0.08)
      case 'sub': return this.synth(n, when, 'sine', 0.4)
    }
  }

  private synth(n: Note, when: number, type: OscillatorType, level: number) {
    const dur = n.dur ?? 0.25
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(midiToFreq(n.midi ?? 60), when)
    const peak = (n.gain ?? 1) * level
    g.gain.setValueAtTime(0.0001, when)
    g.gain.exponentialRampToValueAtTime(peak, when + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur)
    osc.connect(g).connect(this.master)
    osc.start(when)
    osc.stop(when + dur + 0.05)
  }

  private kick(when: number, gain: number) {
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(165, when)
    osc.frequency.exponentialRampToValueAtTime(42, when + 0.11)
    g.gain.setValueAtTime(0.0001, when)
    g.gain.exponentialRampToValueAtTime(gain * 1.0, when + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.22)
    osc.connect(g).connect(this.master)
    osc.start(when); osc.stop(when + 0.26)
    // click transient
    const c = this.ctx.createBufferSource(); c.buffer = this.noiseBuffer(0.02)
    const cg = this.ctx.createGain(); cg.gain.setValueAtTime(gain * 0.25, when); cg.gain.exponentialRampToValueAtTime(0.0001, when + 0.02)
    c.connect(cg).connect(this.master); c.start(when); c.stop(when + 0.03)
  }

  private snare(when: number, gain: number) {
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuffer(0.2)
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 0.6
    const g = this.ctx.createGain(); g.gain.setValueAtTime(gain * 0.55, when); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.18)
    src.connect(bp).connect(g).connect(this.master); src.start(when); src.stop(when + 0.2)
    // tonal body
    const o = this.ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(190, when)
    const og = this.ctx.createGain(); og.gain.setValueAtTime(gain * 0.3, when); og.gain.exponentialRampToValueAtTime(0.0001, when + 0.12)
    o.connect(og).connect(this.master); o.start(when); o.stop(when + 0.14)
  }

  private hat(when: number, gain: number) {
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuffer(0.05)
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 8000
    const g = this.ctx.createGain(); g.gain.setValueAtTime(gain * 0.26, when); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.04)
    src.connect(hp).connect(g).connect(this.master); src.start(when); src.stop(when + 0.06)
  }

  private _noise: AudioBuffer | null = null
  private noiseBuffer(seconds: number): AudioBuffer {
    if (this._noise && this._noise.duration >= seconds) return this._noise
    const len = Math.ceil(this.ctx.sampleRate * Math.max(seconds, 0.2))
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    this._noise = buf
    return buf
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx.sampleRate
    const len = Math.floor(rate * seconds)
    const buf = this.ctx.createBuffer(2, len, rate)
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch)
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
    }
    return buf
  }
}
