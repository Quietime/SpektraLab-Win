#!/usr/bin/env python3
"""Check the final NSIS layout in Wine 10 without claiming a real Windows GUI test.

The isolated Wine E: drive is mapped to artifacts/windows133-E-drive. Setup is
run with /S /NO_WEBVIEW=1 and NO /D override, proving the E:\\SpektraLab
installer default. Only explicit test fixtures are written by this script.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'artifacts'
STAGE = ART / 'SpektraLab-Windows-1.3.3-LightTable-x64'
SETUP = ART / 'SpektraLab-Windows-x64-Setup.exe'
E_DRIVE = ART / 'windows133-E-drive'
INSTALL = E_DRIVE / 'SpektraLab'
WINE_PREFIX = '/tmp/spektra-wine10-installer-prefix'
RECEIPT = ART / 'WINDOWS133-INSTALLATION-CHECK.json'
LOG = ART / 'WINDOWS133-INSTALLATION-CHECK.log'
CONTAINER = 'spektralab-wine10'
WINE_E_DRIVE = '/work/artifacts/windows133-E-drive'


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def static_check() -> dict:
    nsi = (ROOT / 'distribution/windows/installer-windows133.nsi').read_text()
    assert 'InstallDir "E:\\SpektraLab"' in nsi, 'NSIS default is not E:\\SpektraLab'
    assert 'SpektraLab-Windows.exe' in nsi and 'SpektraLab LightTable.lnk' in nsi
    assert '/IM SpektraLab-UpdateHelper.exe' not in nsi, 'setup must not kill the updater helper'
    assert '/IM spektralab-host.exe' not in nsi, 'setup must not kill unrelated host instances'
    assert 'RMDir /r' not in nsi and 'RMDir /R' not in nsi, 'recursive uninstall is forbidden'
    return {'default_install_dir': r'E:\SpektraLab', 'stable_installer': SETUP.name,
            'helper_kill_guard_static': True, 'recursive_uninstall': False,
            'runtime_stage_exists': STAGE.is_dir(), 'installer_exists': SETUP.is_file()}


def manifest() -> dict[str, str]:
    info = json.loads((STAGE / 'BUILD-INFO.json').read_text())
    assert info['build'] == 13304 and info['version'] == '1.3.3-lighttable.3'
    expected = json.loads((STAGE / 'SHA256SUMS.json').read_text())
    actual = {p.relative_to(STAGE).as_posix() for p in STAGE.rglob('*') if p.is_file()}
    assert actual == set(expected) | {'SHA256SUMS.json'}, 'runtime stage differs from its manifest'
    for name, digest in expected.items():
        assert sha(STAGE / name) == digest, f'changed runtime stage file: {name}'
    expected['SHA256SUMS.json'] = sha(STAGE / 'SHA256SUMS.json')
    return expected


def wine(args: list[str], timeout: int = 240) -> subprocess.CompletedProcess:
    command = ['docker', 'exec', '-e', 'WINEDEBUG=-all',
               '-e', 'WINEPREFIX=' + WINE_PREFIX,
               '-e', 'WINEDLLOVERRIDES=mscoree,mshtml,winemenubuilder.exe=d',
               CONTAINER, 'xvfb-run', '-a', '/usr/lib/wine/wine64', *args]
    result = subprocess.run(command, timeout=timeout, capture_output=True, text=True)
    with LOG.open('a') as stream:
        stream.write('COMMAND: ' + ' '.join(command) + '\n')
        stream.write(result.stdout + result.stderr)
        stream.write(f'EXIT CODE: {result.returncode}\n\n')
    if result.returncode != 0:
        raise RuntimeError(f'Wine command exited {result.returncode}; see {LOG}')
    return result


def container_python(code: str, *args: str) -> str:
    result = subprocess.run(['docker', 'exec', CONTAINER, 'python3', '-c', code, *args],
                            check=True, capture_output=True, text=True)
    return result.stdout.strip()


def setup_drive() -> None:
    # Keep Wine registry, profile and Desktop inside container-local /tmp.
    # Let Wine create C: on a pristine prefix BEFORE adding the E: mapping;
    # precreating dosdevices/e: makes Wine mistake a partial prefix for one
    # that has already booted and it never creates drive_c/kernel32.
    E_DRIVE.mkdir(parents=True, exist_ok=True)
    assert not any(E_DRIVE.iterdir()), f'isolated E: fixture is not empty: {E_DRIVE}'
    booted = container_python('from pathlib import Path; import sys; '
                              'print(int((Path(sys.argv[1])/"drive_c/windows/system32").is_dir()))',
                              WINE_PREFIX) == '1'
    if not booted:
        assert container_python('from pathlib import Path; import sys; print(int(Path(sys.argv[1]).exists()))',
                                WINE_PREFIX) == '0', 'incomplete Wine prefix must be reviewed before retry'
        wine(['wineboot.exe', '--init'], timeout=180)
        assert container_python('from pathlib import Path; import sys; '
                                'print(int((Path(sys.argv[1])/"drive_c/windows/system32").is_dir()))',
                                WINE_PREFIX) == '1', 'Wine did not initialize drive_c'
    code = ('from pathlib import Path; import os,sys; '
            'p=Path(sys.argv[1]); d=p/"dosdevices"; assert (d/"c:").is_symlink(); '
            'link=d/"e:"; target=sys.argv[2]; '
            'assert (not link.exists() and not link.is_symlink()) or '
            '(link.is_symlink() and os.readlink(link)==target), "E: already maps elsewhere"; '
            'link.symlink_to(target,target_is_directory=True) if not link.is_symlink() else None')
    container_python(code, WINE_PREFIX, WINE_E_DRIVE)


def write_fixture(path: str, text: str) -> None:
    code = ('from pathlib import Path; import sys; p=Path(sys.argv[1]); '
            'p.parent.mkdir(parents=True,exist_ok=True); '
            'assert not p.exists(); p.write_text(sys.stdin.read())')
    subprocess.run(['docker', 'exec', '-i', CONTAINER, 'python3', '-c', code, path],
                   input=text, text=True, check=True)


def desktop_links() -> list[str]:
    code = ('from pathlib import Path; import json,sys; p=Path(sys.argv[1]); '
            'c=[*p.glob("drive_c/users/*/Desktop/SpektraLab LightTable.lnk"),'
            'Path("/root/Desktop/SpektraLab LightTable.lnk")]; '
            'print(json.dumps(sorted(set(str(x.resolve()) for x in c if x.is_file()))))')
    return json.loads(container_python(code, WINE_PREFIX))


def appdata_path() -> str:
    code = ('from pathlib import Path; import json,sys; p=Path(sys.argv[1]); '
            'homes=[x for x in (p/"drive_c/users").iterdir() if x.is_dir() '
            'and x.name.lower() not in {"public","default"} and (x/"AppData/Roaming").is_dir()]; '
            'assert len(homes)==1, homes; '
            'print(str(homes[0]/"AppData/Roaming/app.spektralab.windows133/check.txt"))')
    return container_python(code, WINE_PREFIX)


def container_read(path: str) -> str:
    code = 'from pathlib import Path; import json,sys; print(json.dumps(Path(sys.argv[1]).read_text()))'
    return json.loads(container_python(code, path))


def run() -> dict:
    scope = static_check()
    assert scope['runtime_stage_exists'] and scope['installer_exists'], 'final stage and installer are required'
    expected = manifest()
    installer_receipt = json.loads((ART / 'WINDOWS133-INSTALLER-RECEIPT.json').read_text())
    assert installer_receipt['sha256'] == sha(SETUP), 'installer differs from build receipt'
    setup_drive()
    assert not INSTALL.exists(), 'default E: install path must start empty'
    assert not desktop_links(), 'Wine desktop shortcut fixture already exists'
    # No /D override: this specifically tests the installer's E: default.
    wine(['/work/artifacts/SpektraLab-Windows-x64-Setup.exe', '/S', '/NO_WEBVIEW=1'])
    assert INSTALL.is_dir(), 'setup did not use E:\\SpektraLab by default'
    for name, digest in expected.items():
        assert sha(INSTALL / name) == digest, f'installed payload differs: {name}'
    shortcuts = desktop_links()
    assert len(shortcuts) == 1, f'expected one Wine desktop shortcut, found {shortcuts}'

    foreign = INSTALL / 'personal/keep-me.txt'
    assert not foreign.exists(), 'foreign-file fixture already exists'
    write_fixture('/work/artifacts/windows133-E-drive/SpektraLab/personal/keep-me.txt',
                  'Personal file must survive uninstall.\n')
    appdata = appdata_path()
    assert container_python('from pathlib import Path; import sys; print(int(Path(sys.argv[1]).exists()))',
                            appdata) == '0', 'AppData fixture already exists'
    write_fixture(appdata, 'Keep user settings.\n')

    # Let NSIS copy itself out of the install directory before deletion.
    wine(['/work/artifacts/windows133-E-drive/SpektraLab/Uninstall.exe', '/S'])
    for _ in range(20):
        if all(not (INSTALL / name).exists() for name in expected) and not desktop_links():
            break
        time.sleep(0.5)
    for name in expected:
        assert not (INSTALL / name).exists(), f'uninstaller retained owned file: {name}'
    assert not (INSTALL / 'Uninstall.exe').exists(), 'uninstaller retained itself'
    assert not desktop_links(), 'desktop shortcut retained after uninstall'
    assert container_read('/work/artifacts/windows133-E-drive/SpektraLab/personal/keep-me.txt') == 'Personal file must survive uninstall.\n'
    assert container_read(appdata) == 'Keep user settings.\n'
    return {'status': 'passed', 'created_utc': datetime.now(timezone.utc).isoformat(),
            'installer': SETUP.name, 'installer_sha256': sha(SETUP),
            'default_install_dir_verified': r'E:\SpektraLab',
            'installed_payload_files_verified': len(expected),
            'desktop_shortcut_created_and_removed': True,
            'uninstall_owned_files_removed': True, 'foreign_file_retained': True,
            'appdata_retained': True, 'helper_kill_guard_static': True,
            'webview_prerequisite_skipped_for_layout_test': True,
            'real_windows_gui_tested': False, 'updater_install_integration_tested': False,
            'wine_container': CONTAINER,
            'wine_prefix': WINE_PREFIX}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='read-only static NSIS/path check')
    args = parser.parse_args()
    if args.check:
        print(json.dumps(static_check(), indent=2))
        return
    try:
        receipt = run()
    except Exception as error:
        RECEIPT.write_text(json.dumps({'status': 'failed', 'error': str(error),
            'webview_prerequisite_skipped_for_layout_test': True,
            'real_windows_gui_tested': False,
            'updater_install_integration_tested': False}, indent=2) + '\n')
        raise
    RECEIPT.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
