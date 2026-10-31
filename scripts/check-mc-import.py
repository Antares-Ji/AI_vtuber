"""Verify every supplied ZIP byte, then run upstream checks in an isolated Git root.

The original tools deliberately reject a parent repository. Exporting the pinned
subtree preserves that contract. Explicit integration patches are verified against
the unchanged original archive as well as their recorded resulting hashes.
"""
from pathlib import Path
import hashlib
import difflib
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def verify(root=ROOT):
    manifest = json.loads((root / 'docs/integration/import-manifest.json').read_text(encoding='utf-8'))
    archive = root / manifest['archive_path']
    if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest['sha256']:
        raise RuntimeError('Original ZIP archive changed')
    exact = 0
    patched = 0
    overrides = manifest.get('integration_overrides', {})
    additions = manifest.get('integration_additions', {})
    if set(additions).intersection(manifest['files']):
        raise RuntimeError('Addition replaces an original source file')
    for name in [*manifest['files'], *additions]:
        relative = Path(name)
        file = root / relative
        if relative.is_absolute() or not name.startswith('mc-player-agent/') or '..' in relative.parts or file.is_symlink() or not file.resolve().is_relative_to((root / 'mc-player-agent').resolve()):
            raise RuntimeError('Invalid import path: ' + name)
    if not set(overrides).issubset(manifest['files']):
        raise RuntimeError('Override is not an original source file')
    with zipfile.ZipFile(archive) as original:
        for name, expected in manifest['files'].items():
            if hashlib.sha256(original.read(name)).hexdigest() != expected:
                raise RuntimeError('Archive member changed: ' + name)
            if name in overrides:
                current = (root / name).read_text(encoding='utf-8')
                baseline = original.read(name).decode('utf-8').replace('\r\n', '\n')
                delta = ''.join(difflib.unified_diff(baseline.splitlines(True), current.splitlines(True), fromfile='a/' + name, tofile='b/' + name))
                if delta != overrides[name]['patch']:
                    raise RuntimeError('Integration patch differs: ' + name)
    for name, expected in manifest['files'].items():
        file = root / name
        if not file.resolve().is_relative_to(root.resolve()) or file.is_symlink():
            raise RuntimeError('Invalid import path: ' + name)
        content = file.read_bytes()
        if name in overrides:
            if hashlib.sha256(content.replace(b'\r\n', b'\n')).hexdigest() != overrides[name]['lf_sha256']:
                raise RuntimeError('Patched source changed: ' + name)
            patched += 1
        elif hashlib.sha256(content).hexdigest() == expected:
            exact += 1
        elif hashlib.sha256(content.replace(b'\r\n', b'\n')).hexdigest() != manifest['lf_sha256'].get(name):
            raise RuntimeError('Imported source changed: ' + name)
    for name, expected in additions.items():
        content = (root / name).read_bytes().replace(b'\r\n', b'\n')
        if hashlib.sha256(content).hexdigest() != expected['lf_sha256']:
            raise RuntimeError('Integration addition changed: ' + name)
    print(f"Original ZIP byte-identical; {len(manifest['files'])} source files retained ({exact} exact; {patched} recorded integration patches; others only Git line endings); {len(additions)} separate integration additions", flush=True)
    return manifest


def main():
    manifest = verify()
    with tempfile.TemporaryDirectory(prefix='mc-player-source-check-') as temp:
        target = Path(temp)
        for name in [*manifest['files'], *manifest.get('integration_additions', {})]:
            dest = target / Path(name).relative_to('mc-player-agent')
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, dest)
        subprocess.run(['git', 'init', '-q', str(target)], check=True)
        subprocess.run(['git', '-C', str(target), 'config', 'core.autocrlf', 'false'], check=True)
        subprocess.run(['git', '-C', str(target), '-c', 'core.safecrlf=false', 'add', '.'], check=True, capture_output=True)
        subprocess.run([sys.executable, 'tools/check_repository.py'], cwd=target, check=True)
        subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tools', '-p', 'test_*.py', '-v'], cwd=target, check=True)


if __name__ == '__main__':
    main()
