#!/usr/bin/env python3
"""Run the compiled Windows tests in an already prepared Wine 10 container.

Inside the container (repository mounted at /work):
  WINEPREFIX=/work/build/wine10-prefix python3 /work/distribution/windows/verify-wine.py

This script installs nothing and does not start a container. The coordinator
supplies Wine 10, Xvfb, Mesa lavapipe, Python 3, and an isolated Wine prefix.
It tests console executables and Vulkan through Wine; GUI/WebView2, a physical
Windows machine, the installer, and an RTX GPU are outside this proof.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "artifacts/Compiled-Windows-13304"
HOST = RUNTIME / "spektralab-host.exe"
RESOURCES = RUNTIME / "host/engine"
CLI = RUNTIME / "SpektraLab-CLI.exe"
TEST_DIR = ROOT / "build/windows-test-proof"


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def lavapipe_icd() -> Path:
    configured = os.environ.get("SPEKTRALAB_LAVAPIPE_ICD")
    if configured:
        return Path(configured)
    candidates = (
        Path("/usr/share/vulkan/icd.d/lvp_icd.x86_64.json"),
        Path("/usr/share/vulkan/icd.d/lvp_icd.json"),
        Path("/etc/vulkan/icd.d/lvp_icd.x86_64.json"),
        Path("/etc/vulkan/icd.d/lvp_icd.json"),
    )
    return next((path for path in candidates if path.is_file()), candidates[0])


def json_rows(output: str) -> list[dict]:
    rows = [json.loads(line) for line in output.splitlines() if line.strip()]
    if not all(isinstance(row, dict) for row in rows):
        raise AssertionError("CLI output contains a non-object JSON row")
    return rows


def check_unit(code: int, output: str) -> None:
    assert code == 0, f"Rust test PE exited {code}"
    assert re.search(r"test result: ok\.", output), "Rust test PE did not report a passing test result"


def check_host(code: int, output: str) -> None:
    assert code == 0, f"Windows host smoke exited {code}"
    line = next((line for line in output.splitlines() if line.strip().startswith("backend:")), None)
    assert line, "host smoke omitted its backend identity"
    backend = ast.literal_eval(line.split("backend:", 1)[1].strip())
    assert backend.get("api") == "vulkan" and backend.get("available") is True, backend
    assert backend.get("render_core") == "native-vulkan", backend
    assert "PASS:" in output, "host smoke did not report its passing result"


def check_cli_status(code: int, output: str) -> None:
    rows = json_rows(output)
    assert code == 0 and len(rows) == 1, (code, rows)
    assert rows[0].get("access") is False and rows[0].get("version") == "1.3.3", rows


def check_cli_schema(code: int, output: str) -> None:
    rows = json_rows(output)
    assert code == 2 and len(rows) == 1 and rows[0].get("error", {}).get("code") == "refused", (code, rows)


def check_cli_mcp(code: int, output: str) -> None:
    rows = json_rows(output)
    assert code == 0 and len(rows) == 5, (code, rows)
    assert rows[0]["result"]["serverInfo"]["version"] == "1.3.3"
    assert rows[1]["result"] == {} and len(rows[2]["result"]["tools"]) == 12
    assert rows[3]["error"]["code"] == -32601 and rows[4]["result"]["isError"]
    refusal = json.loads(rows[4]["result"]["content"][0]["text"])
    assert refusal["error"]["code"] == "refused", refusal


def run_step(name: str, command: list[str], output_dir: Path, environment: dict[str, str],
             receipt: dict, *, input_text: str | None = None, expected=None, timeout=240) -> None:
    log = output_dir / f"{name}.log"
    start = time.monotonic()
    code: int | None = None
    try:
        process = subprocess.run(command, input=input_text, text=True, capture_output=True,
                                 env=environment, timeout=timeout, check=False)
        code = process.returncode
        output = process.stdout
        log.write_text("COMMAND: " + " ".join(command) + "\n\nSTDOUT:\n" + output +
                       "\nSTDERR:\n" + process.stderr, encoding="utf-8")
        if expected:
            expected(code, output)
        elif code != 0:
            raise AssertionError(f"exit {code}")
        status, detail = "passed", ""
    except (OSError, subprocess.TimeoutExpired, AssertionError, ValueError, KeyError, SyntaxError) as error:
        status, detail = "failed", str(error)
        if not log.exists():
            log.write_text("COMMAND: " + " ".join(command) + "\n\nERROR: " + detail + "\n", encoding="utf-8")
    try:
        log_path = str(log.relative_to(ROOT))
    except ValueError:
        log_path = str(log)
    receipt["steps"][name] = {"status": status, "exit_code": code, "duration_seconds": round(time.monotonic()-start, 3),
                              "command": command, "log": log_path, "detail": detail}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/wine10-verification",
                        help="directory for logs and receipt (default: artifacts/wine10-verification)")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    prefix = Path(os.environ.get("WINEPREFIX", "/work/build/wine10-prefix"))
    wine = Path(os.environ.get("SPEKTRALAB_WINE64", "/usr/lib/wine/wine64"))
    icd = lavapipe_icd()
    units = sorted(TEST_DIR.glob("*.exe"))
    required = [HOST, RESOURCES / "vulkan", CLI, wine, icd]
    missing = [str(path) for path in required if not path.exists()]
    if not units:
        missing.append(str(TEST_DIR / "*.exe"))
    for program in ("python3", "xvfb-run"):
        if shutil.which(program) is None:
            missing.append(program)
    environment = dict(os.environ, WINEPREFIX=str(prefix), WINEDEBUG="-all",
                       LIBGL_ALWAYS_SOFTWARE="1", VK_ICD_FILENAMES=str(icd))
    receipt = {
        "schema": 1, "created_utc": datetime.now(timezone.utc).isoformat(),
        "scope": "Wine 10 console PE tests and software Vulkan host; no installer or GUI execution",
        "wine_prefix": str(prefix), "lavapipe_icd": str(icd),
        "gui_webview2_tested": False, "physical_windows_tested": False,
        "physical_gpu_tested": False, "installer_tested": False,
        "rust_compiler_version_from_pe_verified": False,
        "inputs": {str(path.relative_to(ROOT)): digest(path) for path in [*units, HOST, CLI] if path.is_file()},
        "steps": {}, "preflight_missing": missing,
    }
    receipt_path = output / "receipt.json"
    if missing:
        receipt["status"] = "blocked"
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        print(f"Wine preflight missing: {', '.join(missing)}", file=sys.stderr)
        print(receipt_path)
        return 2

    version = subprocess.run([str(wine), "--version"], text=True, capture_output=True, timeout=20, env=environment)
    receipt["wine_version_output"] = (version.stdout + version.stderr).strip()
    major = re.search(r"wine-([0-9]+)", receipt["wine_version_output"])
    if version.returncode != 0 or not major or int(major.group(1)) < 10:
        receipt["status"] = "blocked"
        receipt["preflight_missing"].append("Wine 10 or newer")
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        print(f"Wine 10 required: {receipt['wine_version_output']}", file=sys.stderr)
        return 2

    display = ["xvfb-run", "-a"]
    for unit in units:
        run_step("rust-unit-" + unit.stem, display + [str(wine), str(unit), "--nocapture", "--test-threads=2"],
                 output, environment, receipt, expected=check_unit, timeout=180)
    run_step("windows-host-vulkan-smoke", display + [sys.executable, str(ROOT / "engine/tests/host_smoke.py"),
                 "--wrapper", str(wine), "--host", str(HOST), "--resources", str(RESOURCES)],
             output, environment, receipt, expected=check_host, timeout=480)
    cli_base = display + [str(wine), str(CLI)]
    run_step("windows-cli-status", cli_base + ["status"], output, environment, receipt, expected=check_cli_status)
    run_step("windows-cli-schema-refusal", cli_base + ["schema"], output, environment, receipt, expected=check_cli_schema)
    requests = [{"jsonrpc":"2.0","id":i,"method":method} for i,method in enumerate(("initialize","ping","tools/list","unknown"))]
    requests.append({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_schema","arguments":{}}})
    run_step("windows-cli-mcp", cli_base + ["mcp"], output, environment, receipt,
             input_text="\n".join(map(json.dumps, requests)) + "\n", expected=check_cli_mcp)
    receipt["status"] = "passed" if all(step["status"] == "passed" for step in receipt["steps"].values()) else "failed"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"{receipt['status'].upper()}: {receipt_path}")
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
