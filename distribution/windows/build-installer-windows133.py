#!/usr/bin/env python3
"""Build the build-13304 NSIS installer from an already staged, hashed payload.

Requires an external Unicode NSIS3 `makensis`; does not compile application
code. The uninstall include removes only manifest-listed files and then tries
to remove empty owned directories, preserving unrelated files and AppData.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'artifacts'
DEFAULT_STAGE = ART / 'SpektraLab-Windows-1.3.3-LightTable-x64'
DEFAULT_OUTPUT = ART / 'SpektraLab-Windows-x64-Setup.exe'
NSI = ROOT / 'distribution/windows/installer-windows133.nsi'


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def verify(stage: Path) -> list[str]:
    info = json.loads((stage / 'BUILD-INFO.json').read_text())
    assert info['build'] == 13304 and info['version'] == '1.3.3-lighttable.3', 'wrong staged build'
    assert info['updater_public_key_sha256'] == 'bc81a5943f53c7dec4dcce81f9c3ab6ee281a961df2193fc6cb789e60a850e9c'
    manifest = json.loads((stage / 'SHA256SUMS.json').read_text())
    actual = {p.relative_to(stage).as_posix() for p in stage.rglob('*') if p.is_file()}
    assert actual == set(manifest) | {'SHA256SUMS.json'}, 'payload differs from hashed manifest'
    for name, digest in manifest.items():
        assert sha(stage / name) == digest, f'changed payload: {name}'
    for name in ['SpektraLab-Windows.exe', 'SpektraLab-CLI.exe', 'spektralab-host.exe',
                 'WebView2Loader.dll', 'MicrosoftEdgeWebview2Setup.exe']:
        assert (stage / name).read_bytes().startswith(b'MZ'), f'missing PE: {name}'
    assert (stage / 'host/licenses/WebView2-SDK-LICENSE.txt').is_file()
    assert (stage / 'host/licenses/WebView2-SDK-NOTICE.txt').is_file()
    assert not (stage / 'source').exists(), 'source companions must stay outside the NSIS payload'
    companions = ART / info['source_companions_directory']
    for name, digest in info['source_companions_sha256'].items():
        assert sha(companions / name) == digest, f'changed source companion: {name}'
    return sorted(actual)


def nsis_escape(path: str) -> str:
    assert all(c not in path for c in '\r\n'), 'newline in payload path'
    return path.replace('$', '$$').replace('"', '$\\"').replace('/', '\\')


def uninstall_include(stage: Path, names: list[str]) -> Path:
    lines = ['; Generated exact payload removal list. No recursive directory deletion.']
    lines += ['Delete "$INSTDIR\\' + nsis_escape(name) + '"' for name in names]
    dirs = sorted((p.relative_to(stage).as_posix() for p in stage.rglob('*') if p.is_dir()),
                  key=lambda name: (name.count('/'), name), reverse=True)
    lines += ['RMDir "$INSTDIR\\' + nsis_escape(name) + '"' for name in dirs]
    include = ROOT / 'build/windows133-uninstall.nsh'
    include.parent.mkdir(parents=True, exist_ok=True)
    include.write_text('\n'.join(lines) + '\n')
    return include


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, default=DEFAULT_STAGE)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--makensis', default=shutil.which('makensis'))
    parser.add_argument('--check', action='store_true', help='verify stage only; do not invoke NSIS')
    args = parser.parse_args()
    stage, output = args.stage.resolve(), args.output.resolve()
    files = verify(stage)
    if args.check:
        print(json.dumps({'stage': str(stage), 'payload_files_verified': len(files),
                          'exact_uninstall_list_can_be_generated': True,
                          'installer_executed': False}, indent=2))
        return
    if not args.makensis:
        raise SystemExit('Unicode NSIS3 makensis is required; pass --makensis /path/to/makensis')
    assert not output.exists(), f'existing installer must be reviewed before replacement: {output}'
    include = uninstall_include(stage, files)
    subprocess.run([args.makensis, f'-DSTAGE={stage}', f'-DOUTFILE={output}',
                    f'-DUNINSTALL_LIST={include}', str(NSI)], check=True)
    assert output.read_bytes().startswith(b'MZ'), 'NSIS did not produce a PE installer'
    receipt = {'installer': output.name, 'bytes': output.stat().st_size,
               'sha256': sha(output), 'build': 13304, 'version': '1.3.3-lighttable.3',
               'payload_files_verified': len(files), 'signed': False,
               'windows_gui_tested_by_this_script': False}
    (ART / 'WINDOWS133-INSTALLER-RECEIPT.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
