import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import horseGlb from '../assets/Horse.glb'

// Total seconds the horses take to cross from right edge to center
const SWEEP_DURATION = 3.6
// Seconds they idle at center before onArrived fires
const IDLE_PAUSE = 0.3

// Lane offsets [x-spread, z-depth, scale, delay, animOffset]
const LANES = [
  { x:  3.2, z:  1.5, scale: 1.05, delay: 0.00, animOff: 0.00 },
  { x:  1.0, z:  0.0, scale: 1.12, delay: 0.08, animOff: 0.25 },
  { x: -1.0, z:  0.5, scale: 1.00, delay: 0.16, animOff: 0.50 },
  { x: -3.2, z: -1.0, scale: 1.08, delay: 0.06, animOff: 0.75 },
]

const START_X = 28  // off-screen right
const END_X   =  0  // center

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

export default function LoginCinematic({ onArrived, phase }) {
  const mountRef   = useRef(null)
  const arrivedRef = useRef(false)
  const phaseRef   = useRef(phase)
  useEffect(() => { phaseRef.current = phase }, [phase])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    } catch { return }

    const W = mount.clientWidth  || window.innerWidth
    const H = mount.clientHeight || window.innerHeight
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(W, H)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    mount.appendChild(renderer.domElement)

    const scene  = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x1a0000, 0.025)

    const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 300)
    camera.position.set(0, 4.5, 14)
    camera.lookAt(0, 2, 0)

    // ── Sky gradient mesh ──────────────────────────────────────────────────────
    const skyGeo = new THREE.PlaneGeometry(200, 60, 1, 6)
    const skyPos = skyGeo.attributes.position
    const skyCols = new Float32Array(skyPos.count * 3)
    // rows top→bottom: deep blood crimson → dark amber → near-black
    const palette = [
      [0.55, 0.03, 0.00],
      [0.48, 0.06, 0.00],
      [0.35, 0.08, 0.01],
      [0.22, 0.05, 0.01],
      [0.10, 0.02, 0.01],
      [0.04, 0.01, 0.00],
      [0.02, 0.00, 0.00],
    ]
    for (let i = 0; i < skyPos.count; i++) {
      const c = palette[Math.min(i >> 1, palette.length - 1)]
      skyCols[i*3] = c[0]; skyCols[i*3+1] = c[1]; skyCols[i*3+2] = c[2]
    }
    skyGeo.setAttribute('color', new THREE.BufferAttribute(skyCols, 3))
    const skyMesh = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.FrontSide, depthWrite: false }))
    skyMesh.position.set(0, 12, -40)
    scene.add(skyMesh)

    // ── Ground ─────────────────────────────────────────────────────────────────
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 60),
      new THREE.MeshLambertMaterial({ color: 0x0d0000 })
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)

    // ── Lighting ───────────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0x220808, 2.5))

    const sun = new THREE.DirectionalLight(0xff4400, 3.5)
    sun.position.set(8, 14, 6)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.near = 0.5
    sun.shadow.camera.far  = 80
    sun.shadow.camera.left = -20; sun.shadow.camera.right = 20
    sun.shadow.camera.top  =  12; sun.shadow.camera.bottom = -4
    sun.shadow.bias = -0.001
    scene.add(sun)

    const rim  = new THREE.DirectionalLight(0xff6600, 2.2)
    rim.position.set(-10, 5, -8)
    scene.add(rim)

    const fill = new THREE.PointLight(0xff2200, 1.8, 40)
    fill.position.set(0, 6, 4)
    scene.add(fill)

    // ── Fireball particles ─────────────────────────────────────────────────────
    const FB = 120
    const fbPos  = new Float32Array(FB * 3)
    const fbVel  = new Float32Array(FB * 3)
    const fbLife = new Float32Array(FB)
    const rng = (a, b) => a + Math.random() * (b - a)

    const resetFB = (i) => {
      fbPos[i*3]   = rng(-45, 45)
      fbPos[i*3+1] = rng(14, 28)
      fbPos[i*3+2] = rng(-30, 4)
      fbVel[i*3]   = rng(-1.5, 1.5)
      fbVel[i*3+1] = rng(-6, -3)
      fbVel[i*3+2] = rng(-1, 1)
      fbLife[i]    = rng(0, 1)
    }
    for (let i = 0; i < FB; i++) resetFB(i)

    const fbGeo = new THREE.BufferGeometry()
    fbGeo.setAttribute('position', new THREE.BufferAttribute(fbPos, 3))
    const fbMat = new THREE.PointsMaterial({ color: 0xff5500, size: 0.6, transparent: true, opacity: 0.9, sizeAttenuation: true, depthWrite: false })
    const fbPoints = new THREE.Points(fbGeo, fbMat)
    scene.add(fbPoints)

    // Small glow halos around the fireballs
    const glowGeo = new THREE.BufferGeometry()
    glowGeo.setAttribute('position', new THREE.BufferAttribute(fbPos, 3)) // shared buffer
    const glowMat = new THREE.PointsMaterial({ color: 0xff2200, size: 2.2, transparent: true, opacity: 0.18, sizeAttenuation: true, depthWrite: false })
    scene.add(new THREE.Points(glowGeo, glowMat))

    // ── Load horse GLB and spawn 4 instances ───────────────────────────────────
    const clock  = new THREE.Clock()
    let raf      = null
    let lastTime = 0
    let horses   = []   // filled after GLB loads

    const loader = new GLTFLoader()
    loader.load(horseGlb, (gltf) => {
      const template = gltf.scene.children[0]   // the SkinnedMesh / Mesh

      LANES.forEach((lane, i) => {
        const mesh = template.clone(true)
        mesh.scale.setScalar(lane.scale * 0.012) // Horse.glb is huge in raw units
        mesh.castShadow = true
        mesh.receiveShadow = false

        // Rich dark coat with orange rim emissive
        mesh.traverse(o => {
          if (o.isMesh) {
            o.castShadow = true
            // Clone material so each horse can have independent morph weights
            o.material = o.material.clone()
            o.material.color     = new THREE.Color(0x0d0005)
            o.material.emissive  = new THREE.Color(0xff3300)
            o.material.emissiveIntensity = 0.04
            o.material.roughness = 0.65
            o.material.metalness = 0.15
            if (o.morphTargetInfluences) {
              o.morphTargetInfluences = [...(o.morphTargetInfluences || [])]
            }
          }
        })

        scene.add(mesh)
        horses.push({
          mesh,
          lane,
          // morph animation mixer
          mixer: (() => {
            const m = new THREE.AnimationMixer(mesh)
            const clip = gltf.animations[0]
            if (clip) {
              const action = m.clipAction(clip)
              action.play()
              // Offset so they're not all in sync
              m.setTime(lane.animOff)
            }
            return m
          })(),
        })
      })

      if (!raf) startLoop()
    })

    // ── Main render loop ───────────────────────────────────────────────────────
    const startLoop = () => {
      const animate = () => {
        raf = requestAnimationFrame(animate)
        const elapsed = clock.getElapsedTime()
        const dt = Math.min(elapsed - lastTime, 0.05)
        lastTime = elapsed
        const curPhase = phaseRef.current

        // Fireball update
        if (curPhase < 1) {
          for (let i = 0; i < FB; i++) {
            fbLife[i] += dt * 0.5
            fbPos[i*3]   += fbVel[i*3]   * dt
            fbPos[i*3+1] += fbVel[i*3+1] * dt
            fbPos[i*3+2] += fbVel[i*3+2] * dt
            if (fbLife[i] > 1 || fbPos[i*3+1] < -1) resetFB(i)
          }
          fbGeo.attributes.position.needsUpdate = true
          glowGeo.attributes.position.needsUpdate = true
          fbMat.color.setHSL(0.04 + Math.sin(elapsed * 6) * 0.02, 1, 0.55)
          fbMat.opacity = 0.75 + Math.sin(elapsed * 14) * 0.15
        } else {
          fbMat.opacity  = Math.max(0, fbMat.opacity  - dt * 1.2)
          glowMat.opacity = Math.max(0, glowMat.opacity - dt * 0.6)
        }

        // Flicker rim light
        if (curPhase < 1) {
          rim.intensity  = 2.2 + Math.sin(elapsed * 9)  * 0.5
          fill.intensity = 1.8 + Math.sin(elapsed * 13) * 0.6
        }

        // Horse movement + animation
        let allArrived = true
        horses.forEach(({ mesh, lane, mixer }) => {
          const t = Math.max(0, elapsed - lane.delay)
          mixer.update(t < SWEEP_DURATION ? dt : 0) // freeze animation when stopped

          if (t < SWEEP_DURATION) {
            allArrived = false
            const progress = easeInOut(Math.min(t / SWEEP_DURATION, 1))
            const x = START_X - progress * (START_X - END_X) + lane.x
            mesh.position.set(x, 0, lane.z)
            mesh.rotation.y = -Math.PI / 2  // face left (toward center)
          } else {
            mesh.position.set(lane.x, 0, lane.z)
            mesh.rotation.y = 0  // face forward at rest
          }
        })

        if (allArrived && horses.length === 4 && !arrivedRef.current && elapsed > SWEEP_DURATION + IDLE_PAUSE) {
          arrivedRef.current = true
          onArrived()
        }

        renderer.render(scene, camera)
      }
      animate()
    }

    const onResize = () => {
      const nw = mount.clientWidth  || window.innerWidth
      const nh = mount.clientHeight || window.innerHeight
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      scene.traverse(o => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) { if (Array.isArray(o.material)) o.material.forEach(m => m.dispose()); else o.material.dispose() }
      })
      renderer.dispose()
      renderer.domElement.parentNode?.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={mountRef} style={{ position: 'absolute', inset: 0, zIndex: 1 }} />
}
