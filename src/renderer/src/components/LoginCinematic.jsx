import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import horseGlb from '../assets/Horse.glb'

const SWEEP_DURATION = 3.8
const IDLE_PAUSE     = 0.4

// Biblical Four Horsemen — color, emissive, name
// White=Conquest, Red=War, Black=Famine, Pale=Death
// Colors matched exactly to the logo: white, red, dark-gray, lime-green
const HORSEMEN = [
  { color: 0xf0f0f0, emissive: 0xffffff, emInt: 0.30, name: 'white',  x: -4.8, z:  0.8, scale: 1.00, delay: 0.00, animOff: 0.00 },
  { color: 0xee0000, emissive: 0xff2200, emInt: 0.35, name: 'red',    x: -1.6, z:  0.0, scale: 1.08, delay: 0.10, animOff: 0.33 },
  { color: 0x555555, emissive: 0x888888, emInt: 0.20, name: 'black',  x:  1.6, z:  0.4, scale: 1.04, delay: 0.06, animOff: 0.66 },
  { color: 0x90e020, emissive: 0xaaff00, emInt: 0.40, name: 'pale',   x:  4.8, z: -0.4, scale: 0.96, delay: 0.14, animOff: 0.50 },
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
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', precision: 'highp' })
    } catch { return }

    const W = mount.clientWidth  || window.innerWidth
    const H = mount.clientHeight || window.innerHeight
    // Use full device pixel ratio so horses are crisp on Retina displays
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(W, H)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type    = THREE.PCFSoftShadowMap
    renderer.toneMapping       = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.4
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

    // ── Lighting ──────────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0x330808, 3.0))

    const sun = new THREE.DirectionalLight(0xff4411, 6.0)
    sun.position.set(10, 22, 10)
    sun.castShadow = true
    sun.shadow.mapSize.set(4096, 4096)
    sun.shadow.camera.near = 0.5; sun.shadow.camera.far  = 120
    sun.shadow.camera.left = -28; sun.shadow.camera.right = 28
    sun.shadow.camera.top  =  18; sun.shadow.camera.bottom = -8
    sun.shadow.bias = -0.0005
    scene.add(sun)

    // Back-light to separate horses from background
    const backLight = new THREE.DirectionalLight(0xff2200, 3.0)
    backLight.position.set(0, 10, -20)
    scene.add(backLight)

    const rimL = new THREE.DirectionalLight(0xff6600, 3.5); rimL.position.set(-14, 8, -10); scene.add(rimL)
    const rimR = new THREE.DirectionalLight(0xff3300, 2.0); rimR.position.set( 14, 6, -8);  scene.add(rimR)
    const fill  = new THREE.PointLight(0xff5500, 3.5, 60);  fill.position.set(0, 10, 8);    scene.add(fill)

    // Colored point lights matching each horseman — positioned at their rest X
    const hLights = HORSEMEN.map(h => {
      const l = new THREE.PointLight(new THREE.Color(h.emissive), 0, 16)
      l.position.set(h.x, 4, h.z + 3)
      scene.add(l)
      return l
    })

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
          o.castShadow    = true
          o.receiveShadow = true
          // Compute smooth normals so the low-poly mesh looks rounded
          if (o.geometry) {
            o.geometry = o.geometry.clone()
            o.geometry.computeVertexNormals()
          }
          // Replace with a PBR standard material for realistic shading
          o.material = new THREE.MeshStandardMaterial({
            color:              new THREE.Color(h.color),
            emissive:           new THREE.Color(h.emissive),
            emissiveIntensity:  h.emInt,
            roughness:          0.72,
            metalness:          0.08,
            envMapIntensity:    1.0,
            flatShading:        false,
          })
          if (o.morphTargetDictionary) o.material.morphTargets = true
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

        // Flicker rim lights while horses are sweeping
        if (curPhase < 1) {
          rimL.intensity = 2.8 + Math.sin(elapsed * 9)  * 0.7
          fill.intensity = 2.5 + Math.sin(elapsed * 14) * 0.8
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
            // Slow animation speed to match horse decelerating into stop
            const speedScale = 1 - Math.pow(Math.max(0, (t / SWEEP_DURATION - 0.7) / 0.3), 2)
            mixer.update(dt * Math.max(0.05, speedScale))
            hLights[idx].intensity = 0
          } else {
            // Glide to final position over 0.4s after sweep ends
            const settle = Math.min((t - SWEEP_DURATION) / 0.4, 1)
            const ex = easeInOut(settle)
            mesh.position.set(h.x, 0, h.z)
            mesh.rotation.y = -(1 - ex) * Math.PI / 2  // smoothly rotate to face forward
            mixer.update(dt * Math.max(0, 0.05 - (t - SWEEP_DURATION) * 0.08))
            hLights[idx].intensity = Math.min(hLights[idx].intensity + dt * 2.5, 2.5)
          }
        })

        // When all horses arrive, start canvas fade-out → merge into logo
        if (allArrived && !arrivedRef.current && elapsed > SWEEP_DURATION + IDLE_PAUSE) {
          arrivedRef.current = true
          onArrived()  // LoginScreen: shows logo, schedules login()
        }
        // Canvas fades out after logo is well into its fade-in (600ms after onArrived).
        // The 1.4s CSS transition lets them cross-fade smoothly.
        if (arrivedRef.current && !canvasFadeStarted) {
          canvasFadeStarted = true
          setTimeout(() => {
            if (canvasRef.current) {
              canvasRef.current.style.transition = 'opacity 1.4s cubic-bezier(0.16, 1, 0.3, 1)'
              canvasRef.current.style.opacity = '0'
            }
          }, 600)
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
