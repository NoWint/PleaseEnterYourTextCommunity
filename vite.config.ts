import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2021",
    outDir: "../dist",
    emptyOutDir: true,
  },
  // jieba-wasm 是 wasm-bindgen 产物, 预构建(optimizeDeps)会破坏其
  // `new URL('*.wasm', import.meta.url)` 的 wasm 定位与 MIME 响应,
  // 导致浏览器 `instantiateStreaming` 失败。排除预构建, 按源码 serve。
  optimizeDeps: {
    exclude: ["jieba-wasm"],
  },
});
