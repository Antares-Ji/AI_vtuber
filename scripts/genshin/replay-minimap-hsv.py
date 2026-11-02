"""Offline HSV candidate experiment. Never authorizes input or assumes north-up."""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]

# Only the commission mapping is evidenced by the pinned upstream resource.
# Yellow/blue category mappings remain unknown; never infer from a quest name.
CATEGORY_SOURCES = {'委托任务': 'minimap-commission.png'}
CATEGORIES = {'委托任务', '世界任务', '传说任务', '魔神任务'}


def menu_category(texts):
    """Associate the selected right-hand title with its left-hand category."""
    rows = [r for r in texts if len(r.get('box', [])) == 4]
    normal = lambda r: re.sub(r'\s', '', r.get('text', ''))
    titles = [r for r in rows if 700 < r['box'][0] < 1500
              and 100 <= r['box'][1] < 165 and r['box'][2] > 50]
    stages = [r for r in rows if 800 < r['box'][0] < 1300
              and 180 <= r['box'][1] < 300
              and re.match(r'^(前往|前去|寻找|跟随|尝试|抵达|与.+对话)', normal(r))]
    controls = [r for r in rows if normal(r) in {'追踪目标', '停止追踪', '开始追踪'}
                and r['box'][0] > 1400 and r['box'][1] > 900]
    if len(titles) != 1 or len(stages) != 1 or len(controls) != 1:
        return None
    entries = [r for r in rows if r['box'][0] < 650 and 100 <= r['box'][1] < 980
               and normal(r) == normal(titles[0])]
    if len(entries) != 1:
        return None
    headers = sorted([r for r in rows if r['box'][0] < 650
                      and 100 <= r['box'][1] < entries[0]['box'][1]
                      and normal(r) in CATEGORIES], key=lambda r: r['box'][1])
    if not headers:
        return None
    return {'quest': normal(titles[0]), 'stage': normal(stages[0]),
            'category': normal(headers[-1]), 'source': 'archived_menu_ocr'}


def category_history(root):
    records = []
    for file in root.glob('*/step-*.json'):
        raw = file.read_bytes()
        record = json.loads(raw.decode('utf-8-sig'))
        category = menu_category(record.get('request', {}).get('texts', []))
        if category and isinstance(record.get('at'), (int, float)):
            records.append({**category, 'at': record['at'], 'evidence': str(file),
                            'sha256': hashlib.sha256(raw).hexdigest()})
    return sorted(records, key=lambda r: r['at'])


def category_for_frame(row, history, quest=None):
    if not row.get('hud') or not isinstance(row.get('at'), (int, float)):
        return None
    stage = re.sub(r'\s', '', row['hud']['stage'])
    # Historical menus establish category, not that a task is still tracked.
    # Match the current HUD stage and quest identity; never consume future data.
    candidates = [r for r in history if 0 <= row['at']-r['at'] <= 24*60*60*1000
                  and r['stage'] == stage and (not quest or r['quest'] == quest)]
    identities = {(r['quest'], r['category']) for r in candidates}
    return candidates[-1] if len(identities) == 1 else None


def select_candidate(candidates, roi, category=None):
    selected = candidates
    source = CATEGORY_SOURCES.get(category)
    if source:
        selected = [c for c in candidates if source in c['sources']]
    reason = 'category_unique' if source else 'unique_color_component'
    same_color = len({name for c in selected for name in c['sources']}) == 1
    if len(selected) > 1 and (source or same_color):
        x, y, w, h = roi
        radius = min(w, h)/2
        # A pinned marker lies within one maximum icon width of the rim.
        # Prefer only ONE eligible rim component. Never pick largest of ties.
        rim = [c for c in selected if math.dist(c['center'], [x+w/2, y+h/2]) >= radius-28*(w/212)]
        if len(rim) == 1:
            selected, reason = rim, 'unique_rim_component'
    return (selected[0], reason) if len(selected) == 1 else (None, 'ambiguous' if selected else 'not_found')


