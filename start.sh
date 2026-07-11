#!/usr/bin/env bash
# Grok Chat Web — manual start (dev / non-systemd).
# On GrokBuild LXC the canonical process is systemd unit: grok-chat-web.service
#   systemctl status grok-chat-web
#   systemctl restart grok-chat-web
# Only port 8787. Do not start a second instance on 8080.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"

if [[ "$PORT" != "8787" ]]; then
  echo "This deployment is pinned to port 8787 (got PORT=$PORT)." >&2
  exit 1
fi

# If systemd unit exists and is active, don't double-bind
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet grok-chat-web.service 2>/dev/null; then
    echo "grok-chat-web.service is already running on :8787"
    echo "  URL: http://127.0.0.1:8787/  (this host/container)"
    echo "  Manage: systemctl restart|stop|status grok-chat-web"
    exit 0
  fi
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "需要 uv（https://docs.astral.sh/uv/）。" >&2
  exit 1
fi

if ! command -v "${GROK_BIN:-grok}" >/dev/null 2>&1; then
  echo "找不到 grok CLI。请先安装 Grok Build 并确保 grok 在 PATH 中。" >&2
  exit 1
fi

if [[ ! -d .venv ]]; then
  uv sync
fi

export GROK_CHAT_PREWARM="${GROK_CHAT_PREWARM:-1}"
export GROK_CHAT_AUTO_APPROVE="${GROK_CHAT_AUTO_APPROVE:-1}"
export GROK_CHAT_CWD="${GROK_CHAT_CWD:-/mnt/workspaces}"

echo "Starting Grok Chat Web on http://${HOST}:${PORT} (manual; prefer systemd on this container)"
exec uv run uvicorn app.main:app --host "$HOST" --port "$PORT" --log-level info
