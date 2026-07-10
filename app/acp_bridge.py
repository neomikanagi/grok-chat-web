"""ACP (Agent Client Protocol) bridge: spawns `grok agent stdio` and talks JSON-RPC."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger("grok_chat.acp")

EventHandler = Callable[[dict[str, Any]], Awaitable[None]]


class ACPBridge:
    """One long-lived `grok agent stdio` process + JSON-RPC over lines."""

    def __init__(
        self,
        grok_bin: str = "grok",
        model: Optional[str] = None,
        always_approve: bool = True,
    ) -> None:
        self.grok_bin = grok_bin
        self.model = model
        self.always_approve = always_approve

        self._proc: Optional[asyncio.subprocess.Process] = None
        self._reader_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._write_lock = asyncio.Lock()
        self._handlers: list[EventHandler] = []
        self._started = False
        self.session_id: Optional[str] = None
        self.cwd: Optional[str] = None
        self.init_meta: dict[str, Any] = {}
        self.auth_meta: dict[str, Any] = {}

    def on_event(self, handler: EventHandler) -> None:
        self._handlers.append(handler)

    def remove_handler(self, handler: EventHandler) -> None:
        if handler in self._handlers:
            self._handlers.remove(handler)

    async def _emit(self, event: dict[str, Any]) -> None:
        for h in list(self._handlers):
            try:
                await h(event)
            except Exception:
                logger.exception("event handler failed")

    def _next_req_id(self) -> int:
        self._next_id += 1
        return self._next_id

    async def start(self) -> None:
        if self._started and self._proc and self._proc.returncode is None:
            return

        cmd = [self.grok_bin, "agent", "--no-leader"]
        if self.model:
            cmd.extend(["--model", self.model])
        if self.always_approve:
            cmd.append("--always-approve")
        cmd.append("stdio")

        logger.info("starting agent: %s", " ".join(cmd))
        self._proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=16 * 1024 * 1024,
        )
        self._started = True
        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())

        init = await self.request(
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": {"readTextFile": True, "writeTextFile": True},
                    "terminal": True,
                },
                "clientInfo": {
                    "name": "grok-chat-web",
                    "title": "Grok Chat Web",
                    "version": "0.1.0",
                },
            },
            timeout=30,
        )
        self.init_meta = init or {}

        # Prefer cached login; fall back quietly if missing.
        try:
            auth = await self.request(
                "authenticate",
                {"methodId": "cached_token"},
                timeout=20,
            )
            self.auth_meta = auth or {}
        except Exception as e:
            logger.warning("authenticate failed: %s", e)
            self.auth_meta = {"error": str(e)}

        await self._emit(
            {
                "type": "ready",
                "init": self._public_init(),
                "auth": self._public_auth(),
            }
        )

    def _public_init(self) -> dict[str, Any]:
        meta = self.init_meta.get("_meta") or {}
        models = meta.get("modelState") or {}
        return {
            "agentVersion": meta.get("agentVersion"),
            "hostname": meta.get("hostname"),
            "currentModelId": models.get("currentModelId"),
            "availableModels": [
                {
                    "modelId": m.get("modelId"),
                    "name": m.get("name"),
                    "description": m.get("description"),
                }
                for m in (models.get("availableModels") or [])
            ],
        }

    def _public_auth(self) -> dict[str, Any]:
        meta = self.auth_meta.get("_meta") or {}
        if self.auth_meta.get("error"):
            return {"ok": False, "error": self.auth_meta["error"]}
        return {
            "ok": True,
            "email": meta.get("email"),
            "subscription_tier": meta.get("subscription_tier"),
        }

    async def stop(self) -> None:
        self._started = False
        if self._reader_task:
            self._reader_task.cancel()
        if self._stderr_task:
            self._stderr_task.cancel()
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(RuntimeError("agent stopped"))
        self._pending.clear()
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
        self._proc = None
        self.session_id = None

    async def ensure_running(self) -> None:
        if not self._proc or self._proc.returncode is not None:
            self.session_id = None
            await self.start()

    async def new_session(self, cwd: str) -> str:
        await self.ensure_running()
        cwd_path = str(Path(cwd).expanduser().resolve())
        if not Path(cwd_path).is_dir():
            raise FileNotFoundError(f"cwd is not a directory: {cwd_path}")

        result = await self.request(
            "session/new",
            {"cwd": cwd_path, "mcpServers": []},
            timeout=30,
        )
        sid = result["sessionId"]
        self.session_id = sid
        self.cwd = cwd_path
        await self._emit({"type": "session", "sessionId": sid, "cwd": cwd_path})
        return sid

    async def prompt(self, text: str, session_id: Optional[str] = None) -> dict[str, Any]:
        await self.ensure_running()
        sid = session_id or self.session_id
        if not sid:
            raise RuntimeError("no active session; set a working folder first")
        return await self.request(
            "session/prompt",
            {
                "sessionId": sid,
                "prompt": [{"type": "text", "text": text}],
            },
            timeout=None,  # agent turns can be long
        )

    async def cancel(self, session_id: Optional[str] = None) -> None:
        sid = session_id or self.session_id
        if not sid or not self._proc:
            return
        await self.notify("session/cancel", {"sessionId": sid})

    async def request(
        self,
        method: str,
        params: Optional[dict[str, Any]] = None,
        timeout: Optional[float] = 60,
    ) -> Any:
        if not self._proc or not self._proc.stdin:
            raise RuntimeError("agent not running")
        rid = self._next_req_id()
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[rid] = fut
        msg = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
        await self._write(msg)
        try:
            if timeout is None:
                return await fut
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(rid, None)
            raise TimeoutError(f"ACP request timed out: {method}") from None

    async def notify(self, method: str, params: Optional[dict[str, Any]] = None) -> None:
        await self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    async def reply(self, req_id: Any, result: Any = None, error: Any = None) -> None:
        msg: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id}
        if error is not None:
            msg["error"] = error
        else:
            msg["result"] = result if result is not None else {}
        await self._write(msg)

    async def _write(self, msg: dict[str, Any]) -> None:
        if not self._proc or not self._proc.stdin:
            raise RuntimeError("agent not running")
        line = json.dumps(msg, ensure_ascii=False) + "\n"
        async with self._write_lock:
            self._proc.stdin.write(line.encode("utf-8"))
            await self._proc.stdin.drain()

    async def _read_stdout(self) -> None:
        assert self._proc and self._proc.stdout
        while True:
            line_b = await self._proc.stdout.readline()
            if not line_b:
                break
            line = line_b.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("non-json from agent: %s", line[:200])
                continue
            await self._dispatch(msg)

        # process died
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(RuntimeError("agent process exited"))
        self._pending.clear()
        await self._emit({"type": "agent_exit", "code": self._proc.returncode if self._proc else None})

    async def _read_stderr(self) -> None:
        assert self._proc and self._proc.stderr
        while True:
            line_b = await self._proc.stderr.readline()
            if not line_b:
                break
            text = line_b.decode("utf-8", errors="replace").rstrip()
            if text:
                logger.debug("agent stderr: %s", text)
                await self._emit({"type": "stderr", "text": text})

    async def _dispatch(self, msg: dict[str, Any]) -> None:
        # Response to our request
        if "id" in msg and ("result" in msg or "error" in msg) and "method" not in msg:
            rid = msg["id"]
            fut = self._pending.pop(rid, None)
            if fut and not fut.done():
                if "error" in msg:
                    fut.set_exception(RuntimeError(json.dumps(msg["error"])))
                else:
                    fut.set_result(msg.get("result"))
            return

        method = msg.get("method")
        if not method:
            return

        # Incoming request from agent (needs reply)
        if "id" in msg and method:
            await self._handle_agent_request(msg)
            return

        # Notification
        if method == "session/update":
            params = msg.get("params") or {}
            update = params.get("update") or {}
            await self._emit(
                {
                    "type": "session_update",
                    "sessionId": params.get("sessionId"),
                    "update": update,
                    "meta": params.get("_meta"),
                }
            )
            return

        await self._emit({"type": "notification", "method": method, "params": msg.get("params")})

    async def _handle_agent_request(self, msg: dict[str, Any]) -> None:
        method = msg["method"]
        req_id = msg["id"]
        params = msg.get("params") or {}

        if method == "session/request_permission":
            options = params.get("options") or []
            if self.always_approve:
                option_id = _pick_allow_option(options)
                await self.reply(
                    req_id,
                    {"outcome": {"outcome": "selected", "optionId": option_id}},
                )
                await self._emit(
                    {
                        "type": "permission_auto",
                        "toolCall": params.get("toolCall"),
                        "optionId": option_id,
                    }
                )
            else:
                # Forward to UI; main.py will call reply later.
                await self._emit(
                    {
                        "type": "permission",
                        "id": req_id,
                        "sessionId": params.get("sessionId"),
                        "toolCall": params.get("toolCall"),
                        "options": options,
                    }
                )
            return

        if method in ("fs/read_text_file", "fs/readTextFile"):
            path = params.get("path") or params.get("uri", "").removeprefix("file://")
            try:
                text = Path(path).read_text(encoding="utf-8", errors="replace")
                # ACP often expects { content: "..." }
                await self.reply(req_id, {"content": text})
            except Exception as e:
                await self.reply(req_id, error={"code": -32000, "message": str(e)})
            return

        if method in ("fs/write_text_file", "fs/writeTextFile"):
            path = params.get("path") or params.get("uri", "").removeprefix("file://")
            content = params.get("content") or params.get("text") or ""
            try:
                p = Path(path)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(content, encoding="utf-8")
                await self.reply(req_id, {})
            except Exception as e:
                await self.reply(req_id, error={"code": -32000, "message": str(e)})
            return

        # Unknown agent→client request: acknowledge empty to avoid hangs
        logger.warning("unhandled agent request: %s", method)
        await self.reply(req_id, {})
        await self._emit(
            {
                "type": "agent_request",
                "method": method,
                "id": req_id,
                "params": params,
            }
        )


def _pick_allow_option(options: list[dict[str, Any]]) -> str:
    for o in options:
        kind = (o.get("kind") or "").lower()
        oid = o.get("optionId") or o.get("id") or ""
        if "allow_always" in kind or oid == "allow-always":
            return oid
    for o in options:
        kind = (o.get("kind") or "").lower()
        oid = o.get("optionId") or o.get("id") or ""
        if "allow" in kind or "allow" in oid:
            return oid
    if options:
        return options[0].get("optionId") or options[0].get("id") or "allow-once"
    return "allow-once"


def default_cwd() -> str:
    env = os.environ.get("GROK_CHAT_CWD")
    if env and Path(env).is_dir():
        return str(Path(env).expanduser().resolve())
    home = Path.home()
    for candidate in (
        home / "Developer",
        home / "Projects",
        home / "Code",
        home / "workspaces",
        Path("/mnt/workspaces"),
        home,
    ):
        if candidate.is_dir():
            return str(candidate.resolve())
    return str(Path.cwd().resolve())
