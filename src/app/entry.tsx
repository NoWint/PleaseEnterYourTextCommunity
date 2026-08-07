/* @refresh reload */
import { render } from "solid-js/web"
import App from "./App"
import "./index.css"

// dev 入口可能是 /app.html 或 /，Tauri 桌面端可能是 / 或 /index.html。
// 这些 pathname 都不匹配 Router 的路由，需在渲染前重定向到默认页。
const VALID_PATHS = ["/home", "/work", "/settings"]
if (!VALID_PATHS.includes(location.pathname) && !location.pathname.startsWith("/chat/") && !location.pathname.startsWith("/home/")) {
  history.replaceState(null, "", "/home")
}

const root = document.getElementById("app")
if (!root) throw new Error("Root element #app not found")

render(() => <App />, root)
