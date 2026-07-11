# 多 AI 交接

> Cursor / GrokBuild / Claude Code 共用。换棒时在**最上面**追加一条，不要删历史。

## 2026-07-11 — claudecode → user (修复：auto-approve 改了不生效，无限弹批准窗)

- **状态：** 成功。`/api/health` 验证 `always_approve: true`，agent 正常。
- **根因：** 运行中的容器创建时吃的是 `GROK_CHAT_AUTO_APPROVE=0`（13:28 JST 启动），之后（14:27 JST）`.env` 被改成 `=1`——**Docker 环境变量在容器创建时固化，改 `.env` 必须重建容器**。改文件的是容器里的 Grok 自己：它改对了，但容器内没有 docker socket，不可能重建自己所在的容器，所以永远"改了没生效"。
- **做了：** 宿主侧 `cd /mnt/user/workspaces/grok-chat-web && docker compose up -d`（compose 检测到 env 变化自动 Recreate）。零代码改动。
- **副作用：** 重建杀掉了当时卡在批准弹窗上的那轮对话（kokkai 探针任务）。对话 JSON 在 `./data` 里还在，重开该对话让 Grok 继续即可。
- **给下一棒的规矩：** 任何 `.env` / compose 环境变量改动，都要在**宿主**跑 `docker compose up -d` 才生效；让容器里的 agent 自己改自己的部署配置是死路。
- **不要还原：** `.env` 里 `GROK_CHAT_AUTO_APPROVE=1` 是用户明确要求的全自动允许（token 鉴权仍在，安全面不变）。

- **状态：** 成功，用 Playwright 连 ClaudeCode LXC 的 CDP 浏览器实测过 390×844（手机）和 768×1024（平板竖屏），截图确认。
- **改了：** 两侧栏默认收起（首次访问 ≤860px 宽度时，之前是不管屏幕多窄都默认展开，跟用户截图里看到的一致）；加了点击遮罩关闭；触控目标加大到 ~40px；`#input` 在窄屏强制 16px 防 iOS 自动放大；手机宽度隐藏详细连接状态文字只留圆点；项目根切换菜单改成 JS 算 `position:fixed`（原来 `position:absolute` 相对按钮定位，实测在 390px 宽度下菜单左边缘会截断出屏幕外）。
- **顺手挖到一个真 bug：** 项目根按钮的 `max-width: 40%` 在平板宽度（768px）下几乎坍缩成看不见的宽度——因为它挂在一个"按内容自动撑开宽度"的 flex 容器（`.root-switcher`）里，百分比 max-width 在这种情况下不会按预期方式解析到一个确定值。换成 `vw` 单位 + 给 `.root-switcher` 加 `flex-shrink:0` 解决。
- **不要还原**：`.roots-menu` 从 `position: absolute` 改成 `position: fixed` + JS 里 `positionRootsMenu()` 计算位置，不是误改；`.cwd-btn` 的 `max-width` 用 `vw` 不用 `%`，同理。

## 2026-07-11 — claudecode → user (多根配置简化：自动发现 /roots 子目录)

- **状态：** 成功。用户自己提出原来 `GROK_CHAT_ROOT_<n>_NAME`/`_PATH` 配对的设计有冗余——volume 挂载和环境变量各写一遍同一个路径，两边可能对不上（比如改了挂载忘记同步改名字）。
- **改了：** `app/main.py` 的 `_project_roots()` 现在直接扫描 `/roots/` 下实际挂载了什么子目录，用挂载目录名当显示名，不再需要环境变量配对。`docker-compose.override.yml`（本地）简化成只有 2 行 `-v`，不用改代码就能加减根。
- **为什么：** 名字直接等于挂载目录名，物理上不可能跟实际内容对不上——这对"跟宿主级 grok CLI 保持一致认知"更重要（用户原话："引用名字不要乱...怕docker里一乱在宿主的grokbuild蒙圈了"）。
- **不要还原**：`GROK_CHAT_ROOT_<n>_NAME`/`_PATH` 这套旧机制是刻意删掉的，不是漏改。

## 2026-07-11 — claudecode → user (根切换器改单按钮 + 加宿主路径提示)

- **状态：** 成功，用户截图证实了问题：之前"项目根"主按钮 + 旁边一个小"▾"是两个独立点击目标，窄屏（用户是 Sidecar）下基本看不出来是两个东西，用户一直点的是主按钮，弹出的是旧的"浏览任意路径"弹窗（只显示容器内部路径如 `/`、`/mnt`，看不出对应宿主机哪个盘）。
- **改了：**
  - `static/index.html`/`app.js` — 去掉单独的 `rootsToggle` 按钮，点主按钮"项目根"直接弹快捷根菜单，菜单最下面留一行"浏览其他路径…"打开旧的任意路径浏览
  - `app/main.py` — 新增 `GROK_CHAT_ROOT_<n>_HINT`（默认根用 `GROK_CHAT_CWD_HINT`）环境变量，纯展示用的人话提示（比如"宿主 /mnt/cache/workspaces"），显示在菜单每一项下面
  - `docker-compose.override.yml`（本地）——给三个根都配了 hint
