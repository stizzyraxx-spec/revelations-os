import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { getSettings } from '../theme'
import horseGlb from '../assets/Horse.glb'

// Four Horsemen — realistic GLB horse, galloping in perspective over the nebula sky.
// Transparent canvas: the desktop gradient shows through as backdrop.

const HORSES = [
  { z:  0.0, scale: 1.00, speed: 1.00, xoff:  0 },
  { z: -2.6, scale: 0.86, speed: 0.90, xoff:  9 },
  { z:  2.3, scale: 1.08, speed: 1.07, xoff: 16 },
  { z: -1.1, scale: 0.94, speed: 0.97, xoff: 23 },
]
const LANE = 30

export default function HorsemenWallpaper({ paused = false }) {
  const mountRef  = useRef(null)
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
    } catch { return }

    const w = mount.clientWidth  || window.innerWidth
    const h = mount.clientHeight || window.innerHeight
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(w, h)
    renderer.setClearColor(0x000000, 0)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    mount.appendChild(renderer.domElement)

    const scene  = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100)
    camera.position.set(0, 3.2, 9.6)
    camera.lookAt(0, 1.7, 0)

    scene.add(new THREE.AmbientLight(0x3a456b, 1.15))
    const key = new THREE.DirectionalLight(0x8aa0ff, 0.75); key.position.set(3, 6, 5); scene.add(key)
    const rim = new THREE.DirectionalLight(new THREE.Color(accent), 2.4); rim.position.set(-5, 3, -6); scene.add(rim)
    const rim2 = new THREE.DirectionalLight(0x3b82f6, 1.1); rim2.position.set(6, 2, -4); scene.add(rim2)

    const clock = new THREE.Clock()
    let raf
    let horses = []
    let lastTime = 0

    const loader = new GLTFLoader()
    loader.load(horseGlb, (gltf) => {
      const template = gltf.scene.children[0]

      HORSES.forEach((d, i) => {
        const mesh = template.clone(true)
        mesh.scale.setScalar(d.scale * 0.012)
        mesh.traverse(o => {
          if (o.isMesh) {
            o.castShadow = true
            o.material = o.material.clone()
            o.material.color = new THREE.Color(0x0a0a14)
            o.material.emissive = new THREE.Color(accent)
            o.material.emissiveIntensity = 0.05
            o.material.roughness = 0.55
            o.material.metalness = 0.25
            if (o.morphTargetInfluences) o.morphTargetInfluences = [...(o.morphTargetInfluences || [])]
          }
        })
        scene.add(mesh)

        const mixer = new THREE.AnimationMixer(mesh)
        const clip = gltf.animations[0]
        if (clip) {
          const action = mixer.clipAction(clip)
          action.play()
          mixer.setTime(i * 0.4) // stagger so they're out of sync
        }

        horses.push({ ...d, mesh, mixer })
      })

      if (reduceMotion) {
        frame(0.35, 0)
      } else if (!raf) {
        animate()
      }
    })

    const frame = (elapsed, dt) => {
      const LANE_HALF = LANE / 2
      for (const horse of horses) {
        const x = (((elapsed * horse.speed * 2.4 + horse.xoff) % LANE) + LANE) % LANE - LANE_HALF
        horse.mesh.position.set(x, 0, horse.z)
        horse.mesh.rotation.y = -Math.PI / 2 // face direction of travel
        if (!pausedRef.current && !reduceMotion) horse.mixer.update(dt)
      }
      renderer.render(scene, camera)
    }

    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (pausedRef.current) return
      const elapsed = clock.getElapsedTime()
      const dt = Math.min(elapsed - lastTime, 0.05)
      lastTime = elapsed
      frame(elapsed, dt)
    }

    const onResize = () => {
      const nw = mount.clientWidth || window.innerWidth
      const nh = mount.clientHeight || window.innerHeight
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
      if (pausedRef.current || reduceMotion) frame(reduceMotion ? 0.35 : clock.getElapsedTime(), 0)
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

  return <div ref={mountRef} style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none' }} />
}
