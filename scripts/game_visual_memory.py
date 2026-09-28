"""Evidence-backed stage memory. Retrieval proposes context, never executes input."""
import argparse
import hashlib
import json
import shutil
import re
from functools import lru_cache
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'runtime/vision/stage-memory'

@lru_cache(maxsize=512)
def _cached_feature(path, mtime_ns, size):
    return feature(path)

@lru_cache(maxsize=64)
def _cached_manifest(path, mtime_ns, size):
    return json.loads(Path(path).read_text(encoding='utf-8'))

def feature(path):
    # Low-resolution colour layout; a candidate search, not proof of stage identity.
    with Image.open(path) as image:
        return np.asarray(image.convert('RGB').resize((32, 20)), dtype=np.float32) / 255

def seed():
    STORE.mkdir(parents=True, exist_ok=True)
    if (STORE / '0-1.json').exists():
        current = json.loads((STORE / '0-1.json').read_text(encoding='utf-8'))
        return dict(stage='0-1', images=len(current['frames']), store=str(STORE), preserved_existing=True)
    sources = [
        ('1789145948968-capture.png', 'attempt1', 'battle', False),
        ('1789145980220-click.png', 'attempt1', 'paused', False),
        ('1789146294124-capture.png', 'attempt1', 'result', False),
        ('1789146366991-capture.png', 'attempt2', 'battle', False),
        ('1789146395379-click.png', 'attempt2', 'selection', False),
        ('1789146537154-capture.png', 'attempt2', 'result', False),
        ('1789146607830-capture.png', 'attempt3', 'battle', False),
        ('1789146646071-drag.png', 'attempt3', 'direction', False),
        ('1789146663660-drag.png', 'attempt3', 'battle', True),
        ('1789146721942-capture.png', 'attempt3', 'result', False),
    ]
    frames = []
    for name, session, phase, deployed in sources:
        source = ROOT / 'runtime/vlm/controller' / name
        destination = STORE / 'images' / name
        destination.parent.mkdir(exist_ok=True)
        shutil.copy2(source, destination)
        frames.append(dict(image='images/' + name, session=session, phase=phase,
            deployment_confirmed=deployed, stage='0-1', split='val' if session == 'attempt3' else 'train',
            sha256=hashlib.sha256(destination.read_bytes()).hexdigest(),
            reviewed_by='Codex visual review', image_size=list(Image.open(destination).size)))
    stage = dict(schema_version=1, stage='0-1', name='坍塌', chapter='EP00 黑暗时代上',
        frames=frames, layout=dict(enemy_entry='right', protection_target='left',
        warning='Selection and direction screens change camera projection; recalculate placement from current image.'),
        experiences=[dict(operator='风笛', operator_level=90, facing='right',
            observed_card=[0.044, 0.941], observed_drop=[0.72, 0.43],
            observed_direction_drag=[[0.738, 0.42], [0.85, 0.40]],
            deployment='visually_confirmed', outcome='two_stars_with_leaks',
            automatic_replay_allowed=False, evidence=['1789146646071-drag.png', '1789146663660-drag.png', '1789146721942-capture.png'],
            lesson='Deployment works; timing and route coverage are not yet a validated three-star plan.')],
        failures=[dict(drop=[0.666, 0.492], symptom='operator disappears on release; no direction selector',
            cause='unresolved: release method and drop location changed together')],
        policy='Retrieve candidates; verify current stage, camera, operator availability, cost, green tile and direction UI. Never replay raw coordinates solely from image similarity.')
    (STORE / '0-1.json').write_text(json.dumps(stage, ensure_ascii=False, indent=2), encoding='utf-8')
    return dict(stage='0-1', images=len(frames), store=str(STORE))

def retrieve(image, stage_id=None, limit=3):
    target = feature(image)
    with Image.open(image) as opened:
        target_ratio = opened.width / opened.height
    candidates = []
    for file in STORE.glob('*.json'):
        stat = file.stat()
        memory = _cached_manifest(str(file), stat.st_mtime_ns, stat.st_size)
        if stage_id and memory['stage'] != stage_id:
            continue
        for frame in memory['frames']:
            path = STORE / frame['image']
            w, h = frame['image_size']
            if abs(w / h - target_ratio) > 0.03:
                continue
            stat = path.stat()
            distance = float(np.abs(target - _cached_feature(str(path), stat.st_mtime_ns, stat.st_size)).mean())
            candidates.append(dict(stage=memory['stage'], phase=frame['phase'], image=str(path),
                layout_distance=round(distance, 6), deployment_confirmed=frame['deployment_confirmed'],
                experience=memory['experiences'], warnings=[memory['policy'], memory['layout']['warning']]))
    candidates.sort(key=lambda entry: entry['layout_distance'])
    return dict(candidates=candidates[:limit], identity_confirmed=False, automatic_replay_allowed=False,
        method='32x20 RGB mean absolute distance; uncalibrated similarity, not a confidence probability')

def add_frame(image, stage, phase, session):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', stage or ''):
        raise ValueError('Invalid stage identifier')
    if phase not in ('battle', 'paused', 'selection', 'direction', 'result', 'unknown'):
        raise ValueError('Invalid phase')
    digest = hashlib.sha256(Path(image).read_bytes()).hexdigest()
    file = STORE / (stage + '.json')
    memory = json.loads(file.read_text(encoding='utf-8')) if file.exists() else dict(
        schema_version=1, stage=stage, name=stage, frames=[], experiences=[], failures=[],
        layout={'warning':'Map and camera not verified'}, policy='Unreviewed observations are not action instructions.')
    if any(frame['sha256'] == digest for frame in memory['frames']):
        return dict(added=False, reason='duplicate', stage=stage)
    destination = STORE / 'images' / (digest + '.png')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(image) as opened:
        size = list(opened.size)
        opened.convert('RGB').save(destination)
    memory['frames'].append(dict(image='images/'+destination.name, sha256=digest, stage=stage,
        phase=phase, session=session, image_size=size, split='unassigned', reviewed_by=None,
        deployment_confirmed=None))
    temporary = file.with_suffix('.tmp')
    temporary.write_text(json.dumps(memory, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(file)
    return dict(added=True, stage=stage, requires_review=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['seed', 'query', 'add'])
    parser.add_argument('--image', type=Path)
    parser.add_argument('--stage')
    parser.add_argument('--phase', default='unknown')
    parser.add_argument('--session', default='unassigned')
    args = parser.parse_args()
    if args.command != 'seed' and not args.image:
        parser.error('--image required')
    result = seed() if args.command == 'seed' else (retrieve(args.image, args.stage) if args.command == 'query'
        else add_frame(args.image, args.stage, args.phase, args.session))
    print(json.dumps(result, ensure_ascii=False))
