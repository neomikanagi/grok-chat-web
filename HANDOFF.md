# 多 AI 交接

> Cursor / GrokBuild / Claude Code 共用。换棒时在**最上面**追加一条，不要删历史。

## 2026-07-11 — claudecode → user (optimize pass + archive)

- **状态：** 成功（重启 smoke test 已过，`/api/health` 正常）
- **改了：**
  - `app/main.py`：
    - `fs_search` 的 BFS 用 `list.pop(0)` 改成 `collections.deque.popleft()` — 原来每层出队都是 O(n)，大目录树下退化明显
    - `_conv_payload(conv)` 删掉从没用过的 `conv` 参数（两处调用点跟着改）
    - `_run_prompt` 里 `bridge.prompt()` 补上 `_bridge_lock` — 之前这是唯一一处调 bridge 不加锁的地方，若两个 turn 并发（多开一个标签页、或重试跟第一个请求撞车），共享的 `_turn_agent`/`_turn_thought` 缓冲区会被交叉写坏，存盘消息内容錯亂
  - `deploy/grok-chat-web.service` — 新增，从容器 `/etc/systemd/system/grok-chat-web.service` 存档进仓库（这份 unit 只在容器 rootfs 里，不在 bind mount 上，容器重建会丢，之前没备份）
  - `README.md` — 补一条**未解决**的安全提示（见下）
- **为什么 / 思路：**
  - 用户反馈"体感能用了"，要求做最后一轮优化；上面三处是实际读代码抓到的 bug/低效，不是猜的
  - 系统 unit 没进 git，是纯粹的档案缺口，顺手补上
- **未解决 · 请你决定：**
  - `grok-chat-web.service` 绑 `HOST=0.0.0.0`，而 `/ws`、`/api/fs/*` 全部**零鉴权**，`GROK_CHAT_AUTO_APPROVE=1`。`192.168.122.0/24` 同网段任何主机（包括 `docs/openclaw-trust-boundary.md` 里明确标记为**不可信**的 `OpenClaw` `.121`）理论上都能直接读 `/mnt/workspaces` 任意文件、或通过 WS 让 agent 自动批准执行任意工具调用 —— 这和已经花力气做的 OpenClaw 隔离矛盾。
  - 没有直接改：这是要不要牺牲"同网段随便访问"的便利性换安全性的决定，不是纯代码优化，得用户拍板。建议方案是给 `GROK_CHAT_TOKEN` 环境变量做共享密钥校验（未设置时不校验，不影响现状）。
- **不要还原**：`_run_prompt` 里新加的 `_bridge_lock`（是修 bug，不是误加）。

---

## 2026-07-10 — grokbuild → user (systemd pin)

- **状态：** 成功
- **改了：** 停掉 8080；仅 8787；`/etc/systemd/system/grok-chat-web.service` enabled；`start.sh`/`README` 标明容器绑定
- **请你：** 只用 http://192.168.122.126:8787/ ；管理用 `systemctl restart grok-chat-web`。**不要**再起第二实例。

---

## 2026-07-10 — grokbuild → user (UI v2)

- **状态：** 成功
- **改了：** `static/index.html` `static/app.js` `static/style.css` — 删除对话按钮；右侧可折叠文件夹栏；「项目根」文案
- **请你：** 硬刷新浏览器（Cmd+Shift+R）加载 `?v=2` 静态资源

---

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
