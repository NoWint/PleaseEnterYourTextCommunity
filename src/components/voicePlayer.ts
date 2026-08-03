import { iconSvg } from './icon.js';
import { escapeAttr } from './escape.js';

// 语音消息播放器 — 渲染 + 交互绑定。
// message.ts 在 Voice 附件处调用 renderVoicePlayer 插入 HTML,
// 随后对包含播放器的容器调用 bindVoicePlayer 绑定播放/暂停与计时。
//
// 结构对齐 Delta AudioPlayer:<button class="voice-play"> + <span class="voice-time"> + <audio>。
// 说明:icon.ts 当前没有 play/pause/mic 图标,播放/暂停用 volume-2 / volume-x 占位,
// 待 icon.ts 增加 play/pause 后再替换为三角/双杠图标。

export function renderVoicePlayer(assetUrl: string, audioElId: string): string {
  return (
    `<button type="button" class="voice-play" title="播放语音">${iconSvg('play', { width: 16, height: 16, fill: 'var(--on-accent)' })}</button>` +
    `<span class="voice-time">0:00</span>` +
    `<div class="voice-progress"><span class="voice-progress-fill" style="width:0%"></span></div>` +
    `<span class="voice-dur">0:00</span>` +
    `<audio id="${escapeAttr(audioElId)}" src="${escapeAttr(assetUrl)}" preload="metadata" hidden></audio>`
  );
}

// 绑定播放器交互:点击播放/暂停切换图标,timeupdate 更新计时,ended 恢复 play 图标。
// 兼容容器为单个播放器或整条消息列表(按 button 的父元素分组关联 audio/.voice-time)。
export function bindVoicePlayer(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>('.voice-play').forEach((btn) => {
    const wrapper = btn.parentElement;
    if (!wrapper) return;
    const audio = wrapper.querySelector<HTMLAudioElement>('audio');
    const timeEl = wrapper.querySelector<HTMLElement>('.voice-time');
    const durEl = wrapper.querySelector<HTMLElement>('.voice-dur');
    const progressEl = wrapper.querySelector<HTMLElement>('.voice-progress');
    const fillEl = wrapper.querySelector<HTMLElement>('.voice-progress-fill');
    if (!audio) return;

    const setIcon = (playing: boolean) => {
      btn.innerHTML = iconSvg(playing ? 'pause' : 'play', { width: 16, height: 16, fill: 'var(--on-accent)' });
      btn.classList.toggle('playing', playing);
      btn.title = playing ? '暂停' : '播放语音';
    };
    const updateTime = () => {
      const cur = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (timeEl) timeEl.textContent = formatTime(cur);
      if (durEl) durEl.textContent = formatTime(dur);
      if (fillEl && dur > 0) fillEl.style.width = `${Math.min(100, (cur / dur) * 100)}%`;
    };

    btn.addEventListener('click', () => {
      if (audio.paused) {
        if (audio.ended) audio.currentTime = 0; // 播完后再点 → 从头开始
        void audio.play().catch(() => {});
      } else {
        audio.pause();
      }
    });

    // 进度条拖动定位:pointerdown 即 seek,pointermove 1:1 跟随(Apple §1 直接操控)
    if (progressEl) {
      const seekFromEvent = (clientX: number) => {
        const rect = progressEl.getBoundingClientRect();
        const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
        const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
        if (dur > 0) {
          audio.currentTime = ratio * dur;
          if (audio.paused) updateTime();
        }
      };
      progressEl.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        progressEl.setPointerCapture(e.pointerId);
        seekFromEvent(e.clientX);
      });
      progressEl.addEventListener('pointermove', (e) => {
        if (e.buttons > 0) seekFromEvent(e.clientX);
      });
    }

    audio.addEventListener('play', () => setIcon(true));
    audio.addEventListener('pause', () => setIcon(false));
    audio.addEventListener('ended', () => {
      setIcon(false);
      updateTime();
    });
    audio.addEventListener('timeupdate', updateTime);
    audio.addEventListener('loadedmetadata', updateTime);

    setIcon(false);
    updateTime();
  });
}

// 秒数 → m:ss(如 0:05)
function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
