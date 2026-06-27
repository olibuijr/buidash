// The three.js scene + render loop.
//
// SYNC INVARIANT (ISA ISC-6, ISC-16): the horizontal world is driven ONLY by
// the audio clock. player.x = clock() * SPEED, spike.x = spikeTime * SPEED.
// requestAnimationFrame's delta is used ONLY for the vertical jump arc and
// cosmetic effects (particles, pulses, shake) — never for anything that decides
// where a spike is. That is what keeps every spike frame-accurately on the beat.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { Chart } from './songs'

const SPEED = 8 // world units per second
const GRAVITY = 40 // units / s^2
const JUMP_V = 11 // units / s  (apex ~1.5u, airtime ~0.55s — clears a 1u spike)
const GROUND_Y = 0.5
const SPIKE_HALF = 0.42
const SPIKE_CLEAR_Y = 0.78

export type GameState = 'idle' | 'countdown' | 'playing' | 'dead' | 'won'

export interface GameCallbacks {
  onProgress?: (pct: number, combo: number) => void
  onCountdown?: (n: number) => void
  onStart?: () => void
  onCrash?: (pct: number) => void
  onWin?: () => void
}

// ---- additive particle pool ----
class Particles {
  readonly points: THREE.Points
  private pos: Float32Array
  private col: Float32Array
  private base: Float32Array
  private vel: Float32Array
  private life: Float32Array
  private ttl: Float32Array
  private head = 0
  private max: number

