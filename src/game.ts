// The three.js scene + render loop.
//
// SYNC INVARIANT (ISA ISC-6, ISC-16): the horizontal world is driven ONLY by
// the audio clock — player.x = clock()*SPEED, every obstacle/gate x = its chart
// time * SPEED. rAF delta drives only the vertical axis + cosmetics.
//
// The level alternates two MODES (set by chart.sections):
//   CUBE — auto-run, tap to jump spikes/blocks, stay down under bars, pads launch.
//   SHIP — hold to fly up / release to fall, thread the gate corridor.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { Chart, ObstacleKind, Mode } from './songs'

const SPEED = 8
const GRAVITY = 40
const JUMP_V = 11
const GROUND_Y = 0.5
const JUMP_LEAD = 0.275
const SPIN_RATE = 11.5
const CLEAR_Y = 0.78
const BAR_Y = 1.85
const BAR_AIR_Y = 0.95
const PAD_V = 16.5
const HALF: Record<ObstacleKind, number> = { spike: 0.42, block: 0.46, bar: 0.6, pad: 0.5 }
const BAR_COLOR = 0xffe23d
const PAD_COLOR = 0x8cff5a
// ship
const SHIP_THRUST = 27
const SHIP_GRAV = 23
const SHIP_VMAX = 8.5
const SHIP_MIN_Y = 0.7
const SHIP_MAX_Y = 7.3
const CEIL = 9.2
const GATE_HALF = 0.45
const PLAYER_R = 0.45

export type Difficulty = 'easy' | 'normal' | 'hard'
const DIFF: Record<Difficulty, { clearY: number; halfScale: number; gatePad: number; cull: number }> = {
  easy: { clearY: 0.62, halfScale: 0.82, gatePad: 0.35, cull: 3 }, // forgiving + drops every 3rd jump/gate
  normal: { clearY: CLEAR_Y, halfScale: 1.0, gatePad: 0.0, cull: 0 },
  hard: { clearY: 0.92, halfScale: 1.14, gatePad: -0.15, cull: 0 },
}

export type GameState = 'idle' | 'countdown' | 'playing' | 'dead' | 'won'

export interface GameCallbacks {
  onProgress?: (pct: number, combo: number) => void
  onCountdown?: (n: number) => void
  onStart?: () => void
  onMode?: (mode: Mode) => void
  onCrash?: (pct: number) => void
  onWin?: () => void
}

class Particles {
  readonly points: THREE.Points
  private pos: Float32Array; private col: Float32Array; private base: Float32Array
  private vel: Float32Array; private life: Float32Array; private ttl: Float32Array
  private head = 0; private max: number
  constructor(scene: THREE.Scene, max = 600) {
    this.max = max
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 3); this.base = new Float32Array(max * 3)
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.ttl = new Float32Array(max)
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -1000
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3))
    const mat = new THREE.PointsMaterial({ size: 0.22, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    this.points = new THREE.Points(geo, mat); this.points.frustumCulled = false; scene.add(this.points)
  }
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, c: THREE.Color, ttl: number) {
    const i = this.head; this.head = (this.head + 1) % this.max
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz
    this.base[i * 3] = c.r; this.base[i * 3 + 1] = c.g; this.base[i * 3 + 2] = c.b
    this.life[i] = ttl; this.ttl[i] = ttl
  }
  burst(x: number, y: number, z: number, n: number, speed: number, c: THREE.Color) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI - Math.PI / 2
      const s = speed * (0.35 + Math.random() * 0.65)
      this.spawn(x, y, z, Math.cos(a) * Math.cos(e) * s, Math.abs(Math.sin(e)) * s + 1.5, Math.sin(a) * Math.cos(e) * s * 0.5, c, 0.55 + Math.random() * 0.55)
    }
  }
  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue
      this.life[i] -= dt
      const f = Math.max(0, this.life[i] / this.ttl[i])
      this.vel[i * 3 + 1] -= 16 * dt
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt
      this.col[i * 3] = this.base[i * 3] * f; this.col[i * 3 + 1] = this.base[i * 3 + 1] * f; this.col[i * 3 + 2] = this.base[i * 3 + 2] * f
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -1000; this.col[i * 3] = this.col[i * 3 + 1] = this.col[i * 3 + 2] = 0 }
    }
    ;(this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
  }
}

