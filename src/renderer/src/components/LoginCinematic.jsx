import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import horseGlb from '../assets/Horse.glb'

const SWEEP_DURATION = 3.8
const IDLE_PAUSE     = 0.4

// Biblical Four Horsemen — color, emissive, name
// White=Conquest, Red=War, Black=Famine, Pale=Death
const HORSEMEN = [
  { color: 0xf0f0e0, emissive: 0xffffff, emInt: 0.18, name: 'white',  x: -4.8, z:  0.8, scale: 1.00, delay: 0.00, animOff: 0.00 },
  { color: 0xaa0000, emissive: 0xff2200, emInt: 0.25, name: 'red',    x: -1.6, z:  0.0, scale: 1.08, delay: 0.10, animOff: 0.33 },
  { color: 0x0d0d0d, emissive: 0x4466ff, emInt: 0.20, name: 'black',  x:  1.6, z:  0.4, scale: 1.04, delay: 0.06, animOff: 0.66 },
  { color: 0x3a5c3a, emissive: 0x88ff88, emInt: 0.15, name: 'pale',   x:  4.8, z: -0.4, scale: 0.96, delay: 0.14, animOff: 0.50 },
]

const START_X = 32
const END_X   =  0

function easeInOut(t) {
  return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2
}

export default function LoginCinematic({ onArrived, phase }) {
  const mountRef     = useRef(null)
  const canvasRef    = useRef(null)  // the renderer's domElement, for fade-out
  const arrivedRef   = useRef(false)
  const phaseRef     = useRef(phase)
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
    renderer.shadowMap.type    = THREE.PCFSoftShadowMap
    renderer.toneMapping       = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.15
    // Style the canvas so we can fade it out via CSS
    renderer.domElement.style.transition = 'opacity 1.1s ease'
    renderer.domElement.style.opacity    = '1'
    canvasRef.current = renderer.domElement
    mount.appendChild(renderer.domElement)

    const scene  = new THREE.Scene()
    scene.fog    = new THREE.FogExp2(0x150000, 0.022)

    const camera = new THREE.PerspectiveCamera(52, W/H, 0.1, 300)
    camera.position.set(0, 5, 16)
    camera.lookAt(0, 2.2, 0)

    // ── Starfield behind the sky ──────────────────────────────────────────────
    const STARS = 1800
    const starPos = new Float32Array(STARS * 3)
    for (let i = 0; i < STARS; i++) {
      starPos[i*3]   = (Math.random() - 0.5) * 220
      starPos[i*3+1] = Math.random() * 50 + 2
      starPos[i*3+2] = -30 - Math.random() * 60
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
    const starMat = new THREE.PointsMaterial({ color: 0xffddcc, size: 0.18, transparent: true, opacity: 0.7, sizeAttenuation: true, depthWrite: false })
    scene.add(new THREE.Points(starGeo, starMat))

    // ── Sky — apocalyptic gradient quad ──────────────────────────────────────
    const skyGeo = new THREE.PlaneGeometry(220, 70, 1, 7)
    const skyPos2 = skyGeo.attributes.position
    const skyCols = new Float32Array(skyPos2.count * 3)
    // top→bottom: deep blood-red sky → near-black ground horizon
    const pal = [
      [0.58, 0.04, 0.00],  // top — deep blood-red
      [0.50, 0.07, 0.00],
      [0.38, 0.09, 0.01],
      [0.24, 0.06, 0.01],
      [0.12, 0.03, 0.01],
      [0.05, 0.01, 0.01],
      [0.02, 0.00, 0.00],
      [0.01, 0.00, 0.00],  // bottom
    ]
    for (let i = 0; i < skyPos2.count; i++) {
      const c = pal[Math.min(i >> 1, pal.length-1)]
      skyCols[i*3]=c[0]; skyCols[i*3+1]=c[1]; skyCols[i*3+2]=c[2]
    }
    skyGeo.setAttribute('color', new THREE.BufferAttribute(skyCols, 3))
    const skyMesh = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.FrontSide, depthWrite: false }))
    skyMesh.position.set(0, 14, -48)
    scene.add(skyMesh)

    // ── Lava/ember ground ─────────────────────────────────────────────────────
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x120000 })
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 80), groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)

    // Ground crack glow lines — emissive orange strips
    for (let i = 0; i < 8; i++) {
      const g = new THREE.Mesh(
        new THREE.PlaneGeometry(0.06 + Math.random()*0.08, 18 + Math.random()*12),
        new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 0.3 + Math.random()*0.3 })
      )
      g.rotation.x = -Math.PI/2
      g.rotation.z = (Math.random()-0.5)*0.6
      g.position.set((Math.random()-0.5)*30, 0.01, (Math.random()-0.5)*10 - 5)
      scene.add(g)
    }

    // ── Lighting ──────────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0x330808, 3.0))

    const sun = new THREE.DirectionalLight(0xff3300, 4.5)
    sun.position.set(10, 18, 8)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.near = 0.5; sun.shadow.camera.far  = 100
    sun.shadow.camera.left = -22; sun.shadow.camera.right = 22
    sun.shadow.camera.top  =  14; sun.shadow.camera.bottom = -6
    sun.shadow.bias = -0.001
    scene.add(sun)

    const rimL = new THREE.DirectionalLight(0xff5500, 2.8); rimL.position.set(-12, 6, -10); scene.add(rimL)
    const rimR = new THREE.DirectionalLight(0xff2200, 1.2); rimR.position.set( 12, 4, -8);  scene.add(rimR)
    const fill  = new THREE.PointLight(0xff4400, 2.5, 50);  fill.position.set(0, 8, 6);     scene.add(fill)

    // Colored point lights matching each horseman — positioned at their rest X
    const hLights = HORSEMEN.map(h => {
      const l = new THREE.PointLight(new THREE.Color(h.emissive), 0, 12)
      l.position.set(h.x, 3, h.z + 2)
      scene.add(l)
      return l
    })

    // ── Fireball particles ────────────────────────────────────────────────────
    const FB = 160
    const fbPos  = new Float32Array(FB * 3)
    const fbVel  = new Float32Array(FB * 3)
    const fbLife = new Float32Array(FB)
    const rng = (a,b) => a + Math.random()*(b-a)
    const resetFB = i => {
      fbPos[i*3]   = rng(-55, 55)
      fbPos[i*3+1] = rng(16, 32)
      fbPos[i*3+2] = rng(-36, 6)
      fbVel[i*3]   = rng(-2, 2)
      fbVel[i*3+1] = rng(-7, -3.5)
      fbVel[i*3+2] = rng(-1.2, 1.2)
      fbLife[i]    = rng(0, 1)
    }
    for (let i = 0; i < FB; i++) resetFB(i)

    const fbGeo  = new THREE.BufferGeometry()
    fbGeo.setAttribute('position', new THREE.BufferAttribute(fbPos, 3))
    const fbMat  = new THREE.PointsMaterial({ color: 0xff5500, size: 0.65, transparent: true, opacity: 0.9, sizeAttenuation: true, depthWrite: false })
    const glowMat = new THREE.PointsMaterial({ color: 0xff2200, size: 2.6, transparent: true, opacity: 0.18, sizeAttenuation: true, depthWrite: false })
    const glowGeo = new THREE.BufferGeometry()
    glowGeo.setAttribute('position', new THREE.BufferAttribute(fbPos, 3))
    scene.add(new THREE.Points(fbGeo, fbMat))
    scene.add(new THREE.Points(glowGeo, glowMat))

    // ── Horse loading ─────────────────────────────────────────────────────────
    const clock    = new THREE.Clock()
    let raf        = null
    let lastTime   = 0
    let horses     = []
    let canvasFadeStarted = false

    const loader = new GLTFLoader()
    loader.load(horseGlb, gltf => {
      const template = gltf.scene.children[0]

      HORSEMEN.forEach((h, i) => {
        const mesh = template.clone(true)
        mesh.scale.setScalar(h.scale * 0.013)
        mesh.traverse(o => {
          if (!o.isMesh) return
          o.castShadow = true
          o.material = o.material.clone()
          o.material.color    = new THREE.Color(h.color)
          o.material.emissive = new THREE.Color(h.emissive)
          o.material.emissiveIntensity = h.emInt
          o.material.roughness = 0.6
          o.material.metalness = 0.15
          if (o.morphTargetInfluences) o.morphTargetInfluences = [...o.morphTargetInfluences]
        })
        scene.add(mesh)

        const mixer = new THREE.AnimationMixer(mesh)
        const clip  = gltf.animations[0]
        if (clip) { const a = mixer.clipAction(clip); a.play(); mixer.setTime(h.animOff) }

        horses.push({ h, mesh, mixer })
      })

      if (!raf) startLoop()
    })

    // ── Render loop ───────────────────────────────────────────────────────────
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
            fbLife[i] += dt * 0.45
            fbPos[i*3]   += fbVel[i*3]   * dt
            fbPos[i*3+1] += fbVel[i*3+1] * dt
            fbPos[i*3+2] += fbVel[i*3+2] * dt
            if (fbLife[i] > 1 || fbPos[i*3+1] < -1) resetFB(i)
          }
          fbGeo.attributes.position.needsUpdate  = true
          glowGeo.attributes.position.needsUpdate = true
          const flicker = Math.sin(elapsed * 12)
          fbMat.color.setHSL(0.04 + flicker*0.015, 1, 0.54 + flicker*0.06)
          fbMat.opacity  = 0.78 + flicker*0.12
          rimL.intensity = 2.8 + Math.sin(elapsed * 9)  * 0.7
          fill.intensity = 2.5 + Math.sin(elapsed * 14) * 0.8
        } else {
          // Fade out fireballs
          fbMat.opacity   = Math.max(0, fbMat.opacity   - dt * 1.5)
          glowMat.opacity = Math.max(0, glowMat.opacity - dt * 0.8)
          rimL.intensity  = Math.max(0, rimL.intensity  - dt * 2)
          fill.intensity  = Math.max(0, fill.intensity  - dt * 2)
        }

        // Horse sweep
        let allArrived = horses.length === 4
        horses.forEach(({ h, mesh, mixer }, idx) => {
          const t = Math.max(0, elapsed - h.delay)
          const moving = t < SWEEP_DURATION

          if (moving) {
            allArrived = false
            const progress = easeInOut(Math.min(t / SWEEP_DURATION, 1))
            const x = START_X - progress * (START_X - END_X) + h.x
            mesh.position.set(x, 0, h.z)
            mesh.rotation.y = -Math.PI / 2
            mixer.update(dt)
            hLights[idx].intensity = 0
          } else {
            mesh.position.set(h.x, 0, h.z)
            mesh.rotation.y = 0
            mixer.update(0) // freeze
            // Light up each horse's colored point light when it arrives
            hLights[idx].intensity = Math.min(hLights[idx].intensity + dt * 3, 2.5)
          }
        })

        // When all horses arrive, start canvas fade-out → merge into logo
        if (allArrived && !arrivedRef.current && elapsed > SWEEP_DURATION + IDLE_PAUSE) {
          arrivedRef.current = true
          onArrived()  // LoginScreen: shows logo, schedules login()
        }
        // Canvas fades out slightly after onArrived (matched to logo fade-in in LoginScreen)
        if (arrivedRef.current && !canvasFadeStarted) {
          canvasFadeStarted = true
          setTimeout(() => {
            if (canvasRef.current) canvasRef.current.style.opacity = '0'
          }, 300)
        }

        renderer.render(scene, camera)
      }
      animate()
    }

    const onResize = () => {
      const nw = mount.clientWidth || window.innerWidth
      const nh = mount.clientHeight || window.innerHeight
      camera.aspect = nw / nh; camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      scene.traverse(o => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) { if (Array.isArray(o.material)) o.material.forEach(m=>m.dispose()); else o.material.dispose() }
      })
      renderer.dispose()
      renderer.domElement.parentNode?.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={mountRef} style={{ position: 'absolute', inset: 0, zIndex: 1 }} />
}
