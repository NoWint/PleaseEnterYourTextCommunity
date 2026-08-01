import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import { call } from '../api.js';
import { showToast } from '../toast.js';

const WHITELIST = new Set([
  'ls', 'pwd', 'whoami', 'date', 'echo', 'clear', 'df', 'du',
  'git status', 'git log', 'git branch', 'git diff', 'git pull', 'git fetch',
  'git add', 'git commit', 'git push', 'git stash',
  'npm run dev', 'npm run build', 'npm start', 'npm test',
  'cat', 'head', 'tail', 'grep', 'find', 'which', 'uname', 'ps', 'top',
  'curl', 'ping', 'nslookup', 'dig', 'node', 'python3', 'python',
]);

const QUICK_COMMANDS = [
  { label: 'git status', cmd: 'git status' },
  { label: 'git log', cmd: 'git log --oneline -10' },
  { label: 'ls', cmd: 'ls' },
  { label: 'pwd', cmd: 'pwd' },
  { label: 'npm run dev', cmd: 'npm run dev' },
];

const HISTORY_KEY = 'peyt.term.history';

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let sessionId: string | null = null;
let inputBuf = '';
let history: string[] = [];
let historyIdx = -1;
let unlisten: (() => void) | null = null;
let expertMode = false;
let workdir = '';

function loadHistory(): void {
  try {
    history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    history = [];
  }
  if (!Array.isArray(history)) history = [];
}

function pushHistory(cmd: string): void {
  history = history.filter((h) => h !== cmd);
  history.push(cmd);
  if (history.length > 200) history = history.slice(-200);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  historyIdx = -1;
}

function isWhitelisted(raw: string): boolean {
  const line = raw.trim();
  if (!line) return true;
  return WHITELIST.has(line);
}

function readTheme(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue('--bg').trim() || '#0d0d0d';
  const text = cs.getPropertyValue('--text').trim() || '#e6e6e6';
  const muted = cs.getPropertyValue('--text-mute').trim() || '#888';
  const weak = cs.getPropertyValue('--text-weak').trim() || '#666';
  const panel = cs.getPropertyValue('--panel').trim() || bg;
  const border = cs.getPropertyValue('--border-strong').trim() || muted;
  return { bg, text, muted, weak, panel, border };
}

function applyTheme(term: Terminal): void {
  const t = readTheme();
  term.options.theme = {
    background: t.bg,
    foreground: t.text,
    cursor: t.text,
    cursorAccent: t.bg,
    selectionBackground: t.border,
    black: t.bg,
    brightBlack: t.weak,
    white: t.text,
    brightWhite: t.text,
    brightRed: '#e5484d',
    brightGreen: '#46a758',
    brightYellow: '#d9a741',
    brightBlue: '#3e63dd',
    brightMagenta: '#d6409f',
    brightCyan: '#12a594',
  };
}

function promptReject(raw: string): void {
  if (!term) return;
  term.write(`\r\n\x1b[31m⛔ 命令不在白名单中:\x1b[0m ${raw}\r\n\x1b[90m(可在工具栏开启专家模式执行任意命令)\x1b[0m\r\n`);
}

function sendLine(raw: string, force = false): void {
  if (!term) return;
  if (!force && !expertMode && !isWhitelisted(raw)) {
    promptReject(raw);
    term.write('\r\n');
    return;
  }
  pushHistory(raw);
  term.write(raw + '\r');
}

function renderPanel(panel: HTMLElement): void {
  const btnHtml = QUICK_COMMANDS.map(
    (q, i) =>
      `<button class="term-quick" data-i="${i}">${q.label}</button>`
  ).join('');
  const list = [...WHITELIST].slice(0, 24).join('、');
  panel.innerHTML = `
    <div class="term-panel-head">终端</div>
    <div class="term-panel-section">
      <div class="term-panel-label">快捷命令</div>
      ${btnHtml}
    </div>
    <div class="term-panel-section">
      <div class="term-panel-label">白名单示例</div>
      <div class="term-whitelist">${list}…</div>
    </div>
    <div class="term-panel-tip">回车执行;↑/↓ 历史;专家模式可执行任意命令</div>
  `;
  panel.querySelectorAll<HTMLElement>('.term-quick').forEach((el) => {
    el.addEventListener('click', () => {
      const q = QUICK_COMMANDS[Number(el.dataset.i)];
      if (q && term) sendLine(q.cmd, true);
    });
  });
}

