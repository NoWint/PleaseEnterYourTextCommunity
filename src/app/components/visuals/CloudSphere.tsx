// src/app/components/visuals/CloudSphere.tsx
// 3D 球状词云（Solid 组件版，canvas 渲染逻辑从 src/components/cloudSphere.ts 迁移）：
// Fibonacci 球面分布 + 透视（近大远小/前亮后暗）+ 拖拽惯性 + 自动慢转 + 点击显词频。
// 组件化：onMount 挂载渲染循环与交互，onCleanup 销毁；words 变化时重挂载。

import { createEffect, onCleanup, onMount, type Component, type Ref } from "solid-js"
import type { WordFreq } from "../../../utils/wordAnalysis"

const COLORS = ["#4a90d9", "#e06c6c", "#4caf50", "#d9a441", "#8e6cd9", "#2aa0a0", "#e08a3c", "#6ca0e0"]
const REDUCED = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

interface Point {
  x: number
  y: number
  z: number
  word: string
  w: number
}

export interface CloudSphereProps {
  words: WordFreq[]
  /** 最小词数，不足时静默空球。默认 3。 */
  minWords?: number
  class?: string
  ref?: Ref<HTMLCanvasElement>
}

/** 挂载 3D 球状词云，返回销毁函数（清理事件监听 + 取消 rAF）。 */
export function mountCloudSphere(canvas: HTMLCanvasElement, words: WordFreq[]): () => void {
  if (words.length < 3) return () => {}
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const W = rect.width || 240
  const H = rect.height || 150
  canvas.width = W * dpr
  canvas.height = H * dpr
  const ctx = canvas.getContext("2d")
  if (!ctx) return () => {}
  ctx.scale(dpr, dpr)

  // Fibonacci 球面：均匀分布，避免极点堆积
  const R = Math.min(W, H) * 0.42
  const n = words.length
  const pts: Point[] = words.map((w, i) => {
    const t = (i + 0.5) / n
    const phi = Math.acos(1 - 2 * t)
    const theta = Math.PI * (1 + Math.sqrt(5)) * i
    return {
      x: R * Math.sin(phi) * Math.cos(theta),
      y: R * Math.cos(phi),
      z: R * Math.sin(phi) * Math.sin(theta),
      word: w.word,
      w: w.weight,
    }
  })
  const maxW = Math.max(...words.map((w) => w.weight), 1)

  let rotY = 0
  let rotX = 0.35
  let vx = 0
  let vy = 0
  let autoSpin = !REDUCED
  let dragging = false
  let lastX = 0
  let lastY = 0
  let lastT = performance.now()
  let raf = 0

  const proj = (p: Point): { sx: number; sy: number; scale: number; z: number } => {
    const cx = Math.cos(rotX)
    const sx = Math.sin(rotX)
    const cy = Math.cos(rotY)
    const sy = Math.sin(rotY)
    const x1 = p.x * cy + p.z * sy
    const z1 = -p.x * sy + p.z * cy
    const y2 = p.y * cx - z1 * sx
    const z2 = p.y * sx + z1 * cx
    const persp = R * 2
    const s = persp / (persp - z2)
    return { sx: W / 2 + x1 * s, sy: H / 2 + y2 * s, scale: s, z: z2 }
  }

  const render = () => {
    ctx.clearRect(0, 0, W, H)
    const sorted = pts.map((p) => ({ p, q: proj(p) })).sort((a, b) => b.q.z - a.q.z)
    for (const { p, q } of sorted) {
      const alpha = 0.25 + (0.75 * (q.z + R)) / (2 * R)
      const size = 11 + 17 * Math.sqrt(p.w / maxW) * q.scale
      const color = COLORS[Math.abs(p.word.charCodeAt(0)) % COLORS.length]
      ctx.globalAlpha = alpha
      ctx.font = `600 ${Math.max(8, size)}px system-ui, sans-serif`
      ctx.fillStyle = color
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText(p.word, q.sx, q.sy)
    }
    ctx.globalAlpha = 1
  }

  const tick = () => {
    const now = performance.now()
    const dt = Math.min(50, now - lastT)
    lastT = now
    if (!dragging) {
      if (autoSpin) rotY += 0.003 * (dt / 16.7)
      if (!REDUCED && (Math.abs(vx) > 0.0001 || Math.abs(vy) > 0.0001)) {
        rotX += vx * dt
        rotY += vy * dt
        vx *= 0.9
        vy *= 0.9
      }
    }
    render()
    raf = requestAnimationFrame(tick)
  }

  const hit = (mx: number, my: number): Point | null => {
    let best: Point | null = null
    let bd = 40
    for (const p of pts) {
      const q = proj(p)
      if (q.z <= 0) continue
      const d = Math.hypot(mx - q.sx, my - q.sy)
      if (d < bd) {
        bd = d
        best = p
      }
    }
    return best
  }

  const onClick = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect()
    const p = hit(e.clientX - r.left, e.clientY - r.top)
    if (!p) return
    const f = words.find((w) => w.word === p.word)
    canvas.title = `${p.word} · ${f ? f.count : ""} 次`
  }
  canvas.addEventListener("click", onClick)

  const onDown = (e: PointerEvent) => {
    dragging = true
    autoSpin = false
    lastX = e.clientX
    lastY = e.clientY
    canvas.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    if (!dragging) return
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    rotY += dx * 0.005
    rotX -= dy * 0.005
    vx = (-dy * 0.005) / 16.7
    vy = (dx * 0.005) / 16.7
    lastX = e.clientX
    lastY = e.clientY
  }
  const end = () => {
    dragging = false
  }
  canvas.addEventListener("pointerdown", onDown)
  canvas.addEventListener("pointermove", onMove)
  canvas.addEventListener("pointerup", end)
  canvas.addEventListener("pointercancel", end)

  tick()
  return () => {
    cancelAnimationFrame(raf)
    canvas.removeEventListener("click", onClick)
    canvas.removeEventListener("pointerdown", onDown)
    canvas.removeEventListener("pointermove", onMove)
    canvas.removeEventListener("pointerup", end)
    canvas.removeEventListener("pointercancel", end)
  }
}

export const CloudSphere: Component<CloudSphereProps> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined
  let dispose: (() => void) | undefined

  const mount = () => {
    dispose?.()
    if (!canvasRef || props.words.length < (props.minWords ?? 3)) return
    dispose = mountCloudSphere(canvasRef, props.words)
  }

  onMount(() => {
    // 等布局稳定后取尺寸
    requestAnimationFrame(mount)
  })

  createEffect(() => {
    void props.words.length
    mount()
  })

  onCleanup(() => dispose?.())

  return (
    <canvas
      ref={(el) => {
        canvasRef = el
        if (typeof props.ref === "function") props.ref(el)
      }}
      class={props.class}
      data-component="visual-cloud-sphere"
    />
  )
}

export default CloudSphere
