#!/usr/bin/env python3
"""Verify both final flavor APKs against their intended signed identities."""

import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SDK = ROOT / "build/android-sdk"
TOOLS = SDK / "build-tools/35.0.0"
KEY = (ROOT / "distribution/updater/public-key.json").read_bytes()
EXPECTED_PACKAGE = "app.spektralab.lighttable"


def command(*args):
    return subprocess.check_output([str(arg) for arg in args], text=True)


def sha256(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def verify(flavor):
    name = flavor.title()
    apk = ROOT / "artifacts" / f"SpektraLab-Android-{name}-1.3.3-LightTable.apk"
    alias = ROOT / "artifacts" / f"SpektraLab-Android-{name}.apk"
    receipt_path = ROOT / "artifacts" / f"ANDROID133-{flavor.upper()}-BUILD-RECEIPT.json"
    if not apk.is_file() or not alias.is_file() or not receipt_path.is_file():
        raise FileNotFoundError("Missing final APK, stable alias or receipt for " + flavor)
    subprocess.run([str(TOOLS / "apksigner"), "verify", "--verbose", str(apk)], check=True, stdout=subprocess.DEVNULL)
    subprocess.run([str(TOOLS / "zipalign"), "-P", "16", "-c", "4", str(apk)], check=True, stdout=subprocess.DEVNULL)
    badging = command(TOOLS / "aapt2", "dump", "badging", apk)
    if not re.search(r"package: name='app\.spektralab\.lighttable' versionCode='13304'", badging):
        raise ValueError("Wrong installed package or version for " + flavor)
    xml = command(TOOLS / "aapt2", "dump", "xmltree", "--file", "AndroidManifest.xml", apk)
    channel = "android-" + flavor + "-arm64"
    other = "android-" + ("tablet" if flavor == "phone" else "phone") + "-arm64"
    if channel not in xml or other in xml or "app.spektralab.update_channel" not in xml:
        raise ValueError("Incorrect immutable channel for " + flavor)
    certs = command(TOOLS / "apksigner", "verify", "--print-certs", apk)
    match = re.search(r"Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]{64})", certs)
    if not match:
        raise ValueError("Missing APK signer certificate digest")
    with zipfile.ZipFile(apk) as package:
        if package.read("assets/update-public-key.json") != KEY:
            raise ValueError("Packaged update public key differs from intended key")
        names = set(package.namelist())
        for required in ("classes.dex", "assets/web/index.html", "lib/arm64-v8a/libspektralab_host.so", "lib/x86_64/libspektralab_host.so"):
            if required not in names:
                raise ValueError("Missing APK payload: " + required)
        for abi in ("arm64-v8a", "x86_64"):
            binary = ROOT / "build" / ("android-" + abi) / "engine/host/spektralab-host"
            digest = hashlib.sha256()
            with package.open("lib/" + abi + "/libspektralab_host.so") as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
            if digest.hexdigest() != sha256(binary):
                raise ValueError("Embedded native host differs from built " + abi)
    digest = sha256(apk)
    if digest != sha256(alias):
        raise ValueError("Stable alias differs from versioned APK")
    receipt = json.loads(receipt_path.read_text())
    if receipt.get("sha256") != digest or receipt.get("bytes") != apk.stat().st_size or receipt.get("channel") != channel or receipt.get("package") != EXPECTED_PACKAGE or receipt.get("build") != 13304:
        raise ValueError("Build receipt does not describe the APK")
    return {"flavor": flavor, "apk": str(apk), "bytes": apk.stat().st_size,
            "sha256": digest, "signer_sha256": match.group(1).lower(),
            "channel": channel, "public_key_bytes_match": True,
            "native_abis_match_builds": True, "zipalign_16k": True}


def main():
    arm64 = ROOT / "build/android-arm64-v8a/engine/host/spektralab-host"
    readelf = SDK / "ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf"
    segments = [line for line in command(readelf, "-l", arm64).splitlines() if line.lstrip().startswith("LOAD ")]
    if not segments or any(line.split()[-1] != "0x4000" for line in segments):
        raise ValueError("ARM64 LOAD segment alignment is not 16 KiB")
    reports = [verify(flavor) for flavor in ("phone", "tablet")]
    if reports[0]["signer_sha256"] != reports[1]["signer_sha256"]:
        raise ValueError("Phone and tablet have different signing certificates")
    report = {"arm64_elf_load_align": "0x4000", "apks": reports}
    destination = ROOT / "build/android-apk-verification.json"
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
