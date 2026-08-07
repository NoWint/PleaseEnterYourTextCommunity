import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

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
  // jieba-wasm: wasm-bindgen 产物, 预构建会破坏 wasm 定位
  // @opencode-ai/ui: 源码型包(.tsx), 必须排除预构建让 solid 插件转译
  optimizeDeps: {
    exclude: ["jieba-wasm", "@opencode-ai/ui"],
  },
  plugins: [
    solid(),
    tailwindcss(),
  ],
  test: {
    root: projectRoot,
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
