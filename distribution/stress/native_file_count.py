#!/usr/bin/env python3
"""Exercise many real raster inputs and repeated native render lifecycles.

Creates 1000 independent, Unicode-named TIFFs and probes each over the real
stdio host protocol, then opens/renders/closes 32 images with changing sizes.
Each close is followed by a native memory_report check for zero live/pending
pool bytes and clean audit fault counters. SHA-256 for all 1032 input files is
checked before and after. RSS is sampled from the host process; the report
does not claim VRAM plateau or physical-GPU coverage. Standard library only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import time

from native_image_budget import Host, write_tiff16


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", type=Path, required=True)
    ap.add_argument("--resources", type=Path, required=True)
    ap.add_argument("--work-dir", type=Path)
    ap.add_argument("--receipt", type=Path)
    ap.add_argument("--timeout", type=float, default=180.0, help="per host request timeout")
    ap.add_argument("--run-timeout", type=float, default=1200.0, help="whole run timeout")
    ap.add_argument("--probes", type=int, default=1000)
    ap.add_argument("--cycles", type=int, default=32)
    args = ap.parse_args()
    if args.probes < 1000 or args.cycles < 32:
        ap.error("stress thresholds are at least 1000 probes and 32 render cycles")
    folder = args.work_dir or Path(tempfile.mkdtemp(prefix="spk-many-files-"))
    folder.mkdir(parents=True, exist_ok=True)
    probe_files: list[Path] = []
    cycle_files: list[Path] = []
    started = time.monotonic()
    rss: list[int] = []
    sample_stop = threading.Event()
    host: Host | None = None
    receipt: dict = {"test": "native-file-count", "probe_target": args.probes,
                     "render_cycle_target": args.cycles, "passed": False,
                     "gpu_pool_plateau_claimed": False}
    try:
        for i in range(args.probes):
            path = folder / f"照片-{i:04d}-雪景.tif"
            write_tiff16(path, 32, 24)
            probe_files.append(path)
        for i in range(args.cycles):
            # Deterministic dimensions spanning thumbnail-scale to modest print-scale.
            width = 320 + (i * 257) % 1601
            height = 240 + (i * 173) % 817
            path = folder / f"周期-{i:02d}-画像-{width}x{height}.tif"
            write_tiff16(path, width, height)
            cycle_files.append(path)
        inputs = probe_files + cycle_files
        before_hashes = {p.name: sha256(p) for p in inputs}
        receipt.update({"input_count": len(inputs), "input_hashes_before": before_hashes,
                        "probe_rows": [], "render_cycles": []})
        host = Host([str(args.host.resolve()), "--resources", str(args.resources.resolve())],
                    dict(os.environ), args.timeout, args.run_timeout)

        def sample_rss() -> None:
            while not sample_stop.wait(0.1):
                try:
                    status = Path(f"/proc/{host.proc.pid}/status")
                    for line in status.read_text().splitlines():
                        if line.startswith("VmRSS:"):
                            rss.append(int(line.split()[1]) * 1024)
                            break
                except (OSError, AttributeError):
                    pass

        sampler = threading.Thread(target=sample_rss, daemon=True)
        sampler.start()
        hello, _ = host.call("hello")
        assert hello.get("ok") and hello["result"].get("protocol") == 1, hello
        probe_rows = []
        probe_started = time.monotonic()
        for path in probe_files:
            tick = time.monotonic()
            reply, _ = host.call("probe", {"path": str(path)})
            elapsed = time.monotonic() - tick
            assert reply.get("ok"), (path.name, reply)
            result = reply["result"]
            assert (result.get("width"), result.get("height")) == (32, 24), (path.name, result)
            probe_rows.append({"name": path.name, "elapsed_seconds": round(elapsed, 6),
                               "sha256": before_hashes[path.name]})
            receipt["probe_rows"] = probe_rows
            receipt["probe_count"] = len(probe_rows)
        probe_elapsed = time.monotonic() - probe_started

        cycle_rows = []
        for index, path in enumerate(cycle_files):
            tick = time.monotonic()
            opened, _ = host.call("open", {"path": str(path)})
            assert opened.get("ok"), (path.name, opened)
            result = opened["result"]
            sid = result["session"]
            expected_size = (result["width"], result["height"])
            preview, pixels = host.call("render", {"session": sid, "tier": "full", "format": "rgba8"})
            assert preview.get("ok"), (path.name, preview)
            image = preview["result"]["image"]
            closed, _ = host.call("close", {"session": sid})
            assert closed.get("ok"), (path.name, closed)
            report_reply, _ = host.call("memory_report")
            assert report_reply.get("ok"), report_reply
            report = report_reply["result"]
            pool = report["pool"]
            audit = pool["audit"]
            assert pool["live_bytes"] == 0, (index, pool)
            assert pool["pending_bytes"] == 0, (index, pool)
            bad_audit = {key: audit[key] for key in
                         ("pending_held", "live_underflows", "over_releases", "reclaim_while_encoding")
                         if audit.get(key) != 0}
            assert not bad_audit, (index, bad_audit)
            assert (image["width"], image["height"]) == expected_size, (path.name, image, expected_size)
            assert len(pixels) == image["width"] * image["height"] * 4, (path.name, len(pixels), image)
            cycle_rows.append({"index": index, "name": path.name, "dimensions": list(expected_size),
                               "render_bytes": len(pixels), "elapsed_seconds": round(time.monotonic() - tick, 6),
                               "pool_live_bytes_after_close": pool["live_bytes"],
                               "pool_pending_bytes_after_close": pool["pending_bytes"],
                               "audit_fault_counters_after_close": bad_audit,
                               "host_rss_bytes_after_close_sampled": max(rss, default=None)})
            receipt["render_cycles"] = cycle_rows

        after_hashes = {p.name: sha256(p) for p in inputs}
        assert before_hashes == after_hashes, "one or more input hashes changed"
        assert len({p.name for p in probe_files}) == args.probes and len(probe_rows) == args.probes
        assert len(cycle_rows) == args.cycles
        receipt.update({"passed": True, "probe_count": len(probe_rows), "probe_elapsed_seconds": round(probe_elapsed, 3),
                       "probe_rows": probe_rows, "render_cycles": cycle_rows,
                       "all_input_hashes_unchanged": True,
                       "input_hashes_before": before_hashes, "input_hashes_after": after_hashes,
                       "backend": hello["result"].get("backend")})
    except Exception as exc:
        receipt["failure"] = f"{type(exc).__name__}: {exc}"
        if host:
            receipt["stderr_tail"] = host.stderr_tail[-20:]
    finally:
        sample_stop.set()
        if host:
            host.shutdown()
        receipt["elapsed_seconds"] = round(time.monotonic() - started, 3)
        receipt["host_rss_peak_bytes_sampled"] = max(rss, default=None)
        receipt["host_rss_sample_count"] = len(rss)
        receipt["rss_is_host_process_only"] = True
        receipt["physical_gpu_claim"] = False
        if receipt.get("input_hashes_before"):
            after_hashes = {p.name: sha256(p) for p in probe_files + cycle_files if p.exists()}
            receipt["input_hashes_after"] = after_hashes
            receipt["all_input_hashes_unchanged"] = after_hashes == receipt["input_hashes_before"]
        else:
            receipt["all_input_hashes_unchanged"] = False
        receipt_path = args.receipt or folder / "native-file-count.receipt.json"
        receipt_path.parent.mkdir(parents=True, exist_ok=True)
        receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(receipt, ensure_ascii=False, indent=2), flush=True)
    return 0 if receipt["passed"] and receipt.get("all_input_hashes_unchanged") else 1


if __name__ == "__main__":
    raise SystemExit(main())
