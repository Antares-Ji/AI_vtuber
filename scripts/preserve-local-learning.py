"""Create a local, non-overwriting learning snapshot; never upload it.

Source data, raw evidence and weights remain where they are. SQLite uses its
backup API so an active database and WAL can be preserved consistently.
"""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import sqlite3

COPY_DIRS = ('data/sts2', 'data/minecraft-training', 'runtime/sts2/learning',
             'runtime/sts2/tactics', 'runtime/game-input/learning')
REFERENCE_DIRS = ('runtime/minecraft-training/adapters', 'runtime/game-input/runs',
                  'runtime/sts2/vision', 'runtime/game-input/card-detector',
                  'output/minecraft-training', 'logs/sts2')


def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def preserve(source, destination):
    source, destination = source.resolve(), destination.resolve()
    if destination.exists():
        raise ValueError('Destination already exists; choose a new snapshot directory')
    if destination == source or source.is_relative_to(destination) or any(destination.is_relative_to(source / p) for p in COPY_DIRS + REFERENCE_DIRS):
        raise ValueError('Snapshot must not overlap preserved data directories')
    destination.mkdir(parents=True)
    manifest = {'schema': 1, 'source': str(source), 'copied': [], 'retained_in_place': []}
    for name in COPY_DIRS:
        folder = source / name
        if not folder.exists():
            continue
        for file in sorted(folder.rglob('*')):
            if not file.is_file() or file.is_symlink():
                continue
            rel = file.relative_to(source).as_posix()
            target = destination / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            before = digest(file)
            shutil.copyfile(file, target)
            if before != digest(target) or before != digest(file):
                raise RuntimeError('Source changed during snapshot; retry into a new directory: ' + rel)
            manifest['copied'].append({'path': rel, 'sha256': before, 'bytes': target.stat().st_size})
    db = source / 'data/memory.db'
    if db.exists():
        target = destination / 'data/memory.db'
        target.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True) as original, sqlite3.connect(target) as backup:
            original.backup(backup)
            if backup.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RuntimeError('Memory snapshot failed integrity check')
        manifest['copied'].append({'path': 'data/memory.db', 'sha256': digest(target), 'sqlite_backup': True})
    for name in REFERENCE_DIRS:
        folder = source / name
        if not folder.exists():
            continue
        for file in sorted(folder.rglob('*')):
            if file.is_file() and not file.is_symlink():
                manifest['retained_in_place'].append({'path': file.relative_to(source).as_posix(),
                    'bytes': file.stat().st_size, 'mtime_ns': file.stat().st_mtime_ns})
    (destination / 'manifest.local.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (destination / 'SNAPSHOT_COMPLETE').write_text('Verified copied bytes and SQLite backup. Referenced weights/evidence remain at source.\n')
    return {'copied_files': len(manifest['copied']), 'retained_in_place_files': len(manifest['retained_in_place'])}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(preserve(args.source, args.destination)))
