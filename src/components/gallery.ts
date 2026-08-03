// Gallery 相册 — 会话内媒体浏览（对齐 Delta Gallery）。
// 全屏浮层:头部 4 tab（图库/文件/视频/音频）→ 网格/列表;点图库缩略图进全屏查看器,支持 ←→ 相邻切换。
// 样式策略:不改 styles.css,运行时注入一个 <style id="gallery-css"> 块（首次打开时挂到 <head>）。
import { call, transformBlobURL } from '../api.js';
import { iconSvg } from './icon.js';
import type { MsgDto } from '../types.js';

type GalleryTab = 'Image' | 'File' | 'Video' | 'Audio';

const TABS: { key: GalleryTab; label: string }[] = [
  { key: 'Image', label: '图库' },
  { key: 'File', label: '文件' },
  { key: 'Video', label: '视频' },
  { key: 'Audio', label: '音频' },
];

// 单实例状态:同一时刻只允许一个 gallery 浮层 + 一个全屏查看器。
let gallery: {
  chatId: number;
  overlay: HTMLElement;
  bodyEl: HTMLElement;
  activeTab: GalleryTab;
  media: Partial<Record<GalleryTab, MsgDto[]>>;
} | null = null;

let viewer: {
  overlay: HTMLElement;
  list: MsgDto[];
  index: number;
} | null = null;

/** 首次打开时注入 Gallery 专属样式（只挂一次,不触碰 styles.css）。 */
function ensureStyles(): void {
  if (document.getElementById('gallery-css')) return;
  const style = document.createElement('style');
  style.id = 'gallery-css';
  style.textContent = `
.gallery-overlay {
  position: fixed; inset: 0; z-index: 120;
  background: var(--bg);
  display: flex; flex-direction: column;
}
.gallery-header {
  display: flex; align-items: center; gap: 16px;
  padding: 10px 16px; border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.gallery-title { font-size: var(--font-scale-title); font-weight: 600; color: var(--text); margin-right: auto; }
.gallery-tabs { display: flex; gap: 4px; }
.gallery-tab {
  padding: 5px 12px; border: 1px solid transparent; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-mute); font-size: var(--font-scale-body);
  font-family: var(--font); cursor: pointer;
}
.gallery-tab:hover { background: var(--active); color: var(--text); }
.gallery-tab.active { background: var(--active); color: var(--text); font-weight: 600; border-color: var(--border-strong); }
.gallery-close {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-mute); cursor: pointer;
}
.gallery-close:hover { background: var(--active); color: var(--text); }
.gallery-body { flex: 1; overflow-y: auto; padding: 16px; }
/* 图库:方形缩略图网格(居中,宽屏 ~3-4 列) */
.gallery-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 6px;
  max-width: 720px; margin: 0 auto;
}
.gallery-thumb {
  width: 100%; aspect-ratio: 1; border-radius: 8px; display: block;
  object-fit: cover; cursor: pointer; background: var(--capsule);
}
.gallery-thumb-fail { position: relative; }
.gallery-thumb-fail::after {
  content: '!'; position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  color: var(--text-weak); font-size: var(--font-scale-title);
}
/* 文件/视频/音频:列表卡片 */
.gallery-list { display: flex; flex-direction: column; gap: 8px; max-width: 560px; }
.gallery-card {
  display: flex; align-items: center; gap: 12px;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 10px 12px; cursor: default;
}
.gallery-card[data-download] { cursor: pointer; }
.gallery-card[data-download]:hover { background: var(--active); }
.gallery-card-icon {
  width: 36px; height: 36px; border-radius: var(--radius-sm); flex-shrink: 0;
  background: var(--capsule); border: 1px solid var(--border-strong);
  display: flex; align-items: center; justify-content: center; color: var(--text-mute);
}
.gallery-card-icon svg { display: block; }
.gallery-card-info { min-width: 0; flex: 1; }
.gallery-card-name {
  font-size: var(--font-scale-body); color: var(--text); font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gallery-card-meta { font-size: var(--font-scale-micro); color: var(--text-weak); margin-top: 2px; }
.gallery-card-player { flex-shrink: 0; max-width: 240px; }
.gallery-card-player audio, .gallery-card-player video { width: 100%; max-height: 96px; display: block; }
.gallery-empty { color: var(--text-weak); font-size: var(--font-scale-body); text-align: center; padding: 48px 0; }
/* 全屏查看器 */
.gallery-viewer-overlay {
  position: fixed; inset: 0; z-index: 130;
  background: rgba(0,0,0,0.92);
  display: flex; flex-direction: column;
}
.gallery-viewer-top {
  display: flex; align-items: center; gap: 12px; padding: 10px 16px; flex-shrink: 0;
}
.gallery-viewer-count { color: var(--text-mute); font-size: var(--font-scale-secondary); margin: 0 auto; }
.gallery-viewer-img-wrap {
  flex: 1; display: flex; align-items: center; justify-content: center;
  min-height: 0; padding: 0 56px;
}
.gallery-viewer-img-wrap img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 4px; }
.gallery-viewer-nav {
  position: fixed; top: 50%; transform: translateY(-50%);
  width: 44px; height: 44px; border-radius: 50%;
  background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
  color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.gallery-viewer-nav:hover { background: rgba(255,255,255,0.16); }
.gallery-viewer-prev { left: 12px; }
.gallery-viewer-next { right: 12px; }
.gallery-viewer-caption {
  padding: 8px 16px 16px; text-align: center; flex-shrink: 0;
  color: var(--text-mute); font-size: var(--font-scale-secondary);
}
@media (prefers-reduced-motion: no-preference) {
  .gallery-overlay { animation: fade-in 180ms ease-out; }
  .gallery-viewer-overlay { animation: fade-in 180ms ease-out; }
}
`;
  document.head.appendChild(style);
}