interface Ob { x: number; kind: ObstacleKind; mesh: THREE.Object3D; used?: boolean }
interface GateM { x: number; lo: number; hi: number; meshes: THREE.Object3D[] }

export class Game {
  private renderer: THREE.WebGLRenderer
  private composer: EffectComposer
  private bloom: UnrealBloomPass
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private clock = () => 0
  private cb: GameCallbacks = {}

  private player!: THREE.Object3D
  private playerModel: THREE.Object3D | null = null
  private spikeProto: THREE.Object3D | null = null
  private shadow!: THREE.Mesh
  private ground!: THREE.Mesh
  private grid!: THREE.GridHelper
  private gridMat!: THREE.LineBasicMaterial
  private rails: THREE.Mesh[] = []
  private beatLight!: THREE.PointLight
  private accentMat!: THREE.MeshStandardMaterial
  private sky!: THREE.Mesh
  private stars!: THREE.Points
  private skyline!: THREE.Group
  private particles!: Particles
  private rings: { mesh: THREE.Mesh; age: number; active: boolean }[] = []
  private portals: THREE.Object3D[] = []

  private chart: Chart | null = null
  private diff = DIFF.normal
  private obstacles: Ob[] = []
  private gates: GateM[] = []
  private passX: number[] = []
  private nextCombo = 0
  private combo = 0

