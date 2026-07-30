import { call, onEvent } from "../api.js";
import { state } from "../state.js";
import { renderChatView } from "./chatView.js";
import { openCreateGroupDialog } from "./group.js";
import { openAddFriendDialog } from "./addFriend.js";
import { openMyQrDialog } from "./myQr.js";

export async function renderChatList() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="main">
      <aside class="sidebar">
        <div class="sidebar-header">
          <span>会话</span>
          <div class="sidebar-actions">
            <button id="add-friend" class="link" title="添加好友 / 私聊">添加好友</button>
            <button id="my-qr" class="link" title="我的二维码">我的二维码</button>
            <button id="new-group" class="link" title="新建群组">新建群组</button>
          </div>
        </div>
        <ul id="chatlist" class="chatlist"></ul>
      </aside>
      <main id="chat-panel" class="chat-panel">
        <div class="empty">选择一个会话</div>
      </main>
    </div>
  `;

  document.getElementById("new-group").addEventListener("click", () => {
    openCreateGroupDialog(async () => { await refreshChatlist(); });
  });
  document.getElementById("add-friend").addEventListener("click", () => {
    openAddFriendDialog(async (chatId) => {
      await refreshChatlist();
      if (chatId != null) {
        state.currentChatId = chatId;
        renderChatView(chatId);
      }
    });
  });
  document.getElementById("my-qr").addEventListener("click", () => {
    openMyQrDialog();
  });

  await refreshChatlist();
  onEvent("MsgsChanged", refreshChatlist);
  onEvent("IncomingMsg", refreshChatlist);
  onEvent("ChatlistItemChanged", refreshChatlist);
  onEvent("ChatModified", refreshChatlist);
  onEvent("ContactsChanged", refreshChatlist);
}

async function refreshChatlist() {
  try {
    state.chatlist = await call("get_chatlist");
  } catch {
    return;
  }
  const ul = document.getElementById("chatlist");
  if (!ul) return;
  ul.innerHTML = state.chatlist.map((c, i) => {
    const badge = c.is_contact_request
      ? `<span class="badge-request">请求</span>`
      : (c.unread > 0 ? `<span class="unread">${c.unread}</span>` : "");
    const tag = c.is_group ? "群" : (c.is_self_talk ? "我" : "");
    return `
      <li class="chat-item ${state.currentChatId === c.chat_id ? "active" : ""}" data-id="${c.chat_id}" style="--i: ${i}">
        <div class="avatar">${initial(c.name)}</div>
        <div class="chat-meta">
          <div class="chat-name">${tag ? `<span class="chat-tag">${tag}</span>` : ""}${escapeHtml(c.name)}</div>
          <div class="chat-last">${escapeHtml(c.last_msg || "")}</div>
        </div>
        ${badge}
      </li>
    `;
  }).join("");
  ul.querySelectorAll(".chat-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.id);
      state.currentChatId = id;
      ul.querySelectorAll(".chat-item").forEach((x) => x.classList.remove("active"));
      el.classList.add("active");
      renderChatView(id);
    });
  });
}

function initial(name) {
  return (name || "?").charAt(0).toUpperCase();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}
