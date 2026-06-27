// SynthEngine — the single source of time for the whole game.
//
// Both the music AND the obstacle positions read this engine's clock
// (`AudioContext.currentTime`). That shared clock is the entire reason
// BúiDash stays frame-accurately on the beat: nothing derives motion from
// requestAnimationFrame deltas (see ISA ISC-16).

export type NoteKind = 'bass' | 'lead' | 'kick' | 'snare' | 'hat';

export interface Note {
  time: number; // seconds from song start
  kind: NoteKind;
  freq?: number; // for tonal kinds
  dur?: number; // seconds
  gain?: number; // 0..1 relative
}

export class SynthEngine {
  readonly ctx: AudioContext;
  private master: GainNode;
  private notes: Note[] = [];
  private nextIdx = 0;
  private startTime = 0; // ctx time at which song-time 0 occurs
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly lookahead = 0.12; // schedule this far ahead (s)
  private readonly tickMs = 25;
  private epoch = 0; // bumped on every (re)start to invalidate stale schedules

  started = false;

  constructor() {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);
  }

  load(notes: Note[]) {
    this.notes = notes.slice().sort((a, b) => a.time - b.time);
    this.nextIdx = 0;
  }

  /** (Re)start playback. `leadIn` seconds of silence precede song-time 0. */
  async start(leadIn = 2.0): Promise<void> {
    await this.ctx.resume();
    this.epoch++;
    this.startTime = this.ctx.currentTime + leadIn;
    this.nextIdx = 0;
    this.started = true;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(0.55, this.ctx.currentTime);
    if (this.timer) clearInterval(this.timer);
    const myEpoch = this.epoch;
    this.tick(myEpoch);
    this.timer = setInterval(() => this.tick(myEpoch), this.tickMs);
  }

  stop() {
    this.epoch++;
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Duck instantly so stray scheduled notes don't bleed through.
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(0.0001, this.ctx.currentTime);
  }

  /** Game time in seconds. Negative during the lead-in countdown. */
  get time(): number {
    return this.ctx.currentTime - this.startTime;
  }

  private tick(myEpoch: number) {
    if (myEpoch !== this.epoch) return;
    const horizon = this.time + this.lookahead;
    while (this.nextIdx < this.notes.length && this.notes[this.nextIdx].time < horizon) {
      const n = this.notes[this.nextIdx++];
      this.play(n, this.startTime + n.time);
    }
  }

  private play(n: Note, when: number) {
    when = Math.max(when, this.ctx.currentTime + 0.001);
    switch (n.kind) {
      case 'kick': return this.kick(when, n.gain ?? 1);
      case 'snare': return this.snare(when, n.gain ?? 1);
      case 'hat': return this.hat(when, n.gain ?? 0.5);
      default: return this.tone(n, when);
    }
  }

  private tone(n: Note, when: number) {
    const dur = n.dur ?? 0.2;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = n.kind === 'bass' ? 'triangle' : 'square';
    osc.frequency.setValueAtTime(n.freq ?? 220, when);
    const peak = (n.gain ?? 1) * (n.kind === 'bass' ? 0.5 : 0.22);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(g).connect(this.master);
    osc.start(when);
    osc.stop(when + dur + 0.03);
  }

  private kick(when: number, gain: number) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.12);
    g.gain.setValueAtTime(gain * 0.9, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
    osc.connect(g).connect(this.master);
    osc.start(when);
    osc.stop(when + 0.2);
  }

  private snare(when: number, gain: number) {
    const noise = this.noiseBuffer(0.2);
    const src = this.ctx.createBufferSource();
    src.buffer = noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'highpass';
    bp.frequency.value = 1500;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain * 0.5, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
    src.connect(bp).connect(g).connect(this.master);
    src.start(when);
    src.stop(when + 0.2);
  }

  private hat(when: number, gain: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.05);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain * 0.28, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
    src.connect(hp).connect(g).connect(this.master);
    src.start(when);
    src.stop(when + 0.06);
  }

  private _noise: AudioBuffer | null = null;
  private noiseBuffer(seconds: number): AudioBuffer {
    if (this._noise && this._noise.duration >= seconds) return this._noise;
    const len = Math.ceil(this.ctx.sampleRate * Math.max(seconds, 0.2));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noise = buf;
    return buf;
  }
}
