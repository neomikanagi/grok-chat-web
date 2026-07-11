"""FastAPI server: static UI + REST + WebSocket; conversations on server disk."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any, Optional

from collections import deque

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.acp_bridge import ACPBridge, default_cwd
from app.conversations import store as conv_store

logging.basicConfig(
    level=os.environ.get("GROK_CHAT_LOG", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("grok_chat")

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

app = FastAPI(title="Grok Chat Web", version="0.2.0")

bridge = ACPBridge(
    grok_bin=os.environ.get("GROK_BIN", "grok"),
    model=os.environ.get("GROK_CHAT_MODEL"),
    always_approve=os.environ.get("GROK_CHAT_AUTO_APPROVE", "1") not in ("0", "false", "False"),
)

# Optional shared-secret gate for /ws + /api/* — unset (default) means no
# check, same as before. Same-subnet hosts otherwise have unauthenticated
# read/write access to everything under GROK_CHAT_CWD via this service.
GROK_CHAT_TOKEN = os.environ.get("GROK_CHAT_TOKEN") or None


ROOTS_DIR = Path("/roots")


def _project_roots() -> list[dict[str, str]]:
    """Quick-pick project roots for the UI switcher: the default
    GROK_CHAT_CWD, plus one entry per subdirectory actually bind-mounted
    under /roots. No separate NAME/PATH env vars to keep in sync --
    whatever directory name you mount at /roots/<name> in docker-compose
    IS the name shown, so it can't drift from what's actually there.
    """
    roots: list[dict[str, str]] = []
    seen: set[str] = set()

    default = default_cwd()
    default_hint = os.environ.get("GROK_CHAT_CWD_HINT") or ""
    roots.append({"name": Path(default).name or "default", "path": default, "hint": default_hint})
    seen.add(default)

    if ROOTS_DIR.is_dir():
        for child in sorted(ROOTS_DIR.iterdir()):
            if not child.is_dir():
                continue
            resolved = str(child.resolve())
            if resolved in seen:
                continue
            roots.append({"name": child.name, "path": resolved, "hint": ""})
            seen.add(resolved)
    return roots


def _request_token(request: Request) -> Optional[str]:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.query_params.get("token")


async def require_token(request: Request) -> None:
    if not GROK_CHAT_TOKEN:
        return
    if _request_token(request) != GROK_CHAT_TOKEN:
        raise HTTPException(401, "missing or invalid token")

_clients: set[WebSocket] = set()
_bridge_lock = asyncio.Lock()

# Active conversation id (our store id, not only ACP)
_active_conv_id: Optional[str] = None

# Streaming buffers for assistant turn persistence
_turn_agent: str = ""
_turn_thought: str = ""


async def broadcast(event: dict[str, Any]) -> None:
    dead: list[WebSocket] = []
    data = json.dumps(event, ensure_ascii=False)
    for ws in list(_clients):
        try:
            await ws.send_text(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _clients.discard(ws)


async def on_bridge_event(event: dict[str, Any]) -> None:
    global _turn_agent, _turn_thought
    # Capture assistant stream for server-side history
    if event.get("type") == "session_update":
        update = event.get("update") or {}
        kind = update.get("sessionUpdate")
        if kind == "agent_message_chunk":
            _turn_agent += (update.get("content") or {}).get("text") or ""
        elif kind == "agent_thought_chunk":
            _turn_thought += (update.get("content") or {}).get("text") or ""
    await broadcast(event)


def _conv_payload() -> dict[str, Any]:
    return {
        "type": "conversations",
        "items": conv_store.list(),
        "activeId": conv_store.active_id or _active_conv_id,
    }


async def _broadcast_conv_list() -> None:
    await broadcast(_conv_payload())


def _ensure_active_conv(acp_id: Optional[str], cwd: str) -> str:
    global _active_conv_id
    if acp_id:
        found = conv_store.find_by_acp(acp_id)
        if found:
            _active_conv_id = found["id"]
            conv_store.active_id = found["id"]
            return found["id"]
    data = conv_store.create(cwd=cwd or default_cwd(), acp_session_id=acp_id)
    _active_conv_id = data["id"]
    return data["id"]


@app.on_event("startup")
async def startup() -> None:
    bridge.on_event(on_bridge_event)
    if os.environ.get("GROK_CHAT_PREWARM", "1") not in ("0", "false", "False"):
        asyncio.create_task(_prewarm())


async def _prewarm() -> None:
    global _active_conv_id
    try:
        async with _bridge_lock:
            await bridge.start()
            if not bridge.session_id:
                await bridge.new_session(default_cwd())
            # Link or create a server conversation for the prewarm ACP session
            _active_conv_id = _ensure_active_conv(bridge.session_id, bridge.cwd or default_cwd())
        logger.info(
            "prewarm ok conv=%s acp=%s cwd=%s",
            _active_conv_id,
            bridge.session_id,
            bridge.cwd,
        )
    except Exception:
        logger.exception("prewarm failed")


@app.on_event("shutdown")
async def shutdown() -> None:
    await bridge.stop()


class SessionBody(BaseModel):
    cwd: str = Field(..., description="Absolute working directory for the agent")


@app.get("/api/health", dependencies=[Depends(require_token)])
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "agent_running": bridge._proc is not None and bridge._proc.returncode is None,
        "session_id": bridge.session_id,
        "conversation_id": _active_conv_id,
        "cwd": bridge.cwd,
        "always_approve": bridge.always_approve,
        "auth": bridge._public_auth() if bridge.auth_meta else None,
        "init": bridge._public_init() if bridge.init_meta else None,
        "grok_bin": shutil.which(bridge.grok_bin) or bridge.grok_bin,
        "conversations": len(conv_store.list()),
        "data_dir": str(conv_store.root),
    }


@app.get("/api/defaults", dependencies=[Depends(require_token)])
async def defaults() -> dict[str, Any]:
    return {
        "cwd": bridge.cwd or default_cwd(),
        "home": str(Path.home()),
        "send_key": "enter",
        "newline_key": "shift+enter",
        "always_approve": bridge.always_approve,
    }


@app.get("/api/project-roots", dependencies=[Depends(require_token)])
async def project_roots() -> dict[str, Any]:
    return {"items": _project_roots(), "active": bridge.cwd or default_cwd()}


@app.get("/api/conversations", dependencies=[Depends(require_token)])
async def api_list_conversations() -> dict[str, Any]:
    return {
        "items": conv_store.list(),
        "activeId": conv_store.active_id or _active_conv_id,
    }


@app.get("/api/conversations/{conv_id}", dependencies=[Depends(require_token)])
async def api_get_conversation(conv_id: str) -> dict[str, Any]:
    data = conv_store.get(conv_id)
    if not data:
        raise HTTPException(404, "conversation not found")
    return data


@app.delete("/api/conversations/{conv_id}", dependencies=[Depends(require_token)])
async def api_delete_conversation(conv_id: str) -> dict[str, Any]:
    global _active_conv_id
    ok = conv_store.delete(conv_id)
    if not ok:
        raise HTTPException(404, "conversation not found")
    if _active_conv_id == conv_id:
        _active_conv_id = None
    await _broadcast_conv_list()
    return {"ok": True, "id": conv_id}


@app.get("/api/fs/list", dependencies=[Depends(require_token)])
async def fs_list(
    path: Optional[str] = Query(None),
    show_hidden: bool = Query(False),
) -> dict[str, Any]:
    base = Path(path or bridge.cwd or default_cwd()).expanduser()
    try:
        base = base.resolve()
    except Exception as e:
        raise HTTPException(400, f"invalid path: {e}") from e
    if not base.exists():
        raise HTTPException(404, f"not found: {base}")
    if not base.is_dir():
        raise HTTPException(400, f"not a directory: {base}")

    entries = []
    try:
        children = sorted(base.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e

    for child in children:
        name = child.name
        if not show_hidden and name.startswith("."):
            continue
        try:
            is_dir = child.is_dir()
        except OSError:
            continue
        entries.append({"name": name, "path": str(child), "is_dir": is_dir})
    parent = str(base.parent) if base.parent != base else None
    return {"path": str(base), "parent": parent, "entries": entries}


@app.get("/api/fs/search", dependencies=[Depends(require_token)])
async def fs_search(
    q: str = Query(..., min_length=1),
    root: Optional[str] = Query(None),
    limit: int = Query(40, ge=1, le=100),
) -> dict[str, Any]:
    base = Path(root or bridge.cwd or default_cwd()).expanduser().resolve()
    if not base.is_dir():
        raise HTTPException(400, f"bad root: {base}")

    q_lower = q.lower().lstrip("@")
    hits: list[dict[str, Any]] = []

    try:
        if q.startswith("/") or q.startswith("~"):
            p = Path(q).expanduser()
            parent = p.parent if not p.exists() else p if p.is_dir() else p.parent
            if parent.is_dir():
                prefix = p.name.lower()
                for child in sorted(parent.iterdir(), key=lambda x: x.name.lower()):
                    if prefix and not child.name.lower().startswith(prefix):
                        continue
                    if child.name.startswith("."):
                        continue
                    hits.append(
                        {"name": child.name, "path": str(child), "is_dir": child.is_dir()}
                    )
                    if len(hits) >= limit:
                        break
            return {"query": q, "root": str(base), "entries": hits}
    except Exception:
        pass

    stack = deque([base])
    depth_guard = 0
    while stack and len(hits) < limit and depth_guard < 5000:
        cur = stack.popleft()
        depth_guard += 1
        try:
            children = list(cur.iterdir())
        except (PermissionError, OSError):
            continue
        for child in children:
            name = child.name
            if name.startswith("."):
                continue
            try:
                is_dir = child.is_dir()
            except OSError:
                continue
            rel = str(child.relative_to(base)) if child.is_relative_to(base) else str(child)
            if q_lower in name.lower() or q_lower in rel.lower():
                hits.append({"name": name, "path": str(child), "is_dir": is_dir, "rel": rel})
                if len(hits) >= limit:
                    break
            if is_dir and depth_guard < 2000 and (len(q_lower) >= 2 or child.parent == base):
                if name not in ("node_modules", ".git", ".venv", "venv", "dist", "build", "target"):
                    stack.append(child)

    return {"query": q, "root": str(base), "entries": hits}


async def _open_conversation(conv_id: str) -> None:
    """Load server transcript to UI + resume ACP if possible."""
    global _active_conv_id
    data = conv_store.get(conv_id)
    if not data:
        await broadcast({"type": "error", "message": f"对话不存在: {conv_id}"})
        return

    _active_conv_id = conv_id
    conv_store.active_id = conv_id
    cwd = data.get("cwd") or default_cwd()
    acp_id = data.get("acpSessionId")

    await broadcast({"type": "session_load_start", "conversationId": conv_id, "cwd": cwd})
    # Push stored messages immediately (source of truth for UI)
    await broadcast(
        {
            "type": "conversation_open",
            "conversation": {
                "id": data["id"],
                "title": data.get("title"),
                "cwd": cwd,
                "acpSessionId": acp_id,
                "messages": data.get("messages") or [],
            },
        }
    )

    # Try ACP resume for agent memory; UI already has history even if this fails
    if acp_id:
        try:
            await bridge.load_session(acp_id, cwd)
            await broadcast(
                {
                    "type": "session",
                    "sessionId": acp_id,
                    "conversationId": conv_id,
                    "cwd": cwd,
                    "loaded": True,
                }
            )
        except Exception as e:
            logger.warning("ACP load failed for %s: %s — new session", acp_id, e)
            try:
                newsid = await bridge.new_session(cwd)
                conv_store.bind_acp(conv_id, newsid, cwd)
                await broadcast(
                    {
                        "type": "session",
                        "sessionId": newsid,
                        "conversationId": conv_id,
                        "cwd": cwd,
                        "fresh": False,
                        "acpReset": True,
                        "message": "Agent 侧会话已重建，界面历史来自本机记录",
                    }
                )
            except Exception as e2:
                await broadcast({"type": "error", "message": str(e2)})
    else:
        try:
            newsid = await bridge.new_session(cwd)
            conv_store.bind_acp(conv_id, newsid, cwd)
            await broadcast(
                {
                    "type": "session",
                    "sessionId": newsid,
                    "conversationId": conv_id,
                    "cwd": cwd,
                    "fresh": False,
                }
            )
        except Exception as e:
            await broadcast({"type": "error", "message": str(e)})

    await broadcast({"type": "session_load_end", "conversationId": conv_id})
    await _broadcast_conv_list()


async def _new_conversation(cwd: Optional[str] = None) -> None:
    global _active_conv_id
    c = cwd or bridge.cwd or default_cwd()
    async with _bridge_lock:
        await bridge.start()
        sid = await bridge.new_session(c)
    data = conv_store.create(cwd=c, acp_session_id=sid)
    _active_conv_id = data["id"]
    await broadcast(
        {
            "type": "session",
            "sessionId": sid,
            "conversationId": data["id"],
            "cwd": c,
            "fresh": True,
        }
    )
    await broadcast(
        {
            "type": "conversation_open",
            "conversation": {
                "id": data["id"],
                "title": data["title"],
                "cwd": c,
                "acpSessionId": sid,
                "messages": [],
            },
        }
    )
    await _broadcast_conv_list()


@app.websocket("/ws")
async def ws_chat(ws: WebSocket) -> None:
    global _active_conv_id
    if GROK_CHAT_TOKEN and ws.query_params.get("token") != GROK_CHAT_TOKEN:
        # Browsers can't set custom headers on the WS handshake, so the
        # token travels as a query param here (matches app.js).
        await ws.close(code=4401)
        return
    await ws.accept()
    _clients.add(ws)
    try:
        async with _bridge_lock:
            try:
                await bridge.start()
                if not bridge.session_id:
                    await bridge.new_session(default_cwd())
                if not _active_conv_id:
                    _active_conv_id = _ensure_active_conv(
                        bridge.session_id, bridge.cwd or default_cwd()
                    )
            except Exception as e:
                await ws.send_text(
                    json.dumps({"type": "error", "message": f"agent start failed: {e}"})
                )

        await ws.send_text(
            json.dumps(
                {
                    "type": "hello",
                    "sessionId": bridge.session_id,
                    "conversationId": _active_conv_id,
                    "cwd": bridge.cwd,
                    "auth": bridge._public_auth(),
                    "init": bridge._public_init(),
                    "always_approve": bridge.always_approve,
                    "conversations": conv_store.list(),
                    "activeId": _active_conv_id,
                },
                ensure_ascii=False,
            )
        )

        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps({"type": "error", "message": "invalid json"}))
                continue

            mtype = msg.get("type")
            try:
                if mtype == "prompt":
                    text = (msg.get("text") or "").strip()
                    if not text:
                        continue
                    # Ensure we have a server conversation
                    if not _active_conv_id:
                        _active_conv_id = _ensure_active_conv(
                            bridge.session_id, bridge.cwd or default_cwd()
                        )
                    conv_store.append_message(_active_conv_id, "user", text)
                    await _broadcast_conv_list()
                    await broadcast({"type": "user", "text": text, "conversationId": _active_conv_id})
                    acp = msg.get("sessionId") or bridge.session_id
                    asyncio.create_task(_run_prompt(text, acp, _active_conv_id))

                elif mtype == "cancel":
                    await bridge.cancel(msg.get("sessionId"))

                elif mtype == "set_cwd":
                    cwd = msg.get("cwd")
                    if not cwd:
                        continue
                    await _new_conversation(cwd)

                elif mtype == "new_session":
                    await _new_conversation(msg.get("cwd"))

                elif mtype == "open_conversation":
                    cid = msg.get("conversationId") or msg.get("sessionId")
                    if not cid:
                        await ws.send_text(
                            json.dumps(
                                {"type": "error", "message": "open_conversation needs conversationId"}
                            )
                        )
                        continue
                    async with _bridge_lock:
                        await _open_conversation(cid)

                elif mtype == "load_session":
                    # Back-compat: treat as open_conversation by our id or acp id
                    sid = msg.get("sessionId") or msg.get("conversationId")
                    if not sid:
                        continue
                    # Prefer our conversation id
                    data = conv_store.get(sid) or conv_store.find_by_acp(sid)
                    if data:
                        async with _bridge_lock:
                            await _open_conversation(data["id"])
                    else:
                        await broadcast(
                            {"type": "error", "message": "本机没有这条对话记录"}
                        )

                elif mtype == "delete_conversation":
                    cid = msg.get("conversationId")
                    if not cid:
                        continue
                    was_active = cid == _active_conv_id
                    conv_store.delete(cid)
                    if was_active:
                        _active_conv_id = None
                        await _new_conversation(bridge.cwd or default_cwd())
                    else:
                        await _broadcast_conv_list()

                elif mtype == "permission_reply":
                    req_id = msg.get("id")
                    option_id = msg.get("optionId") or "allow-once"
                    await bridge.reply(
                        req_id,
                        {"outcome": {"outcome": "selected", "optionId": option_id}},
                    )

                elif mtype == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))

                elif mtype == "list_conversations":
                    await ws.send_text(json.dumps(_conv_payload(), ensure_ascii=False))

                else:
                    await ws.send_text(
                        json.dumps({"type": "error", "message": f"unknown type: {mtype}"})
                    )
            except Exception as e:
                logger.exception("ws handler error")
                await ws.send_text(
                    json.dumps({"type": "error", "message": str(e)}, ensure_ascii=False)
                )
    except WebSocketDisconnect:
        pass
    finally:
        _clients.discard(ws)


async def _run_prompt(
    text: str, session_id: Optional[str], conv_id: Optional[str]
) -> None:
    global _turn_agent, _turn_thought
    _turn_agent = ""
    _turn_thought = ""
    try:
        await broadcast({"type": "turn_start", "conversationId": conv_id})
        # Serialize turns: _turn_agent/_turn_thought are shared buffers that
        # on_bridge_event() appends to, so two turns running concurrently
        # (e.g. a second tab, or a retry racing the first) would interleave
        # and corrupt each other's saved message.
        async with _bridge_lock:
            result = await bridge.prompt(text, session_id=session_id)
        if conv_id and (_turn_agent or _turn_thought):
            conv_store.append_message(
                conv_id,
                "assistant",
                _turn_agent,
                thought=_turn_thought,
            )
            await _broadcast_conv_list()
        await broadcast({"type": "turn_end", "result": result, "conversationId": conv_id})
    except Exception as e:
        logger.exception("prompt failed")
        if conv_id:
            conv_store.append_message(conv_id, "system", f"错误: {e}")
        await broadcast({"type": "error", "message": str(e)})
        await broadcast({"type": "turn_end", "error": str(e), "conversationId": conv_id})
    finally:
        _turn_agent = ""
        _turn_thought = ""


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")
