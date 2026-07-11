# Grok Chat Web

给 **Grok Build** 套一层浏览器聊天壳，解决 CLI 里这几件事：

1. **一键复制** Grok 的回复  
2. **多行输入**：`Enter` 换行，`⌘/Ctrl+Enter` 发送  
3. **`@` 插入路径** + 📁 选工作目录（不用去别处复制路径）
4. **多项目根切换**：项目根按钮旁的 ▾ 可以在几个预配置的目录间一键切换（类似 Cursor 的多根工作区），见下面 `GROK_CHAT_ROOT_<n>_*`

底层仍是本机的 `grok agent stdio`（完整工具链 / MCP / skills），只是 UI 换成网页。

## 要求

- macOS / Linux  
- 已安装 [Grok Build CLI](https://x.ai/news/grok-build-cli)（`grok` 在 PATH 里）  
- 已登录过一次：`grok` 打开浏览器登录，生成 `~/.grok/auth.json`  
- Docker 部署：Docker + Docker Compose  
- 手动 / 源码运行：[uv](https://docs.astral.sh/uv/)（`brew install uv`）

## 部署（Docker，推荐）

```bash
cp .env.example .env   # 按需改 GROK_CHAT_TOKEN / GROK_CHAT_PROJECTS_DIR
docker compose up -d --build
```

- 默认监听 `8787`：http://127.0.0.1:8787/
- `grok` 二进制本身**不会**打进镜像（属于 xAI 的专有 CLI，不能随意分发）——容器通过挂载宿主已登录好的 `~/.grok` 目录来复用它，见 `docker-compose.yml` 里的 `GROK_HOME_DIR`
- `GROK_CHAT_PROJECTS_DIR` 决定容器里 `/workspace` 挂载哪个宿主目录，也就是 grok 默认能读写的项目根
- 对话记录落在 `./data`（宿主目录，已在 `.gitignore` 里排除，不会被提交）
- 想接进自己已有的 Docker 网络 / 固定重启策略 / 日志大小 / DNS：复制 `docker-compose.override.yml.example` 为 `docker-compose.override.yml`（已 gitignore）按需改，Compose 会自动叠加它，不用改 `docker-compose.yml` 本体
- 想加更多可切换的项目根：同一个 override 文件里加 `GROK_CHAT_ROOT_1_NAME` / `GROK_CHAT_ROOT_1_PATH`（`_2`、`_3`… 继续加）+ 对应的 volume 挂载，见 `.example` 里的示例

**鉴权：** 只要服务监听地址不是 `127.0.0.1`（比如暴露给局域网或反代到公网），任何能连上的人都能直接读 `GROK_CHAT_CWD` 下任意文件、驱动 agent 自动批准任意工具调用。默认**不鉴权**（向后兼容单机场景），建议凡是监听非 loopback 地址就设置 `GROK_CHAT_TOKEN`：

- 在 `.env` 里设置 `GROK_CHAT_TOKEN`，重启容器生效
- HTTP：`Authorization: Bearer <token>` 或 `?token=` query 均可；WebSocket 握手浏览器不能带自定义 header，走 `?token=` query
- 浏览器首次请求若收到 401，`app.js` 会弹窗要求粘贴 token，存 `localStorage`（`gcw_token`），之后自动带上
- 换 token：改 `.env` + 重启容器；浏览器端清掉 `localStorage.gcw_token` 后刷新会重新弹窗

## 部署（不用 Docker，直接跑）

```bash
./start.sh   # 需要本机已装 uv + grok，固定监听 8787
```

或手动 `uv sync && uv run uvicorn app.main:app --host 0.0.0.0 --port 8787`。`deploy/grok-chat-web.example.service` 是一份可参考的 systemd unit 模板（路径按你自己的部署改）。

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
| `HOST` | `127.0.0.1` | 绑定地址（Docker 镜像里默认 `0.0.0.0`，见上面鉴权说明） |
| `GROK_BIN` | `grok` | grok 可执行文件（Docker 里指向挂载进来的 `/opt/grok-home/bin/grok`） |
| `GROK_HOME` | `~/.grok` | grok 配置/会话目录（Docker 里指向 `/opt/grok-home`） |
| `GROK_CHAT_CWD` | 自动探测 | 初始工作目录 |
| `GROK_CHAT_TOKEN` | （未设置） | 鉴权共享密钥，见上面鉴权说明 |
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
- Agent 跑在部署它的机器上；默认只监听本机，暴露给网络前请设置 `GROK_CHAT_TOKEN`。  
- 若提示登录失败：在宿主机终端再跑一次 `grok` 完成 OAuth（登录状态在 `~/.grok`，Docker 部署靠挂载复用它，不会重新登录一遍）。