- **不要还原**：`cwdBtn` 现在身兼两职（点击弹快捷菜单，菜单里"浏览其他路径"才走旧的 `openPicker`）——这是故意合并成一个入口，不是漏删代码。

## 2026-07-11 — claudecode → user (加"笔记仓库"第二个根)

- **状态：** 成功。用户明确了想要的就两个：项目库（`workspaces`，已有）+ 笔记仓库。加了第二个根 `notes` → `/mnt/cache/SOCIAL_CALCULUS`（Obsidian 库），容器内挂载点 `/roots/notes`。`/api/project-roots` 现在返回 3 项：默认根、`workspaces`、`notes`。已用 `/api/fs/list?path=/roots/notes` 验证真能看到库内容（`00_Inbox`、`02_PersonalOS` 等）。
- **改了：** `docker-compose.override.yml`（本地，不进 git）加了 `GROK_CHAT_ROOT_2_NAME=notes` / `GROK_CHAT_ROOT_2_PATH=/roots/notes` + 对应 volume。

## 2026-07-11 — claudecode → user (多项目根切换器 + 固定 IP)

- **状态：** 成功。回答了"workspace 到底是哪" 的疑问——不是没映射，是当初（上一条 HANDOFF）故意只挂了 `grok-chat-web` 自己的项目目录（`GROK_CHAT_PROJECTS_DIR`），没给全量 `workspaces`，为了不在没问过你的情况下就把 `_secrets` 之类的东西一起暴露给一个刚上线、还没验证过的部署。现在按你的要求做了"可以选多个项目根"。
- **改了：**
  - `app/main.py` — 新增 `GROK_CHAT_ROOT_<n>_NAME`/`_PATH` 环境变量对（`n=1,2,3...`），`/api/project-roots` 列出所有配置的根（含默认的 `GROK_CHAT_CWD`）
  - `static/index.html`/`app.js`/`style.css` — 项目根按钮旁加了个下拉切换器（参考 Cursor 的多根工作区切换），点一下就切（复用现成的 `set_cwd` 流程，没加新的访问控制面——之前 `@` 路径搜索本来就能任意路径，这个只是加个快捷入口）
  - `docker-compose.override.yml`（本地，不进 git）——加了 `GROK_CHAT_ROOT_1_NAME=workspaces` + 挂载 `/mnt/cache/workspaces:/roots/workspaces`，跟 Cursor/ClaudeCode/GrokBuild LXC 那几个工人容器的挂载范围对齐（含 `_secrets`，这是既有约定，不是新洞）
  - 同时把 `grok-chat-web` 在 `darknet` 上的 IP 固定为 `172.20.0.4`（原来是 DHCP 分配，重启可能变）
- **请你：** 如果还想加别的根（比如 `persistent-dev`），在 `docker-compose.override.yml` 里照 `docker-compose.override.yml.example` 的样子加 `GROK_CHAT_ROOT_2_NAME`/`_PATH` + 对应 volume 就行，不用改代码。
- **不要还原**：`GROK_CHAT_ROOT_1_PATH` 指向 `/roots/workspaces` 不是笔误，是刻意用固定容器内路径（不是 `/workspace`）避免跟默认根冲突。

## 2026-07-11 — claudecode → user (迁移到宿主 Docker 部署，旧 LXC 部署退役)

- **状态：** 成功。这个项目的实际部署方式变了——不再是"systemd unit 跑在 GrokBuild LXC 容器里"，而是"Docker 容器跑在 Unraid 宿主上，挂载宿主已持久化的 grok CLI"。旧的 GrokBuild LXC（`.126`）已经整个退役重建成纯浏览器手脚容器（不再跑 grok agent），新 IP `.140`，旧 rootfs 归档在 `/mnt/cache/lxc/_retired-GrokBuild-20260711`。
- **改了：**
  - 新增 `Dockerfile` / `docker-compose.yml` / `.dockerignore` / `.env.example`：容器挂载宿主 `grok-home`（`GROK_HOME`/`GROK_BIN` 指过去），不打包 grok 专有二进制
  - `docker-compose.yml` 默认只绑 `127.0.0.1`（`BIND_ADDR`），不像旧部署默认 `0.0.0.0`——要暴露到局域网需自己设 `GROK_CHAT_TOKEN` 并加宽 `BIND_ADDR`
  - `data/conversations/*.json`（真实聊天记录）之前被 git 误跟踪，已 `git rm --cached` + 补 `.gitignore`
  - `README.md` 改成 Docker-first，去掉了内网 IP / 容器名等家庭实验室特定信息（要推公开仓库）
  - 旧的 `deploy/grok-chat-web.service`（真实部署用，路径写死 `/mnt/workspaces`）保留在本地但**不进公开仓库**；新增泛化版 `deploy/grok-chat-web.example.service` 给外部用户参考
  - 旧 LXC 里的 `grok-chat-web.service` 已 `systemctl stop` + `disable`
