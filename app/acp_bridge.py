"""ACP (Agent Client Protocol) bridge: spawns `grok agent stdio` and talks JSON-RPC."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal as _signal
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger("grok_chat.acp")

EventHandler = Callable[[dict[str, Any]], Awaitable[None]]

DEFAULT_OUTPUT_BYTE_LIMIT = 1_048_576


class _Terminal:
    """One agent-requested command (ACP terminal/*) with byte-capped rolling output."""

    def __init__(self, proc: asyncio.subprocess.Process, output_byte_limit: int) -> None:
        self.proc = proc
        self.limit = output_byte_limit
        self.buf = bytearray()
        self.truncated = False
        self.exit_status: Optional[dict[str, Any]] = None
        self._done = asyncio.Event()
        self._pump_task = asyncio.create_task(self._pump())

    async def _pump(self) -> None:
        assert self.proc.stdout
        while True:
            chunk = await self.proc.stdout.read(65536)
            if not chunk:
                break
            self.buf.extend(chunk)
            if len(self.buf) > self.limit:
                # ACP: truncate from the beginning, keep the tail
                del self.buf[: len(self.buf) - self.limit]
                self.truncated = True
        rc = await self.proc.wait()
        if rc is not None and rc < 0:
            try:
                sig_name = _signal.Signals(-rc).name
            except ValueError:
                sig_name = f"SIG{-rc}"
            self.exit_status = {"exitCode": None, "signal": sig_name}
        else:
            self.exit_status = {"exitCode": rc, "signal": None}
        self._done.set()

    def output(self) -> dict[str, Any]:
        return {
            "output": self.buf.decode("utf-8", errors="replace"),
            "truncated": self.truncated,
            "exitStatus": self.exit_status,
        }

    async def wait_for_exit(self) -> dict[str, Any]:
        await self._done.wait()
        assert self.exit_status is not None
        return self.exit_status

    def kill(self) -> None:
        if self.proc.returncode is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), _signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    self.proc.kill()
                except ProcessLookupError:
                    pass

    def release(self) -> None:
        self.kill()


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
        self._terminals: dict[str, _Terminal] = {}
        self._agent_req_tasks: set[asyncio.Task] = set()
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
        for term in self._terminals.values():
            term.release()
        self._terminals.clear()
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
        await self._emit({"type": "session", "sessionId": sid, "cwd": cwd_path, "fresh": True})
        return sid

    async def load_session(self, session_id: str, cwd: str) -> str:
        """Resume a previous ACP session (local list only; no cloud listing)."""
        await self.ensure_running()
        cwd_path = str(Path(cwd).expanduser().resolve())
        if not Path(cwd_path).is_dir():
            raise FileNotFoundError(f"cwd is not a directory: {cwd_path}")
        # Client should clear UI first; agent replays history via session/update
        await self._emit({"type": "session_load_start", "sessionId": session_id, "cwd": cwd_path})
        await self.request(
            "session/load",
            {"sessionId": session_id, "cwd": cwd_path, "mcpServers": []},
            timeout=120,
        )
        self.session_id = session_id
        self.cwd = cwd_path
        await self._emit(
            {
                "type": "session",
                "sessionId": session_id,
                "cwd": cwd_path,
                "loaded": True,
            }
        )
        await self._emit({"type": "session_load_end", "sessionId": session_id})
        return session_id

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

        # Incoming request from agent (needs reply). Run in its own task:
        # terminal/wait_for_exit blocks until the command finishes, and the
        # reader loop must keep consuming messages (e.g. terminal/kill).
        if "id" in msg and method:
            task = asyncio.create_task(self._handle_agent_request(msg))
            self._agent_req_tasks.add(task)
            task.add_done_callback(self._agent_req_tasks.discard)
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

        if method == "terminal/create":
            try:
                tid = await self._terminal_create(params)
                await self.reply(req_id, {"terminalId": tid})
            except Exception as e:
                await self.reply(req_id, error={"code": -32000, "message": str(e)})
            return

        if method in ("terminal/output", "terminal/wait_for_exit", "terminal/kill", "terminal/release"):
            term = self._terminals.get(params.get("terminalId") or "")
            if term is None:
                await self.reply(
                    req_id,
                    error={"code": -32000, "message": f"unknown terminalId: {params.get('terminalId')}"},
                )
                return
            if method == "terminal/output":
                await self.reply(req_id, term.output())
            elif method == "terminal/wait_for_exit":
                await self.reply(req_id, await term.wait_for_exit())
            elif method == "terminal/kill":
                term.kill()
                await self.reply(req_id, {})
            else:  # terminal/release
                term.release()
                self._terminals.pop(params.get("terminalId"), None)
                await self.reply(req_id, {})
            return

        # Unknown agent→client request: report it instead of faking success —
        # an empty {} result breaks the agent's response deserialization.
        logger.warning("unhandled agent request: %s", method)
        await self.reply(
            req_id,
            error={"code": -32601, "message": f"method not supported by client: {method}"},
        )
        await self._emit(
            {
                "type": "agent_request",
                "method": method,
                "id": req_id,
                "params": params,
            }
        )

    async def _terminal_create(self, params: dict[str, Any]) -> str:
        command = params.get("command") or ""
        args = params.get("args") or []
        cwd = params.get("cwd") or self.cwd or os.getcwd()
        if not Path(cwd).is_dir():
            raise FileNotFoundError(f"cwd is not a directory: {cwd}")
        env = dict(os.environ)
        for pair in params.get("env") or []:
            name = pair.get("name")
            if name:
                env[name] = pair.get("value") or ""
        limit = params.get("outputByteLimit") or DEFAULT_OUTPUT_BYTE_LIMIT

        if args:
            proc = await asyncio.create_subprocess_exec(
                command,
                *[str(a) for a in args],
                cwd=cwd,
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
        else:
            # No args: treat command as a shell line (covers both "ls" and "ls -la | wc")
            proc = await asyncio.create_subprocess_shell(
                command,
                cwd=cwd,
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
        tid = f"term-{uuid.uuid4().hex[:12]}"
        self._terminals[tid] = _Terminal(proc, limit)
        logger.info("terminal/create %s: %s %s (cwd=%s)", tid, command, args, cwd)
        return tid


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
