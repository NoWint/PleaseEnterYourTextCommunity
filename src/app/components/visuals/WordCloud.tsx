// src/app/components/visuals/WordCloud.tsx
// 词频词云（Solid 组件版，canvas 逻辑从 src/components/wordCloud.ts 的
// drawWordCloud 迁移）：词频→字号/颜色，瀑布式逐行堆叠。
// 组件化：onMount + words 变化时重绘（createEffect 触发）。

import { createEffect, onMount, type Component } from "solid-js"
import type { WordFreq } from "../../../utils/wordAnalysis"

const CLOUD_COLORS = ["#4a90d9", "#e06c6c", "#4caf50", "#d9a441", "#8e6cd9", "#2aa0a0", "#e08a3c", "#6ca0e0"]

export interface WordCloudProps {
  words: WordFreq[]
  width?: number
  height?: number
  class?: string
}

/** 按词频在 canvas 画词云：词频→字号(12-36px)/颜色，瀑布式逐行堆叠。 */
export function drawWordCloud(canvas: HTMLCanvasElement, words: WordFreq[]): void {
  const ctx = canvas.getContext("2d")
  if (!ctx || words.length === 0) return
  const cssW = canvas.width
  const cssH = canvas.height
  ctx.clearRect(0, 0, cssW, cssH)
  ctx.textBaseline = "alphabetic"

  const maxWeight = words[0].weight || 1
  const maxFont = 36
  const minFont = 12
  let x = 8
  let y = maxFont + 4
  let maxRowH = 0

  for (const w of words) {
    const size = minFont + (w.weight / maxWeight) * (maxFont - minFont)
    ctx.font = `${Math.round(size)}px sans-serif`
    const width = ctx.measureText(w.word).width + 10
    if (x + width > cssW - 8) {
      x = 8
      y += maxRowH + 6
      maxRowH = 0
    }
    ctx.fillStyle = CLOUD_COLORS[Math.floor(Math.random() * CLOUD_COLORS.length)]
    ctx.fillText(w.word, x, y)
    x += width
    maxRowH = Math.max(maxRowH, size)
  }
}

export const WordCloud: Component<WordCloudProps> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined
  const width = () => props.width ?? 280
  const height = () => props.height ?? 220

  const redraw = () => {
    const canvas = canvasRef
    if (!canvas || props.words.length === 0) return
    // 仅当 CSS 尺寸变化或画布未初始化时重置（避免滚动窗口内频繁重建）
    if (canvas.width !== width() || canvas.height !== height()) {
      canvas.width = width()
      canvas.height = height()
    }
    drawWordCloud(canvas, props.words)
  }

  onMount(redraw)
  createEffect(() => {
    void props.words.length
    redraw()
  })

  return (
    <canvas
      ref={(el) => {
        canvasRef = el
      }}
      width={width()}
      height={height()}
      class={props.class}
      data-component="visual-word-cloud"
    />
  )
}

export default WordCloud
