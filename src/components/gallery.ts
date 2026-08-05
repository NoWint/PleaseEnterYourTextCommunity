// Gallery 相册 — 会话内媒体浏览（对齐 Delta Gallery）。
// 全屏浮层:头部 4 tab（图库/文件/视频/音频）→ 网格/列表;点图库缩略图进全屏查看器,支持 ←→ 相邻切换。
// 样式已并入 styles.css「Gallery 相册浮层」段(2026-08-05 消灭运行时注入)。
import { call, transformBlobURL } from '../api.js';
import { iconSvg, type IconName } from './icon.js';
import { escapeHtml, escapeAttr } from './escape.js';
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
  query: string;
  /** 搜索范围:'name' 按文件名 / 'content' 检索附件正文 */
  searchMode: 'name' | 'content';
  /** 附件正文缓存:msg_id → 提取文本(正文搜索用) */
  docTextCache: Map<number, string>;
} | null = null;

let viewer: {
  overlay: HTMLElement;
  list: MsgDto[];
  index: number;
} | null = null;


function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** 打开 Gallery。重复调用会先关掉旧浮层,保证单实例。 */
export async function openGallery(chatId: number): Promise<void> {
  if (gallery) closeGallery();

  const overlay = document.createElement('div');
  overlay.className = 'gallery-overlay';
  overlay.innerHTML = `
    <div class="gallery-shell">
      <header class="gallery-header">
        <span class="gallery-title">媒体</span>
        <div class="gallery-search">
          ${iconSvg('search', { width: 14, height: 14 })}
          <nav class="gallery-search-pill">
            <button class="gallery-pill-btn active" data-pill="name">名称</button>
            <button class="gallery-pill-btn" data-pill="content">正文</button>
          </nav>
          <input class="gallery-search-input" type="text" placeholder="搜索…" />
          <button class="gallery-search-clear" data-search-clear title="清除">${iconSvg('x', { width: 12, height: 12 })}</button>
        </div>
        <button class="gallery-close" data-action="close" title="关闭">${iconSvg('x', { width: 16, height: 16 })}</button>
        <nav class="gallery-tabs">
          ${TABS.map((t) => `<button class="gallery-tab" data-tab="${t.key}">${t.label}</button>`).join('')}
        </nav>
      </header>
      <div class="gallery-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  gallery = {
    chatId,
    overlay,
    bodyEl: overlay.querySelector<HTMLElement>('.gallery-body')!,
    activeTab: 'Image',
    media: {},
    query: '',
    searchMode: 'name',
    docTextCache: new Map(),
  };
  overlay.querySelector<HTMLElement>('.gallery-tab[data-tab="Image"]')?.classList.add('active');

  // 搜索:输入即时过滤当前 tab;清除按钮复位
  const searchInput = overlay.querySelector<HTMLInputElement>('.gallery-search-input')!;
  const searchClear = overlay.querySelector<HTMLElement>('[data-search-clear]')!;
  const syncClear = (): void => {
    searchClear.classList.toggle('show', searchInput.value.length > 0);
  };
  const applyQuery = (): void => {
    if (!gallery) return;
    void renderTab(gallery.activeTab);
  };
  searchInput.addEventListener('input', () => {
    if (!gallery) return;
    gallery.query = searchInput.value.trim().toLowerCase();
    syncClear();
    applyQuery();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    searchInput.value = '';
    if (gallery) gallery.query = '';
    syncClear();
    applyQuery();
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    if (gallery) gallery.query = '';
    syncClear();
    applyQuery();
  });
  // 名称/正文 pill:切换搜索范围
  overlay.querySelectorAll<HTMLElement>('.gallery-pill-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const mode = btn.dataset.pill as 'name' | 'content';
      if (!gallery || gallery.searchMode === mode) return;
      gallery.searchMode = mode;
      overlay.querySelectorAll<HTMLElement>('.gallery-pill-btn').forEach((b) => b.classList.toggle('active', b.dataset.pill === mode));
      const ph = mode === 'content' ? '搜索文件正文…' : '搜索文件名…';
      searchInput.placeholder = ph;
      applyQuery();
    });
  });
  syncClear();

  overlay.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-action="close"]')) {
      closeGallery();
      return;
    }
    // 点击遮罩(卡片外)关闭
    if (target === overlay) {
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
    await renderTab(tab);
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
  await renderTab(tab);
}

async function renderTab(tab: GalleryTab): Promise<void> {
  if (!gallery || gallery.activeTab !== tab) return;
  const all = gallery.media[tab] || [];
  const q = gallery.query;
  const g = gallery;
  if (all.length === 0) {
    g.bodyEl.innerHTML = '<div class="gallery-empty">暂无媒体</div>';
    return;
  }
  if (g.searchMode === 'content' && q) {
    // 正文模式:逐文件提取正文并过滤(带缓存)。先显示 loading。
    g.bodyEl.innerHTML = '<div class="gallery-empty">正在检索正文…</div>';
    const hits: MsgDto[] = [];
    for (const m of all) {
      if (!m.msg_id) continue;
      let text = g.docTextCache.get(m.msg_id);
      if (text === undefined) {
        try {
          text = await call<string>('get_msg_file_text', { msgId: m.msg_id });
        } catch {
          text = '';
        }
        g.docTextCache.set(m.msg_id, text);
      }
      if (text.toLowerCase().includes(q)) hits.push(m);
      // 等待期间切了 tab/关闭,丢弃本次渲染
      if (gallery !== g || g.activeTab !== tab) return;
    }
    if (hits.length === 0) {
      g.bodyEl.innerHTML = `<div class="gallery-empty">未找到「${escapeHtml(q)}」</div>`;
      return;
    }
    if (tab === 'Image') {
      await renderImageGrid(g.bodyEl, tab, hits);
    } else {
      await renderMediaList(g.bodyEl, tab, hits);
    }
    return;
  }
  // 名称模式(或无 query):按文件名匹配
  const list = q
    ? all.filter((m) => (m.file_name || '').toLowerCase().includes(q))
    : all;
  if (list.length === 0) {
    g.bodyEl.innerHTML = `<div class="gallery-empty">未找到「${escapeHtml(q)}」</div>`;
    return;
  }
  if (tab === 'Image') {
    await renderImageGrid(g.bodyEl, tab, list);
  } else {
    await renderMediaList(g.bodyEl, tab, list);
  }
}

async function renderImageGrid(container: HTMLElement, tab: GalleryTab, list: MsgDto[]): Promise<void> {
  const cells = await Promise.all(
    list.map(async (m, i) => {
      let url = '';
      if (m.file) url = await transformBlobURL(m.file);
      const name = m.file_name || 'image';
      if (!url) {
        return `<div class="gallery-img-card gallery-thumb-fail" data-idx="${i}" title="${escapeAttr(name)}">
          <div class="gallery-img-tag">${escapeHtml(extOf(name))}</div>
        </div>`;
      }
      // 图片卡片:缩略图(点击查看)+ 右上角下载钮 + 底部格式/名称 tag
      const ext = extOf(name).toUpperCase();
      return `
        <div class="gallery-img-card" data-idx="${i}">
          <img class="gallery-thumb" src="${escapeAttr(url)}" alt="${escapeAttr(name)}" title="${escapeAttr(name)}" loading="lazy" />
          <button class="gallery-media-download gallery-img-download" data-download="${escapeAttr(url)}" data-name="${escapeAttr(name)}" title="下载 ${escapeAttr(name)}">
            ${iconSvg('download', { width: 14, height: 14 })}
          </button>
          <div class="gallery-img-meta">
            <span class="gallery-img-tag">${escapeHtml(ext)}</span>
            <span class="gallery-img-name">${escapeHtml(name)}</span>
          </div>
        </div>
      `;
    }),
  );
  if (!gallery || gallery.activeTab !== tab) return; // 等待期间切了 tab,丢弃本次渲染
  const grid = document.createElement('div');
  grid.className = 'gallery-grid';
  grid.innerHTML = cells.join('');
  container.innerHTML = '';
  container.appendChild(grid);
  // 点击卡片/缩略图 → 全屏查看器;下载按钮独立触发下载
  grid.querySelectorAll<HTMLElement>('.gallery-img-card').forEach((card) => {
    const idx = Number(card.dataset.idx);
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.gallery-img-download')) return;
      if (list[idx]) openViewer(list, idx);
    });
  });
  grid.querySelectorAll<HTMLElement>('.gallery-img-download').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = document.createElement('a');
      a.href = btn.dataset.download || '';
      a.download = btn.dataset.name || '';
      a.click();
    });
  });
}

// 文件扩展名 → tdesign 专属图标名(映射常见文档/压缩/代码格式,其余落 file-text)
const FILE_ICON_MAP: Array<[RegExp, IconName]> = [
  [/\.pdf$/i, 'file-pdf'],
  [/\.(zip|rar|7z|tar|gz|bz2|xz)$/i, 'file-zip'],
  [/\.(txt|log|md|rtf|nfo)$/i, 'file-txt'],
  [/\.(doc|docx|odt|pages)$/i, 'file-word'],
  [/\.(xls|xlsx|csv|ods|numbers)$/i, 'file-excel'],
  [/\.(json|ya?ml|toml|xml)$/i, 'file-json'],
  [/\.(js|ts|jsx|tsx|rs|go|py|java|c|cc|cpp|h|cs|php|rb|swift|kt|sql|sh|html|css|scss)$/i, 'file-code'],
];
function fileIconOf(name: string): IconName {
  const hit = FILE_ICON_MAP.find(([re]) => re.test(name));
  return (hit ? hit[1] : 'file-text') as IconName;
}

/** 取文件名扩展名(含点,如 ".png");无扩展名返回空串。 */
function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(idx) : '';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把 text 中所有 query 命中段包 <mark class="gallery-hit">(已 escapeHtml 安全)。 */
function highlightHit(text: string, query: string): string {
  if (!query) return escapeHtml(text);
  const safe = escapeHtml(text);
  const re = new RegExp(escapeRegex(escapeHtml(query)), 'gi');
  return safe.replace(re, '<mark class="gallery-hit">$&</mark>');
}

/** 从正文找 query 首位置,前后截取片段(约 ±40 字符)供 snippet 展示。 */
function makeSnippet(body: string, query: string): string {
  const q = query.toLowerCase();
  const idx = body.toLowerCase().indexOf(q);
  if (idx < 0) return '';
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + query.length + 40);
  const pre = start > 0 ? '…' : '';
  const post = end < body.length ? '…' : '';
  return pre + highlightHit(body.slice(start, end), query) + post;
}

async function renderMediaList(container: HTMLElement, tab: GalleryTab, list: MsgDto[]): Promise<void> {
  const cards = await Promise.all(
    list.map(async (m) => {
      let url = '';
      if (m.file) url = await transformBlobURL(m.file);
      const name = m.file_name || 'file';
      const meta = formatBytes(m.file_bytes ?? null);
      // 图标:音频 volume-2,视频 play,文件按扩展名映射 tdesign 专属图标
      const iconName: IconName = tab === 'Audio' ? 'volume-2'
        : tab === 'Video' ? 'play'
        : fileIconOf(name);
      const icon = iconSvg(iconName, { width: 18, height: 18, strokeWidth: 1.8 });
      // 音频/视频:内嵌播放器(点击即播,绝不触发跳转/下载)。文件:无播放器。
      let action = '';
      if (url && tab === 'Audio') {
        action = `<div class="gallery-media-player"><audio controls preload="metadata" src="${escapeAttr(url)}"></audio></div>`;
      } else if (url && tab === 'Video') {
        action = `<div class="gallery-media-player"><video controls preload="metadata" src="${escapeAttr(url)}"></video></div>`;
      }
      // 下载按钮固定右上角:文件管理器式统一操作位(所有文件一致,养成肌肉记忆)
      const downloadBtn = url
        ? `<button class="gallery-media-download" data-download="${escapeAttr(url)}" data-name="${escapeAttr(name)}" title="下载 ${escapeAttr(name)}">
            ${iconSvg('download', { width: 15, height: 15 })}
          </button>`
        : '';
      // 名称搜索 → 文件名高亮;正文搜索 → 卡片下方正文片段 area(命中词高亮)
      const q = gallery?.query ?? '';
      const inContentMode = gallery?.searchMode === 'content';
      const nameHtml = inContentMode ? escapeHtml(name) : highlightHit(name, q);
      let snippet = '';
      if (inContentMode && q && m.msg_id) {
        const body = gallery?.docTextCache.get(m.msg_id) || '';
        const s = makeSnippet(body, q);
        if (s) snippet = `<div class="gallery-media-snippet">${s}</div>`;
      }
      return `
        <div class="gallery-media-item">
          <div class="gallery-media-top">
            <div class="gallery-media-icon">${icon}</div>
            <div class="gallery-media-info">
              <div class="gallery-media-name">${nameHtml}</div>
              <div class="gallery-media-meta">${escapeHtml(meta)}${url ? '' : ' · 附件加载失败'}</div>
            </div>
            ${downloadBtn}
          </div>
          ${action}
          ${snippet}
        </div>
      `;
    }),
  );
  if (!gallery || gallery.activeTab !== tab) return;
  const gridEl = document.createElement('div');
  gridEl.className = 'gallery-media-grid';
  gridEl.innerHTML = cards.join('');
  container.innerHTML = '';
  container.appendChild(gridEl);
  // 文件:点击下载按钮才触发下载(播放器/行本身不下载)
  gridEl.querySelectorAll<HTMLElement>('.gallery-media-download').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = document.createElement('a');
      a.href = btn.dataset.download || '';
      a.download = btn.dataset.name || '';
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
