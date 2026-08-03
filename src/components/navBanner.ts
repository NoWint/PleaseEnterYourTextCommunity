import { iconSvg } from './icon.js';
import { showToast } from '../toast.js';
import { escapeHtml } from './escape.js';

export interface NavBannerOpts {
  title: string;
  subtitle: string;
  inviteLink?: string;
  onViewChannels?: () => void;
  onDismiss: () => void;
}

export function createNavBanner(opts: NavBannerOpts): HTMLElement {
  const banner = document.createElement('div');
  banner.className = 'nav-banner';
  const inviteBtn = opts.inviteLink
    ? `<button class="nav-banner-btn" data-action="copy">复制邀请</button>`
    : '';
  const viewBtn = opts.onViewChannels
    ? `<button class="nav-banner-btn" data-action="view">查看频道</button>`
    : '';
  banner.innerHTML = `
    <div class="nav-banner-icon">${iconSvg('check', { width: 16, height: 16 })}</div>
    <div class="nav-banner-content">
      <div class="nav-banner-title">${escapeHtml(opts.title)}</div>
      <div class="nav-banner-subtitle">${escapeHtml(opts.subtitle)}</div>
    </div>
    <div class="nav-banner-actions">
      ${inviteBtn}
      ${viewBtn}
      <button class="nav-banner-close" data-action="close">${iconSvg('x', { width: 14, height: 14 })}</button>
    </div>
  `;
  banner.querySelector<HTMLButtonElement>('[data-action="copy"]')?.addEventListener('click', async () => {
    if (!opts.inviteLink) return;
    try {
      await navigator.clipboard.writeText(opts.inviteLink);
      showToast('邀请链接已复制');
    } catch {
      showToast('复制失败');
    }
  });
  banner.querySelector<HTMLButtonElement>('[data-action="view"]')?.addEventListener('click', () => {
    opts.onViewChannels?.();
  });
  banner.querySelector<HTMLButtonElement>('[data-action="close"]')?.addEventListener('click', () => {
    opts.onDismiss();
    banner.remove();
  });
  return banner;
}

export function showNavBanner(opts: NavBannerOpts): HTMLElement {
  const banner = createNavBanner(opts);
  const nav = document.querySelector<HTMLElement>('.nav-panel');
  if (nav) {
    nav.insertBefore(banner, nav.firstChild);
  } else {
    document.body.appendChild(banner);
  }
  return banner;
}
