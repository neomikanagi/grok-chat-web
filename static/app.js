/* Grok Chat Web v6 — collapsible rails + per-message work panel */
(() => {
  const $ = (id) => document.getElementById(id);

  const appEl = $("app");
  const messagesEl = $("messages");
  const inputEl = $("input");
  const sendBtn = $("sendBtn");
  const cancelBtn = $("cancelBtn");
  const statusText = $("statusText");
  const dot = $("dot");
  const cwdBtn = $("cwdBtn");
  const rootsMenu = $("rootsMenu");
  const newChatBtn = $("newChatBtn");
  const chatListEl = $("chatList");
  const toggleChatRail = $("toggleChatRail");
  const chatRailClose = $("chatRailClose");
  const chatRail = $("chatRail");
  const toggleSidebar = $("toggleSidebar");
  const sidebar = $("sidebar");
  const sidebarClose = $("sidebarClose");
  const sidePath = $("sidePath");
  const sideList = $("sideList");
  const sideUp = $("sideUp");
  const sideRefresh = $("sideRefresh");
  const sideToProject = $("sideToProject");
  const attachBar = $("attachBar");
  const attachName = $("attachName");
  const attachPath = $("attachPath");
  const attachBtn = $("attachBtn");
  const acEl = $("ac");
  const picker = $("picker");
  const pickerPath = $("pickerPath");
  const pickerList = $("pickerList");

  let ws = null;
  let sessionId = null; // ACP session id
  let conversationId = null; // server store id
  let cwd = "";
  let browsePath = "";
  let browseParent = null;
  let homePath = "";
  let busy = false;
  let reconnectTimer = null;
  let sidebarOpen = localStorage.getItem("gcw_sidebar") !== "0";
  let chatRailOpen = localStorage.getItem("gcw_chat_rail") !== "0";
  let selected = null;

  /** @type {Array<{id,title,cwd,updatedAt,messageCount}>} */
  let convItems = [];

  /**
   * Active streaming turn. Each finished message keeps its own DOM + handlers;
   * we never share global thought text across toggles.
   * @type {null | {
   *   el: HTMLElement,
   *   body: HTMLElement,
   *   toggle: HTMLElement,
   *   panel: HTMLElement,
   *   thoughtBlock: HTMLElement,
   *   toolsBlock: HTMLElement,
   *   agentText: string,
   *   thoughtText: string,
   *   toolCount: number,
   * }}
   */
  let currentTurn = null;

  let acItems = [];
  let acIndex = 0;
  let acActive = false;
  let acQueryStart = -1;
  let acTimer = null;
  let pickerCwd = "";
  let pickerParent = null;
  let suppressUserEcho = false;

  function applyLayout() {
    appEl.classList.toggle("sidebar-collapsed", !sidebarOpen);
    appEl.classList.toggle("chat-rail-collapsed", !chatRailOpen);
    sidebar.classList.toggle("open", sidebarOpen);
    if (chatRail) chatRail.classList.toggle("open", chatRailOpen);
    localStorage.setItem("gcw_sidebar", sidebarOpen ? "1" : "0");
    localStorage.setItem("gcw_chat_rail", chatRailOpen ? "1" : "0");
  }
  applyLayout();

  function setStatus(text, mode) {
    statusText.textContent = text;
    dot.className = "dot" + (mode ? " " + mode : "");
  }
  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  // ── Access token (only matters if the server has GROK_CHAT_TOKEN set) ──
  function getStoredToken() {
    return localStorage.getItem("gcw_token") || "";
  }
  function promptForToken() {
    const t = window.prompt("需要访问令牌（服务器已开启 GROK_CHAT_TOKEN 校验），请粘贴：", "");
    if (t && t.trim()) localStorage.setItem("gcw_token", t.trim());
    return getStoredToken();
  }
  function authHeaders() {
    const t = getStoredToken();
    return t ? { Authorization: "Bearer " + t } : {};
  }
  async function apiFetch(url, opts = {}) {
    const merged = Object.assign({}, opts, {
      headers: Object.assign({}, opts.headers || {}, authHeaders()),
    });
    let res = await fetch(url, merged);
    if (res.status === 401) {
      promptForToken();
      res = await fetch(
        url,
        Object.assign({}, opts, {
          headers: Object.assign({}, opts.headers || {}, authHeaders()),
        })
      );
    }
    return res;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function shortPath(p) {
    if (!p) return "";
    if (p.length > 36) {
      const segs = p.split("/").filter(Boolean);
      return "…/" + segs.slice(-2).join("/");
    }
    return p;
  }
  function renderMarkdown(text) {
    const escaped = escapeHtml(text || "");
    let html = escaped.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code class="lang-${lang || "text"}">${code.replace(/\n$/, "")}</code></pre>`;
    });
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    const parts = html.split(/(<pre>[\s\S]*?<\/pre>)/g);
    return parts
      .map((part) => {
        if (part.startsWith("<pre>")) return part;
        return part
          .split(/\n{2,}/)
          .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
          .join("");
      })
      .join("");
  }

  // ── Server conversation list ──────────────────────────────────
  function renderChatList() {
    if (!convItems.length) {
      chatListEl.innerHTML = `<div class="chat-item" style="cursor:default;opacity:.7">
        <div class="title">本机暂无对话</div>
        <div class="meta">点「新对话」开始（存于服务器磁盘）</div>
      </div>`;
      return;
    }
    chatListEl.innerHTML = convItems
      .map((it) => {
        const active = it.id === conversationId ? "active" : "";
        const when = it.updatedAt
          ? new Date(it.updatedAt).toLocaleString(undefined, {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "";
        const n = it.messageCount != null ? `${it.messageCount} 条` : "";
        return `<div class="chat-item ${active}" data-id="${escapeHtml(it.id)}">
          <div class="title" title="${escapeHtml(it.title || "")}">${escapeHtml(it.title || "未命名")}</div>
          <div class="meta">${escapeHtml(when)}${n ? " · " + n : ""} · ${escapeHtml(shortPath(it.cwd || ""))}</div>
          <div class="ops">
            <button type="button" class="ghost-btn small" data-act="enter">进入</button>
            <button type="button" class="ghost-btn small danger" data-act="del">删除</button>
          </div>
        </div>`;
      })
      .join("");

    chatListEl.querySelectorAll(".chat-item[data-id]").forEach((el) => {
      const id = el.dataset.id;
      el.querySelector('[data-act="enter"]').addEventListener("click", (e) => {
        e.stopPropagation();
        openConversation(id);
      });
      el.querySelector('[data-act="del"]').addEventListener("click", (e) => {
        e.stopPropagation();
        deleteConversation(id);
      });
      el.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        openConversation(id);
      });
    });
  }

  function openConversation(id) {
    if (!id || busy) {
      if (busy) addSystem("请先停止当前任务再切换对话。");
      return;
    }
    if (id === conversationId) return;
    wsSend({ type: "open_conversation", conversationId: id });
  }

  function deleteConversation(id) {
    const item = convItems.find((x) => x.id === id);
    if (!item) return;
    if (!confirm(`删除本机对话「${item.title || "未命名"}」？\n记录在服务器上删除，不可恢复。`)) return;
    wsSend({ type: "delete_conversation", conversationId: id });
  }

  function startNewChat() {
    if (busy) {
      addSystem("请先停止当前任务。");
      return;
    }
    wsSend({ type: "new_session", cwd: cwd || homePath || undefined });
  }

  function addSystem(text) {
    const el = document.createElement("div");
    el.className = "msg system";
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollBottom();
  }

  function addUser(text) {
    const el = document.createElement("div");
    el.className = "msg user";
    el.innerHTML = `
      <div class="role">
        <span>你</span>
        <button class="copy-btn" type="button" data-copy>复制</button>
      </div>
      <div class="body"></div>`;
    el.querySelector(".body").textContent = text;
    wireCopy(el, text);
    messagesEl.appendChild(el);
    scrollBottom();
  }

  function agentShellHtml() {
    return `
      <div class="role">
        <span>Grok</span>
        <button class="copy-btn" type="button" data-copy>复制</button>
      </div>
      <button type="button" class="work-toggle" aria-expanded="false">
        <span class="chev">▶</span>
        <span class="work-label">工作过程</span>
      </button>
      <div class="work-panel">
        <div class="thought-block"></div>
        <div class="tools-block"></div>
      </div>
      <div class="body markdown"></div>`;
  }

  /**
   * Wire THIS message's work toggle to THIS panel only (closure over local nodes).
   * Critical: never read global currentTurn inside the click handler for history msgs.
   */
  function wireWorkToggle(toggle, panel, getSummary) {
    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = panel.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.querySelector(".chev").textContent = open ? "▼" : "▶";
      const base = typeof getSummary === "function" ? getSummary() : "工作过程";
      toggle.querySelector(".work-label").textContent = open
        ? `收起 · ${base}`
        : base;
    });
  }

  function workSummary(thoughtText, toolCount) {
    const parts = [];
    if (thoughtText && thoughtText.trim()) parts.push("思考");
    if (toolCount > 0) parts.push(`${toolCount} 个工具`);
    if (!parts.length) return "工作过程";
    return parts.join(" · ");
  }

  function refreshTurnChrome(turn) {
    if (!turn) return;
    const has =
      (turn.thoughtText && turn.thoughtText.trim()) || turn.toolCount > 0;
    turn.toggle.classList.toggle("visible", !!has);
    const summary = workSummary(turn.thoughtText, turn.toolCount);
    const open = turn.panel.classList.contains("open");
    turn.toggle.querySelector(".work-label").textContent = open
      ? `收起 · ${summary}`
      : summary;
    // keep panel closed by default while streaming
    turn.thoughtBlock.textContent = turn.thoughtText || "";
  }

  function addAssistantStatic(content, thought) {
    const el = document.createElement("div");
    el.className = "msg agent";
    el.innerHTML = agentShellHtml();
    const body = el.querySelector(".body");
    const toggle = el.querySelector(".work-toggle");
    const panel = el.querySelector(".work-panel");
    const thoughtBlock = el.querySelector(".thought-block");
    body.innerHTML = renderMarkdown(content || "");
    wireCopy(el, content || "");
    const t = thought || "";
    if (t.trim()) {
      thoughtBlock.textContent = t;
      toggle.classList.add("visible");
      const summary = workSummary(t, 0);
      toggle.querySelector(".work-label").textContent = summary;
      wireWorkToggle(toggle, panel, () => summary);
    }
    // panel stays closed (no .open)
    messagesEl.appendChild(el);
    scrollBottom();
  }

  function renderStoredMessages(messages) {
    clearChatUI();
    for (const m of messages || []) {
      if (m.role === "user") addUser(m.content || "");
      else if (m.role === "assistant") addAssistantStatic(m.content || "", m.thought || "");
      else if (m.role === "system") addSystem(m.content || "");
      // tool rows from store: skip standalone (live tools live inside work panel)
    }
  }

  function ensureAgentBubble() {
    if (currentTurn) return;
    const el = document.createElement("div");
    el.className = "msg agent";
    el.innerHTML = agentShellHtml();
    const body = el.querySelector(".body");
    const toggle = el.querySelector(".work-toggle");
    const panel = el.querySelector(".work-panel");
    const thoughtBlock = el.querySelector(".thought-block");
    const toolsBlock = el.querySelector(".tools-block");

    const turn = {
      el,
      body,
      toggle,
      panel,
      thoughtBlock,
      toolsBlock,
      agentText: "",
      thoughtText: "",
      toolCount: 0,
    };
    // Bind once with closures over THIS turn's nodes (not globals)
    wireWorkToggle(toggle, panel, () =>
      workSummary(turn.thoughtText, turn.toolCount)
    );
    wireCopy(el, () => turn.agentText);
    currentTurn = turn;
    messagesEl.appendChild(el);
  }

  function finishAgentBubble() {
    if (!currentTurn) return;
    // finalize chrome; leave panel collapsed
    currentTurn.panel.classList.remove("open");
    currentTurn.toggle.setAttribute("aria-expanded", "false");
    currentTurn.toggle.querySelector(".chev").textContent = "▶";
    refreshTurnChrome(currentTurn);
    currentTurn = null;
  }

  function wireCopy(el, getText) {
    const btn = el.querySelector("[data-copy]");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const text = typeof getText === "function" ? getText() : getText;
      try {
        await navigator.clipboard.writeText(text || "");
        btn.textContent = "已复制";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = "复制";
          btn.classList.remove("copied");
        }, 1500);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text || "";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        btn.textContent = "已复制";
      }
    });
  }

  /** Tools go inside current turn's work panel (hidden until expanded). */
  function upsertTurnTool(update) {
    ensureAgentBubble();
    const turn = currentTurn;
    const id = update.toolCallId || `t-${turn.toolCount}`;
    let row = turn.toolsBlock.querySelector(`[data-tool-id="${CSS.escape(id)}"]`);
    if (!row) {
      row = document.createElement("div");
      row.className = "work-tool";
      row.dataset.toolId = id;
      row.innerHTML = `<span class="kind"></span><span class="title"></span><span class="status"></span>`;
      turn.toolsBlock.appendChild(row);
      turn.toolCount += 1;
    }
    const kind = row.querySelector(".kind");
    const title = row.querySelector(".title");
    const status = row.querySelector(".status");
    if (update.kind) kind.textContent = update.kind;
    else if (!kind.textContent) kind.textContent = "tool";
    if (update.title) title.textContent = update.title;
    else if (!title.textContent) title.textContent = id;
    if (update.status) status.textContent = update.status;
    refreshTurnChrome(turn);
    scrollBottom();
  }

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v;
    cancelBtn.disabled = !v;
    newChatBtn.disabled = v;
    if (v) setStatus("working…", "busy");
    else if (ws && ws.readyState === WebSocket.OPEN) setStatus(statusLine(), "ok");
  }
  function statusLine() {
    return cwd ? shortPath(cwd) : "connected";
  }
  function updateCwdBtn() {
    cwdBtn.textContent = "项目根：" + (cwd ? shortPath(cwd) : "…");
    cwdBtn.title = cwd ? "项目根\n" + cwd : "设置项目根";
  }
  function clearChatUI() {
    finishAgentBubble();
    messagesEl.innerHTML = "";
    currentTurn = null;
  }

  // ── File cite ─────────────────────────────────────────────────
  function setSelected(entry) {
    selected = entry
      ? { path: entry.path, name: entry.name, is_dir: !!entry.is_dir }
      : null;
    updateAttachBar();
    sideList.querySelectorAll(".row").forEach((row) => {
      row.classList.toggle("selected", !!(selected && row.dataset.path === selected.path));
    });
  }
  function updateAttachBar() {
    if (!selected) {
      attachBar.classList.add("idle");
      attachBar.classList.remove("active");
      attachName.textContent = "未选择";
      attachPath.textContent = "点文件夹进入；点文件选中后点「引用」";
      attachBtn.disabled = true;
      return;
    }
    attachBar.classList.remove("idle");
    attachBar.classList.add("active");
    attachName.textContent = `${selected.is_dir ? "文件夹" : "文件"} · ${selected.name}`;
    attachPath.textContent = selected.path;
    attachBtn.disabled = false;
    attachBtn.textContent = selected.is_dir ? "引用此文件夹" : "引用";
  }
  function citeSelected() {
    if (!selected) return;
    const path = selected.path + (selected.is_dir ? "/" : "");
    insertPath(path);
    const prev = attachBtn.textContent;
    attachBtn.textContent = "已引用 ✓";
    setTimeout(() => {
      attachBtn.textContent = prev;
    }, 1000);
    inputEl.focus();
  }
  function insertPath(path) {
    const start = inputEl.selectionStart ?? inputEl.value.length;
    const end = inputEl.selectionEnd ?? start;
    const val = inputEl.value;
    const before = val.slice(0, start);
    const after = val.slice(end);
    const needSpace = before.length && !/\s$/.test(before);
    const insert = (needSpace ? " " : "") + path;
    inputEl.value = before + insert + after;
    const caret = (before + insert).length;
    inputEl.focus();
    inputEl.setSelectionRange(caret, caret);
    inputEl.dispatchEvent(new Event("input"));
  }

  async function loadSideList(path) {
    const target = path || browsePath || cwd || homePath || "/";
    try {
      const res = await apiFetch(`/api/fs/list?path=${encodeURIComponent(target)}`);
      if (!res.ok) {
        addSystem("无法列出目录：" + (await res.text()));
        return;
      }
      const data = await res.json();
      browsePath = data.path;
      browseParent = data.parent;
      sidePath.textContent = data.path;
      renderSideList(data.entries || []);
    } catch (e) {
      addSystem("列目录失败：" + e);
    }
  }
  function renderSideList(entries) {
    const rows = [];
    for (const e of entries) {
      const icon = e.is_dir ? "📁" : "📄";
      const sel = selected && selected.path === e.path ? "selected" : "";
      rows.push(`
        <div class="row ${sel}" data-path="${escapeHtml(e.path)}"
             data-name="${escapeHtml(e.name)}" data-dir="${e.is_dir ? "1" : "0"}"
             title="${escapeHtml(e.path)}">
          <span class="icon">${icon}</span>
          <span class="name">${escapeHtml(e.name)}</span>
        </div>`);
    }
    sideList.innerHTML =
      rows.join("") || `<div class="row"><span class="name">（空目录）</span></div>`;
    sideList.querySelectorAll(".row[data-path]").forEach((row) => {
      row.addEventListener("click", () => {
        const entry = {
          path: row.dataset.path,
          name: row.dataset.name,
          is_dir: row.dataset.dir === "1",
        };
        if (entry.is_dir) {
          setSelected(entry);
          loadSideList(entry.path);
        } else setSelected(entry);
      });
    });
  }

  async function openPicker(startPath) {
    picker.classList.add("open");
    await loadPicker(startPath || cwd || homePath || "/");
  }
  function closePicker() {
    picker.classList.remove("open");
  }
  async function loadPicker(path) {
    const res = await apiFetch(`/api/fs/list?path=${encodeURIComponent(path)}`);
    if (!res.ok) return;
    const data = await res.json();
    pickerCwd = data.path;
    pickerParent = data.parent;
    pickerPath.textContent = data.path;
    const rows = [];
    if (data.parent) {
      rows.push(`<div class="row" data-up="1"><span>⬆️</span><span class="name">..</span></div>`);
    }
    for (const e of data.entries || []) {
      if (!e.is_dir) continue;
      rows.push(
        `<div class="row" data-path="${escapeHtml(e.path)}"><span>📁</span><span class="name">${escapeHtml(e.name)}</span></div>`
      );
    }
    pickerList.innerHTML = rows.join("") || `<div class="row"><span class="name">（无子目录）</span></div>`;
    pickerList.querySelectorAll(".row[data-path]").forEach((row) => {
      row.addEventListener("click", () => loadPicker(row.dataset.path));
    });
    const up = pickerList.querySelector("[data-up]");
    if (up) up.addEventListener("click", () => pickerParent && loadPicker(pickerParent));
  }
  function useProjectRoot() {
    if (!pickerCwd || busy) return;
    wsSend({ type: "set_cwd", cwd: pickerCwd });
    closePicker();
  }

  function closeRootsMenu() {
    rootsMenu.classList.remove("open");
  }

  async function loadRootsMenu() {
    rootsMenu.innerHTML = `<div class="empty">加载中…</div>`;
    rootsMenu.classList.add("open");
    const browseRow = `<div class="row browse-other" data-browse="1">
      <span class="name">浏览其他路径…</span>
    </div>`;
    try {
      const res = await apiFetch("/api/project-roots");
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const items = data.items || [];
      rootsMenu.innerHTML =
        items
          .map((it) => {
            const isActive = it.path === (data.active || cwd);
            const hint = it.hint ? `<span class="hint">${escapeHtml(it.hint)}</span>` : "";
            return `<div class="row${isActive ? " active" : ""}" data-path="${escapeHtml(it.path)}">
              <span class="name">${escapeHtml(it.name)}</span>
              ${hint}
              <span class="path">${escapeHtml(it.path)}</span>
            </div>`;
          })
          .join("") + browseRow;
      rootsMenu.querySelectorAll(".row[data-path]").forEach((row) => {
        row.addEventListener("click", () => {
          const path = row.dataset.path;
          if (path && path !== cwd && !busy) wsSend({ type: "set_cwd", cwd: path });
          closeRootsMenu();
        });
      });
      rootsMenu.querySelector(".browse-other").addEventListener("click", () => {
        closeRootsMenu();
        openPicker(cwd);
      });
    } catch {
      rootsMenu.innerHTML = `<div class="empty">加载项目根列表失败</div>` + browseRow;
      rootsMenu.querySelector(".browse-other").addEventListener("click", () => {
        closeRootsMenu();
        openPicker(cwd);
      });
    }
  }

  // ── WebSocket ─────────────────────────────────────────────────
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const t = getStoredToken();
    const qs = t ? `?token=${encodeURIComponent(t)}` : "";
    ws = new WebSocket(`${proto}://${location.host}/ws${qs}`);
    setStatus("connecting…", "");
    ws.onopen = () => setStatus("connected", "ok");
    ws.onclose = (ev) => {
      // 4401 = server-side token check failed (see require_token in main.py)
      if (ev.code === 4401) promptForToken();
      setStatus("disconnected — reconnecting…", "err");
      setBusy(false);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1200);
    };
    ws.onerror = () => setStatus("socket error", "err");
    ws.onmessage = (ev) => {
      try {
        handleEvent(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    };
  }

  function handleEvent(msg) {
    switch (msg.type) {
      case "hello": {
        sessionId = msg.sessionId;
        conversationId = msg.conversationId || msg.activeId || null;
        cwd = msg.cwd || "";
        convItems = msg.conversations || [];
        updateCwdBtn();
        renderChatList();
        const auth = msg.auth || {};
        const init = msg.init || {};
        const who = auth.email || "not signed in";
        const model = init.currentModelId || "";
        setStatus(`${who}${model ? " · " + model : ""}`, auth.ok === false ? "err" : "ok");
        loadSideList(cwd || homePath || "/");
        // Load active conversation transcript from server
        if (conversationId) {
          apiFetch(`/api/conversations/${encodeURIComponent(conversationId)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (data && data.messages && data.messages.length) {
                renderStoredMessages(data.messages);
              }
            })
            .catch(() => {});
        }
        break;
      }
      case "conversations":
        convItems = msg.items || [];
        if (msg.activeId) conversationId = msg.activeId;
        renderChatList();
        break;
      case "conversation_open": {
        const c = msg.conversation || {};
        conversationId = c.id;
        cwd = c.cwd || cwd;
        if (c.acpSessionId) sessionId = c.acpSessionId;
        updateCwdBtn();
        // Don't double-add streaming later; history is the source
        renderStoredMessages(c.messages || []);
        renderChatList();
        if (cwd) loadSideList(cwd);
        break;
      }
      case "session":
        sessionId = msg.sessionId;
        if (msg.conversationId) conversationId = msg.conversationId;
        cwd = msg.cwd || cwd;
        updateCwdBtn();
        if (msg.fresh) {
          clearChatUI();
          addSystem("新对话已创建（保存在本机服务器）");
        }
        if (msg.acpReset) {
          addSystem(msg.message || "Agent 会话已重建；历史来自本机记录");
        }
        setStatus(statusLine(), "ok");
        break;
      case "session_load_start":
        // conversation_open will fill messages
        break;
      case "session_load_end":
        finishAgentBubble();
        break;
      case "user":
        // server echo — UI already added on send, skip unless from another client
        if (!suppressUserEcho) {
          // only add if last message isn't the same user text
          const last = messagesEl.lastElementChild;
          const lastText = last && last.classList.contains("user")
            ? last.querySelector(".body")?.textContent
            : null;
          if (lastText !== msg.text) addUser(msg.text);
        }
        suppressUserEcho = false;
        break;
      case "session_update":
        handleSessionUpdate(msg.update || {});
        break;
      case "turn_start":
        setBusy(true);
        finishAgentBubble();
        break;
      case "turn_end":
        setBusy(false);
        finishAgentBubble();
        break;
      case "error":
        addSystem("错误：" + (msg.message || "unknown"));
        setBusy(false);
        break;
      case "permission":
        showPermission(msg);
        break;
      case "agent_exit":
        addSystem("Grok agent 已退出，正在重连…");
        setBusy(false);
        break;
      default:
        break;
    }
  }

  function handleSessionUpdate(update) {
    const kind = update.sessionUpdate;
    // History already rendered from disk; only stream live when busy.
    if (
      !busy &&
      (kind === "user_message_chunk" ||
        kind === "agent_message_chunk" ||
        kind === "agent_thought_chunk" ||
        kind === "tool_call" ||
        kind === "tool_call_update")
    ) {
      return;
    }
    if (kind === "agent_message_chunk") {
      ensureAgentBubble();
      currentTurn.agentText += (update.content && update.content.text) || "";
      currentTurn.body.innerHTML = renderMarkdown(currentTurn.agentText);
      scrollBottom();
    } else if (kind === "agent_thought_chunk") {
      ensureAgentBubble();
      currentTurn.thoughtText += (update.content && update.content.text) || "";
      refreshTurnChrome(currentTurn);
      scrollBottom();
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      upsertTurnTool(update);
    }
  }

  function showPermission(msg) {
    const el = document.createElement("div");
    el.className = "msg perm-card";
    const tool = msg.toolCall || {};
    const title = tool.title || tool.toolCallId || "tool permission";
    const options = msg.options || [];
    el.innerHTML = `<div class="role">需要批准</div><div>${escapeHtml(title)}</div><div class="actions"></div>`;
    const actions = el.querySelector(".actions");
    (options.length ? options : [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]).forEach(
      (opt) => {
        const b = document.createElement("button");
        b.className = (opt.kind || "").includes("allow") ? "primary-btn" : "ghost-btn";
        b.type = "button";
        b.textContent = opt.name || opt.optionId;
        b.onclick = () => {
          wsSend({ type: "permission_reply", id: msg.id, optionId: opt.optionId });
          el.remove();
        };
        actions.appendChild(b);
      }
    );
    messagesEl.appendChild(el);
    scrollBottom();
  }

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function send() {
    const text = inputEl.value;
    if (!text.trim() || busy) return;
    suppressUserEcho = true;
    addUser(text);
    wsSend({ type: "prompt", text, sessionId });
    inputEl.value = "";
    inputEl.style.height = "";
    closeAc();
  }

  sendBtn.addEventListener("click", send);
  cancelBtn.addEventListener("click", () => wsSend({ type: "cancel", sessionId }));
  newChatBtn.addEventListener("click", startNewChat);
  attachBtn.addEventListener("click", citeSelected);
  toggleSidebar.addEventListener("click", () => {
    sidebarOpen = !sidebarOpen;
    applyLayout();
  });
  toggleChatRail.addEventListener("click", () => {
    chatRailOpen = !chatRailOpen;
    applyLayout();
  });
  if (chatRailClose) {
    chatRailClose.addEventListener("click", () => {
      chatRailOpen = false;
      applyLayout();
    });
  }
  sidebarClose.addEventListener("click", () => {
    sidebarOpen = false;
    applyLayout();
  });
  sideUp.addEventListener("click", () => browseParent && loadSideList(browseParent));
  sideRefresh.addEventListener("click", () => loadSideList(browsePath));
  sideToProject.addEventListener("click", () => loadSideList(cwd || homePath || "/"));
  cwdBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (rootsMenu.classList.contains("open")) {
      closeRootsMenu();
    } else {
      loadRootsMenu();
    }
  });
  document.addEventListener("click", (e) => {
    if (!rootsMenu.contains(e.target) && e.target !== cwdBtn) closeRootsMenu();
  });
  $("pickerClose").addEventListener("click", closePicker);
  $("pickerUse").addEventListener("click", useProjectRoot);
  $("pickerUp").addEventListener("click", () => pickerParent && loadPicker(pickerParent));
  picker.addEventListener("click", (e) => {
    if (e.target === picker) closePicker();
  });

  inputEl.addEventListener("keydown", (e) => {
    if (acActive) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        acIndex = Math.min(acIndex + 1, acItems.length - 1);
        renderAc();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        acIndex = Math.max(acIndex - 1, 0);
        renderAc();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickAc(acIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeAc();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 280) + "px";
    maybeOpenAc();
  });

  function maybeOpenAc() {
    const pos = inputEl.selectionStart;
    const before = inputEl.value.slice(0, pos);
    const m = before.match(/(?:^|[\s\n])@([^\s@]*)$/);
    if (!m) {
      closeAc();
      return;
    }
    acQueryStart = before.lastIndexOf("@");
    clearTimeout(acTimer);
    acTimer = setTimeout(() => fetchAc(m[1] || ""), 120);
  }
  async function fetchAc(q) {
    try {
      const url = q
        ? `/api/fs/search?q=${encodeURIComponent(q)}&root=${encodeURIComponent(cwd || browsePath || "")}`
        : `/api/fs/list?path=${encodeURIComponent(cwd || browsePath || "")}`;
      const res = await apiFetch(url);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      acItems = (data.entries || []).slice(0, 30);
      acIndex = 0;
      acActive = acItems.length > 0;
      renderAc();
    } catch {
      closeAc();
    }
  }
  function renderAc() {
    if (!acActive || !acItems.length) {
      acEl.classList.remove("open");
      return;
    }
    acEl.innerHTML = acItems
      .map((it, i) => {
        const icon = it.is_dir ? "📁" : "📄";
        const path = it.rel || it.path;
        return `<div class="item ${i === acIndex ? "active" : ""}" data-i="${i}">
          <span class="icon">${icon}</span>
          <span class="name">${escapeHtml(it.name)}</span>
          <span class="path">${escapeHtml(path)}</span>
        </div>`;
      })
      .join("");
    acEl.classList.add("open");
    acEl.querySelectorAll(".item").forEach((node) => {
      node.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pickAc(Number(node.dataset.i));
      });
    });
  }
  function pickAc(i) {
    const it = acItems[i];
    if (!it) return;
    const pos = inputEl.selectionStart;
    const val = inputEl.value;
    const before = val.slice(0, acQueryStart);
    const after = val.slice(pos);
    const insert = it.path + (it.is_dir ? "/" : "");
    inputEl.value = before + insert + after;
    const caret = (before + insert).length;
    inputEl.setSelectionRange(caret, caret);
    inputEl.focus();
    closeAc();
  }
  function closeAc() {
    acActive = false;
    acItems = [];
    acEl.classList.remove("open");
    acEl.innerHTML = "";
  }

  updateAttachBar();
  // Update foot text in HTML via first system line
  apiFetch("/api/defaults")
    .then((r) => r.json())
    .then((d) => {
      homePath = d.home || "";
    })
    .catch(() => {})
    .finally(() => {
      addSystem("对话存在本机服务器磁盘（非浏览器缓存）。左侧列表换浏览器也能看到。");
      connect();
    });
})();
