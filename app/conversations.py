"""Server-side conversation store (this machine's disk — not browser cache)."""

from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

# Under workspaces bind-mount so it survives container rebuilds.
DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "conversations"


class ConversationStore:
    def __init__(self, root: Optional[Path] = None) -> None:
        self.root = Path(root or DEFAULT_DATA_DIR)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.active_id: Optional[str] = None

    def _path(self, conv_id: str) -> Path:
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in conv_id)
        return self.root / f"{safe}.json"

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            items: list[dict[str, Any]] = []
            for p in self.root.glob("*.json"):
                if p.name.endswith(".tmp"):
                    continue
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                except Exception:
                    continue
                items.append(self.meta(data))
            items.sort(key=lambda x: x.get("updatedAt") or 0, reverse=True)
            return items

    def meta(self, data: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": data.get("id"),
            "title": data.get("title") or "新对话",
            "cwd": data.get("cwd") or "",
            "acpSessionId": data.get("acpSessionId"),
            "createdAt": data.get("createdAt"),
            "updatedAt": data.get("updatedAt"),
            "messageCount": len(data.get("messages") or []),
        }

    def get(self, conv_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            p = self._path(conv_id)
            if not p.is_file():
                return None
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                return None

    def save(self, data: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            cid = data["id"]
            data["updatedAt"] = int(time.time() * 1000)
            if "createdAt" not in data:
                data["createdAt"] = data["updatedAt"]
            path = self._path(cid)
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(path)
            return data

    def create(
        self,
        *,
        cwd: str,
        acp_session_id: Optional[str] = None,
        title: str = "新对话",
        conv_id: Optional[str] = None,
    ) -> dict[str, Any]:
        now = int(time.time() * 1000)
        data = {
            "id": conv_id or str(uuid.uuid4()),
            "title": title,
            "cwd": cwd,
            "acpSessionId": acp_session_id,
            "createdAt": now,
            "updatedAt": now,
            "messages": [],
        }
        self.save(data)
        self.active_id = data["id"]
        return data

    def delete(self, conv_id: str) -> bool:
        with self._lock:
            p = self._path(conv_id)
            if not p.is_file():
                return False
            p.unlink()
            if self.active_id == conv_id:
                self.active_id = None
            return True

    def bind_acp(self, conv_id: str, acp_session_id: str, cwd: Optional[str] = None) -> None:
        data = self.get(conv_id)
        if not data:
            return
        data["acpSessionId"] = acp_session_id
        if cwd:
            data["cwd"] = cwd
        self.save(data)
        self.active_id = conv_id

    def append_message(
        self,
        conv_id: str,
        role: str,
        content: str,
        *,
        thought: str = "",
        extra: Optional[dict[str, Any]] = None,
    ) -> None:
        data = self.get(conv_id)
        if not data:
            return
        msg: dict[str, Any] = {
            "role": role,
            "content": content or "",
            "ts": int(time.time() * 1000),
        }
        if thought:
            msg["thought"] = thought
        if extra:
            msg.update(extra)
        data.setdefault("messages", []).append(msg)
        if role == "user" and (not data.get("title") or data.get("title") == "新对话"):
            t = (content or "").strip().replace("\n", " ")
            if t:
                data["title"] = t[:40]
        self.save(data)
        self.active_id = conv_id

    def find_by_acp(self, acp_session_id: str) -> Optional[dict[str, Any]]:
        if not acp_session_id:
            return None
        with self._lock:
            for p in self.root.glob("*.json"):
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                except Exception:
                    continue
                if data.get("acpSessionId") == acp_session_id:
                    return data
        return None

    def ensure_for_acp(self, acp_session_id: str, cwd: str) -> dict[str, Any]:
        existing = self.find_by_acp(acp_session_id)
        if existing:
            self.active_id = existing["id"]
            return existing
        return self.create(cwd=cwd, acp_session_id=acp_session_id)


store = ConversationStore()
