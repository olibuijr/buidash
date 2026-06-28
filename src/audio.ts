// SynthEngine — the single source of time for the whole game.
//
// Music and obstacle positions both read this engine's clock
// (`AudioContext.currentTime`), which is what keeps spikes frame-accurately on
// the beat (ISA ISC-16). The clock subtracts the audio output latency so what
// you HEAR lines up with what you SEE.
//
// Melodic voices (lead = distortion guitar, bass) use real instrument samples
// via soundfont-player so the songs are recognisable. Sub, pad and drums stay
// synthesised. If a soundfont fails to load, the voice falls back to a synth.

import Soundfont from 'soundfont-player'

export type NoteKind = 'bass' | 'sub' | 'lead' | 'pad' | 'kick' | 'snare' | 'hat'

export interface Note {
  time: number
  kind: NoteKind
  midi?: number // for tonal kinds
  dur?: number
  gain?: number
}

const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

export class SynthEngine {
  readonly ctx: AudioContext
  private master: GainNode
  private comp: DynamicsCompressorNode
  private notes: Note[] = []
  private nextIdx = 0
  private startTime = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly lookahead = 0.12
  private readonly tickMs = 25
  private epoch = 0

  private guitar: Soundfont.Player | null = null
  private bass: Soundfont.Player | null = null
  private loadingPromise: Promise<void> | null = null

  started = false

  constructor() {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    this.ctx = new Ctx()
    this.master = this.ctx.createGain()
    this.master.gain.value = 0.85
    this.comp = this.ctx.createDynamicsCompressor()
    this.comp.threshold.value = -16
    this.comp.ratio.value = 3.5
    this.master.connect(this.comp).connect(this.ctx.destination)
  }

  /** Fetch the guitar + bass instrument samples (idempotent). */
  loadInstruments(): Promise<void> {
    if (this.loadingPromise) return this.loadingPromise
    const base = (import.meta as any).env?.BASE_URL ?? '/'
    const opt = {
      destination: this.master,
      format: 'mp3' as const,
      soundfont: 'FluidR3_GM' as const,
      nameToUrl: (name: string) => `${base}soundfonts/${name}-mp3.js`,
    }
    this.loadingPromise = (async () => {
      await this.ctx.resume()
      try {
        const [g, b] = await Promise.all([
          Soundfont.instrument(this.ctx, 'distortion_guitar' as any, opt as any),
          Soundfont.instrument(this.ctx, 'electric_bass_finger' as any, opt as any),
        ])
        this.guitar = g
        this.bass = b
      } catch (e) {
        console.warn('[buidash] soundfont load failed, using synth fallback', e)
      }
    })()
    return this.loadingPromise
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
    this.master.gain.setValueAtTime(0.85, this.ctx.currentTime)
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

  /** Game time (s). Negative during lead-in. Compensated for output latency. */
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
    switch (n.kind) {
      case 'kick': return this.kick(when, n.gain ?? 1)
      case 'snare': return this.snare(when, n.gain ?? 1)
      case 'hat': return this.hat(when, n.gain ?? 0.5)
      case 'lead':
        if (this.guitar) { this.guitar.play(String(n.midi ?? 64), when, { duration: Math.min(n.dur ?? 0.3, 2), gain: (n.gain ?? 1) * 0.85 }); return }
        return this.synth(n, when, 'square', 0.18)
      case 'bass':
        if (this.bass) { this.bass.play(String(n.midi ?? 40), when, { duration: Math.min(n.dur ?? 0.4, 2), gain: (n.gain ?? 1) * 0.9 }); return }
        return this.synth(n, when, 'triangle', 0.45)
      case 'sub': return this.synth(n, when, 'sine', 0.5)
      case 'pad': return this.pad(n, when)
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

  private pad(n: Note, when: number) {
    const dur = Math.min(n.dur ?? 0.6, 1.6)
    const osc = this.ctx.createOscillator()
    const lp = this.ctx.createBiquadFilter()
    const g = this.ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(midiToFreq(n.midi ?? 60), when)
    lp.type = 'lowpass'
    lp.frequency.value = 1300
    lp.Q.value = 0.6
    const peak = (n.gain ?? 1) * 0.07
    g.gain.setValueAtTime(0.0001, when)
    g.gain.exponentialRampToValueAtTime(peak, when + 0.09)
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur)
    osc.connect(lp).connect(g).connect(this.master)
    osc.start(when)
    osc.stop(when + dur + 0.05)
  }

  private kick(when: number, gain: number) {
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(150, when)
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.12)
    g.gain.setValueAtTime(gain * 0.95, when)
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.17)
    osc.connect(g).connect(this.master)
    osc.start(when)
    osc.stop(when + 0.22)
  }

  private snare(when: number, gain: number) {
    const src = this.ctx.createBufferSource()
    src.buffer = this.noiseBuffer(0.2)
    const bp = this.ctx.createBiquadFilter()
    bp.type = 'highpass'
    bp.frequency.value = 1500
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(gain * 0.5, when)
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.16)
    src.connect(bp).connect(g).connect(this.master)
    src.start(when)
    src.stop(when + 0.2)
  }

  private hat(when: number, gain: number) {
    const src = this.ctx.createBufferSource()
    src.buffer = this.noiseBuffer(0.05)
    const hp = this.ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 7000
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(gain * 0.28, when)
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.045)
    src.connect(hp).connect(g).connect(this.master)
    src.start(when)
    src.stop(when + 0.06)
  }

  private _noise: AudioBuffer | null = null
  private noiseBuffer(seconds: number): AudioBuffer {
    if (this._noise && this._noise.duration >= seconds) return this._noise
    const len = Math.ceil(this.ctx.sampleRate * Math.max(seconds, 0.2))
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    this._noise = buf
    return buf
  }
}
