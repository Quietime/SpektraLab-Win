#!/usr/bin/env python3
"""Stage the verified build 13304 runtime and its corresponding source.

`--check` is read-only. Packaging never builds binaries or publishes a release.
The final GUI, CLI, native host and notices must first be placed in
artifacts/Compiled-Windows-13304 and recorded in COMPILE-CHECKPOINT.json.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'artifacts'
COMPILED = ART / 'Compiled-Windows-13304'
STAGE = ART / 'SpektraLab-Windows-1.3.3-LightTable-x64'
SOURCE_OUT = ART / 'SpektraLab-Windows-13304-Source'
ARCHIVED = Path('/workspace/recovery/installer/source')
VERSION = '1.3.3-lighttable.3'
BUILD = 13304
KEY_SHA256 = 'bc81a5943f53c7dec4dcce81f9c3ab6ee281a961df2193fc6cb789e60a850e9c'
RUNTIME_ROOTS = {'SpektraLab-Windows.exe', 'SpektraLab-CLI.exe', 'spektralab-host.exe',
                 'WebView2Loader.dll', 'MicrosoftEdgeWebview2Setup.exe'}
ARCHIVED_FILES = {'Frontend-runtime-dependency-sources.zip', 'Rust-dependency-sources.zip',
                  'LibRaw-0.22.2.zip', 'LICENSE-PROVENANCE.json',
                  'LICENSE-REVIEW-GAPS.json', 'THIRD-PARTY-COMPONENTS.json'}


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def dump(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def inputs(archive: Path) -> dict:
    checkpoint = json.loads((COMPILED / 'COMPILE-CHECKPOINT.json').read_text())
    assert checkpoint['build'] == BUILD and checkpoint['version'] == VERSION, 'wrong runtime build'
    listed = checkpoint['files']
    actual = {p.relative_to(COMPILED).as_posix() for p in COMPILED.rglob('*')
              if p.is_file() and p.name != 'COMPILE-CHECKPOINT.json'}
    assert actual == set(listed), f'runtime manifest mismatch: missing {set(listed)-actual}, extra {actual-set(listed)}'
    for name, digest in listed.items():
        assert sha(COMPILED / name) == digest, f'compiled runtime changed: {name}'
    for name in RUNTIME_ROOTS:
        assert (COMPILED / name).read_bytes().startswith(b'MZ'), f'missing PE runtime: {name}'
    assert b'SPEKTRALAB_EMBEDDED_UI_V1' in (COMPILED / 'SpektraLab-Windows.exe').read_bytes(), 'GUI has no embedded release UI'
    assert (COMPILED / 'host/engine').is_dir() and (COMPILED / 'host/licenses').is_dir()
    for name in ['WebView2-SDK-LICENSE.txt', 'WebView2-SDK-NOTICE.txt']:
        assert (COMPILED / 'host/licenses' / name).is_file(), f'Microsoft notice missing: {name}'
    key = ROOT / 'distribution/updater/public-key.json'
    assert sha(key) == KEY_SHA256, 'unexpected updater public key bytes'

    archived_manifest = json.loads((archive.parent / 'SHA256SUMS.json').read_text())
    for name in ARCHIVED_FILES:
        path = archive / name
        assert sha(path) == archived_manifest['source/' + name], f'archived source failed readback: {name}'
    for path in (archive / 'licenses').rglob('*'):
        if path.is_file():
            name = path.relative_to(archive).as_posix()
            assert sha(path) == archived_manifest['source/' + name], f'archived licence failed readback: {name}'
    with zipfile.ZipFile(archive / 'SpektraLab-source.zip') as previous:
        for name in ['desktop/package-lock.json', 'desktop/src-tauri/Cargo.lock']:
            assert previous.read(name) == (ROOT / name).read_bytes(), f'dependency lock changed: {name}'
    return checkpoint


def source_names() -> list[str]:
    raw = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT)
    result = []
    for name in sorted(set(filter(None, raw.decode().split('\0')))):
        if name == 'SOURCE-INDEX.json':
            continue  # generated receipt; the archive writes its own current index
        path = ROOT / name
        if not path.is_file():
            continue
        parts = Path(name).parts
        assert not path.is_symlink() and path.resolve().is_relative_to(ROOT), f'unsafe source link: {name}'
        assert not any(part in {'build', 'artifacts', 'node_modules', 'target', '.git'} for part in parts), f'generated path in source: {name}'
        leaf = path.name.lower()
        assert not (leaf.startswith('.env') or leaf.endswith(('.pem', '.p12', '.pfx', '.jks', '.keystore', '.key'))
                    or 'signing-private' in leaf), f'sensitive source filename: {name}'
        data = path.read_bytes()
        assert not re.search(rb'^-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----\r?$', data, re.MULTILINE), \
            f'private key in source: {name}'
        result.append(name)
    return result


def package(archive: Path, checkpoint: dict) -> dict:
    assert 'COMPILED ONLY' not in checkpoint.get('status', '').upper(), 'final tested runtime checkpoint required before packaging'
    assert not STAGE.exists(), f'existing stage must be reviewed before replacement: {STAGE}'
    assert not SOURCE_OUT.exists(), f'existing source companions must be reviewed before replacement: {SOURCE_OUT}'
    work = STAGE.with_name(STAGE.name + '.staging')
    source_work = SOURCE_OUT.with_name(SOURCE_OUT.name + '.staging')
    assert not work.exists(), f'existing staging directory must be reviewed: {work}'
    assert not source_work.exists(), f'existing staging directory must be reviewed: {source_work}'
    work.mkdir(parents=True)
    source_work.mkdir(parents=True)
    try:
        for name in RUNTIME_ROOTS:
            shutil.copy2(COMPILED / name, work / name)
        shutil.copytree(COMPILED / 'host', work / 'host')
        names = source_names()
        index = {name: sha(ROOT / name) for name in names}
        with zipfile.ZipFile(source_work / 'SpektraLab-source.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as output:
            for name in names:
                output.write(ROOT / name, name)
            output.writestr('SOURCE-INDEX.json', json.dumps(index, indent=2) + '\n')
        dump(source_work / 'SOURCE-INDEX.json', index)
        for name in ARCHIVED_FILES:
            if name.endswith('.zip'):
                # Same filesystem in this recovery workspace: avoid another
                # ~94 MiB dependency copy while preserving separate uploads.
                try:
                    (source_work / name).hardlink_to(archive / name)
                except OSError:
                    shutil.copy2(archive / name, source_work / name)
        with zipfile.ZipFile(source_work / 'Third-Party-Notices-13304.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as notices:
            for path in sorted((archive / 'licenses').rglob('*')):
                if path.is_file():
                    notices.write(path, 'licenses/' + path.relative_to(archive / 'licenses').as_posix())
            for name in sorted(ARCHIVED_FILES):
                if name.endswith('.json'):
                    notices.write(archive / name, name)
        (source_work / 'README-SOURCE.txt').write_text(
            'SpektraLab Windows 1.3.3-lighttable.3 (build 13304) corresponding source\n\n'
            'These are separate source companions, not part of the runtime installer.\n'
            'SpektraLab-source.zip is a snapshot of this checkout, including local changes.\n'
            'SOURCE-INDEX.json records SHA-256 of every included source file. The archived\n'
            'Rust, npm and LibRaw dependency source ZIPs and third-party notices were read\n'
            'back against the prior installer receipt. Both dependency locks match exactly.\n'
            'Public updater key fingerprint: SHA-256 of exact raw bytes of\n'
            'distribution/updater/public-key.json, including its final newline.\n'
            'No private key or signing credential is included.\n')
        with zipfile.ZipFile(source_work / 'SpektraLab-source.zip') as source_zip:
            assert source_zip.testzip() is None
            assert len(index) + 1 == len(source_zip.namelist())
            assert len(set(source_zip.namelist())) == len(source_zip.namelist()), 'duplicate source path'
        with zipfile.ZipFile(source_work / 'Third-Party-Notices-13304.zip') as notices:
            assert notices.testzip() is None
        source_manifest = {p.name: sha(p) for p in sorted(source_work.iterdir()) if p.is_file()}
        dump(source_work / 'SOURCE-SHA256SUMS.json', source_manifest)
        dump(work / 'BUILD-INFO.json', {
            'name': 'SpektraLab Windows LightTable', 'version': VERSION, 'build': BUILD,
            'target': 'x86_64-pc-windows-gnu', 'identifier': 'app.spektralab.windows133',
            'packaged_at_utc': datetime.now(timezone.utc).isoformat(),
            'runtime_checkpoint_status': checkpoint['status'],
            'runtime_files_verified': len(checkpoint['files']), 'source_files': len(index),
            'source_companions_directory': SOURCE_OUT.name,
            'source_companions_sha256': source_manifest,
            'updater_public_key_sha256': KEY_SHA256,
            'updater_key_fingerprint_format': 'SHA-256 of exact distribution/updater/public-key.json file bytes',
            'main_exe_sha256': sha(work / 'SpektraLab-Windows.exe'),
            'host_exe_sha256': sha(work / 'spektralab-host.exe'),
            'windows_gui_tested_by_this_script': False,
        })
        manifest = {p.relative_to(work).as_posix(): sha(p) for p in sorted(work.rglob('*')) if p.is_file()}
        dump(work / 'SHA256SUMS.json', manifest)
        source_work.rename(SOURCE_OUT)
        work.rename(STAGE)
        receipt = {'runtime_stage': STAGE.name, 'runtime_files_verified': len(manifest),
                   'source_companions_directory': SOURCE_OUT.name,
                   'source_companions_sha256': source_manifest,
                   'source_files': len(index), 'build': BUILD, 'version': VERSION,
                   'updater_public_key_sha256': KEY_SHA256,
                   'installer_built': False}
        dump(ART / 'WINDOWS133-PACKAGE-RECEIPT.json', receipt)
        return receipt
    except BaseException:
        if work.exists():
            shutil.rmtree(work)
        if source_work.exists():
            shutil.rmtree(source_work)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archived-source', type=Path, default=ARCHIVED)
    parser.add_argument('--check', action='store_true', help='validate inputs without staging or writing')
    args = parser.parse_args()
    checkpoint = inputs(args.archived_source)
    if args.check:
        current_sources = source_names()
        print(json.dumps({'runtime_files_verified': len(checkpoint['files']),
                          'source_archive_lock_identity': True,
                          'current_source_files_checked': len(current_sources),
                          'updater_public_key_sha256': KEY_SHA256,
                          'checkpoint_status': checkpoint['status'],
                          'ready_for_package': 'COMPILED ONLY' not in checkpoint.get('status', '').upper()}, indent=2))
    else:
        print(json.dumps(package(args.archived_source, checkpoint), indent=2))


if __name__ == '__main__':
    main()
