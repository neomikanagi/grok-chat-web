/* Grok Chat Web — frontend */
(() => {
  const $ = (id) => document.getElementById(id);

  const messagesEl = $("messages");
  const inputEl = $("input");
  const sendBtn = $("sendBtn");
  const cancelBtn = $("cancelBtn");
  const statusText = $("statusText");
  const dot = $("dot");
  const cwdBtn = $("cwdBtn");
  const browseBtn = $("browseBtn");
  const newSessionBtn = $("newSessionBtn");
  const acEl = $("ac");
  const picker = $("picker");
  const pickerPath = $("pickerPath");
  const pickerList = $("pickerList");
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || navigator.userAgent.includes("Mac");
  $("modKey").textContent = isMac ? "⌘" : "Ctrl";

  let ws = null;
  let sessionId = null;
  let cwd = "";
  let busy = false;
  let reconnectTimer = null;

  // Streaming message assembly
  let currentAgentEl = null;
  let currentAgentBody = null;
  let currentThoughtEl = null;
  let agentBuf = "";
  let thoughtBuf = "";

  // @ autocomplete
  let acItems = [];
  let acIndex = 0;
  let acActive = false;
  let acQueryStart = -1;
  let acTimer = null;

  // Picker state
  let pickerCwd = "";
  let pickerParent = null;

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

  /** Minimal markdown: fenced code, inline code, bold, paragraphs */
  function renderMarkdown(text) {
    const escaped = escapeHtml(text);
    // fenced code
    let html = escaped.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code class="lang-${lang || "text"}">${code.replace(/\n$/, "")}</code></pre>`;
    });
    // inline code
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    // bold
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // paragraphs (only outside pre)
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
        // fallback
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
    if (v) setStatus("working…", "busy");
    else if (ws && ws.readyState === WebSocket.OPEN) setStatus(statusLine(), "ok");
  }

  function statusLine() {
    const parts = [];
    if (cwd) parts.push(shortPath(cwd));
    return parts.join(" · ") || "connected";
  }

  function shortPath(p) {
    if (!p) return "";
    const homeHints = ["/Users/", "/home/"];
    // show last 2 segments if long
    if (p.length > 48) {
      const segs = p.split("/").filter(Boolean);
      return "…/" + segs.slice(-2).join("/");
    }
    return p;
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
        cwdBtn.textContent = cwd || "(no cwd)";
        cwdBtn.title = cwd;
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
        break;

      case "session":
        sessionId = msg.sessionId;
        cwd = msg.cwd || cwd;
        cwdBtn.textContent = cwd;
        cwdBtn.title = cwd;
        addSystem(`工作目录：${cwd}`);
        setStatus(statusLine(), "ok");
        break;

      case "user":
        // echoed from server
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

      case "permission_auto":
        // silent
        break;

      case "agent_exit":
        addSystem("Grok agent 进程已退出，正在重连…");
        setBusy(false);
        break;

      case "ready":
        break;

      default:
        // ignore noise (stderr, notifications)
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
    } else if (kind === "user_message_chunk") {
      // history replay
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

    // Enter = newline (default). Mod+Enter = send.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });

  inputEl.addEventListener("input", () => {
    // auto-grow
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
        ? `/api/fs/search?q=${encodeURIComponent(q)}&root=${encodeURIComponent(cwd || "")}`
        : `/api/fs/list?path=${encodeURIComponent(cwd || "")}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      acItems = (data.entries || []).slice(0, 30);
      acIndex = 0;
      acActive = acItems.length > 0;
      renderAc();
    } catch (e) {
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

  // Folder picker
  async function openPicker(startPath) {
    picker.classList.add("open");
    await loadPicker(startPath || cwd || "/");
  }

  function closePicker() {
    picker.classList.remove("open");
  }

  async function loadPicker(path) {
    const res = await fetch(`/api/fs/list?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      addSystem("无法列出目录：" + (await res.text()));
      return;
    }
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
      row.addEventListener("dblclick", () => {
        useCwd(row.dataset.path);
      });
    });
    const up = pickerList.querySelector("[data-up]");
    if (up) up.addEventListener("click", () => pickerParent && loadPicker(pickerParent));
  }

  function useCwd(path) {
    const p = path || pickerCwd;
    wsSend({ type: "set_cwd", cwd: p });
    closePicker();
  }

  browseBtn.addEventListener("click", () => openPicker(cwd));
  cwdBtn.addEventListener("click", () => openPicker(cwd));
  $("pickerClose").addEventListener("click", closePicker);
  $("pickerUse").addEventListener("click", () => useCwd());
  $("pickerUp").addEventListener("click", () => pickerParent && loadPicker(pickerParent));
  picker.addEventListener("click", (e) => {
    if (e.target === picker) closePicker();
  });

  newSessionBtn.addEventListener("click", () => {
    if (cwd) wsSend({ type: "set_cwd", cwd });
  });

  // Boot
  addSystem("Grok Chat Web — Enter 换行 · ⌘/Ctrl+Enter 发送 · @ 选路径 · 消息可一键复制");
  connect();
})();
