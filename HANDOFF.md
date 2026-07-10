# 多 AI 交接

> Cursor / GrokBuild / Claude Code 共用。换棒时在**最上面**追加一条，不要删历史。

## 2026-07-10 — grokbuild → user (morning)

- **状态：** 成功（本机 smoke test 已过）
- **改了：** 新项目 `grok-chat-web/`（整仓）
  - `app/acp_bridge.py` — 启动 `grok agent stdio`，ACP JSON-RPC
  - `app/main.py` — FastAPI + WebSocket + `/api/fs/*` 列目录/搜索
  - `static/*` — 聊天 UI（复制、Enter 换行、⌘/Ctrl+Enter 发送、@ 路径、📁 选 cwd）
  - `start.sh`、`README.md`
- **为什么 / 思路：** 用户痛点是 TUI 复制难、Enter 不能换行、路径要手抄。用浏览器薄壳套 Grok Build ACP，不重做 agent。已验证：health OK、WS prompt 返回 `web-ok-42`、`stopReason=end_turn`。
- **请你（Mac 早上）：**
  1. 确保本机已装 `grok` 且登录过（`~/.grok/auth.json`）
  2. 进入本项目目录，执行：
     ```bash
     chmod +x start.sh && ./start.sh
     ```
  3. 浏览器打开 http://127.0.0.1:8787/
  4. **不要还原** 本项目；后续可加 diff 审阅 / 会话列表
- **注意：** 必须在 **跑 grok 的同一台机器** 上启动（agent 访问本机文件系统）。若代码在 LXC 的 `/mnt/workspaces/grok-chat-web`，Mac 上对应你的 workspaces 挂载路径。

---

<!-- 旧记录留在下方 -->