  state: GameState = 'idle'
  private mode: Mode = 'cube'
  private vy = 0
  private grounded = true
  private jumpHeld = false
  private lastFrame = 0
  private spin = 0
  private lastBeat = -1
  private shake = 0
  private paused = false
  private accent = new THREE.Color(0xff3da6)
  private playerColor = new THREE.Color(0x36e0ff)

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.Fog(0x0a0a16, 28, 75)
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 800)
    this.camera.position.set(6, 3.4, 12.5)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x202040, 0.5))
    const dir = new THREE.DirectionalLight(0xffffff, 0.45); dir.position.set(-4, 10, 8); this.scene.add(dir)
    this.beatLight = new THREE.PointLight(0xff3da6, 0, 40); this.beatLight.position.set(0, 5, 6); this.scene.add(this.beatLight)

    this.buildSky(); this.buildStars(); this.buildSkyline(); this.buildWorld(); this.buildRings()
    this.particles = new Particles(this.scene)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.95, 0.55, 0.2)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    this.resize()
    window.addEventListener('resize', () => this.resize())
    requestAnimationFrame((t) => this.loop(t))
  }

  setClock(fn: () => number) { this.clock = fn }
  on(cb: GameCallbacks) { this.cb = cb }

  async loadAssets(url: string): Promise<boolean> {
    try {
      const gltf = await new GLTFLoader().loadAsync(url)
      const s = gltf.scene.getObjectByName('spike')
      if (s) this.spikeProto = s // keep the Blender spike; player is the procedural cube (so it can have a face)
      return Boolean(s)
    } catch { return false }
  }

  setPaused(p: boolean) { this.paused = p }

  private buildSky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { top: { value: new THREE.Color(0x0a0a16) }, bottom: { value: new THREE.Color(0x1a1033) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying vec3 vP; uniform vec3 top; uniform vec3 bottom; void main(){ float h = clamp(normalize(vP).y*0.5+0.5,0.0,1.0); gl_FragColor = vec4(mix(bottom, top, h),1.0); }',
    })
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), mat); this.scene.add(this.sky)
  }
  private buildStars() {
    const N = 800, pos = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) { pos[i * 3] = Math.random() * 1100 - 50; pos[i * 3 + 1] = 6 + Math.random() * 60; pos[i * 3 + 2] = -45 + Math.random() * 30 }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xbfd8ff, size: 0.35, transparent: true, opacity: 0.85, depthWrite: false }))
    this.stars.frustumCulled = false; this.scene.add(this.stars)
  }
  private buildSkyline() {
    this.skyline = new THREE.Group()
    const mat = new THREE.MeshBasicMaterial({ color: 0x3a2d6b })
    for (let x = -40; x < 1000; x += 9 + Math.random() * 8) {
      const h = 4 + Math.random() * 16, w = 4 + Math.random() * 5
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, 3), mat); box.position.set(x, h / 2, -26 - Math.random() * 8); this.skyline.add(box)
    }
    this.scene.add(this.skyline)
  }
  private buildWorld() {
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 26), new THREE.MeshStandardMaterial({ color: 0x141430, roughness: 0.85, metalness: 0.15 }))
    this.ground.rotation.x = -Math.PI / 2; this.ground.position.set(1900, 0, 0); this.scene.add(this.ground)
    this.grid = new THREE.GridHelper(4000, 1000, 0xff3da6, 0x223); this.grid.position.set(1900, 0.01, 0)
    this.gridMat = (Array.isArray(this.grid.material) ? this.grid.material[0] : this.grid.material) as THREE.LineBasicMaterial
    this.scene.add(this.grid)
    const railGeo = new THREE.BoxGeometry(4000, 0.18, 0.18)
    for (const z of [-6, 6]) { const m = new THREE.Mesh(railGeo, new THREE.MeshBasicMaterial({ color: 0xff3da6 })); m.position.set(1900, 0.2, z); this.rails.push(m); this.scene.add(m) }
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false }))
    this.shadow.rotation.x = -Math.PI / 2; this.shadow.position.y = 0.02; this.scene.add(this.shadow)
    const pGeo = new THREE.BoxGeometry(1, 1, 1)
    this.accentMat = new THREE.MeshStandardMaterial({ color: 0x36e0ff, emissive: 0x36e0ff, emissiveIntensity: 0.6, roughness: 0.35, metalness: 0.4 })
    const cube = new THREE.Mesh(pGeo, this.accentMat)
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(pGeo), new THREE.LineBasicMaterial({ color: 0xffffff }))
    this.player = new THREE.Group(); this.player.add(cube); this.player.add(edges)
    // face — eyes on the camera-facing side give the icon character (and read its spin)
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.4 })
    const pupilMat = new THREE.MeshBasicMaterial({ color: 0x05060a })
    for (const sx of [-0.2, 0.2]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 16), eyeMat); eye.position.set(sx, 0.13, 0.46); eye.scale.z = 0.5
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), pupilMat); pupil.position.set(sx + 0.045, 0.13, 0.55)
      this.player.add(eye); this.player.add(pupil)
    }
    this.player.position.set(0, GROUND_Y, 0); this.scene.add(this.player)
  }
  private buildRings() {
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.78, 40), new THREE.MeshBasicMaterial({ color: 0xff3da6, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }))
      m.rotation.x = -Math.PI / 2; m.position.y = 0.06; m.visible = false; this.scene.add(m); this.rings.push({ mesh: m, age: 0, active: false })
    }
  }

  loadChart(chart: Chart, difficulty: Difficulty = 'normal') {
    this.chart = chart
    this.diff = DIFF[difficulty]
    const pal = chart.palette
    // difficulty culls density on Easy
    let jc = 0
    const obsList = this.diff.cull
      ? chart.obstacles.filter((o) => (o.kind === 'spike' || o.kind === 'block') ? jc++ % this.diff.cull !== this.diff.cull - 1 : true)
      : chart.obstacles
    const gateList = this.diff.cull ? chart.gates.filter((_, i) => i % this.diff.cull !== this.diff.cull - 1) : chart.gates
    this.accent.set(pal.accent); this.playerColor.set(pal.player)
    this.scene.background = null
    ;((this.sky.material as THREE.ShaderMaterial).uniforms.top.value as THREE.Color).set(pal.bg)
    ;((this.sky.material as THREE.ShaderMaterial).uniforms.bottom.value as THREE.Color).set(pal.bg).lerp(new THREE.Color(pal.accent), 0.22)
    ;(this.scene.fog as THREE.Fog).color.set(pal.bg)
    ;(this.ground.material as THREE.MeshStandardMaterial).color.set(pal.ground)
    this.gridMat.color.set(pal.accent)
    for (const r of this.rails) (r.material as THREE.MeshBasicMaterial).color.set(pal.accent)
    this.beatLight.color.set(pal.accent)
    this.accentMat.color.set(pal.player); this.accentMat.emissive.set(pal.player)
    for (const ring of this.rings) (ring.mesh.material as THREE.MeshBasicMaterial).color.set(pal.accent)

    if (this.playerModel) { this.scene.remove(this.player); this.player = this.playerModel.clone(); this.player.position.set(0, GROUND_Y, 0); this.scene.add(this.player) }

    // clear old
    for (const o of this.obstacles) this.scene.remove(o.mesh)
    for (const g of this.gates) for (const m of g.meshes) this.scene.remove(m)
    for (const p of this.portals) this.scene.remove(p)
    this.obstacles = []; this.gates = []; this.portals = []

    const spikeMat = new THREE.MeshStandardMaterial({ color: pal.spike, emissive: pal.spike, emissiveIntensity: 0.85, roughness: 0.3, metalness: 0.3 })
    const blockMat = new THREE.MeshStandardMaterial({ color: pal.player, emissive: pal.player, emissiveIntensity: 0.7, roughness: 0.3, metalness: 0.4 })
    const barMat = new THREE.MeshBasicMaterial({ color: BAR_COLOR })
    const padMat = new THREE.MeshStandardMaterial({ color: PAD_COLOR, emissive: PAD_COLOR, emissiveIntensity: 1.0, roughness: 0.4 })
    const gateMat = new THREE.MeshStandardMaterial({ color: pal.accent, emissive: pal.accent, emissiveIntensity: 0.6, roughness: 0.4, metalness: 0.4 })

    for (const ob of obsList) {
      let mesh: THREE.Object3D, x: number
      if (ob.kind === 'bar') { x = ob.time * SPEED; mesh = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.24, 12), barMat); mesh.position.set(x, BAR_Y, 0) }
      else if (ob.kind === 'block') { x = (ob.time + JUMP_LEAD) * SPEED; mesh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), blockMat); mesh.position.set(x, 0.45, 0) }
      else if (ob.kind === 'pad') { x = ob.time * SPEED; mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.16, 16), padMat); mesh.position.set(x, 0.08, 0) }
      else { x = (ob.time + JUMP_LEAD) * SPEED; if (this.spikeProto) mesh = this.spikeProto.clone(); else { mesh = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 4), spikeMat); (mesh as THREE.Mesh).rotation.y = Math.PI / 4 } mesh.position.set(x, 0.5, 0) }
      this.scene.add(mesh)
      this.obstacles.push({ x, kind: ob.kind, mesh })
    }

    for (const g of gateList) {
      const x = g.time * SPEED
      const lo = g.centerY - g.gap / 2, hi = g.centerY + g.gap / 2
      const bottom = new THREE.Mesh(new THREE.BoxGeometry(0.7, Math.max(0.1, lo), 5), gateMat)
      bottom.position.set(x, lo / 2, 0)
      const top = new THREE.Mesh(new THREE.BoxGeometry(0.7, Math.max(0.1, CEIL - hi), 5), gateMat)
      top.position.set(x, (CEIL + hi) / 2, 0)
      this.scene.add(bottom); this.scene.add(top)
      this.gates.push({ x, lo, hi, meshes: [bottom, top] })
    }

    // portals at section boundaries
    for (let i = 1; i < chart.sections.length; i++) {
      const sec = chart.sections[i]
      const col = sec.mode === 'ship' ? 0x36e0ff : 0xff9a3d
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.16, 10, 28), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8 }))
      ring.rotation.y = Math.PI / 2; ring.position.set(sec.start * SPEED, 3, 0)
      this.scene.add(ring); this.portals.push(ring)
    }

    this.passX = [...this.obstacles.filter((o) => o.kind !== 'pad').map((o) => o.x), ...this.gates.map((g) => g.x)].sort((a, b) => a - b)
    this.reset()
  }

  private modeAt(t: number): Mode {
    if (!this.chart) return 'cube'
    for (const s of this.chart.sections) if (t >= s.start && t < s.end) return s.mode
    return 'cube'
  }

  reset() {
    this.vy = 0; this.grounded = true; this.spin = 0; this.nextCombo = 0; this.combo = 0
    this.lastBeat = -1; this.shake = 0; this.mode = 'cube'
    for (const o of this.obstacles) o.used = false
    this.player.visible = true; this.player.position.set(0, GROUND_Y, 0); this.player.scale.setScalar(1); this.player.rotation.set(0, 0, 0)
    this.shadow.visible = true
    this.state = 'countdown'
  }

  setJump(held: boolean) {
    this.jumpHeld = held
    if (held && this.mode === 'cube' && this.grounded && this.state === 'playing') this.jump()
  }
  private jump() { this.vy = JUMP_V; this.grounded = false; this.particles.burst(this.player.position.x, this.player.position.y, 0, 14, 4, this.playerColor) }

  private resize() {
    const w = window.innerWidth, h = window.innerHeight
    this.renderer.setSize(w, h, false); this.composer.setSize(w, h); this.bloom.resolution.set(w, h)
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix()
  }

  private spawnRing(x: number) {
    const r = this.rings.find((r) => !r.active) ?? this.rings[0]
    r.active = true; r.age = 0; r.mesh.visible = true; r.mesh.position.x = x; r.mesh.scale.setScalar(1)
    ;(r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9
  }

  private loop(now: number) {
    requestAnimationFrame((t) => this.loop(t))
    const dt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.05) : 0
    this.lastFrame = now
    if (!this.paused) {
      const t = this.clock()
      if (this.chart) this.update(t, dt)
      this.particles.update(dt)
    }
    this.composer.render()
  }

  private update(t: number, dt: number) {
    const chart = this.chart!
    if (this.state === 'countdown') {
      if (t < 0) this.cb.onCountdown?.(Math.ceil(-t))
      else { this.state = 'playing'; this.cb.onStart?.() }
    }

    const px = t * SPEED
    this.player.position.x = px

    // mode switch
    if (this.state === 'playing' || this.state === 'won') {
      const m = this.modeAt(t)
      if (m !== this.mode) {
        this.mode = m
        this.vy = 0; this.grounded = false
        this.cb.onMode?.(m)
        this.particles.burst(px, this.player.position.y, 0, 24, 6, this.accent)
      }
    }

    if (this.state === 'playing' || this.state === 'won') {
      if (this.mode === 'cube') {
        if (!this.grounded) {
          this.vy -= GRAVITY * dt
          this.player.position.y += this.vy * dt
          if (this.player.position.y <= GROUND_Y) { this.player.position.y = GROUND_Y; this.vy = 0; this.grounded = true; if (this.jumpHeld) this.jump() }
        }
        if (this.grounded) { this.player.rotation.z = 0; this.spin = 0 }
        else { this.spin += SPIN_RATE * dt; this.player.rotation.z = -this.spin }
      } else {
        // SHIP: hold to thrust up, release to fall
        this.vy += (this.jumpHeld ? SHIP_THRUST : -SHIP_GRAV) * dt
        this.vy = Math.max(-SHIP_VMAX, Math.min(SHIP_VMAX, this.vy))
        this.player.position.y += this.vy * dt
        if (this.player.position.y < SHIP_MIN_Y) { this.player.position.y = SHIP_MIN_Y; this.vy = 0 }
        if (this.player.position.y > SHIP_MAX_Y) { this.player.position.y = SHIP_MAX_Y; this.vy = 0 }
        this.player.rotation.z = THREE.MathUtils.clamp(this.vy * 0.06, -0.5, 0.5)
        if (this.jumpHeld) this.particles.spawn(px - 0.4, this.player.position.y - 0.3, 0, -2, -1, 0, this.playerColor, 0.35)
      }
      if (this.player.visible) this.particles.spawn(px - 0.4, this.player.position.y, 0, -1 - Math.random(), Math.random() * 0.5, 0, this.playerColor, 0.4)
    }

    // beat ring
    const secPerBeat = 60 / chart.bpm
    if (t > 0) { const beat = Math.floor(t / secPerBeat); if (beat > this.lastBeat) { this.lastBeat = beat; this.spawnRing(px) } }
    const beatPhase = t > 0 ? (t / secPerBeat) % 1 : 1
    const pulse = Math.max(0, 1 - beatPhase)
    this.beatLight.position.x = px + 2
    this.beatLight.intensity = 1.5 + pulse * 7
    this.accentMat.emissiveIntensity = 0.5 + pulse * 1.1
    this.gridMat.color.copy(this.accent).multiplyScalar(0.5 + pulse * 0.9)
    this.bloom.strength = 0.85 + pulse * 0.5
    if (this.state === 'playing') this.player.scale.setScalar(1 + pulse * 0.13)

    const air = this.player.position.y - GROUND_Y
    this.shadow.position.x = px
    this.shadow.scale.setScalar(Math.max(0.35, 1 - air * 0.18))
    ;(this.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.05, 0.4 - air * 0.07)

    for (const r of this.rings) {
      if (!r.active) continue
      r.age += dt; r.mesh.scale.setScalar(1 + r.age * 9)
      const mm = r.mesh.material as THREE.MeshBasicMaterial; mm.opacity = Math.max(0, 0.9 - r.age * 1.6)
      if (mm.opacity <= 0) { r.active = false; r.mesh.visible = false }
    }
    for (const p of this.portals) p.rotation.x += dt * 1.5

    const camX = px + 6
    this.sky.position.copy(this.camera.position)
    this.stars.position.x = camX * 0.85
    this.skyline.position.x = camX * 0.45
    this.shake = Math.max(0, this.shake - dt * 2.2)
    const camY = (this.mode === 'ship' ? 4.3 : 3.4) + (Math.random() - 0.5) * this.shake
    this.camera.position.set(camX + (Math.random() - 0.5) * this.shake, camY, 12.5 - pulse * 0.5)
    this.camera.lookAt(camX, this.mode === 'ship' ? 2.6 : 1.6, -2)

    if (this.state === 'playing') {
      const py = this.player.position.y
      const bottom = py - 0.5
      if (this.mode === 'cube') {
        for (const ob of this.obstacles) {
          const dx = Math.abs(px - ob.x)
          if (ob.kind === 'pad') { if (!ob.used && dx < HALF.pad && this.grounded) { ob.used = true; this.vy = PAD_V; this.grounded = false; this.particles.burst(ob.x, 0.3, 0, 20, 6, new THREE.Color(PAD_COLOR)) } }
          else if (ob.kind === 'bar') { if (dx < HALF.bar && py > BAR_AIR_Y) return this.crash(t) }
          else { if (dx < HALF[ob.kind] * this.diff.halfScale && bottom < this.diff.clearY) return this.crash(t) }
        }
      } else {
        for (const g of this.gates) {
          if (Math.abs(px - g.x) < GATE_HALF && (py - PLAYER_R < g.lo - this.diff.gatePad || py + PLAYER_R > g.hi + this.diff.gatePad)) return this.crash(t)
        }
      }
      while (this.nextCombo < this.passX.length && this.passX[this.nextCombo] < px - 0.5) { this.nextCombo++; this.combo++ }
      this.cb.onProgress?.(Math.min(100, Math.max(0, (t / chart.duration) * 100)), this.combo)
      if (t >= chart.duration) { this.state = 'won'; this.cb.onWin?.() }
    }
  }

  private crash(t: number) {
    this.state = 'dead'; this.shake = 0.9
    this.particles.burst(this.player.position.x, this.player.position.y, 0, 160, 13, new THREE.Color(this.chart!.palette.spike))
    this.player.visible = false; this.shadow.visible = false
    this.cb.onCrash?.(this.chart ? Math.min(100, (t / this.chart.duration) * 100) : 0)
  }
}

export { SPEED }
