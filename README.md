# Grok Chat Web

给 **Grok Build** 套一层浏览器聊天壳，解决 CLI 里这几件事：

1. **一键复制** Grok 的回复  
2. **多行输入**：`Enter` 换行，`⌘/Ctrl+Enter` 发送  
3. **`@` 插入路径** + 📁 选工作目录（不用去别处复制路径）

底层仍是本机的 `grok agent stdio`（完整工具链 / MCP / skills），只是 UI 换成网页。

## 要求

- macOS / Linux  
- 已安装 [Grok Build CLI](https://x.ai/news/grok-build-cli)（`grok` 在 PATH 里）  
- 已登录过一次：`grok` 打开浏览器登录，生成 `~/.grok/auth.json`  
- [uv](https://docs.astral.sh/uv/)（`brew install uv`）

## 部署（GrokBuild 容器）

本服务**绑定本容器**，只监听 **8787**（不要再起 8080）。

```bash
systemctl status grok-chat-web
systemctl restart grok-chat-web
systemctl stop grok-chat-web
```

- 容器内：http://127.0.0.1:8787/
- 同网段：http://192.168.122.126:8787/
- unit：`/etc/systemd/system/grok-chat-web.service`（`enabled`，开机自启；存档副本见 `deploy/grok-chat-web.service`，容器 rootfs 丢失时用它重建）
- 默认项目根：`GROK_CHAT_CWD=/mnt/workspaces`

**注意（未解决）：** unit 绑定 `HOST=0.0.0.0`，且 `/ws`、`/api/fs/*` 均无鉴权、`GROK_CHAT_AUTO_APPROVE=1`。同网段（`192.168.122.0/24`）任何主机都能读 `/mnt/workspaces` 任意文件、驱动 agent 自动批准执行任意工具调用 —— 包括 `OpenClaw`（不可信中国模型容器，`.121`）在内。这与 `docs/openclaw-trust-boundary.md` 建立的隔离矛盾。修一次性方案：给 `/ws` 和 `/api/*` 加共享 token 校验（`GROK_CHAT_TOKEN` 环境变量，未设置时不校验，向后兼容）。

手动调试（仅当 systemd 未运行时）可用 `./start.sh`，且强制端口 8787。
## 快捷键

| 操作 | 按键 |
|------|------|
| 换行 | `Enter` |
| 发送 | `⌘+Enter`（Mac）/ `Ctrl+Enter` |
| 路径补全 | 输入 `@`，方向键选择，`Enter`/`Tab` 插入 |
| 复制回复 | 消息右上角「复制」 |
| 换工作目录 | 点顶部路径或 📁 |

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8787` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 绑定地址（仅本机） |
| `GROK_BIN` | `grok` | grok 可执行文件 |
| `GROK_CHAT_CWD` | 自动探测 | 初始工作目录 |
| `GROK_CHAT_MODEL` | （CLI 默认） | 模型 ID |
| `GROK_CHAT_AUTO_APPROVE` | `1` | 自动批准工具（`0` 则网页弹批准） |
| `GROK_CHAT_PREWARM` | `1` | 启动时预热 agent |

## 架构

```
Browser  --WebSocket-->  FastAPI (app/main.py)
                              |
                              v
                     grok agent stdio  (ACP JSON-RPC)
```

## 说明

- 这是 **MVP**，不是 Cursor 完整替代品。  
- Agent 跑在你本机；网页只连 `127.0.0.1`。  
- 若提示登录失败：在终端再跑一次 `grok` 完成 OAuth。
