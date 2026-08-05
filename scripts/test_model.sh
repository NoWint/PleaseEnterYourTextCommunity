#!/usr/bin/env bash
# PEYT 本地 LLM 模型终端测试脚本
#
# 用途:检测 dev 下载的模型(GGUF)与 llama-server 引擎,终端内选择模型,
#       启动 llama-server 后用 curl 对话测试推理。
#
# 用法: bash scripts/test_model.sh
#
# 环境:Git Bash (Windows)。引擎缺失时自动下载 llama.cpp CPU 版。
# 退出: 输入 /quit 或 Ctrl+C。

set -u

APP_DATA="${APPDATA//\\//}"   # Git Bash 下 APPDATA 是反斜杠路径,转正
MODELS_DIR="${PEYT_MODELS_DIR:-$APP_DATA/com.peytchat.app/models}"
ENGINE_TAG="b10276"
ENGINE_ASSET="llama-${ENGINE_TAG}-bin-win-cpu-x64.zip"
ENGINE_URL="https://github.com/ggml-org/llama.cpp/releases/download/${ENGINE_TAG}/${ENGINE_ASSET}"
PORT=12700

# ── 颜色(非 TTY 自动禁用) ─────────────────────────────────
if [ -t 1 ]; then
  C_G="\033[32m"; C_Y="\033[33m"; C_R="\033[31m"; C_B="\033[36m"; C_0="\033[0m"
else
  C_G=""; C_Y=""; C_R=""; C_B=""; C_0=""
fi
ok()   { echo -e "${C_G}[✓]${C_0} $*"; }
warn() { echo -e "${C_Y}[!]${C_0} $*"; }
err()  { echo -e "${C_R}[✗]${C_0} $*"; }
info() { echo -e "${C_B}[i]${C_0} $*"; }

# ── 前置检查 ─────────────────────────────────────────────
command -v curl >/dev/null 2>&1 || { err "缺少 curl"; exit 1; }
[ -d "$MODELS_DIR" ] || { err "模型目录不存在: $MODELS_DIR"; exit 1; }

ENGINE="$MODELS_DIR/llama-server.exe"
info "模型目录: $MODELS_DIR"

# ── 引擎检测/下载 ─────────────────────────────────────────
if [ -x "$ENGINE" ]; then
  ok "引擎就绪: llama-server.exe"
else
  warn "引擎缺失($ENGINE),正在从 llama.cpp releases 下载..."
  warn "  $ENGINE_URL"
  TMP_ZIP="$(mktemp -u).zip"
  if curl -fL --connect-timeout 30 -o "$TMP_ZIP" "$ENGINE_URL"; then
    info "下载完成,解压提取 llama-server.exe..."
    TMP_DIR="$(mktemp -d)"
    if command -v unzip >/dev/null 2>&1; then
      unzip -o -q "$TMP_ZIP" -d "$TMP_DIR"
    elif command -v tar >/dev/null 2>&1; then
      tar -xf "$TMP_ZIP" -C "$TMP_DIR"
    else
      err "无 unzip/tar 解压工具"; rm -f "$TMP_ZIP"; exit 1
    fi
    # 注意:llama-server.exe 依赖同目录的全部 DLL(ggml-*.dll/llama.dll 等 29 个),
    # 单独拷 exe 会因缺 DLL 无法运行 → 整包拷贝解压根目录全部内容到 models。
    if [ -f "$TMP_DIR/llama-server.exe" ]; then
      find "$TMP_DIR" -mindepth 1 -maxdepth 1 -exec cp -rf {} "$MODELS_DIR/" \;
      [ -x "$ENGINE" ] && chmod +x "$ENGINE" 2>/dev/null || true
      ok "引擎已安装: $ENGINE (含全部依赖 DLL)"
    else
      err "压缩包内未找到 llama-server.exe"; rm -rf "$TMP_DIR" "$TMP_ZIP"; exit 1
    fi
    rm -rf "$TMP_DIR" "$TMP_ZIP"
  else
    err "引擎下载失败(网络/代理?)"; exit 1
  fi
fi

