#!/usr/bin/env python3
"""Real-host VRAM-budget refusal and recovery check (stdlib only).

Writes a row-streamed, uncompressed 8192x4096 RGB16 TIFF (192 MiB on disk),
starts a fresh host with SPEKTRALAB_VRAM_BUDGET_MB=128, and requires the exact
controlled heap-budget diagnostic. A 64x48 image is then opened and rendered
in that same process. This exercises real TIFF I/O and Vulkan allocation; it
does not allocate a multi-gigabyte image in Python or claim physical-GPU
coverage. A JSON receipt records elapsed time and sampled host RSS.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import struct
import subprocess
import sys
import tempfile
import threading
import time

MiB = 1 << 20
BUDGET_RE = re.compile(
    r"^(?:open|render full): Vulkan memory budget exceeded on heap \d+ "
    r"\(requested \d+ MiB, committed \d+ MiB, limit 128 MiB\)$"
)


def write_tiff16(path: Path, width: int, height: int) -> None:
    """Stream an uncompressed little-endian RGB16 TIFF without image libraries."""
    entries = [
        (256, 4, 1, width), (257, 4, 1, height), (258, 3, 3, None),
        (259, 3, 1, 1), (262, 3, 1, 2), (273, 4, 1, None),
        (277, 3, 1, 3), (278, 4, 1, height), (279, 4, 1, width * height * 6),
        (284, 3, 1, 1),
    ]
    ifd = 8
    extras = ifd + 2 + 12 * len(entries) + 4
    bps = extras
    pixels = bps + 6
    with path.open("wb") as f:
        f.write(b"II*\0" + struct.pack("<I", ifd) + struct.pack("<H", len(entries)))
        for tag, typ, count, value in entries:
            if tag == 258:
                f.write(struct.pack("<HHII", tag, typ, count, bps))
            elif tag == 273:
                f.write(struct.pack("<HHII", tag, typ, count, pixels))
            elif typ == 3:
                f.write(struct.pack("<HHIHH", tag, typ, count, value, 0))
            else:
                f.write(struct.pack("<HHII", tag, typ, count, value))
        f.write(struct.pack("<I", 0) + struct.pack("<HHH", 16, 16, 16))
        # Non-constant horizontal/vertical ramp; one reusable row bounds RAM.
        row = bytearray(width * 6)
        for x in range(width):
            struct.pack_into("<HHH", row, x * 6, (x * 65535) // max(1, width - 1), 12000, 42000)
        for y in range(height):
            if y:
                value = (y * 65535) // max(1, height - 1)
                for x in range(width):
                    struct.pack_into("<H", row, x * 6 + 2, value)
            f.write(row)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


class Host:
    def __init__(self, command: list[str], env: dict[str, str], timeout: float, run_timeout: float):
        self.proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, bufsize=0, env=env)
        self.timeout = timeout
        self.run_deadline = time.monotonic() + run_timeout
        self.next_id = 1
        self.replies: queue.Queue[tuple[dict, bytes] | BaseException] = queue.Queue()
        self.stderr_tail: list[str] = []
        threading.Thread(target=self._read_frames, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stderr(self) -> None:
        assert self.proc.stderr
        for raw in iter(self.proc.stderr.readline, b""):
            self.stderr_tail.append(raw.decode("utf-8", "replace").rstrip())
            del self.stderr_tail[:-40]

    def _read_exact(self, n: int) -> bytes:
        assert self.proc.stdout
        chunks = bytearray()
        while len(chunks) < n:
            part = self.proc.stdout.read(n - len(chunks))
            if not part:
                raise EOFError("host closed stdout: " + "\n".join(self.stderr_tail[-12:]))
            chunks.extend(part)
        return bytes(chunks)

    def _read_frames(self) -> None:
        try:
            while True:
                head_len, payload_len = struct.unpack("<II", self._read_exact(8))
                head = json.loads(self._read_exact(head_len))
                payload = self._read_exact(payload_len) if payload_len else b""
                self.replies.put((head, payload))
        except BaseException as exc:
            self.replies.put(exc)

    def call(self, method: str, params: dict | None = None, payload: bytes = b"") -> tuple[dict, bytes]:
        rid = self.next_id
        self.next_id += 1
        header = json.dumps({"id": rid, "method": method, "params": params or {}}).encode()
        assert self.proc.stdin
        self.proc.stdin.write(struct.pack("<II", len(header), len(payload)) + header + payload)
        self.proc.stdin.flush()
        deadline = min(time.monotonic() + self.timeout, self.run_deadline)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"host request {method} exceeded request/run timeout")
            item = self.replies.get(timeout=remaining)
            if isinstance(item, BaseException):
                raise item
            reply, data = item
            if reply.get("event"):
                continue
            if reply.get("id") == rid:
                return reply, data
            raise RuntimeError(f"unexpected host reply id: {reply!r}")

    def shutdown(self) -> None:
        if self.proc.poll() is None:
            try:
                self.call("shutdown")
            except Exception:
                pass
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", type=Path, required=True)
    ap.add_argument("--resources", type=Path, required=True)
    ap.add_argument("--work-dir", type=Path)
    ap.add_argument("--receipt", type=Path, help="JSON receipt path (default: alongside TIFF)")
    ap.add_argument("--timeout", type=float, default=180.0, help="per host request timeout")
    ap.add_argument("--run-timeout", type=float, default=600.0, help="whole run timeout")
    args = ap.parse_args()
    root = args.work_dir or Path(tempfile.mkdtemp(prefix="spk-vram-budget-"))
    root.mkdir(parents=True, exist_ok=True)
    large, small = root / "budget-8192x4096-192MiB.tif", root / "recovery-64x48.tif"
    started = time.monotonic()
    sample_stop = threading.Event()
    rss_samples: list[int] = []
    host: Host | None = None
    receipt: dict = {"test": "native-vram-budget", "budget_mib": 128,
                     "large_dimensions": [8192, 4096], "large_uncompressed_bytes": 192 * MiB,
                     "small_dimensions": [64, 48], "passed": False}
    try:
        write_tiff16(large, 8192, 4096)
        write_tiff16(small, 64, 48)
        large_hash_before = sha256(large)
        small_hash_before = sha256(small)
        receipt.update({"large_sha256": large_hash_before, "small_sha256": small_hash_before})
        env = dict(os.environ)
        env["SPEKTRALAB_VRAM_BUDGET_MB"] = "128"
        host = Host([str(args.host.resolve()), "--resources", str(args.resources.resolve())], env, args.timeout, args.run_timeout)

        def sample_rss() -> None:
            while not sample_stop.wait(0.1):
                try:
                    status = Path(f"/proc/{host.proc.pid}/status")
                    for line in status.read_text().splitlines():
                        if line.startswith("VmRSS:"):
                            rss_samples.append(int(line.split()[1]) * 1024)
                            break
                except (OSError, AttributeError):
                    pass

        sampler = threading.Thread(target=sample_rss, daemon=True)
        sampler.start()
        hello, _ = host.call("hello")
        assert hello.get("ok") and hello["result"].get("protocol") == 1, hello
        probe, _ = host.call("probe", {"path": str(large)})
        assert probe.get("ok") and probe["result"]["width"] == 8192 and probe["result"]["height"] == 4096, probe
        denied, _ = host.call("open", {"path": str(large)})
        error = denied.get("error", {})
        controlled = error.get("code") == "engine_error" and isinstance(error.get("message"), str) and bool(BUDGET_RE.fullmatch(error["message"]))
        assert controlled, f"expected exact controlled Vulkan budget refusal; got {denied!r}"

        opened, _ = host.call("open", {"path": str(small)})
        assert opened.get("ok"), opened
        sid = opened["result"]["session"]
        rendered, pixels = host.call("render", {"session": sid, "tier": "full", "format": "rgba8"})
        assert rendered.get("ok"), rendered
        image = rendered["result"]["image"]
        assert (image["width"], image["height"]) == (64, 48) and len(pixels) == 64 * 48 * 4, (image, len(pixels))
        closed, _ = host.call("close", {"session": sid})
        assert closed.get("ok"), closed
        assert sha256(large) == large_hash_before and sha256(small) == small_hash_before, "input TIFF changed"
        receipt.update({"passed": True, "budget_error": error, "recovery_render_bytes": len(pixels),
                       "backend": hello["result"].get("backend")})
    except Exception as exc:
        receipt["failure"] = f"{type(exc).__name__}: {exc}"
        if host:
            receipt["stderr_tail"] = host.stderr_tail[-20:]
    finally:
        if host:
            sample_stop.set()
            host.shutdown()
        receipt["elapsed_seconds"] = round(time.monotonic() - started, 3)
        receipt["host_rss_peak_bytes_sampled"] = max(rss_samples, default=None)
        receipt["host_rss_sample_count"] = len(rss_samples)
        receipt["rss_is_host_process_only"] = True
        receipt["physical_gpu_claim"] = False
        receipt["inputs_unchanged"] = large.exists() and small.exists() and receipt.get("large_sha256") == sha256(large) and receipt.get("small_sha256") == sha256(small)
        receipt_path = args.receipt or root / "native-image-budget.receipt.json"
        receipt_path.parent.mkdir(parents=True, exist_ok=True)
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(receipt, indent=2), flush=True)
    return 0 if receipt["passed"] and receipt.get("inputs_unchanged") else 1


if __name__ == "__main__":
    raise SystemExit(main())
