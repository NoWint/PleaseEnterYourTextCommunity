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
    // 注意（生产入口决策，Phase 6）：
    // 构建产物同时包含 index.html（legacy 壳 src/index.html）与 app.html（新壳
    // src/app.html）。Tauri 生产 frontendDist=../dist 默认取 index.html（legacy），
    // dev 则经 tauri.conf.json devUrl 指向 app.html（新壳）。
    // Phase 6 清理 legacy src/ 后，需把生产入口固定为 app.html
    // （在 tauri.conf.json frontendDist 或构建配置中锁定），此处不擅自改动。
    rollupOptions: {
      input: {
        legacy: path.resolve(projectRoot, "src/index.html"),
        app: path.resolve(projectRoot, "src/app.html"),
      },
    },
  },
  // jieba-wasm: wasm-bindgen 产物, 预构建会破坏 wasm 定位
  // @opencode-ai/ui: 源码型包(.tsx), 必须排除预构建让 solid 插件转译
  optimizeDeps: {
    exclude: ["jieba-wasm", "@opencode-ai/ui"],
  },
  resolve: {
    alias: {
      "@": path.resolve(projectRoot, "src"),
    },
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