function escapeHtml(s: unknown): string {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeAttr(s: unknown): string {
  return escapeHtml(s);
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** 打开 Gallery。重复调用会先关掉旧浮层,保证单实例。 */
export async function openGallery(chatId: number): Promise<void> {
  ensureStyles();
  if (gallery) closeGallery();

  const overlay = document.createElement('div');
  overlay.className = 'gallery-overlay';
  overlay.innerHTML = `
    <header class="gallery-header">
      <span class="gallery-title">媒体</span>
      <nav class="gallery-tabs">
        ${TABS.map((t) => `<button class="gallery-tab" data-tab="${t.key}">${t.label}</button>`).join('')}
      </nav>
      <button class="gallery-close" data-action="close" title="关闭">${iconSvg('x', { width: 16, height: 16 })}</button>
    </header>
    <div class="gallery-body"></div>
  `;
  document.body.appendChild(overlay);

  gallery = {
    chatId,
    overlay,
    bodyEl: overlay.querySelector<HTMLElement>('.gallery-body')!,
    activeTab: 'Image',
    media: {},
  };
  overlay.querySelector<HTMLElement>('.gallery-tab[data-tab="Image"]')?.classList.add('active');

  overlay.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-action="close"]')) {
      closeGallery();
      return;
    }
    const tabBtn = target.closest<HTMLElement>('.gallery-tab');
    if (tabBtn && tabBtn.dataset.tab) {
      switchTab(tabBtn.dataset.tab as GalleryTab);
    }
  });

  document.addEventListener('keydown', onKeyDown);

  await loadTab('Image');
}

function switchTab(tab: GalleryTab): void {
  if (!gallery || gallery.activeTab === tab) return;
  gallery.activeTab = tab;
  gallery.overlay.querySelectorAll('.gallery-tab').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-tab') === tab);
  });
  void loadTab(tab);
}

async function loadTab(tab: GalleryTab): Promise<void> {
  if (!gallery) return;
  const g = gallery;
  if (g.media[tab] !== undefined) {
    renderTab(tab);
    return;
  }
  g.bodyEl.innerHTML = '<div class="gallery-empty">加载中…</div>';
  try {
    const list = await call<MsgDto[]>('get_chat_media', { chatId: g.chatId, viewType: tab });
    g.media[tab] = Array.isArray(list) ? list : [];
  } catch (err) {
    g.media[tab] = [];
    if (gallery === g && g.activeTab === tab) {
      g.bodyEl.innerHTML = '<div class="gallery-empty">媒体加载失败</div>';
    }
    return;
  }
  renderTab(tab);
}

function renderTab(tab: GalleryTab): void {
  if (!gallery || gallery.activeTab !== tab) return;
  const list = gallery.media[tab] || [];
  if (list.length === 0) {
    gallery.bodyEl.innerHTML = '<div class="gallery-empty">暂无媒体</div>';
    return;
  }
  if (tab === 'Image') {
    void renderImageGrid(gallery.bodyEl, tab, list);
  } else {
    void renderMediaList(gallery.bodyEl, tab, list);
  }
}

async function renderImageGrid(container: HTMLElement, tab: GalleryTab, list: MsgDto[]): Promise<void> {
  const cells = await Promise.all(
    list.map(async (m, i) => {
      let url = '';
      if (m.file) url = await transformBlobURL(m.file);
      if (!url) {
        return `<div class="gallery-thumb gallery-thumb-fail" data-idx="${i}" title="${escapeAttr(m.file_name || '')}"></div>`;
      }
      return `<img class="gallery-thumb" data-idx="${i}" src="${escapeAttr(url)}" alt="${escapeAttr(m.file_name || '')}" loading="lazy" />`;
    }),
  );
  if (!gallery || gallery.activeTab !== tab) return; // 等待期间切了 tab,丢弃本次渲染
  const grid = document.createElement('div');
  grid.className = 'gallery-grid';
  grid.innerHTML = cells.join('');
  container.innerHTML = '';
  container.appendChild(grid);
  grid.querySelectorAll<HTMLElement>('.gallery-thumb').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.idx);
      if (list[idx]) openViewer(list, idx);
    });
  });
}

