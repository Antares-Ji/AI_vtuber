"""Verify every supplied ZIP byte, then run upstream checks in an isolated Git root.

The original tools deliberately reject a parent repository. Exporting the pinned
subtree preserves that contract without weakening or modifying the ZIP sources.
"""
from pathlib import Path
import hashlib
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
    with zipfile.ZipFile(archive) as original:
        for name, expected in manifest['files'].items():
            if hashlib.sha256(original.read(name)).hexdigest() != expected:
                raise RuntimeError('Archive member changed: ' + name)
    for name, expected in manifest['files'].items():
        file = root / name
        if not file.resolve().is_relative_to(root.resolve()) or file.is_symlink():
            raise RuntimeError('Invalid import path: ' + name)
        content = file.read_bytes()
        if hashlib.sha256(content).hexdigest() == expected:
            exact += 1
        elif hashlib.sha256(content.replace(b'\r\n', b'\n')).hexdigest() != manifest['lf_sha256'].get(name):
            raise RuntimeError('Imported source changed: ' + name)
    print(f"Original ZIP byte-identical; {len(manifest['files'])} source files preserved ({exact} exact; others only Git line endings)", flush=True)
    return manifest


def main():
    manifest = verify()
    with tempfile.TemporaryDirectory(prefix='mc-player-source-check-') as temp:
        target = Path(temp)
        for name in manifest['files']:
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