- **为什么：** 用户要求把这个项目整理成可 docker 部署、可推公开 GitHub 仓库；同时把 grok CLI 从"只能在专属 LXC 里跑"升级成"宿主级安装，跟 Claude Code / Cursor 平级"，GrokBuild LXC 相应地从"跑 grok 的工人"变成"纯浏览器手脚"，跟 ClaudeCode/Cursor LXC 同构。
- **请你：**
  - 宿主上通过 `docker ps --filter name=grok-chat-web` 管理，不再用 `systemctl ... grok-chat-web`（旧 unit 还在但已停用）
  - 公开仓库还没实际 `push`——按用户自己的规矩，公开前他要亲自看一遍会公开的内容，目前只准备到本地 `public-release` 分支（干净的单一 commit，不含 `HANDOFF.md` / 真实 systemd unit / 聊天记录），没有创建远端仓库
- **不要还原**：旧 `deploy/grok-chat-web.service` 里的路径——那是真实部署存档，不是笔误。

## 2026-07-11 — claudecode → user (token auth，跟进上一条「未解决」)

- **状态：** 成功。已重启 `grok-chat-web`，curl 验证：无 token → `401`；`Authorization: Bearer` 或 `?token=` 带对 token → `200`；WS 握手不带 token → `403 Forbidden`（Starlette 在 `ws.close()` 于 `accept()` 之前时的标准行为）、带对 token → `101 Switching Protocols`。`/` 和 `/static/*` 保持不鉴权（只是壳，没有密钥）。
- **改了：**
  - `app/main.py` — 新增 `GROK_CHAT_TOKEN` 环境变量 + `require_token` 依赖；挂到所有 `/api/*` 路由；`/ws` 在 `accept()` 前手动比对 `ws.query_params["token"]`
  - `static/app.js` — 新增 `apiFetch()`（自动带 `Authorization` header，收到 401 就 `prompt()` 弹窗要 token 存 `localStorage.gcw_token`，重试一次）；所有原来裸 `fetch()` 换成 `apiFetch()`；`connect()` 里 WS URL 拼 `?token=`；`ws.onclose` 里 `code===4401` 也触发弹窗
  - `static/index.html` — `app.js?v=6` → `v=7`（改了要硬刷新才生效）
  - `_secrets/agent.env` / `agent.env.example` — 加 `GROK_CHAT_TOKEN`（真实值只在 agent.env + 容器 unit，没进 git）
  - 容器 `/etc/systemd/system/grok-chat-web.service` — 加 `Environment=GROK_CHAT_TOKEN=<真实值>`；`deploy/grok-chat-web.service`（git 里的存档副本）用占位符 `__SET_FROM_SECRETS_AGENT_ENV__`，不提交真实值
- **为什么 / 思路：**
  - 上一条 HANDOFF 记录了这个洞但没动手，因为要不要牺牲"同网段免密访问"的便利性是用户的决定；问过之后用户选了"现在加 token"
  - 没做的替代方案：① 只留文档不改代码（用户没选）；② 用 iptables/防火墙隔离 OpenClaw 网段（用户没选，且更复杂、牵扯宿主网络配置，风险更高）
  - Token 走 query param 而非只走 header，是因为浏览器原生 `WebSocket` 构造函数不能设自定义 header，`/ws` 握手只能靠 URL 带；HTTP 端两种都支持，`Authorization` 优先
  - 没有把 token 存进 git（哪怕是 `deploy/` 里的存档副本）——那是纯粹给"容器 rootfs 没了怎么重建"用的文档，真值只活在 `agent.env`（唯一权威源）和运行中的 unit 里，符合 `agent-secrets.mdc`
- **请你：**
  - 如果你（人类）要从浏览器访问 http://192.168.122.126:8787/，第一次会弹窗要粘贴 token —— 去 `_secrets/agent.env` 找 `GROK_CHAT_TOKEN` 那一行的值
  - 换 token 步骤见 `README.md` 鉴权那节
- **不要还原**：`require_token` / `apiFetch` / WS 的 `?token=` —— 这是刚补的鉴权，不是误加的复杂度。

---

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
