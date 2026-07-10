/* Grok Chat Web — frontend v2 */
(() => {
  const $ = (id) => document.getElementById(id);

  const appEl = $("app");
  const messagesEl = $("messages");
  const inputEl = $("input");
  const sendBtn = $("sendBtn");
  const cancelBtn = $("cancelBtn");
  const statusText = $("statusText");
  const dot = $("dot");
  const clearBtn = $("clearBtn");
  const toggleSidebar = $("toggleSidebar");
  const sidebar = $("sidebar");
  const sidebarClose = $("sidebarClose");
  const projectPathEl = $("projectPath");
  const setProjectBtn = $("setProjectBtn");
  const goHomeBtn = $("goHomeBtn");
  const sidePath = $("sidePath");
  const sideList = $("sideList");
  const sideUp = $("sideUp");
  const sideRefresh = $("sideRefresh");
  const acEl = $("ac");

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || navigator.userAgent.includes("Mac");
  $("modKey").textContent = isMac ? "⌘" : "Ctrl";

  let ws = null;
  let sessionId = null;
  let cwd = ""; // project root (agent session cwd)
  let browsePath = ""; // sidebar browse location
  let browseParent = null;
  let homePath = "";
  let busy = false;
  let reconnectTimer = null;
  let sidebarOpen = localStorage.getItem("gcw_sidebar") !== "0";

  // Streaming message assembly
  let currentAgentEl = null;
  let currentAgentBody = null;
  let currentThoughtEl = null;
  let agentBuf = "";
  let thoughtBuf = "";

  // @ autocomplete (kept as secondary)
  let acItems = [];
  let acIndex = 0;
  let acActive = false;
  let acQueryStart = -1;
  let acTimer = null;

  applySidebarState();

  function applySidebarState() {
    if (sidebarOpen) {
      appEl.classList.remove("sidebar-collapsed");
      sidebar.classList.add("open");
    } else {
      appEl.classList.add("sidebar-collapsed");
      sidebar.classList.remove("open");
    }
    localStorage.setItem("gcw_sidebar", sidebarOpen ? "1" : "0");
  }

  function setSidebar(open) {
    sidebarOpen = open;
    applySidebarState();
  }

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

  function renderMarkdown(text) {
    const escaped = escapeHtml(text);
    let html = escaped.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code class="lang-${lang || "text"}">${code.replace(/\n$/, "")}</code></pre>`;
    });
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    const parts = html.split(/(<pre>[\s\S]*?<\/pre>)/g);
    html = parts
      .map((part) => {
        if (part.startsWith("<pre>")) return part;
        return part
          .split(/\n{2,}/)
          .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
          .join("");
      })
      .join("");
    return html;
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

  function ensureAgentBubble() {
    if (currentAgentEl) return;
    currentAgentEl = document.createElement("div");
    currentAgentEl.className = "msg agent";
    currentAgentEl.innerHTML = `
      <div class="role">
        <span>Grok</span>
        <button class="copy-btn" type="button" data-copy>复制</button>
      </div>
      <div class="thought" style="display:none"></div>
      <div class="body markdown"></div>`;
    currentThoughtEl = currentAgentEl.querySelector(".thought");
    currentAgentBody = currentAgentEl.querySelector(".body");
    agentBuf = "";
    thoughtBuf = "";
    wireCopy(currentAgentEl, () => agentBuf);
    messagesEl.appendChild(currentAgentEl);
  }

  function finishAgentBubble() {
    if (currentAgentEl && currentThoughtEl && thoughtBuf) {
      currentThoughtEl.style.display = "block";
      currentThoughtEl.title = "点击展开/收起思考过程";
      currentThoughtEl.onclick = () => currentThoughtEl.classList.toggle("open");
    }
    currentAgentEl = null;
    currentAgentBody = null;
    currentThoughtEl = null;
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
    const title = update.title || update.toolCallId || "tool";
    const status = update.status || "";
    const kind = update.kind || "";
    el.innerHTML = `
      <div class="tool-line">
        <span class="kind">${escapeHtml(kind || "tool")}</span>
        <span class="title">${escapeHtml(title)}</span>
        <span class="status">${escapeHtml(status)}</span>
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
    clearBtn.disabled = v;
    if (v) setStatus("working…", "busy");
    else if (ws && ws.readyState === WebSocket.OPEN) setStatus(statusLine(), "ok");
  }

  function statusLine() {
    if (!cwd) return "connected";
    return shortPath(cwd);
  }

  function shortPath(p) {
    if (!p) return "";
    if (p.length > 40) {
      const segs = p.split("/").filter(Boolean);
      return "…/" + segs.slice(-2).join("/");
    }
    return p;
  }

  function updateProjectUI() {
    projectPathEl.textContent = cwd || "（未设置）";
    projectPathEl.title = cwd || "";
  }

  function clearChatUI() {
    finishAgentBubble();
    messagesEl.innerHTML = "";
    agentBuf = "";
    thoughtBuf = "";
  }

  /** 删除对话 = 清空界面 + 同项目根开新会话（上下文作废） */
  function clearConversation() {
    if (busy) {
      addSystem("请先停止当前任务，再删除对话。");
      return;
    }
    if (!confirm("删除当前对话？界面会清空，并在同一项目根下开新会话（模型记不住旧对话）。")) {
      return;
    }
    clearChatUI();
    if (cwd) {
      wsSend({ type: "set_cwd", cwd });
      addSystem("已删除对话，新会话已开始。项目根：" + cwd);
    } else {
      addSystem("已清空界面。请在右侧设置项目根。");
    }
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
      const isProject = e.is_dir && cwd && e.path === cwd;
      rows.push(`
        <div class="row ${isProject ? "is-project" : ""}"
             data-path="${escapeHtml(e.path)}"
             data-dir="${e.is_dir ? "1" : "0"}"
             title="${escapeHtml(e.path)}">
          <span class="icon">${icon}</span>
          <span class="name">${escapeHtml(e.name)}</span>
          ${isProject ? '<span class="badge">项目根</span>' : ""}
        </div>`);
    }
    sideList.innerHTML =
      rows.join("") || `<div class="row"><span class="name">（空目录）</span></div>`;

    sideList.querySelectorAll(".row[data-path]").forEach((row) => {
      row.addEventListener("click", () => {
        const p = row.dataset.path;
        const isDir = row.dataset.dir === "1";
        if (isDir) {
          loadSideList(p);
        } else {
          insertPath(p);
        }
      });
      row.addEventListener("dblclick", () => {
        const p = row.dataset.path;
        const isDir = row.dataset.dir === "1";
        if (isDir) {
          // double-click folder: set as project root
          setProjectRoot(p);
        } else {
          insertPath(p);
        }
      });
    });
  }

  function setProjectRoot(path) {
    const p = path || browsePath;
    if (!p) return;
    if (busy) {
      addSystem("任务进行中，请先停止再切换项目根。");
      return;
    }
    // Switching project root starts a new agent session
    clearChatUI();
    wsSend({ type: "set_cwd", cwd: p });
    addSystem("项目根已切换为：" + p + "（新对话）");
    // browse stays where user is, or jump into project
    loadSideList(p);
  }

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
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleEvent(msg);
    };
  }

  function handleEvent(msg) {
    switch (msg.type) {
      case "hello":
        sessionId = msg.sessionId;
        cwd = msg.cwd || "";
        updateProjectUI();
        {
          const auth = msg.auth || {};
          const init = msg.init || {};
          const who = auth.email || "not signed in";
          const model = init.currentModelId || "";
          setStatus(`${who}${model ? " · " + model : ""}`, auth.ok === false ? "err" : "ok");
          if (auth.ok === false) {
            addSystem("登录失败：请先在终端运行 grok 完成登录（写入 ~/.grok/auth.json）");
          }
        }
        loadSideList(cwd || homePath || "/");
        break;

      case "session":
        sessionId = msg.sessionId;
        cwd = msg.cwd || cwd;
        updateProjectUI();
        setStatus(statusLine(), "ok");
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
        addSystem("Grok agent 进程已退出，正在重连…");
        setBusy(false);
        break;

      default:
        break;
    }
  }

  function handleSessionUpdate(update) {
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk") {
      ensureAgentBubble();
      const t = (update.content && update.content.text) || "";
      agentBuf += t;
      currentAgentBody.innerHTML = renderMarkdown(agentBuf);
      scrollBottom();
    } else if (kind === "agent_thought_chunk") {
      ensureAgentBubble();
      const t = (update.content && update.content.text) || "";
      thoughtBuf += t;
      if (currentThoughtEl) {
        currentThoughtEl.style.display = "block";
        currentThoughtEl.textContent = thoughtBuf;
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
    options.forEach((opt) => {
      const b = document.createElement("button");
      b.className = (opt.kind || "").includes("allow") ? "primary-btn" : "ghost-btn";
      b.type = "button";
      b.textContent = opt.name || opt.optionId;
      b.onclick = () => {
        wsSend({ type: "permission_reply", id: msg.id, optionId: opt.optionId });
        el.remove();
      };
      actions.appendChild(b);
    });
    if (!options.length) {
      const b = document.createElement("button");
      b.className = "primary-btn";
      b.textContent = "Allow once";
      b.onclick = () => {
        wsSend({ type: "permission_reply", id: msg.id, optionId: "allow-once" });
        el.remove();
      };
      actions.appendChild(b);
    }
    messagesEl.appendChild(el);
    scrollBottom();
  }

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
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

  sendBtn.addEventListener("click", send);
  cancelBtn.addEventListener("click", () => wsSend({ type: "cancel", sessionId }));
  clearBtn.addEventListener("click", clearConversation);
  clearBtn.classList.add("danger");

  toggleSidebar.addEventListener("click", () => setSidebar(!sidebarOpen));
  sidebarClose.addEventListener("click", () => setSidebar(false));
  setProjectBtn.addEventListener("click", () => setProjectRoot(browsePath));
  goHomeBtn.addEventListener("click", () => loadSideList(homePath || "/"));
  sideUp.addEventListener("click", () => {
    if (browseParent) loadSideList(browseParent);
  });
  sideRefresh.addEventListener("click", () => loadSideList(browsePath));

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
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
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
    const q = m[1] || "";
    clearTimeout(acTimer);
    acTimer = setTimeout(() => fetchAc(q), 120);
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
        return `<div class="item ${i === acIndex ? "active" : ""}" data-i="${i}" role="option">
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

  // Boot
  fetch("/api/defaults")
    .then((r) => r.json())
    .then((d) => {
      homePath = d.home || "";
      if (!cwd && d.cwd) {
        // will be overwritten by hello
      }
    })
    .catch(() => {})
    .finally(() => {
      addSystem("Grok Chat — 右侧文件夹点选路径 · 删除对话可清空上下文 · 项目根≈打开工程");
      connect();
    });
})();