async function renderMediaList(container: HTMLElement, tab: GalleryTab, list: MsgDto[]): Promise<void> {
  const cards = await Promise.all(
    list.map(async (m) => {
      let url = '';
      if (m.file) url = await transformBlobURL(m.file);
      const name = m.file_name || 'file';
      const meta = formatBytes(m.file_size);
      const icon = tab === 'Audio'
        ? iconSvg('volume-2', { width: 18, height: 18, strokeWidth: 1.8 })
        : iconSvg('file-text', { width: 18, height: 18, strokeWidth: 1.8 });
      let player = '';
      if (url && tab === 'Video') {
        player = `<div class="gallery-card-player"><video controls preload="metadata" src="${escapeAttr(url)}"></video></div>`;
      } else if (url && tab === 'Audio') {
        player = `<div class="gallery-card-player"><audio controls preload="metadata" src="${escapeAttr(url)}"></audio></div>`;
      }
      return `
        <div class="gallery-card" ${url ? `data-download="${escapeAttr(url)}"` : ''}>
          <div class="gallery-card-icon">${icon}</div>
          <div class="gallery-card-info">
            <div class="gallery-card-name">${escapeHtml(name)}</div>
            <div class="gallery-card-meta">${escapeHtml(meta)}${url ? '' : ' · 附件加载失败'}</div>
          </div>
          ${player}
        </div>
      `;
    }),
  );
  if (!gallery || gallery.activeTab !== tab) return;
  const listEl = document.createElement('div');
  listEl.className = 'gallery-list';
  listEl.innerHTML = cards.join('');
  container.innerHTML = '';
  container.appendChild(listEl);
  // 文件/视频/音频卡片点击下载;点击播放器本体不触发
  listEl.querySelectorAll<HTMLElement>('.gallery-card[data-download]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.gallery-card-player')) return;
      const a = document.createElement('a');
      a.href = el.dataset.download || '';
      a.download = '';
      a.click();
    });
  });
}

/** 全屏图片查看器:复用 .img-fullscreen-overlay 的暗底 + 大图展示思路,支持相邻切换。 */
function openViewer(list: MsgDto[], index: number): void {
  if (!gallery) return;
  const overlay = document.createElement('div');
  overlay.className = 'gallery-viewer-overlay';
  document.body.appendChild(overlay);
  viewer = { overlay, list, index };
  void renderViewer();
}

async function renderViewer(): Promise<void> {
  const v = viewer;
  if (!v) return;
  const m = v.list[v.index];
  if (!m) return;
  let url = '';
  if (m.file) url = await transformBlobURL(m.file);
  if (viewer !== v) return; // 渲染期间已关闭/切换
  const navBtns = v.list.length > 1
    ? `<button class="gallery-viewer-nav gallery-viewer-prev" data-nav="-1" title="上一张">${iconSvg('chevron-left', { width: 22, height: 22 })}</button>
       <button class="gallery-viewer-nav gallery-viewer-next" data-nav="1" title="下一张">${iconSvg('chevron-right', { width: 22, height: 22 })}</button>`
    : '';
  v.overlay.innerHTML = `
    <div class="gallery-viewer-top">
      <button class="gallery-close" data-action="close" title="关闭">${iconSvg('x', { width: 18, height: 18 })}</button>
      <span class="gallery-viewer-count">${v.index + 1} / ${v.list.length}</span>
    </div>
    ${navBtns}
    <div class="gallery-viewer-img-wrap">
      ${url ? `<img src="${escapeAttr(url)}" alt="${escapeAttr(m.file_name || '')}" />` : '<span class="gallery-empty">图片加载失败</span>'}
    </div>
    <div class="gallery-viewer-caption">${escapeHtml(m.from_name || '')}${m.file_name ? ' · ' + escapeHtml(m.file_name) : ''}</div>
  `;

  v.overlay.querySelectorAll<HTMLElement>('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => viewerNav(Number(btn.dataset.nav)));
  });
  v.overlay.querySelector<HTMLElement>('[data-action="close"]')?.addEventListener('click', () => closeViewer());
  v.overlay.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    // 点暗底（overlay 本身或图片四周留白区）关闭
    if (t === v.overlay || t.classList.contains('gallery-viewer-img-wrap')) closeViewer();
  });
}

function viewerNav(delta: number): void {
  const v = viewer;
  if (!v || v.list.length === 0) return;
  v.index = (v.index + delta + v.list.length) % v.list.length;
  void renderViewer();
}

/** 关闭全屏查看器,回到 Gallery 网格（Gallery 浮层仍在下层 DOM）。 */
function closeViewer(): void {
  if (!viewer) return;
  viewer.overlay.remove();
  viewer = null;
}

function closeGallery(): void {
  if (viewer) {
    viewer.overlay.remove();
    viewer = null;
  }
  if (gallery) {
    gallery.overlay.remove();
    gallery = null;
  }
  document.removeEventListener('keydown', onKeyDown);
}

function onKeyDown(e: KeyboardEvent): void {
  if (viewer) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeViewer();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      viewerNav(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      viewerNav(1);
    }
  } else if (gallery && e.key === 'Escape') {
    e.stopPropagation();
    closeGallery();
  }
}
