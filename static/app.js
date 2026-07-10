/* Grok Chat Web v4 — Enter send, collapsed thinking, local chats only */
(() => {
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = "gcw_local_chats_v1";

  const appEl = $("app");
  const messagesEl = $("messages");
  const inputEl = $("input");
  const sendBtn = $("sendBtn");
  const cancelBtn = $("cancelBtn");
  const statusText = $("statusText");
  const dot = $("dot");
  const cwdBtn = $("cwdBtn");
  const newChatBtn = $("newChatBtn");
  const chatListEl = $("chatList");
  const toggleChatRail = $("toggleChatRail");
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
  let sessionId = null;
  let cwd = "";
  let browsePath = "";
  let browseParent = null;
  let homePath = "";
  let busy = false;
  let reconnectTimer = null;
  let sidebarOpen = localStorage.getItem("gcw_sidebar") !== "0";
  let chatRailOpen = localStorage.getItem("gcw_chat_rail") !== "0";
  let replaying = false; // session/load history
  let selected = null;

  // Streaming agent bubble
  let currentAgentEl = null;
  let currentAgentBody = null;
  let currentThoughtEl = null;
  let currentThinkToggle = null;
  let agentBuf = "";
  let thoughtBuf = "";

  let acItems = [];
  let acIndex = 0;
  let acActive = false;
  let acQueryStart = -1;
  let acTimer = null;
  let pickerCwd = "";
  let pickerParent = null;

  // ── Local conversation store (browser only; never list cloud) ──
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return { items: [], activeId: null };
      const data = JSON.parse(raw);
      return {
        items: Array.isArray(data.items) ? data.items : [],
        activeId: data.activeId || null,
      };
    } catch {
      return { items: [], activeId: null };
    }
  }

  function saveStore(store) {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ items: store.items, activeId: store.activeId })
    );
  }

  let store = loadStore();

  function upsertLocalChat({ id, title, cwd: c, touch }) {
    if (!id) return;
    const now = Date.now();
    let item = store.items.find((x) => x.id === id);
    if (!item) {
      item = {
        id,
        title: title || "新对话",
        cwd: c || cwd || "",
        createdAt: now,
        updatedAt: now,
      };
      store.items.unshift(item);
    } else {
      if (title) item.title = title;
      if (c) item.cwd = c;
      if (touch !== false) item.updatedAt = now;
    }
    store.activeId = id;
    // sort newest first
    store.items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    saveStore(store);
    renderChatList();
  }

  function removeLocalChat(id) {
    store.items = store.items.filter((x) => x.id !== id);
    if (store.activeId === id) store.activeId = null;
    saveStore(store);
    renderChatList();
  }

  function renderChatList() {
    if (!store.items.length) {
      chatListEl.innerHTML = `<div class="chat-item" style="cursor:default;opacity:.7">
        <div class="title">暂无本地对话</div>
        <div class="meta">点上方「新对话」开始</div>
      </div>`;
      return;
    }
    chatListEl.innerHTML = store.items
      .map((it) => {
        const active = it.id === store.activeId ? "active" : "";
        const when = it.updatedAt
          ? new Date(it.updatedAt).toLocaleString(undefined, {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "";
        return `<div class="chat-item ${active}" data-id="${escapeHtml(it.id)}">
          <div class="title" title="${escapeHtml(it.title || "")}">${escapeHtml(it.title || "未命名")}</div>
          <div class="meta">${escapeHtml(when)} · ${escapeHtml(shortPath(it.cwd || ""))}</div>
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
        enterChat(id);
      });
      el.querySelector('[data-act="del"]').addEventListener("click", (e) => {
        e.stopPropagation();
        deleteChat(id);
      });
      el.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        enterChat(id);
      });
    });
  }

  function enterChat(id) {
    const item = store.items.find((x) => x.id === id);
    if (!item) return;
    if (busy) {
      addSystem("请先停止当前任务再切换对话。");
      return;
    }
    if (item.id === sessionId && item.id === store.activeId) {
      // already active — still re-render highlight
      store.activeId = id;
      saveStore(store);
      renderChatList();
      return;
    }
    clearChatUI();
    store.activeId = id;
    saveStore(store);
    renderChatList();
    addSystem("正在进入本地对话…");
    wsSend({ type: "load_session", sessionId: id, cwd: item.cwd || cwd || homePath });
  }

  function deleteChat(id) {
    const item = store.items.find((x) => x.id === id);
    if (!item) return;
    if (!confirm(`删除本地对话「${item.title || "未命名"}」？\n仅从本机列表移除，不会列出或同步云端。`)) {
      return;
    }
    const wasActive = sessionId === id || store.activeId === id;
    removeLocalChat(id);
    if (wasActive) {
      // start a fresh local chat
      startNewChat();
    }
  }

  function startNewChat() {
    if (busy) {
      addSystem("请先停止当前任务。");
      return;
    }
    clearChatUI();
    addSystem("正在创建新对话…");
    wsSend({ type: "new_session", cwd: cwd || homePath || undefined });
  }

  // ── Layout toggles ────────────────────────────────────────────
  function applyLayout() {
    appEl.classList.toggle("sidebar-collapsed", !sidebarOpen);
    appEl.classList.toggle("chat-rail-collapsed", !chatRailOpen);
    sidebar.classList.toggle("open", sidebarOpen);
    localStorage.setItem("gcw_sidebar", sidebarOpen ? "1" : "0");
    localStorage.setItem("gcw_chat_rail", chatRailOpen ? "1" : "0");
  }
  applyLayout();
  renderChatList();

  function setStatus(text, mode) {
    statusText.textContent = text;
    dot.className = "dot" + (mode ? " " + mode : "");
  }
  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
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
    const escaped = escapeHtml(text);
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
    // title from first user message
    if (sessionId) {
      const item = store.items.find((x) => x.id === sessionId);
      if (!item || !item.title || item.title === "新对话") {
        const t = text.trim().replace(/\s+/g, " ").slice(0, 40);
        upsertLocalChat({ id: sessionId, title: t || "新对话", cwd, touch: true });
      } else {
        upsertLocalChat({ id: sessionId, cwd, touch: true });
      }
    }
  }

  function ensureAgentBubble() {
    if (currentAgentEl) return;
    currentAgentEl = document.createElement("div");
    currentAgentEl.className = "msg agent";
    currentAgentEl.innerHTML = `
      <div class="role">
        <span>Grok</span>
        <button class="copy-btn" type="button" data-copy>复制</button>
      </div>
      <button type="button" class="think-toggle" style="display:none">
        <span class="chev">▶</span>
        <span class="think-label">展开思考过程</span>
      </button>
      <div class="thought"></div>
      <div class="body markdown"></div>`;
    currentThinkToggle = currentAgentEl.querySelector(".think-toggle");
    currentThoughtEl = currentAgentEl.querySelector(".thought");
    currentAgentBody = currentAgentEl.querySelector(".body");
    agentBuf = "";
    thoughtBuf = "";
    wireCopy(currentAgentEl, () => agentBuf);

    currentThinkToggle.addEventListener("click", () => {
      const open = currentThoughtEl.classList.toggle("open");
      currentThinkToggle.querySelector(".chev").textContent = open ? "▼" : "▶";
      currentThinkToggle.querySelector(".think-label").textContent = open
        ? "收起思考过程"
        : "展开思考过程";
    });

    messagesEl.appendChild(currentAgentEl);
  }

  function finishAgentBubble() {
    // keep bubble as history; just detach streaming pointers
    if (currentThinkToggle && thoughtBuf.trim()) {
      currentThinkToggle.style.display = "inline-flex";
      // stay collapsed by default
      currentThoughtEl.classList.remove("open");
      currentThoughtEl.textContent = thoughtBuf;
      currentThinkToggle.querySelector(".chev").textContent = "▶";
      currentThinkToggle.querySelector(".think-label").textContent = "展开思考过程";
    } else if (currentThinkToggle) {
      currentThinkToggle.style.display = "none";
    }
    currentAgentEl = null;
    currentAgentBody = null;
    currentThoughtEl = null;
    currentThinkToggle = null;
    agentBuf = "";
    thoughtBuf = "";
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

  function addTool(update) {
    const el = document.createElement("div");
    el.className = "msg tool";
    el.innerHTML = `
      <div class="tool-line">
        <span class="kind">${escapeHtml(update.kind || "tool")}</span>
        <span class="title">${escapeHtml(update.title || update.toolCallId || "tool")}</span>
        <span class="status">${escapeHtml(update.status || "")}</span>
      </div>`;
    el.dataset.toolId = update.toolCallId || "";
    messagesEl.appendChild(el);
    scrollBottom();
    return el;
  }

  function updateTool(update) {
    if (!update.toolCallId) {
      addTool(update);
      return;
    }
    let el = messagesEl.querySelector(`.msg.tool[data-tool-id="${CSS.escape(update.toolCallId)}"]`);
    if (!el) el = addTool(update);
    const status = el.querySelector(".status");
    if (update.status && status) status.textContent = update.status;
    if (update.title) {
      const t = el.querySelector(".title");
      if (t) t.textContent = update.title;
    }
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
    agentBuf = "";
    thoughtBuf = "";
  }

  // ── Selection / 引用 ──────────────────────────────────────────
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
      const res = await fetch(`/api/fs/list?path=${encodeURIComponent(target)}`);
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
        } else {
          setSelected(entry);
        }
      });
    });
  }

  // Project root modal
  async function openPicker(startPath) {
    picker.classList.add("open");
    await loadPicker(startPath || cwd || homePath || "/");
  }
  function closePicker() {
    picker.classList.remove("open");
  }
  async function loadPicker(path) {
    const res = await fetch(`/api/fs/list?path=${encodeURIComponent(path)}`);
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

  function useProjectRoot(path) {
    const p = path || pickerCwd;
    if (!p || busy) return;
    clearChatUI();
    wsSend({ type: "set_cwd", cwd: p }); // creates new session
    closePicker();
  }

  // ── WebSocket ─────────────────────────────────────────────────
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    setStatus("connecting…", "");
    ws.onopen = () => setStatus("connected", "ok");
    ws.onclose = () => {
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
        cwd = msg.cwd || "";
        updateCwdBtn();
        const auth = msg.auth || {};
        const init = msg.init || {};
        const who = auth.email || "not signed in";
        const model = init.currentModelId || "";
        setStatus(`${who}${model ? " · " + model : ""}`, auth.ok === false ? "err" : "ok");
        loadSideList(cwd || homePath || "/");

        // If we have local chats, prefer restoring active; else register current session as local
        if (store.activeId && store.items.some((x) => x.id === store.activeId)) {
          // Don't auto-load on every reconnect if already same id
          if (store.activeId !== sessionId) {
            enterChat(store.activeId);
          } else {
            upsertLocalChat({ id: sessionId, cwd, touch: false });
          }
        } else if (sessionId) {
          upsertLocalChat({ id: sessionId, title: "新对话", cwd, touch: false });
        }
        renderChatList();
        break;
      }
      case "session":
        sessionId = msg.sessionId;
        cwd = msg.cwd || cwd;
        updateCwdBtn();
        if (msg.fresh) {
          upsertLocalChat({
            id: sessionId,
            title: "新对话",
            cwd,
            touch: true,
          });
          // if replacedFrom, drop dead id
          if (msg.replacedFrom) {
            removeLocalChat(msg.replacedFrom);
            upsertLocalChat({ id: sessionId, title: "新对话", cwd, touch: true });
          }
        } else if (msg.loaded) {
          upsertLocalChat({ id: sessionId, cwd, touch: true });
        } else {
          upsertLocalChat({ id: sessionId, cwd, touch: false });
        }
        setStatus(statusLine(), "ok");
        break;
      case "session_load_start":
        replaying = true;
        clearChatUI();
        addSystem("正在加载本地对话历史…");
        break;
      case "session_load_end":
        replaying = false;
        finishAgentBubble();
        addSystem("已进入该对话。");
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
        if (sessionId) upsertLocalChat({ id: sessionId, cwd, touch: true });
        break;
      case "error":
        addSystem("错误：" + (msg.message || "unknown"));
        setBusy(false);
        replaying = false;
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
    if (kind === "user_message_chunk") {
      // history replay
      const t = (update.content && update.content.text) || "";
      if (t) {
        // coalesce consecutive user chunks into one bubble when replaying is hard;
        // simple approach: each chunk as append to last user or new
        const last = messagesEl.lastElementChild;
        if (last && last.classList.contains("user") && replaying) {
          const body = last.querySelector(".body");
          body.textContent = (body.textContent || "") + t;
        } else {
          addUser(t);
        }
      }
    } else if (kind === "agent_message_chunk") {
      ensureAgentBubble();
      const t = (update.content && update.content.text) || "";
      agentBuf += t;
      currentAgentBody.innerHTML = renderMarkdown(agentBuf);
      scrollBottom();
    } else if (kind === "agent_thought_chunk") {
      ensureAgentBubble();
      const t = (update.content && update.content.text) || "";
      thoughtBuf += t;
      // while streaming: keep collapsed, but show toggle once we have content
      if (currentThinkToggle && thoughtBuf.trim()) {
        currentThinkToggle.style.display = "inline-flex";
        // only update hidden thought buffer text; don't open
        if (currentThoughtEl) currentThoughtEl.textContent = thoughtBuf;
      }
      scrollBottom();
    } else if (kind === "tool_call") {
      finishAgentBubble();
      addTool(update);
    } else if (kind === "tool_call_update") {
      updateTool(update);
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
    addUser(text);
    wsSend({ type: "prompt", text, sessionId });
    inputEl.value = "";
    inputEl.style.height = "";
    closeAc();
  }

  // ── Events ────────────────────────────────────────────────────
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
  sidebarClose.addEventListener("click", () => {
    sidebarOpen = false;
    applyLayout();
  });
  sideUp.addEventListener("click", () => browseParent && loadSideList(browseParent));
  sideRefresh.addEventListener("click", () => loadSideList(browsePath));
  sideToProject.addEventListener("click", () => loadSideList(cwd || homePath || "/"));

  cwdBtn.addEventListener("click", () => openPicker(cwd));
  $("pickerClose").addEventListener("click", closePicker);
  $("pickerUse").addEventListener("click", () => useProjectRoot());
  $("pickerUp").addEventListener("click", () => pickerParent && loadPicker(pickerParent));
  picker.addEventListener("click", (e) => {
    if (e.target === picker) closePicker();
  });

  // Enter = send, Shift+Enter = newline
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
    // Shift+Enter: default textarea newline
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
      const res = await fetch(url);
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
  fetch("/api/defaults")
    .then((r) => r.json())
    .then((d) => {
      homePath = d.home || "";
    })
    .catch(() => {})
    .finally(() => {
      addSystem("Enter 发送 · Shift+Enter 换行 · 思考默认折叠 · 左侧仅本地对话（进入/删除）");
      connect();
    });
})();
