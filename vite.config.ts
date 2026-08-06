// defineConfig 从 vitest/config 引入（它转发 vite 的同名函数并补上 test 字段的类型），
// 这样单测配置和构建配置留在同一份文件里，不必再维护一份 vitest.config.ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: true },
  build: { target: "chrome105" },
  // 版本号唯一来源是 package.json：tauri.conf.json 也指向它，
  // 这样打包产物、窗口标题与「关于」面板不会各说各话
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // jsdom 而非 node：docx.ts 用的是浏览器的 DOMParser / XMLSerializer
  test: { environment: "jsdom", include: ["src/**/*.test.ts"] },
});
