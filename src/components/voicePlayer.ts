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
    `<button type="button" class="voice-play" title="播放语音">${iconSvg('volume-2', { width: 18, height: 18 })}</button>` +
    `<span class="voice-time">0:00 / 0:00</span>` +
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
    if (!audio) return;

    const setIcon = (playing: boolean) => {
      btn.innerHTML = iconSvg(playing ? 'volume-x' : 'volume-2', { width: 18, height: 18 });
      btn.classList.toggle('playing', playing);
      btn.title = playing ? '暂停' : '播放语音';
    };
    const updateTime = () => {
      if (!timeEl) return;
      const cur = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
      timeEl.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    };

    btn.addEventListener('click', () => {
      if (audio.paused) {
        if (audio.ended) audio.currentTime = 0; // 播完后再点 → 从头开始
        void audio.play().catch(() => {});
      } else {
        audio.pause();
      }
    });
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
