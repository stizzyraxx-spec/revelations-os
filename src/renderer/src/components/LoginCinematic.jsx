import { useEffect, useRef } from 'react'
import * as THREE from 'three'

// Total sweep duration in seconds: horses travel from right edge to center
const SWEEP_DURATION = 3.2
// How long they idle at center before onArrived fires
const IDLE_PAUSE = 0.25

const HORSES = [
  { lane: -2.2, scale: 0.92, speed: 1.00, strideFreq: 0.95, delay: 0.00 },
  { lane:  0.0, scale: 1.00, speed: 1.00, strideFreq: 0.92, delay: 0.10 },
  { lane:  2.2, scale: 0.92, speed: 1.00, strideFreq: 0.98, delay: 0.20 },
  { lane: -1.1, scale: 0.96, speed: 1.00, strideFreq: 0.88, delay: 0.05 },
]

const LEG_PHASE = [0.55, 0.65, 0.05, 0.15]

function buildHorse() {
  const g = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({
    color: 0x0a0008, roughness: 0.55, metalness: 0.25,
    emissive: new THREE.Color('#ff2200').multiplyScalar(0.08),
  })
  const box = (w, h, d) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)

  const body = box(2.0, 0.82, 0.66); body.position.y = 1.55; g.add(body)
  const chest = box(0.7, 0.9, 0.6); chest.position.set(0.95, 1.55, 0); g.add(chest)
  const rump = box(0.8, 0.95, 0.64); rump.position.set(-0.9, 1.55, 0); g.add(rump)
  const neck = box(0.5, 1.05, 0.46); neck.position.set(1.25, 2.05, 0); neck.rotation.z = -0.62; g.add(neck)
  const head = box(0.78, 0.4, 0.36); head.position.set(1.72, 2.46, 0); head.rotation.z = -0.18; g.add(head)
  const ear = box(0.12, 0.26, 0.1); ear.position.set(1.55, 2.74, 0.12); ear.rotation.z = 0.2; g.add(ear)
  const tail = box(0.7, 0.16, 0.16); tail.position.set(-1.35, 1.75, 0); tail.rotation.z = 0.85; g.add(tail)

  const legs = []
  const makeLeg = (x, z) => {
    const hip = new THREE.Group(); hip.position.set(x, 1.25, z); g.add(hip)
    const upper = box(0.2, 0.72, 0.2); upper.position.y = -0.36; hip.add(upper)
    const knee = new THREE.Group(); knee.position.y = -0.72; hip.add(knee)
    const lower = box(0.16, 0.72, 0.16); lower.position.y = -0.36; knee.add(lower)
    const hoof = box(0.24, 0.2, 0.24); hoof.position.y = -0.74; knee.add(hoof)
    legs.push({ hip, knee })
  }
  makeLeg(0.78, 0.26)
  makeLeg(0.78, -0.26)
  makeLeg(-0.78, 0.26)
  makeLeg(-0.78, -0.26)

  g.userData.legs = legs
  return g
}

function poseLegs(legs, t) {
  for (let i = 0; i < legs.length; i++) {
    const p = (t + LEG_PHASE[i]) % 1
    const swing = Math.sin(p * Math.PI * 2)
    const bend = Math.max(0, Math.sin(p * Math.PI * 2 + 1.4))
    legs[i].hip.rotation.z = swing * 0.8
    legs[i].knee.rotation.z = -bend * 1.2 - 0.1
  }
}

// Easing: ease-in-out cubic
function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

