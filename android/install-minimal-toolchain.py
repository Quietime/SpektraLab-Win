#!/usr/bin/env python3
"""Install pinned official Android 35 build tools and a small NDK r27c subset.

The default is a read-only plan. Use --install explicitly when disk space is
available. The complete Google archive is checked before any files are used;
the NDK extractor then keeps only the pieces needed by build-native.sh for
arm64-v8a and x86_64 at API 29. Run a real native build before relying on the
subset for release packaging.
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
    "build-tools": {
        "url": "https://dl.google.com/android/repository/build-tools_r35_linux.zip",
        "size": 61958799,
        "sha1": "2cfaa0bbb2336e9ec18ed3ecea84fa2e2af607bc",
        "destination": SDK / "build-tools/35.0.0",
    },
    "ndk": {
        "url": "https://dl.google.com/android/repository/android-ndk-r27c-linux.zip",
        "size": 663987688,
        "sha1": "090e8083a715fdb1a3e402d0763c388abb03fb4e",
        "destination": SDK / "ndk/27.2.12479018",
    },
}
NDK_PREFIX = "android-ndk-r27c/"
HOST = "toolchains/llvm/prebuilt/linux-x86_64/"
BINARIES = {
    "clang", "clang++", "clang-18", "lld", "ld", "ld.lld", "llvm-ar",
    "llvm-ranlib", "llvm-objcopy", "llvm-strip", "llvm-nm", "llvm-readobj",
    "llvm-readelf", "llvm-size",
    "aarch64-linux-android29-clang", "aarch64-linux-android29-clang++",
    "x86_64-linux-android29-clang", "x86_64-linux-android29-clang++",
}
ROOT_FILES = {
    "source.properties", "NOTICE", "NOTICE.toolchain",
    HOST + "AndroidVersion.txt", HOST + "BUILD_INFO", HOST + "NOTICE",
}
RUNTIME_FILES = {
    HOST + "lib/clang/18/lib/linux/libclang_rt.builtins-aarch64-android.a",
    HOST + "lib/clang/18/lib/linux/libclang_rt.builtins-x86_64-android.a",
    HOST + "lib/clang/18/lib/linux/aarch64/libatomic.a",
    HOST + "lib/clang/18/lib/linux/aarch64/libunwind.a",
    HOST + "lib/clang/18/lib/linux/x86_64/libatomic.a",
    HOST + "lib/clang/18/lib/linux/x86_64/libunwind.a",
}
PREFIXES = (
    "build/cmake/", "build/core/", "meta/", HOST + "sysroot/",
    HOST + "include/", HOST + "prebuilt_include/", HOST + "share/",
    HOST + "lib/clang/18/include/", HOST + "lib/clang/18/share/",
    HOST + "lib/x86_64-unknown-linux-gnu/",
)


def selected_ndk(path):
    if path in ROOT_FILES or path in RUNTIME_FILES:
        return True
    if any(path.startswith(prefix) for prefix in PREFIXES):
        return True
    if path.startswith(HOST + "bin/"):
        return path[len(HOST + "bin/"):] in BINARIES
    if path.startswith(HOST + "lib/"):
        return path[len(HOST + "lib/"):].split("/", 1)[0] in {
            "libc++.so", "libc++.so.1", "libc++abi.so.1", "libunwind.so",
            "libxml2.so", "libxml2.so.2",
        }
    return False


def safe_path(name, prefix):
    if not name.startswith(prefix):
        raise ValueError("Unexpected archive root: " + name)
    relative = name[len(prefix):]
    parts = PurePosixPath(relative).parts
    if relative.startswith("/") or ".." in parts or not relative:
        raise ValueError("Unsafe ZIP path: " + name)
    return relative


def fetch_archive(package, destination):
    digest = hashlib.sha1()
    total = 0
    request = urllib.request.Request(package["url"], headers={"User-Agent": "SpektraLab-toolchain/1"})
    with urllib.request.urlopen(request, timeout=90) as response, destination.open("wb") as output:
        if response.status != 200:
            raise ValueError("Download did not return HTTP 200")
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > package["size"]:
                raise ValueError("Archive exceeds pinned size")
            digest.update(chunk)
            output.write(chunk)
    if total != package["size"] or digest.hexdigest() != package["sha1"]:
        raise ValueError("Official archive size or SHA-1 mismatch")
    return {"bytes": total, "sha1": digest.hexdigest(), "sha256": sha256(destination)}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def extract(archive, destination, kind):
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        prefix = NDK_PREFIX if kind == "ndk" else ""
        if kind == "build-tools":
            roots = {item.filename.split("/", 1)[0] for item in entries if item.filename}
            if len(roots) != 1:
                raise ValueError("Unexpected Build Tools archive layout")
            prefix = next(iter(roots)) + "/"
        selected = []
        for item in entries:
            if item.filename == prefix:
                continue
            relative = safe_path(item.filename, prefix)
            if kind == "build-tools" or selected_ndk(relative):
                selected.append((item, relative))
        if kind == "ndk":
            required = ROOT_FILES | RUNTIME_FILES | {HOST + "bin/" + name for name in BINARIES}
            present = {name for _, name in selected}
            missing = required - present
            if missing:
                raise ValueError("NDK selection lacks: " + ", ".join(sorted(missing)))
        for item, relative in selected:
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
                    raise ValueError("ZIP symlink escapes destination: " + relative)
                target.symlink_to(link)
            else:
                with source.open(item) as input_file, target.open("wb") as output:
                    shutil.copyfileobj(input_file, output, length=1024 * 1024)
                if mode & 0o111:
                    target.chmod(target.stat().st_mode | 0o111)
        for item, relative in selected:
            if stat.S_ISLNK(item.external_attr >> 16) and not (destination / relative).exists():
                raise ValueError("Selected NDK symlink has no target: " + relative)
    return {"extracted_entries": len(selected), "installed_bytes": sum(
        p.lstat().st_size for p in destination.rglob("*") if p.is_file() or p.is_symlink()
    )}


def install(kind):
    package = PACKAGES[kind]
    destination = package["destination"]
    if destination.exists():
        raise FileExistsError("Refusing to overwrite " + str(destination))
    reserve = 1300 * 1024 * 1024 if kind == "ndk" else 300 * 1024 * 1024
    destination.parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(destination.parent).free < reserve:
        raise OSError("Not enough free space for verified " + kind + " extraction")
    with tempfile.TemporaryDirectory(prefix="android-toolchain-", dir=destination.parent) as work:
        archive = Path(work) / "official.zip"
        receipt = fetch_archive(package, archive)
        partial = Path(work) / "extracted"
        partial.mkdir()
        receipt.update(extract(archive, partial, kind))
        archive.unlink()
        partial.rename(destination)
    receipt.update({"package": kind, "url": package["url"], "destination": str(destination)})
    print(json.dumps(receipt, indent=2))


def repair_runtime():
    """Add only absent pinned runtime entries to an already installed NDK."""
    package = PACKAGES["ndk"]
    destination = package["destination"]
    if not (destination / "source.properties").is_file():
        raise FileNotFoundError("No installed NDK r27c to repair")
    missing = sorted(name for name in RUNTIME_FILES if not (destination / name).is_file())
    if not missing:
        print(json.dumps({"mode": "repair-runtime", "added": [], "message": "All pinned runtime files exist"}, indent=2))
        return
    if shutil.disk_usage(destination).free < 850 * 1024 * 1024:
        raise OSError("Need at least 850 MiB to verify the complete official NDK archive")
    with tempfile.TemporaryDirectory(prefix="ndk-runtime-repair-", dir=destination.parent) as work:
        archive = Path(work) / "official.zip"
        receipt = fetch_archive(package, archive)
        with zipfile.ZipFile(archive) as source:
            entries = {item.filename: item for item in source.infolist()}
            for name in missing:
                item = entries.get(NDK_PREFIX + name)
                if item is None or item.is_dir() or stat.S_ISLNK(item.external_attr >> 16):
                    raise ValueError("Official NDK runtime entry is missing or unexpected: " + name)
            for name in missing:
                target = destination / name
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = Path(work) / Path(name).name
                with source.open(entries[NDK_PREFIX + name]) as input_file, temporary.open("wb") as output:
                    shutil.copyfileobj(input_file, output, length=1024 * 1024)
                if target.exists():
                    raise FileExistsError("Refusing to overwrite existing NDK runtime: " + str(target))
                temporary.rename(target)
    receipt.update({"mode": "repair-runtime", "added": missing, "destination": str(destination)})
    print(json.dumps(receipt, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true", help="Download, verify and install")
    parser.add_argument("--repair-runtime", action="store_true", help="Verify full NDK ZIP and add only missing runtime archives")
    parser.add_argument("--package", choices=["build-tools", "ndk", "both"], default="both")
    args = parser.parse_args()
    if args.repair_runtime:
        if args.install:
            parser.error("--repair-runtime and --install are mutually exclusive")
        repair_runtime()
        return
    if not args.install:
        print(json.dumps({"mode": "plan", "packages": {
            key: {**value, "destination": str(value["destination"])}
            for key, value in PACKAGES.items() if args.package in ("both", key)
        }, "ndk_selection": {
            "abis": ["arm64-v8a", "x86_64"], "api": 29,
            "components": ["CMake toolchain", "Clang 18", "LLD", "LLVM binutils",
                           "Android sysroot", "C++ static and compiler-rt builtins",
                           "NDK notices and metadata"],
            "estimated_extracted_mib": 425,
        }}, indent=2))
        return
    for kind in (["build-tools", "ndk"] if args.package == "both" else [args.package]):
        install(kind)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        sys.exit(str(error))