def color_range(image):
    """Select the resource's dominant saturated hue, without reading game frames."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    pixels = hsv[(hsv[:, :, 1] >= 60) & (hsv[:, :, 2] >= 150)]
    if len(pixels) < 6:
        raise ValueError('source_has_insufficient_color_pixels')
    mode = int(np.bincount(pixels[:, 0], minlength=180).argmax())
    delta = np.abs(pixels[:, 0].astype(int) - mode)
    selected = pixels[np.minimum(delta, 180 - delta) <= 8]
    # Circular offsets retain red hues that straddle OpenCV's 0/179 boundary.
    offsets = (selected[:, 0].astype(int) - mode + 90) % 180 - 90
    return {'hueMode': mode, 'hueOffsets': [int(offsets.min()) - 2, int(offsets.max()) + 2],
            'saturationMin': max(0, int(selected[:, 1].min()) - 10),
            'valueMin': max(0, int(selected[:, 2].min()) - 10),
            'sourcePixels': len(selected)}


def detect(image, sources, category=None):
    height, width = image.shape[:2]
    scale = min(width / 1920, 1)
    x, y, w, h = [round(v * scale) for v in (62, 19, 212, 212)]
    if w < 32 or h < 32 or x + w > width or y + h > height:
        raise ValueError('invalid_minimap_roi')
    hsv = cv2.cvtColor(image[y:y+h, x:x+w], cv2.COLOR_BGR2HSV)
    yy, xx = np.indices((h, w))
    radius = np.hypot(xx-w/2, yy-h/2)
    ring = (radius >= 12*scale) & (radius <= min(w, h)/2)
    candidates, components = [], []
    for source in sources:
        color = source['colorRange']
        offset = (hsv[:, :, 0].astype(int) - color['hueMode'] + 90) % 180 - 90
        mask = ((offset >= color['hueOffsets'][0]) & (offset <= color['hueOffsets'][1])
                & (hsv[:, :, 1] >= color['saturationMin'])
                & (hsv[:, :, 2] >= color['valueMin']) & ring).astype(np.uint8)*255
        _, _, stats, centers = cv2.connectedComponentsWithStats(mask)
        for stat, center in zip(stats[1:], centers[1:]):
            bx, by, bw, bh, area = map(int, stat)
            if not (6*scale**2 <= area <= 250*scale**2
                    and 2*scale <= bw <= 28*scale and 2*scale <= bh <= 28*scale):
                continue
            c = {'source': source['file'], 'box': [x+bx, y+by, bw, bh], 'area': area,
                 'center': [x+float(center[0]), y+float(center[1])], 'sources': [source['file']]}
            components.append(c)
            # Merge only overlapping color definitions, never two separate
            # components from one color mask into a falsely unique target.
            near = [q for q in candidates if source['file'] not in q['sources']
                    and math.dist(q['center'], c['center']) <= 8*scale]
            if len(near) == 1:
                near[0]['sources'].append(source['file'])
            else:
                candidates.append(c)
    marker, selection_reason = select_candidate(candidates, [x, y, w, h], category)
    accepted = marker is not None
    angle = None
    if accepted:
        cx, cy = marker['center']
        angle = math.degrees(math.atan2(cy-y-h/2, cx-x-w/2))
    return {'roi': [x, y, w, h], 'accepted': accepted, 'candidates': candidates,
            'selected': marker, 'selectionReason': selection_reason, 'category': category,
            'components': components, 'imageBearingDegrees': angle,
            'gameBearingDegrees': None, 'gameBearingReason': 'same_frame_projection_required'}


def replay(input_file, output_file):
    manifest = json.loads((ROOT/'scripts/genshin/assets/minimap-candidates.source.json').read_text())
    sources = []
    for spec in manifest['templates']:
        file = ROOT/'scripts/genshin/assets'/spec['file']
        raw = file.read_bytes()
        if hashlib.sha256(raw).hexdigest() != spec['sha256']:
            raise ValueError('source_hash_mismatch:' + spec['file'])
        image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        sources.append({**spec, 'colorRange': color_range(image)})
    archive = json.loads(input_file.read_text(encoding='utf8'))
    history = category_history(ROOT/'runtime/genshin/story')
    rows, deltas = [], []
    for row in archive['frames']:
        raw = Path(row['image']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != row['sha256']:
            raise ValueError('frame_hash_mismatch')
        image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        current = {key: row.get(key) for key in ('evidence', 'image', 'sha256', 'session', 'hud', 'at')}
        record = json.loads(Path(row['evidence']).read_text(encoding='utf-8-sig'))
        quest = record.get('decision', {}).get('quest')
        category = category_for_frame(row, history, quest)
        current['categoryEvidence'] = category
        current.update(detect(image, sources, category['category'] if category else None))
        if rows:
            previous = rows[-1]
            if (current['hud'] and current['hud'] == previous['hud'] and current['session'] == previous['session']
                    and current['accepted'] and previous['accepted']):
                deltas.append(abs((current['imageBearingDegrees']-previous['imageBearingDegrees']+180) % 360-180))
        rows.append(current)
    eligible = [row for row in rows if row['hud'] and 8 < row['hud']['meters'] <= 1500]
    eligible_rate = sum(row['accepted'] for row in eligible)/len(eligible) if eligible else 0
    summary = {'frames': len(rows), 'hits': sum(row['accepted'] for row in rows),
               'hitRate': sum(row['accepted'] for row in rows)/len(rows) if rows else 0,
               'hudEligibleFrames': len(eligible), 'hudEligibleHits': sum(row['accepted'] for row in eligible),
               'hudEligibleHitRate': eligible_rate,
               'coverageGate': 'standard' if eligible_rate >= .7 else 'bounded_trial_only' if eligible_rate >= .5 else 'failed',
               'categoryGroundedFrames': sum(row['categoryEvidence'] is not None for row in rows),
               'colorRestrictedFrames': sum(row['category'] in CATEGORY_SOURCES for row in rows),
               'angleComparablePairs': len(deltas), 'stableImagePairs': sum(delta <= 15 for delta in deltas),
               'maximumImageAngleDelta': max(deltas, default=None), 'deploymentGatePassed': False}
    report = {'kind': 'offline_minimap_hsv_replay', 'inputOrNetworkCalls': 0, 'input': str(input_file),
              'inputSha256': hashlib.sha256(input_file.read_bytes()).hexdigest(),
              'sources': sources, 'summary': summary, 'frames': rows,
              'limitations': ['A color blob is not proof of a quest icon.',
                              'Only commission color is proven; other categories retain all colors.',
                              'Multiple rim candidates remain rejected; no highest-area fallback.',
                              'Coverage is not detection accuracy; HSV native integration is not deployed.',
                              'Saved HUD/scene data is not new independent inference.',
                              'Image bearings cannot certify world direction without projection.']}
    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf8')
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, default=ROOT/'runtime/genshin/minimap-replay-history.json')
    parser.add_argument('--output', type=Path, default=ROOT/'runtime/genshin/minimap-hsv-replay.json')
    args = parser.parse_args()
    print(json.dumps(replay(args.input, args.output)))
