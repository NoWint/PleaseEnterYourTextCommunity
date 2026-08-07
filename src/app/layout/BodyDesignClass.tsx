// src/app/layout/BodyDesignClass.tsx
// V2 设计模式 body 类切换：对齐 opencode app.tsx 的 BodyDesignClass 组件。
//
// 对齐点（opencode BodyDesignClass）：
// - document.body.toggleAttribute("data-new-layout", true)
// - document.body.classList.toggle("text-[13px]", true)
// - document.body.classList.toggle("font-[440]", true)
// - document.body.classList.toggle("font-(family-name:--font-family-text)", true)
//
// peytchat 始终启用 V2 设计（无 legacy 路径），所以直接在 onMount 设置。

import { onMount, type Component } from "solid-js"

const BodyDesignClass: Component = () => {
  onMount(() => {
    document.body.setAttribute("data-new-layout", "")
    document.body.classList.add("text-[13px]", "font-[440]", "font-(family-name:--font-family-text)")
  })
  return null
}

export default BodyDesignClass
