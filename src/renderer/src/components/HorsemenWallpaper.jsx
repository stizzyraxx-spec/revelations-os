import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { getSettings } from '../theme'

// Four Horsemen — procedural 3D horses galloping in perspective over the nebula sky.
// Transparent canvas: the desktop gradient shows through as the backdrop.

const HORSES = [
  { z: 0.0, scale: 1.00, speed: 1.00, xoff: 0, strideFreq: 0.95 },
  { z: -2.6, scale: 0.86, speed: 0.90, xoff: 9, strideFreq: 0.88 },
  { z: 2.3, scale: 1.08, speed: 1.07, xoff: 16, strideFreq: 1.02 },
  { z: -1.1, scale: 0.94, speed: 0.97, xoff: 23, strideFreq: 0.93 },
]

const LANE = 30 // wrap span along X
// Gallop footfall phases for [front-left, front-right, hind-left, hind-right]
const LEG_PHASE = [0.55, 0.65, 0.05, 0.15]

function buildHorse(rimColor) {
  const g = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({
    color: 0x0a0a14, roughness: 0.55, metalness: 0.25,
    emissive: new THREE.Color(rimColor).multiplyScalar(0.05),
  })
  const box = (w, h, d) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)

  // Torso — body + tapered chest and hindquarter
  const body = box(2.0, 0.82, 0.66); body.position.y = 1.55; g.add(body)
  const chest = box(0.7, 0.9, 0.6); chest.position.set(0.95, 1.55, 0); g.add(chest)
  const rump = box(0.8, 0.95, 0.64); rump.position.set(-0.9, 1.55, 0); g.add(rump)

  // Neck + head
  const neck = box(0.5, 1.05, 0.46); neck.position.set(1.25, 2.05, 0); neck.rotation.z = -0.62; g.add(neck)
  const head = box(0.78, 0.4, 0.36); head.position.set(1.72, 2.46, 0); head.rotation.z = -0.18; g.add(head)
  const ear = box(0.12, 0.26, 0.1); ear.position.set(1.55, 2.74, 0.12); ear.rotation.z = 0.2; g.add(ear)

  // Tail (flowing back)
  const tail = box(0.7, 0.16, 0.16); tail.position.set(-1.35, 1.75, 0); tail.rotation.z = 0.85; g.add(tail)

  // Legs — hip pivot → upper → knee pivot → lower + hoof
  const legs = []
  const makeLeg = (x, z) => {
    const hip = new THREE.Group(); hip.position.set(x, 1.25, z); g.add(hip)
    const upper = box(0.2, 0.72, 0.2); upper.position.y = -0.36; hip.add(upper)
    const knee = new THREE.Group(); knee.position.y = -0.72; hip.add(knee)
    const lower = box(0.16, 0.72, 0.16); lower.position.y = -0.36; knee.add(lower)
    const hoof = box(0.24, 0.2, 0.24); hoof.position.y = -0.74; knee.add(hoof)
    legs.push({ hip, knee })
  }
  makeLeg(0.78, 0.26)   // front-left
  makeLeg(0.78, -0.26)  // front-right
  makeLeg(-0.78, 0.26)  // hind-left
  makeLeg(-0.78, -0.26) // hind-right

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

export default function HorsemenWallpaper({ paused = false }) {
  const mountRef = useRef(null)
  const pausedRef = useRef(paused)
  useEffect(() => { pausedRef.current = paused }, [paused])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const reduceMotion = !!getSettings().reduceMotion
    const accent = getSettings().accentColor || '#6d28d9'

    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' })
    } catch {
      return // No WebGL — gradient backdrop remains
    }

    const w = mount.clientWidth || window.innerWidth
    const h = mount.clientHeight || window.innerHeight
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(w, h)
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100)
    camera.position.set(0, 3.2, 9.6)
    camera.lookAt(0, 1.7, 0)

    scene.add(new THREE.AmbientLight(0x3a456b, 1.15))
    const key = new THREE.DirectionalLight(0x8aa0ff, 0.75); key.position.set(3, 6, 5); scene.add(key)
    const rim = new THREE.DirectionalLight(new THREE.Color(accent), 2.4); rim.position.set(-5, 3, -6); scene.add(rim)
    const rim2 = new THREE.DirectionalLight(0x3b82f6, 1.1); rim2.position.set(6, 2, -4); scene.add(rim2)

    const shadowGeo = new THREE.CircleGeometry(1.1, 24)
    const horses = HORSES.map((d) => {
      const group = buildHorse(accent)
      group.scale.setScalar(d.scale)
      scene.add(group)
      const shadow = new THREE.Mesh(shadowGeo, new THREE.MeshBasicMaterial({ color: 0x000008, transparent: true, opacity: 0.28 }))
      shadow.rotation.x = -Math.PI / 2
      shadow.position.y = 0.02
      scene.add(shadow)
      return { ...d, group, shadow, legs: group.userData.legs }
    })

    const clock = new THREE.Clock()
    let raf

    const frame = (t) => {
      for (const horse of horses) {
        const x = (((t * horse.speed * 2.4 + horse.xoff) % LANE) + LANE) % LANE - LANE / 2
        const stride = (t * horse.strideFreq * horse.speed) % 1
        const bob = Math.abs(Math.sin(stride * Math.PI * 2)) * 0.22
        horse.group.position.set(x, bob, horse.z)
        horse.group.rotation.z = Math.sin(stride * Math.PI * 2) * 0.05
        poseLegs(horse.legs, stride)
        horse.shadow.position.x = x
        horse.shadow.position.z = horse.z
        const s = horse.scale * (1.15 - bob * 0.7)
        horse.shadow.scale.set(s, s, s)
        horse.shadow.material.opacity = 0.3 * Math.max(0, 1 - bob * 1.4)
      }
      renderer.render(scene, camera)
    }

    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (pausedRef.current) return
      frame(clock.getElapsedTime())
    }

    if (reduceMotion) {
      frame(0.35)
    } else {
      animate()
    }

    const onResize = () => {
      const nw = mount.clientWidth || window.innerWidth
      const nh = mount.clientHeight || window.innerHeight
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
      if (pausedRef.current || reduceMotion) frame(reduceMotion ? 0.35 : clock.getElapsedTime())
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

  return <div ref={mountRef} style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none' }} />
}
