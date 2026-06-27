// The three.js scene + render loop.
//
// SYNC INVARIANT (ISA ISC-6, ISC-16): the horizontal world is driven ONLY by
// the audio clock. player.x = clock() * SPEED, spike.x = spikeTime * SPEED.
// requestAnimationFrame's delta is used ONLY for the vertical jump arc and
// cosmetic spin — never for anything that decides where a spike is. That is
// what keeps every spike frame-accurately on the beat.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Chart } from './songs'

const SPEED = 8 // world units per second
const GRAVITY = 40 // units / s^2
const JUMP_V = 11 // units / s   (apex ~1.5u, airtime ~0.55s — clears a 1u spike)
const GROUND_Y = 0.5 // player centre rests here
const SPIKE_HALF = 0.42 // lethal half-width in x
const SPIKE_CLEAR_Y = 0.78 // player bottom must be above this to survive a spike

export type GameState = 'idle' | 'countdown' | 'playing' | 'dead' | 'won'

export interface GameCallbacks {
  onProgress?: (pct: number, combo: number) => void
  onCountdown?: (n: number) => void
  onStart?: () => void
  onCrash?: (pct: number) => void
  onWin?: () => void
}

export class Game {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private clock = () => 0
  private cb: GameCallbacks = {}

  private player!: THREE.Object3D
  private playerModel: THREE.Object3D | null = null
  private spikeProto: THREE.Object3D | null = null
  private ground!: THREE.Mesh
  private grid!: THREE.GridHelper
  private beatLight!: THREE.PointLight
  private accentMat!: THREE.MeshStandardMaterial

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

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.Fog(0x0a0a16, 22, 60)

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400)
    this.camera.position.set(6, 3.4, 12.5)

    // Lights
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x202040, 0.55))
    const dir = new THREE.DirectionalLight(0xffffff, 0.5)
    dir.position.set(-4, 10, 8)
    this.scene.add(dir)
    this.beatLight = new THREE.PointLight(0xff3da6, 0, 30)
    this.beatLight.position.set(0, 5, 6)
    this.scene.add(this.beatLight)

    this.buildWorld()
    this.resize()
    window.addEventListener('resize', () => this.resize())
    requestAnimationFrame((t) => this.loop(t))
  }

  setClock(fn: () => number) { this.clock = fn }
  on(cb: GameCallbacks) { this.cb = cb }

  /** Load an optional Blender-exported GLB. Expects meshes named "player" and "spike". */
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
      return false // graceful fallback to procedural geometry
    }
  }

  private buildWorld() {
    // Ground
    const gGeo = new THREE.PlaneGeometry(4000, 26)
    const gMat = new THREE.MeshStandardMaterial({ color: 0x141430, roughness: 0.85, metalness: 0.1 })
    this.ground = new THREE.Mesh(gGeo, gMat)
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.set(1900, 0, 0)
    this.scene.add(this.ground)

    // Neon grid running along the track
    this.grid = new THREE.GridHelper(4000, 1000, 0xff3da6, 0x223)
    this.grid.position.set(1900, 0.01, 0)
    this.scene.add(this.grid)

    // Player (procedural default — replaced by GLB if loaded)
    const pGeo = new THREE.BoxGeometry(1, 1, 1)
    this.accentMat = new THREE.MeshStandardMaterial({ color: 0x36e0ff, emissive: 0x36e0ff, emissiveIntensity: 0.5, roughness: 0.35, metalness: 0.4 })
    const cube = new THREE.Mesh(pGeo, this.accentMat)
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(pGeo), new THREE.LineBasicMaterial({ color: 0xffffff }))
    this.player = new THREE.Group()
    this.player.add(cube)
    this.player.add(edges)
    this.player.position.set(0, GROUND_Y, 0)
    this.scene.add(this.player)
  }

  loadChart(chart: Chart) {
    this.chart = chart
    // palette
    const pal = chart.palette
    this.scene.background = new THREE.Color(pal.bg)
    ;(this.scene.fog as THREE.Fog).color = new THREE.Color(pal.bg)
    ;(this.ground.material as THREE.MeshStandardMaterial).color = new THREE.Color(pal.ground)
    this.beatLight.color = new THREE.Color(pal.accent)
    this.accentMat.color = new THREE.Color(pal.player)
    this.accentMat.emissive = new THREE.Color(pal.player)

    // swap player to GLB model if available
    if (this.playerModel) {
      this.scene.remove(this.player)
      this.player = this.playerModel.clone()
      this.player.position.set(0, GROUND_Y, 0)
      this.scene.add(this.player)
    }

    // clear old spikes
    for (const s of this.spikeMeshes) this.scene.remove(s.mesh)
    this.spikeMeshes = []

    const spikeMat = new THREE.MeshStandardMaterial({ color: pal.spike, emissive: pal.spike, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.3 })
    for (const time of chart.spikes) {
      let mesh: THREE.Object3D
      if (this.spikeProto) {
        mesh = this.spikeProto.clone()
      } else {
        const geo = new THREE.ConeGeometry(0.5, 1, 4)
        mesh = new THREE.Mesh(geo, spikeMat)
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
    this.player.position.set(0, GROUND_Y, 0)
    this.state = 'countdown'
  }

  setJump(held: boolean) {
    this.jumpHeld = held
    if (held && this.grounded && this.state === 'playing') this.jump()
  }

  private jump() {
    this.vy = JUMP_V
    this.grounded = false
  }

  private resize() {
    const w = window.innerWidth, h = window.innerHeight
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private loop(now: number) {
    requestAnimationFrame((t) => this.loop(t))
    const dt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.05) : 0
    this.lastFrame = now

    const t = this.clock()
    if (this.chart) this.update(t, dt)
    this.renderer.render(this.scene, this.camera)
  }

  private update(t: number, dt: number) {
    const chart = this.chart!

    // ----- countdown -----
    if (this.state === 'countdown') {
      if (t < 0) {
        this.cb.onCountdown?.(Math.ceil(-t))
      } else {
        this.state = 'playing'
        this.cb.onStart?.()
      }
    }

    // ----- horizontal position from the AUDIO clock (the sync invariant) -----
    const px = t * SPEED
    this.player.position.x = px

    // ----- vertical jump arc (frame dt — cosmetic axis, not sync-critical) -----
    if (this.state === 'playing' || this.state === 'won') {
      if (!this.grounded) {
        this.vy -= GRAVITY * dt
        this.player.position.y += this.vy * dt
        if (this.player.position.y <= GROUND_Y) {
          this.player.position.y = GROUND_Y
          this.vy = 0
          this.grounded = true
          if (this.jumpHeld) this.jump() // hold-to-bounce, GD style
        }
      }
      // rolling / flipping spin
      this.spin += (this.grounded ? SPEED : SPEED * 1.6) * dt
      this.player.rotation.z = -this.spin * (Math.PI / 2) / 1
    }

    // ----- camera follows -----
    const camX = px + 6
    this.camera.position.x = camX
    this.camera.lookAt(camX, 1.6, -2)
    this.beatLight.position.x = px + 2

    // ----- beat pulse (the beat is felt, not just heard) -----
    const secPerBeat = 60 / chart.bpm
    const beatPhase = t > 0 ? (t / secPerBeat) % 1 : 1
    const pulse = Math.max(0, 1 - beatPhase) // 1 on the beat, decays to 0
    this.beatLight.intensity = 1.2 + pulse * 6
    this.accentMat.emissiveIntensity = 0.4 + pulse * 0.9
    const s = 1 + pulse * 0.14
    if (this.state === 'playing') this.player.scale.setScalar(s)

    // ----- collision + combo -----
    if (this.state === 'playing') {
      const bottom = this.player.position.y - 0.5
      for (const sp of this.spikeMeshes) {
        if (Math.abs(px - sp.x) < SPIKE_HALF && bottom < SPIKE_CLEAR_Y) {
          this.crash(t)
          return
        }
      }
      // count spikes cleared (combo)
      while (this.nextCombo < chart.spikes.length && chart.spikes[this.nextCombo] * SPEED < px - SPIKE_HALF) {
        this.nextCombo++
        this.combo++
      }
      const pct = Math.min(100, Math.max(0, (t / chart.duration) * 100))
      this.cb.onProgress?.(pct, this.combo)

      if (t >= chart.duration) {
        this.state = 'won'
        this.cb.onWin?.()
      }
    }
  }

  private crash(t: number) {
    this.state = 'dead'
    const pct = this.chart ? Math.min(100, (t / this.chart.duration) * 100) : 0
    this.cb.onCrash?.(pct)
  }
}

export { SPEED }
