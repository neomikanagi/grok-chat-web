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

## 启动

```bash
cd /path/to/grok-chat-web
chmod +x start.sh
./start.sh
```

浏览器打开：http://127.0.0.1:8787/

换端口：

```bash
PORT=9000 ./start.sh
```

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
