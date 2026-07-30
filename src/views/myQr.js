import QRCode from "qrcode";
import { call } from "../api.js";

/**
 * Show the user's own SecureJoin QR code so a friend nearby can scan it
 * to add them as a verified contact. The QR is rendered to a canvas
 * using the `qrcode` npm package.
 *
 * @param {number|null} chatId  Optional group chat id to share a group-invite QR.
 */
export function openMyQrDialog(chatId = null) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="dialog">
      <h2>${chatId ? "群组邀请二维码" : "我的二维码"}</h2>
      <p class="hint">让好友用 Delta Chat 扫描此二维码（或复制下方链接发送），即可建立端到端加密的验证联系。</p>
      <div class="qr-area"><canvas id="qr-canvas"></canvas></div>
      <textarea id="qr-text" rows="2" readonly></textarea>
      <div id="qr-error" class="error" style="display:none"></div>
      <div class="dialog-actions">
        <button type="button" id="qr-copy" class="link">复制链接</button>
        <button type="button" id="qr-close">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  document.getElementById("qr-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  // Load QR asynchronously.
  (async () => {
    const errEl = document.getElementById("qr-error");
    try {
      const qr = await call("get_securejoin_qr", { chatId });
      document.getElementById("qr-text").value = qr;
      const canvas = document.getElementById("qr-canvas");
      await QRCode.toCanvas(canvas, qr, { width: 240, margin: 2 });
    } catch (err) {
      errEl.textContent = typeof err === "object" && err?.message ? err.message : String(err);
      errEl.style.display = "block";
    }
  })();

  document.getElementById("qr-copy").addEventListener("click", async () => {
    const text = document.getElementById("qr-text").value;
    try {
      await navigator.clipboard.writeText(text);
      const btn = document.getElementById("qr-copy");
      const old = btn.textContent;
      btn.textContent = "✓ 已复制";
      overlay.querySelector(".dialog").classList.add("flash-copied");
      setTimeout(() => {
        btn.textContent = old;
        overlay.querySelector(".dialog").classList.remove("flash-copied");
      }, 1200);
    } catch {}
  });
}