export default function LoginCinematic({ onArrived, phase }) {
  const mountRef = useRef(null)
  const arrivedRef = useRef(false)
  const phaseRef = useRef(phase)
  useEffect(() => { phaseRef.current = phase }, [phase])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: false, antialias: true, powerPreference: 'high-performance' })
    } catch { return }

    const w = mount.clientWidth || window.innerWidth
    const h = mount.clientHeight || window.innerHeight
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(w, h)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()

    // Sky plane — apocalyptic gradient via vertex colors on a big quad
    const skyGeo = new THREE.PlaneGeometry(60, 30, 1, 4)
    const skyMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.FrontSide })
    const skyColors = [
      [0.55, 0.05, 0.00], [0.55, 0.05, 0.00], // top row — deep blood red
      [0.45, 0.08, 0.00], [0.45, 0.08, 0.00],
      [0.30, 0.06, 0.01], [0.30, 0.06, 0.01],
      [0.18, 0.04, 0.02], [0.18, 0.04, 0.02],
      [0.04, 0.01, 0.01], [0.04, 0.01, 0.01], // bottom — near black ground
    ]
    const posArr = skyGeo.attributes.position
    const colArr = new Float32Array(posArr.count * 3)
    // PlaneGeometry vertices go row by row; 2 cols × 5 rows = 10 verts
    for (let i = 0; i < posArr.count; i++) {
      const c = skyColors[Math.min(i, skyColors.length - 1)]
      colArr[i * 3] = c[0]; colArr[i * 3 + 1] = c[1]; colArr[i * 3 + 2] = c[2]
    }
    skyGeo.setAttribute('color', new THREE.BufferAttribute(colArr, 3))
    const skyMesh = new THREE.Mesh(skyGeo, skyMat)
    skyMesh.position.set(0, 5, -12)
    scene.add(skyMesh)

    // Ground plane
    const groundMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 20),
      new THREE.MeshBasicMaterial({ color: 0x0a0000 })
    )
    groundMesh.rotation.x = -Math.PI / 2
    groundMesh.position.y = 0
    scene.add(groundMesh)

    // Lighting
    scene.add(new THREE.AmbientLight(0x3a1010, 1.2))
    const key = new THREE.DirectionalLight(0xff4400, 1.4); key.position.set(5, 8, 3); scene.add(key)
    const rim = new THREE.DirectionalLight(0xff8800, 1.8); rim.position.set(-6, 4, -5); scene.add(rim)
    const fill = new THREE.DirectionalLight(0xff2200, 0.6); fill.position.set(0, -2, 6); scene.add(fill)

    // Camera
    const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 200)
    camera.position.set(0, 3.2, 9.6)
    camera.lookAt(0, 1.7, 0)

    // Fireball particles
    const FIREBALL_COUNT = 80
    const fbGeo = new THREE.BufferGeometry()
    const fbPos = new Float32Array(FIREBALL_COUNT * 3)
    const fbVel = new Float32Array(FIREBALL_COUNT * 3)
    const fbLife = new Float32Array(FIREBALL_COUNT)
    const fbSize = new Float32Array(FIREBALL_COUNT)

    const rng = (a, b) => a + Math.random() * (b - a)

    for (let i = 0; i < FIREBALL_COUNT; i++) {
      fbPos[i * 3] = rng(-25, 25)
      fbPos[i * 3 + 1] = rng(8, 18)
      fbPos[i * 3 + 2] = rng(-10, 2)
      fbVel[i * 3] = rng(-0.8, 0.8)
      fbVel[i * 3 + 1] = rng(-4, -2)
      fbVel[i * 3 + 2] = rng(-0.5, 0.5)
      fbLife[i] = rng(0, 1)
      fbSize[i] = rng(0.15, 0.55)
    }

    fbGeo.setAttribute('position', new THREE.BufferAttribute(fbPos, 3))
    fbGeo.setAttribute('size', new THREE.BufferAttribute(fbSize, 1))

    const fbMat = new THREE.PointsMaterial({
      color: 0xff5500, size: 0.35, transparent: true, opacity: 0.85,
      sizeAttenuation: true, depthWrite: false,
    })
    const fireballs = new THREE.Points(fbGeo, fbMat)
    scene.add(fireballs)

    // Shadow geo reused
    const shadowGeo = new THREE.CircleGeometry(1.1, 16)

    // Build horses
    const START_X = 22  // off right edge
    const END_X = 0      // center
    const horseObjects = HORSES.map((d, i) => {
      const group = buildHorse()
      group.scale.setScalar(d.scale)
      scene.add(group)
      const shadow = new THREE.Mesh(shadowGeo, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }))
      shadow.rotation.x = -Math.PI / 2
      shadow.position.y = 0.02
      scene.add(shadow)
      return { ...d, group, shadow, legs: group.userData.legs }
    })

    const clock = new THREE.Clock()
    let raf
    let lastTime = 0

    const animate = () => {
      raf = requestAnimationFrame(animate)
      const elapsed = clock.getElapsedTime()
      const dt = Math.min(elapsed - lastTime, 0.05)
      lastTime = elapsed

      // Update fireball particles
      const currentPhase = phaseRef.current
      if (currentPhase < 1) {
        for (let i = 0; i < FIREBALL_COUNT; i++) {
          fbLife[i] += dt * 0.75
          fbPos[i * 3] += fbVel[i * 3] * dt
          fbPos[i * 3 + 1] += fbVel[i * 3 + 1] * dt
          fbPos[i * 3 + 2] += fbVel[i * 3 + 2] * dt
          if (fbLife[i] > 1 || fbPos[i * 3 + 1] < 0) {
            fbPos[i * 3] = rng(-25, 25)
            fbPos[i * 3 + 1] = rng(12, 22)
            fbPos[i * 3 + 2] = rng(-10, 2)
            fbLife[i] = 0
          }
        }
        fbGeo.attributes.position.needsUpdate = true
        // Flicker color
        const r = 0.85 + Math.sin(elapsed * 8) * 0.15
        const g2 = 0.2 + Math.sin(elapsed * 5 + 1) * 0.1
        fbMat.color.setRGB(r, g2, 0)
        fbMat.opacity = 0.7 + Math.sin(elapsed * 12) * 0.15
      } else {
        // Fade out fireballs
        fbMat.opacity = Math.max(0, fbMat.opacity - 0.02)
      }

      // Horses sweep
      for (const horse of horseObjects) {
        const t = Math.max(0, elapsed - horse.delay)
        let x, stride, bob

        if (t < SWEEP_DURATION) {
          // Galloping sweep R → L (positive X to 0)
          const progress = easeInOut(Math.min(t / SWEEP_DURATION, 1))
          x = START_X - progress * (START_X - END_X)
          stride = (elapsed * horse.strideFreq) % 1
          bob = Math.abs(Math.sin(stride * Math.PI * 2)) * 0.22
        } else {
          // Arrived — idle pose
          x = END_X
          stride = 0
          bob = 0
          if (!arrivedRef.current && elapsed > SWEEP_DURATION + IDLE_PAUSE) {
            arrivedRef.current = true
            onArrived()
          }
        }

        horse.group.position.set(x + horse.lane * 0.6, bob, horse.lane * 0.1)
        horse.group.rotation.y = t < SWEEP_DURATION ? -Math.PI : 0
        horse.group.rotation.z = t < SWEEP_DURATION ? Math.sin(stride * Math.PI * 2) * 0.05 : 0
        if (t < SWEEP_DURATION) poseLegs(horse.legs, stride)
        else poseLegs(horse.legs, 0)

        horse.shadow.position.x = x + horse.lane * 0.6
        horse.shadow.position.z = horse.lane * 0.1
        const s = horse.scale * (1.15 - bob * 0.7)
        horse.shadow.scale.set(s, s, s)
        horse.shadow.material.opacity = 0.3 * Math.max(0, 1 - bob * 1.4)
      }

      // Flicker key light during sweep
      if (currentPhase === 0) {
        key.intensity = 1.4 + Math.sin(elapsed * 7) * 0.3
        rim.intensity = 1.8 + Math.sin(elapsed * 11 + 2) * 0.4
      }

      renderer.render(scene, camera)
    }

    animate()

    const onResize = () => {
      const nw = mount.clientWidth || window.innerWidth
      const nh = mount.clientHeight || window.innerHeight
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) o.material.dispose()
      })
      shadowGeo.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
  }, [])

  return (
    <div ref={mountRef} style={{ position: 'absolute', inset: 0, zIndex: 1 }} />
  )
}