  constructor(scene: THREE.Scene, max = 600) {
    this.max = max
    this.pos = new Float32Array(max * 3)
    this.col = new Float32Array(max * 3)
    this.base = new Float32Array(max * 3)
    this.vel = new Float32Array(max * 3)
    this.life = new Float32Array(max)
    this.ttl = new Float32Array(max)
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -1000
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3))
    const mat = new THREE.PointsMaterial({ size: 0.22, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    scene.add(this.points)
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, c: THREE.Color, ttl: number) {
    const i = this.head
    this.head = (this.head + 1) % this.max
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz
    this.base[i * 3] = c.r; this.base[i * 3 + 1] = c.g; this.base[i * 3 + 2] = c.b
    this.life[i] = ttl; this.ttl[i] = ttl
  }

  burst(x: number, y: number, z: number, n: number, speed: number, c: THREE.Color) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2
      const e = Math.random() * Math.PI - Math.PI / 2
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
      this.pos[i * 3] += this.vel[i * 3] * dt
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt
      this.col[i * 3] = this.base[i * 3] * f
      this.col[i * 3 + 1] = this.base[i * 3 + 1] * f
      this.col[i * 3 + 2] = this.base[i * 3 + 2] * f
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -1000; this.col[i * 3] = this.col[i * 3 + 1] = this.col[i * 3 + 2] = 0 }
    }
    ;(this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
  }
}

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
  private ground!: THREE.Mesh
  private grid!: THREE.GridHelper
  private gridMat!: THREE.LineBasicMaterial
  private rails: THREE.Mesh[] = []
  private beatLight!: THREE.PointLight
  private accentMat!: THREE.MeshStandardMaterial
  private sky!: THREE.Mesh
  private skyTop = new THREE.Color()
  private stars!: THREE.Points
  private skyline!: THREE.Group
  private particles!: Particles
  private rings: { mesh: THREE.Mesh; age: number; active: boolean }[] = []

  private chart: Chart | null = null
  private spikeMeshes: { x: number; mesh: THREE.Object3D }[] = []
  private nextCombo = 0
  private combo = 0

  state: GameState = 'idle'
  private vy = 0
  private grounded = true
  private jumpHeld = false
  private lastFrame = 0
  private spin = 0
  private lastBeat = -1
  private shake = 0
  private accent = new THREE.Color(0xff3da6)
  private playerColor = new THREE.Color(0x36e0ff)

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.Fog(0x0a0a16, 26, 70)

    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 800)
    this.camera.position.set(6, 3.4, 12.5)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x202040, 0.5))
    const dir = new THREE.DirectionalLight(0xffffff, 0.45)
    dir.position.set(-4, 10, 8)
    this.scene.add(dir)
    this.beatLight = new THREE.PointLight(0xff3da6, 0, 40)
    this.beatLight.position.set(0, 5, 6)
    this.scene.add(this.beatLight)

    this.buildSky()
    this.buildStars()
    this.buildSkyline()
    this.buildWorld()
    this.buildRings()
    this.particles = new Particles(this.scene)

    // post-processing (bloom = the neon glow)
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
      const loader = new GLTFLoader()
      const gltf = await loader.loadAsync(url)
      const p = gltf.scene.getObjectByName('player')
      const s = gltf.scene.getObjectByName('spike')
      if (p) this.playerModel = p
      if (s) this.spikeProto = s
      return Boolean(p || s)
    } catch {
      return false
    }
  }

  private buildSky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { top: { value: new THREE.Color(0x0a0a16) }, bottom: { value: new THREE.Color(0x1a1033) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying vec3 vP; uniform vec3 top; uniform vec3 bottom; void main(){ float h = clamp(normalize(vP).y*0.5+0.5, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, h), 1.0); }',
    })
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), mat)
    this.scene.add(this.sky)
  }

  private buildStars() {
    const N = 800
    const pos = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      pos[i * 3] = Math.random() * 1100 - 50
      pos[i * 3 + 1] = 6 + Math.random() * 60
      pos[i * 3 + 2] = -45 + Math.random() * 30
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const mat = new THREE.PointsMaterial({ color: 0xbfd8ff, size: 0.35, transparent: true, opacity: 0.85, depthWrite: false })
    this.stars = new THREE.Points(geo, mat)
    this.stars.frustumCulled = false
    this.scene.add(this.stars)
  }

  private buildSkyline() {
    this.skyline = new THREE.Group()
    const mat = new THREE.MeshBasicMaterial({ color: 0x3a2d6b })
    for (let x = -40; x < 1000; x += 9 + Math.random() * 8) {
      const h = 4 + Math.random() * 16
      const w = 4 + Math.random() * 5
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, 3), mat)
      box.position.set(x, h / 2, -26 - Math.random() * 8)
      this.skyline.add(box)
    }
    this.scene.add(this.skyline)
  }

  private buildWorld() {
    const gGeo = new THREE.PlaneGeometry(4000, 26)
    const gMat = new THREE.MeshStandardMaterial({ color: 0x141430, roughness: 0.85, metalness: 0.15 })
    this.ground = new THREE.Mesh(gGeo, gMat)
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.set(1900, 0, 0)
    this.scene.add(this.ground)

    this.grid = new THREE.GridHelper(4000, 1000, 0xff3da6, 0x223)
    this.grid.position.set(1900, 0.01, 0)
    this.gridMat = (Array.isArray(this.grid.material) ? this.grid.material[0] : this.grid.material) as THREE.LineBasicMaterial
    this.scene.add(this.grid)

    // neon side rails (glowing tubes under bloom)
    const railGeo = new THREE.BoxGeometry(4000, 0.18, 0.18)
    for (const z of [-6, 6]) {
      const m = new THREE.Mesh(railGeo, new THREE.MeshBasicMaterial({ color: 0xff3da6 }))
      m.position.set(1900, 0.2, z)
      this.rails.push(m)
      this.scene.add(m)
    }

    // player (procedural default — replaced by GLB if loaded)
    const pGeo = new THREE.BoxGeometry(1, 1, 1)
    this.accentMat = new THREE.MeshStandardMaterial({ color: 0x36e0ff, emissive: 0x36e0ff, emissiveIntensity: 0.6, roughness: 0.35, metalness: 0.4 })
    const cube = new THREE.Mesh(pGeo, this.accentMat)
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(pGeo), new THREE.LineBasicMaterial({ color: 0xffffff }))
    this.player = new THREE.Group()
    this.player.add(cube)
    this.player.add(edges)
    this.player.position.set(0, GROUND_Y, 0)
    this.scene.add(this.player)
  }

  private buildRings() {
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 0.78, 40),
        new THREE.MeshBasicMaterial({ color: 0xff3da6, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
      )
      m.rotation.x = -Math.PI / 2
      m.position.y = 0.06
      m.visible = false
      this.scene.add(m)
      this.rings.push({ mesh: m, age: 0, active: false })
    }
  }

  loadChart(chart: Chart) {
    this.chart = chart
    const pal = chart.palette
    this.accent.set(pal.accent)
    this.playerColor.set(pal.player)

    this.scene.background = null
    this.skyTop.set(pal.bg)
    ;((this.sky.material as THREE.ShaderMaterial).uniforms.top.value as THREE.Color).set(pal.bg)
    ;((this.sky.material as THREE.ShaderMaterial).uniforms.bottom.value as THREE.Color).set(pal.bg).lerp(new THREE.Color(pal.accent), 0.22)
    ;(this.scene.fog as THREE.Fog).color.set(pal.bg)
    ;(this.ground.material as THREE.MeshStandardMaterial).color.set(pal.ground)
    this.gridMat.color.set(pal.accent)
    for (const r of this.rails) (r.material as THREE.MeshBasicMaterial).color.set(pal.accent)
    this.beatLight.color.set(pal.accent)
    this.accentMat.color.set(pal.player)
    this.accentMat.emissive.set(pal.player)
    for (const ring of this.rings) (ring.mesh.material as THREE.MeshBasicMaterial).color.set(pal.accent)

    if (this.playerModel) {
      this.scene.remove(this.player)
      this.player = this.playerModel.clone()
      this.player.position.set(0, GROUND_Y, 0)
      this.scene.add(this.player)
    }

    for (const s of this.spikeMeshes) this.scene.remove(s.mesh)
    this.spikeMeshes = []
    const spikeMat = new THREE.MeshStandardMaterial({ color: pal.spike, emissive: pal.spike, emissiveIntensity: 0.85, roughness: 0.3, metalness: 0.3 })
    for (const time of chart.spikes) {
      let mesh: THREE.Object3D
      if (this.spikeProto) {
        mesh = this.spikeProto.clone()
      } else {
        mesh = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 4), spikeMat)
        ;(mesh as THREE.Mesh).rotation.y = Math.PI / 4
      }
      const x = time * SPEED
      mesh.position.set(x, 0.5, 0)
      this.scene.add(mesh)
      this.spikeMeshes.push({ x, mesh })
    }
    this.reset()
  }

  reset() {
    this.vy = 0
    this.grounded = true
    this.spin = 0
    this.nextCombo = 0
    this.combo = 0
    this.lastBeat = -1
    this.shake = 0
    this.player.visible = true
    this.player.position.set(0, GROUND_Y, 0)
    this.player.scale.setScalar(1)
    this.state = 'countdown'
  }

  setJump(held: boolean) {
    this.jumpHeld = held
    if (held && this.grounded && this.state === 'playing') this.jump()
  }

  private jump() {
    this.vy = JUMP_V
    this.grounded = false
    this.particles.burst(this.player.position.x, GROUND_Y, 0, 14, 4, this.playerColor)
  }

  private resize() {
    const w = window.innerWidth, h = window.innerHeight
    this.renderer.setSize(w, h, false)
    this.composer.setSize(w, h)
    this.bloom.resolution.set(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private spawnRing(x: number) {
    const r = this.rings.find((r) => !r.active) ?? this.rings[0]
    r.active = true
    r.age = 0
    r.mesh.visible = true
    r.mesh.position.x = x
    r.mesh.scale.setScalar(1)
    ;(r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9
  }

  private onBeat(px: number) {
    this.spawnRing(px)
  }

  private loop(now: number) {
    requestAnimationFrame((t) => this.loop(t))
    const dt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.05) : 0
    this.lastFrame = now
    const t = this.clock()
    if (this.chart) this.update(t, dt)
    this.particles.update(dt)
    this.composer.render()
  }

  private update(t: number, dt: number) {
    const chart = this.chart!

    if (this.state === 'countdown') {
      if (t < 0) this.cb.onCountdown?.(Math.ceil(-t))
      else { this.state = 'playing'; this.cb.onStart?.() }
    }

    // horizontal position from the AUDIO clock (the sync invariant)
    const px = t * SPEED
    this.player.position.x = px

    // vertical jump arc (frame dt — cosmetic axis, not sync-critical)
    if (this.state === 'playing' || this.state === 'won') {
      if (!this.grounded) {
        this.vy -= GRAVITY * dt
        this.player.position.y += this.vy * dt
        if (this.player.position.y <= GROUND_Y) {
          this.player.position.y = GROUND_Y
          this.vy = 0
          this.grounded = true
          if (this.jumpHeld) this.jump()
        }
      }
      this.spin += (this.grounded ? SPEED : SPEED * 1.6) * dt
      this.player.rotation.z = -this.spin * (Math.PI / 2)
      if (this.player.visible) this.particles.spawn(px - 0.4, this.player.position.y, 0, -1 - Math.random(), Math.random() * 0.5, 0, this.playerColor, 0.4)
    }

    // beat detection → shockwave ring
    const secPerBeat = 60 / chart.bpm
    if (t > 0) {
      const beat = Math.floor(t / secPerBeat)
      if (beat > this.lastBeat) { this.lastBeat = beat; this.onBeat(px) }
    }
    const beatPhase = t > 0 ? (t / secPerBeat) % 1 : 1
    const pulse = Math.max(0, 1 - beatPhase)

    // beat-reactive visuals
    this.beatLight.position.x = px + 2
    this.beatLight.intensity = 1.5 + pulse * 7
    this.accentMat.emissiveIntensity = 0.5 + pulse * 1.1
    this.gridMat.color.copy(this.accent).multiplyScalar(0.5 + pulse * 0.9)
    this.bloom.strength = 0.85 + pulse * 0.5
    if (this.state === 'playing') this.player.scale.setScalar(1 + pulse * 0.13)

    // expand + fade rings
    for (const r of this.rings) {
      if (!r.active) continue
      r.age += dt
      r.mesh.scale.setScalar(1 + r.age * 9)
      const m = r.mesh.material as THREE.MeshBasicMaterial
      m.opacity = Math.max(0, 0.9 - r.age * 1.6)
      if (m.opacity <= 0) { r.active = false; r.mesh.visible = false }
    }

    // parallax background follows camera
    const camX = px + 6
    this.sky.position.copy(this.camera.position)
    this.stars.position.x = camX * 0.85
    this.skyline.position.x = camX * 0.45

    // camera follow + juice
    this.shake = Math.max(0, this.shake - dt * 2.2)
    const sx = (Math.random() - 0.5) * this.shake
    const sy = (Math.random() - 0.5) * this.shake
    this.camera.position.set(camX + sx, 3.4 + sy, 12.5 - pulse * 0.5)
    this.camera.lookAt(camX, 1.6, -2)

    // collision + combo
    if (this.state === 'playing') {
      const bottom = this.player.position.y - 0.5
      for (const sp of this.spikeMeshes) {
        if (Math.abs(px - sp.x) < SPIKE_HALF && bottom < SPIKE_CLEAR_Y) { this.crash(t); return }
      }
      while (this.nextCombo < chart.spikes.length && chart.spikes[this.nextCombo] * SPEED < px - SPIKE_HALF) {
        this.nextCombo++; this.combo++
      }
      this.cb.onProgress?.(Math.min(100, Math.max(0, (t / chart.duration) * 100)), this.combo)
      if (t >= chart.duration) { this.state = 'won'; this.cb.onWin?.() }
    }
  }

  private crash(t: number) {
    this.state = 'dead'
    this.shake = 0.9
    this.particles.burst(this.player.position.x, GROUND_Y, 0, 160, 13, new THREE.Color(this.chart!.palette.spike))
    this.player.visible = false
    const pct = this.chart ? Math.min(100, (t / this.chart.duration) * 100) : 0
    this.cb.onCrash?.(pct)
  }
}

export { SPEED }