# ── 列出模型供选择 ───────────────────────────────────────
mapfile -t MODELS < <(find "$MODELS_DIR" -maxdepth 1 -iname "*.gguf" 2>/dev/null | sort)
if [ "${#MODELS[@]}" -eq 0 ]; then
  err "未找到任何 .gguf 模型。请先在应用 设置→智能 下载模型,再跑本脚本。"
  exit 1
fi

echo
info "检测到 ${#MODELS[@]} 个模型:"
for i in "${!MODELS[@]}"; do
  NAME=$(basename "${MODELS[$i]}")
  SIZE=$(du -sh "${MODELS[$i]}" 2>/dev/null | cut -f1)
  echo "  ${C_B}[$((i+1))]${C_0} $NAME  (${SIZE})"
done
echo -n "选择模型序号 [1-${#MODELS[@]}]: "
read -r SEL
SEL_IDX=$(( ${SEL:-1} - 1 ))
if [ "$SEL_IDX" -lt 0 ] || [ "$SEL_IDX" -ge "${#MODELS[@]}" ]; then
  err "无效选择"; exit 1
fi
MODEL="${MODELS[$SEL_IDX]}"
ok "选择模型: $(basename "$MODEL")"

# ── 启动 llama-server ────────────────────────────────────
# 探测空闲端口(避开应用已占用):/dev/tcp 连接成功=端口被占用→换下一个。
while (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; do
  exec 3>&- 3<&-   # 关掉探测连接
  PORT=$((PORT+1))
  [ "$PORT" -gt 12710 ] && { err "端口全部占用"; exit 1; }
done
exec 3>&- 3<&- 2>/dev/null

info "启动 llama-server (port $PORT)..."
"$ENGINE" --model "$MODEL" --port "$PORT" --host 127.0.0.1 --ctx-size 4096 --n-predict -1 >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null; echo; info "已停止 llama-server"; exit 0' INT TERM EXIT

# 等 /health 就绪(上限 120s,模型加载需几秒)
BASE="http://127.0.0.1:$PORT"
info "等待模型就绪..."
READY=0
for _ in $(seq 1 120); do
  if curl -s --max-time 2 "$BASE/health" | grep -q '"ok"'; then READY=1; break; fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  err "引擎启动超时/失败。查看上方日志。"
  kill "$SERVER_PID" 2>/dev/null; exit 1
fi
ok "引擎就绪: $BASE (模型加载完成)"

# ── 对话循环 ─────────────────────────────────────────────
echo
echo -e "${C_Y}── 终端对话测试 ──────────────────────────────"
echo -e "  输入问题回车发送; /quit 退出; /clear 清屏${C_0}"
echo

# 保持会话历史(带 system 角色)
BODY_FILE="$(mktemp)"
echo '{"model":"local","stream":false,"messages":[{"role":"system","content":"你是 PEYT 的本地测试助手,用中文简洁回答。"}]}' > "$BODY_FILE"

while true; do
  echo -n "${C_G}你${C_0} > "
  read -r INPUT
  [ -z "$INPUT" ] && continue
  case "$INPUT" in
    /quit|/exit|q) echo; info "退出测试。"; break ;;
    /clear) clear; continue ;;
  esac
  # 追加用户消息
  python - "$BODY_FILE" "$INPUT" <<'PYEOF'
import json, sys
path, msg = sys.argv[1], sys.argv[2]
d = json.load(open(path, encoding='utf-8'))
d['messages'].append({"role": "user", "content": msg})
json.dump(d, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
PYEOF
  # 请求并提取回复
  RESP=$(curl -s --max-time 120 "$BASE/v1/chat/completions" \
    -H "Content-Type: application/json" \
    --data-binary "@$BODY_FILE")
  REPLY=$(echo "$RESP" | python -c "import json,sys; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])" 2>/dev/null)
  if [ -n "$REPLY" ]; then
    echo -e "${C_B}模型${C_0} > $REPLY"
    # 追加助手回复,保持多轮上下文
    python - "$BODY_FILE" "$REPLY" <<'PYEOF'
import json, sys
path, msg = sys.argv[1], sys.argv[2]
d = json.load(open(path, encoding='utf-8'))
d['messages'].append({"role": "assistant", "content": msg})
json.dump(d, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
PYEOF
  else
    err "请求失败。引擎日志被丢弃,可去掉 --max-time 或检查模型。"
  fi
  echo
done

rm -f "$BODY_FILE"
