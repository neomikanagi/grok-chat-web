#!/usr/bin/env bash
# Grok Chat Web — start the browser shell on macOS / Linux
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"

# Prefer project venv via uv
if ! command -v uv >/dev/null 2>&1; then
  echo "需要 uv（https://docs.astral.sh/uv/）。macOS: brew install uv" >&2
  exit 1
fi

if ! command -v "${GROK_BIN:-grok}" >/dev/null 2>&1; then
  echo "找不到 grok CLI。请先安装 Grok Build 并确保 grok 在 PATH 中。" >&2
  echo "  curl -fsSL https://x.ai/cli/install.sh | bash" >&2
  exit 1
fi

# Sync deps if needed
if [[ ! -d .venv ]]; then
  uv sync
fi

export GROK_CHAT_PREWARM="${GROK_CHAT_PREWARM:-1}"
export GROK_CHAT_AUTO_APPROVE="${GROK_CHAT_AUTO_APPROVE:-1}"

echo "Starting Grok Chat Web on http://${HOST}:${PORT}"
echo "  Enter = 换行 · ⌘/Ctrl+Enter = 发送 · @ = 路径"
echo "  浏览器会尽量自动打开…"

# Open browser shortly after bind (macOS open / linux xdg-open)
(
  sleep 1.2
  url="http://${HOST}:${PORT}/"
  if command -v open >/dev/null 2>&1; then
    open "$url" 2>/dev/null || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" 2>/dev/null || true
  fi
) &

exec uv run uvicorn app.main:app --host "$HOST" --port "$PORT" --log-level info
