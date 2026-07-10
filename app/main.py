"""FastAPI server: static UI + REST for paths + WebSocket chat bridge."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.acp_bridge import ACPBridge, default_cwd

logging.basicConfig(
    level=os.environ.get("GROK_CHAT_LOG", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("grok_chat")

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

app = FastAPI(title="Grok Chat Web", version="0.1.0")

bridge = ACPBridge(
    grok_bin=os.environ.get("GROK_BIN", "grok"),
    model=os.environ.get("GROK_CHAT_MODEL"),
    always_approve=os.environ.get("GROK_CHAT_AUTO_APPROVE", "1") not in ("0", "false", "False"),
)

# WebSocket clients
_clients: set[WebSocket] = set()
_bridge_lock = asyncio.Lock()
_bootstrapped = False


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
    await broadcast(event)


@app.on_event("startup")
async def startup() -> None:
    bridge.on_event(on_bridge_event)
    # Lazy start on first WS connect is fine; also pre-warm if asked.
    if os.environ.get("GROK_CHAT_PREWARM", "1") not in ("0", "false", "False"):
        asyncio.create_task(_prewarm())


async def _prewarm() -> None:
    global _bootstrapped
    try:
        async with _bridge_lock:
            await bridge.start()
            if not bridge.session_id:
                await bridge.new_session(default_cwd())
            _bootstrapped = True
        logger.info("prewarm ok session=%s cwd=%s", bridge.session_id, bridge.cwd)
    except Exception:
        logger.exception("prewarm failed (will retry on connect)")


@app.on_event("shutdown")
async def shutdown() -> None:
    await bridge.stop()


class SessionBody(BaseModel):
    cwd: str = Field(..., description="Absolute working directory for the agent")


class PromptBody(BaseModel):
    text: str
    session_id: Optional[str] = None


class PermissionBody(BaseModel):
    id: Any
    option_id: str


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "agent_running": bridge._proc is not None and bridge._proc.returncode is None,
        "session_id": bridge.session_id,
        "cwd": bridge.cwd,
        "always_approve": bridge.always_approve,
        "auth": bridge._public_auth() if bridge.auth_meta else None,
        "init": bridge._public_init() if bridge.init_meta else None,
        "grok_bin": shutil.which(bridge.grok_bin) or bridge.grok_bin,
    }


@app.get("/api/defaults")
async def defaults() -> dict[str, Any]:
    home = str(Path.home())
    return {
        "cwd": bridge.cwd or default_cwd(),
        "home": home,
        "send_key": "mod+enter",  # Cmd/Ctrl+Enter
        "newline_key": "enter",
        "always_approve": bridge.always_approve,
    }


@app.post("/api/session")
async def create_session(body: SessionBody) -> dict[str, Any]:
    try:
        async with _bridge_lock:
            await bridge.start()
            sid = await bridge.new_session(body.cwd)
        return {"sessionId": sid, "cwd": bridge.cwd}
    except FileNotFoundError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        logger.exception("session create failed")
        raise HTTPException(500, str(e)) from e


@app.get("/api/fs/list")
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
        entries.append(
            {
                "name": name,
                "path": str(child),
                "is_dir": is_dir,
            }
        )
    parent = str(base.parent) if base.parent != base else None
    return {"path": str(base), "parent": parent, "entries": entries}


@app.get("/api/fs/search")
async def fs_search(
    q: str = Query(..., min_length=1),
    root: Optional[str] = Query(None),
    limit: int = Query(40, ge=1, le=100),
) -> dict[str, Any]:
    """Shallow fuzzy-ish search under root for @ autocomplete."""
    base = Path(root or bridge.cwd or default_cwd()).expanduser().resolve()
    if not base.is_dir():
        raise HTTPException(400, f"bad root: {base}")

    q_lower = q.lower().lstrip("@")
    hits: list[dict[str, Any]] = []

    # Prefer direct children + one level deep; also match absolute path prefix.
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
                        {
                            "name": child.name,
                            "path": str(child),
                            "is_dir": child.is_dir(),
                        }
                    )
                    if len(hits) >= limit:
                        break
            return {"query": q, "root": str(base), "entries": hits}
    except Exception:
        pass

    stack = [base]
    depth_guard = 0
    while stack and len(hits) < limit and depth_guard < 5000:
        cur = stack.pop(0)
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
            # Limit breadth: only recurse into dirs when query longer or few hits
            if is_dir and depth_guard < 2000 and (len(q_lower) >= 2 or child.parent == base):
                # Don't dive into huge trees
                if name not in ("node_modules", ".git", ".venv", "venv", "dist", "build", "target"):
                    stack.append(child)

    return {"query": q, "root": str(base), "entries": hits}


@app.websocket("/ws")
async def ws_chat(ws: WebSocket) -> None:
    await ws.accept()
    _clients.add(ws)
    try:
        async with _bridge_lock:
            try:
                await bridge.start()
                if not bridge.session_id:
                    await bridge.new_session(default_cwd())
            except Exception as e:
                await ws.send_text(
                    json.dumps({"type": "error", "message": f"agent start failed: {e}"})
                )

        await ws.send_text(
            json.dumps(
                {
                    "type": "hello",
                    "sessionId": bridge.session_id,
                    "cwd": bridge.cwd,
                    "auth": bridge._public_auth(),
                    "init": bridge._public_init(),
                    "always_approve": bridge.always_approve,
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
                    await broadcast({"type": "user", "text": text})
                    # Run prompt without blocking the receive loop for cancel
                    asyncio.create_task(_run_prompt(text, msg.get("sessionId")))

                elif mtype == "cancel":
                    await bridge.cancel(msg.get("sessionId"))

                elif mtype == "set_cwd":
                    cwd = msg.get("cwd")
                    if not cwd:
                        continue
                    async with _bridge_lock:
                        sid = await bridge.new_session(cwd)
                    await broadcast(
                        {"type": "session", "sessionId": sid, "cwd": bridge.cwd}
                    )

                elif mtype == "permission_reply":
                    req_id = msg.get("id")
                    option_id = msg.get("optionId") or "allow-once"
                    await bridge.reply(
                        req_id,
                        {
                            "outcome": {
                                "outcome": "selected",
                                "optionId": option_id,
                            }
                        },
                    )

                elif mtype == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))

                else:
                    await ws.send_text(
                        json.dumps(
                            {"type": "error", "message": f"unknown type: {mtype}"}
                        )
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


async def _run_prompt(text: str, session_id: Optional[str]) -> None:
    try:
        await broadcast({"type": "turn_start"})
        result = await bridge.prompt(text, session_id=session_id)
        await broadcast({"type": "turn_end", "result": result})
    except Exception as e:
        logger.exception("prompt failed")
        await broadcast({"type": "error", "message": str(e)})
        await broadcast({"type": "turn_end", "error": str(e)})


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")
