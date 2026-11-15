#!/usr/bin/env python3
"""Sign the exact final release assets; this script never uploads or publishes."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
ASSETS = {
    'windows-x64': 'SpektraLab-Windows-x64-Setup.exe',
    'android-phone-arm64': 'SpektraLab-Android-Phone.apk',
    'android-tablet-arm64': 'SpektraLab-Android-Tablet.apk',
}


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-dir', type=Path, required=True)
    parser.add_argument('--windows-exe', type=Path, required=True)
    parser.add_argument('--private-key', type=Path, default=ROOT / 'build/update-signing-private.pem')
    parser.add_argument('--tag', default='v1.3.3-lighttable.3')
    parser.add_argument('--notes', default='LightTable integration, bounded image memory, device display adaptation and signed updates.')
    args = parser.parse_args()
    if not re.fullmatch(r'v[0-9A-Za-z][0-9A-Za-z._-]*', args.tag):
        parser.error('Tag must be a plain release path segment')
    public = json.loads((ROOT / 'distribution/updater/public-key.json').read_bytes())
    modulus = subprocess.check_output(['openssl', 'rsa', '-in', str(args.private_key), '-noout', '-modulus'], stderr=subprocess.DEVNULL).decode().strip().split('=', 1)[1]
    if public['algorithm'] != 'RSA-PKCS1-SHA256' or int(modulus, 16) != int(public['modulus'], 16) or int(public['exponent'], 16) != 65537:
        raise ValueError('Signing key does not match the packaged public key')
    if args.windows_exe.read_bytes()[:2] != b'MZ':
        raise ValueError('Installed Windows executable is missing or invalid')
    channels = {}
    for channel, name in ASSETS.items():
        path = args.release_dir / name
        size = path.stat().st_size
        if not 0 < size <= 512 * 1024 * 1024:
            raise ValueError('Invalid final asset size: ' + name)
        with path.open('rb') as file:
            magic = file.read(4)
        if (name.endswith('.exe') and magic[:2] != b'MZ') or (name.endswith('.apk') and magic != b'PK\x03\x04'):
            raise ValueError('Invalid final asset format: ' + name)
        channels[channel] = {
            'name': name,
            'url': f'https://github.com/Quietime/SpektraLab-Win/releases/download/{args.tag}/{name}',
            'sha256': digest(path), 'bytes': size,
        }
        if channel == 'windows-x64':
            channels[channel]['installed_sha256'] = digest(args.windows_exe)
    manifest = {'schema': 1, 'build': 13304, 'version': '1.3.3-lighttable.3', 'notes': args.notes, 'channels': channels}
    raw = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    manifest_path = args.release_dir / 'updates.json'
    with tempfile.TemporaryDirectory() as temporary:
        raw_path = Path(temporary) / 'manifest.json'
        signature_path = Path(temporary) / 'signature.bin'
        public_path = Path(temporary) / 'public.pem'
        raw_path.write_bytes(raw)
        subprocess.run(['openssl', 'dgst', '-sha256', '-sign', str(args.private_key), '-out', str(signature_path), str(raw_path)], check=True)
        with public_path.open('wb') as output:
            subprocess.run(['openssl', 'pkey', '-in', str(args.private_key), '-pubout'], stdout=output, stderr=subprocess.DEVNULL, check=True)
        subprocess.run(['openssl', 'dgst', '-sha256', '-verify', str(public_path), '-signature', str(signature_path), str(raw_path)], check=True, stdout=subprocess.DEVNULL)
        signature = signature_path.read_bytes()
        if len(signature) != 384:
            raise ValueError('Expected RSA-3072 signature')
        manifest_path.write_bytes(raw)
        (args.release_dir / 'updates.json.sig').write_text(signature.hex() + '\n', encoding='ascii')
    print(json.dumps({'build': 13304, 'manifest_sha256': digest(manifest_path), 'channels': channels, 'published': False}, indent=2))


if __name__ == '__main__':
    main()
