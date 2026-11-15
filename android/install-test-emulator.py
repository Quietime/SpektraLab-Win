#!/usr/bin/env python3
"""Plan or install pinned official host tools for API 29 x86_64 emulator tests.

No network or disk mutation occurs in the default plan mode. Explicit --install
downloads and verifies each complete Google ZIP before extraction. The system
image uses sparse writes for zero-filled 4 KiB blocks to fit the test disk.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import tempfile
import urllib.request
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SDK = Path(os.environ.get("ANDROID_HOME", ROOT / "build/android-sdk"))
PACKAGES = {
    "platform-tools": {
        "url": "https://dl.google.com/android/repository/platform-tools_r37.0.3-linux.zip",
        "size": 9571024,
        "sha1": "e1579b288a7ae4e9bc28dedec6a154d78b3c04ed",
        "archive_root": "platform-tools/",
        "destination": SDK / "platform-tools",
        "reserve_mib": 64,
    },
    "emulator": {
        "url": "https://dl.google.com/android/repository/emulator-linux_x64-16863232.zip",
        "size": 350070672,
        "sha1": "5c3eeebb678f7f94a45a0b963409d8e875d1962d",
        "archive_root": "emulator/",
        "destination": SDK / "emulator",
        "reserve_mib": 1350,
    },
    "api29-image": {
        "url": "https://dl.google.com/android/repository/sys-img/android/x86_64-29_r08-linux.zip",
        "size": 689676765,
        "sha1": "e4b798d6fcddff90d528d74ef22ce3dd4a2ca798",
        "archive_root": "x86_64/",
        "destination": SDK / "system-images/android-29/default/x86_64",
        "reserve_mib": 2350,
    },
}
PAGE = 4096


def digest(path, algorithm):
    value = hashlib.new(algorithm)
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def download(package, path):
    total = 0
    sha1 = hashlib.sha1()
    request = urllib.request.Request(package["url"], headers={"User-Agent": "SpektraLab-emulator-test/1"})
    with urllib.request.urlopen(request, timeout=90) as response, path.open("wb") as output:
        if response.status != 200:
            raise ValueError("Official download did not return HTTP 200")
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > package["size"]:
                raise ValueError("Archive exceeds pinned size")
            sha1.update(chunk)
            output.write(chunk)
    if total != package["size"] or sha1.hexdigest() != package["sha1"]:
        raise ValueError("Official archive size or SHA-1 mismatch")
    return {"archive_bytes": total, "archive_sha1": sha1.hexdigest(), "archive_sha256": digest(path, "sha256")}


def sparse_copy(source, output):
    logical = 0
    while chunk := source.read(1024 * 1024):
        for offset in range(0, len(chunk), PAGE):
            block = chunk[offset:offset + PAGE]
            if block.strip(b"\0"):
                output.write(block)
            else:
                output.seek(len(block), os.SEEK_CUR)
            logical += len(block)
        if logical % (32 * 1024 * 1024) == 0 and shutil.disk_usage(Path(output.name).parent).free < 512 * 1024 * 1024:
            raise OSError("Sparse image extraction is approaching disk capacity")
    output.truncate(logical)


def extract(package, archive, destination, sparse):
    prefix = package["archive_root"]
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        for item in entries:
            name = item.filename
            if name == prefix:
                continue
            if not name.startswith(prefix):
                raise ValueError("Unexpected official archive root: " + name)
            relative = name[len(prefix):]
            parts = PurePosixPath(relative).parts
            if relative.startswith("/") or ".." in parts or not relative:
                raise ValueError("Unsafe ZIP path: " + name)
            target = destination / relative
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            mode = item.external_attr >> 16
            if stat.S_ISLNK(mode):
                link = source.read(item).decode("utf-8")
                resolved = (target.parent / link).resolve(strict=False)
                if not resolved.is_relative_to(destination.resolve()):
                    raise ValueError("ZIP symlink escapes destination: " + name)
                target.symlink_to(link)
            else:
                with source.open(item) as input_file, target.open("wb") as output:
                    if sparse and relative.endswith(".img"):
                        sparse_copy(input_file, output)
                    else:
                        shutil.copyfileobj(input_file, output, length=1024 * 1024)
                if mode & 0o111:
                    target.chmod(target.stat().st_mode | 0o111)
        for item in entries:
            if item.filename.startswith(prefix) and stat.S_ISLNK(item.external_attr >> 16):
                relative = item.filename[len(prefix):]
                if not (destination / relative).exists():
                    raise ValueError("ZIP symlink target missing: " + relative)
    allocated = sum(p.lstat().st_blocks * 512 for p in destination.rglob("*") if p.is_file() or p.is_symlink())
    return {"entries": len(entries), "allocated_bytes": allocated}


def install(kind):
    package = PACKAGES[kind]
    destination = package["destination"]
    if destination.exists():
        raise FileExistsError("Refusing to overwrite " + str(destination))
    destination.parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(destination.parent).free < package["reserve_mib"] * 1024 * 1024:
        raise OSError("Insufficient free space for " + kind + "; finish earlier build stages first")
    with tempfile.TemporaryDirectory(prefix="official-emulator-", dir=destination.parent) as work:
        archive = Path(work) / "official.zip"
        receipt = download(package, archive)
        partial = Path(work) / "extracted"
        partial.mkdir()
        receipt.update(extract(package, archive, partial, kind == "api29-image"))
        archive.unlink()
        partial.rename(destination)
    receipt.update({"package": kind, "url": package["url"], "destination": str(destination)})
    print(json.dumps(receipt, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true", help="Download verified official ZIPs and extract")
    parser.add_argument("--package", choices=[*PACKAGES, "all"], default="all")
    args = parser.parse_args()
    chosen = list(PACKAGES) if args.package == "all" else [args.package]
    if not args.install:
        print(json.dumps({"mode": "plan", "packages": {
            key: {**PACKAGES[key], "destination": str(PACKAGES[key]["destination"])}
            for key in chosen
        }, "expanded_mib": {"platform-tools": 21.8, "emulator": 851.6,
                            "api29-image_logical": 3217.5},
            "image_extraction": "Sparse 4 KiB zero blocks; actual allocated size must be measured after installation",
        }, indent=2))
        return
    for kind in chosen:
        install(kind)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        sys.exit(str(error))