function renderMain(main: HTMLElement): void {
  main.innerHTML = `
    <div class="term-toolbar">
      <label class="term-cwd-label">目录</label>
      <input class="term-cwd" id="term-cwd" placeholder="~" spellcheck="false">
      <button class="term-btn" id="term-open">打开会话</button>
      <label class="term-expert"><input type="checkbox" id="term-expert"> 专家模式</label>
    </div>
    <div class="term-body"><div class="term-holder"></div></div>
  `;

  const holder = main.querySelector<HTMLElement>('.term-holder')!;
  const cwdInput = main.querySelector<HTMLInputElement>('#term-cwd')!;
  const expertInput = main.querySelector<HTMLInputElement>('#term-expert')!;
  cwdInput.value = workdir;
  expertInput.checked = expertMode;
  expertInput.addEventListener('change', () => {
    expertMode = expertInput.checked;
  });
  main.querySelector<HTMLElement>('#term-open')!.addEventListener('click', () => {
    workdir = cwdInput.value.trim();
    void openSession(workdir || undefined);
  });

  // 初始化 xterm
  term = new Terminal({
    fontSize: 13,
    fontFamily: 'Menlo, Consolas, "SF Mono", monospace',
    cursorBlink: true,
    scrollback: 2000,
    allowProposedApi: true,
  });
  applyTheme(term);
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(holder);
  fit.fit();

  term.onData((data) => handleData(data));

  // 容器尺寸变化 → fit + resize
  const ro = new ResizeObserver(() => {
    if (fit && term) {
      fit.fit();
      void syncSize();
    }
  });
  ro.observe(holder);

  // 主题切换时刷新配色
  const onThemeChange = () => {
    if (term) applyTheme(term);
  };
  document.addEventListener('peyt:theme-change', onThemeChange);

  void openSession(workdir || undefined);

  holder.addEventListener('click', () => term?.focus());
}

async function syncSize(): Promise<void> {
  if (!term || !sessionId) return;
  const cols = term.cols;
  const rows = term.rows;
  try {
    await call('resize_terminal', { sessionId, cols, rows });
  } catch {}
}

function handleData(data: string): void {
  if (!term) return;
  if (data === '\r') {
    sendLine(inputBuf);
    inputBuf = '';
    return;
  }
  if (data === '\x7f') {
    inputBuf = inputBuf.slice(0, -1);
    return;
  }
  if (data === '\x1b[A') {
    if (history.length && historyIdx < history.length - 1) {
      historyIdx++;
      const cmd = history[history.length - 1 - historyIdx];
      inputBuf = cmd;
      term.write('\r\x1b[K' + cmd);
    }
    return;
  }
  if (data === '\x1b[B') {
    if (historyIdx > 0) {
      historyIdx--;
      const cmd = history[history.length - 1 - historyIdx];
      inputBuf = cmd;
      term.write('\r\x1b[K' + cmd);
    } else {
      historyIdx = -1;
      inputBuf = '';
      term.write('\r\x1b[K');
    }
    return;
  }
  inputBuf += data;
}

async function openSession(dir?: string): Promise<void> {
  try {
    const sid = await call<string>('open_terminal', { workdir: dir ?? null });
    sessionId = sid;
    if (term) term.writeln('');

    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    const { listen } = await import('@tauri-apps/api/event');
    unlisten = await listen<{ session_id: string; data: string }>(
      'terminal-output',
      (ev) => {
        if (ev.payload.session_id !== sessionId) return;
        if (term) term.write(ev.payload.data);
      }
    );
    void syncSize();
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
  }
}

export function renderTerminalPage(panel: HTMLElement, main: HTMLElement): void {
  cleanupTerminalPage();
  loadHistory();
  renderPanel(panel);
  renderMain(main);
}

export function cleanupTerminalPage(): void {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  if (sessionId) {
    void call('close_terminal', { sessionId }).catch(() => {});
    sessionId = null;
  }
  term = null;
  fit = null;
  inputBuf = '';
  historyIdx = -1;
}
