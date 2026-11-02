"""Offline HSV candidate experiment. Never authorizes input or assumes north-up."""
import argparse
import hashlib
import json
import math
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]


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


def detect(image, sources):
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
    accepted = len(candidates) == 1
    angle = None
    if accepted:
        cx, cy = candidates[0]['center']
        angle = math.degrees(math.atan2(cy-y-h/2, cx-x-w/2))
    return {'roi': [x, y, w, h], 'accepted': accepted, 'candidates': candidates,
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
    rows, deltas = [], []
    for row in archive['frames']:
        raw = Path(row['image']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != row['sha256']:
            raise ValueError('frame_hash_mismatch')
        image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        current = {key: row.get(key) for key in ('evidence', 'image', 'sha256', 'session', 'hud', 'at')}
        current.update(detect(image, sources))
        if rows:
            previous = rows[-1]
            if (current['hud'] and current['hud'] == previous['hud'] and current['session'] == previous['session']
                    and current['accepted'] and previous['accepted']):
                deltas.append(abs((current['imageBearingDegrees']-previous['imageBearingDegrees']+180) % 360-180))
        rows.append(current)
    eligible = [row for row in rows if row['hud'] and 8 < row['hud']['meters'] <= 1500]
    summary = {'frames': len(rows), 'hits': sum(row['accepted'] for row in rows),
               'hitRate': sum(row['accepted'] for row in rows)/len(rows) if rows else 0,
               'hudEligibleFrames': len(eligible), 'hudEligibleHits': sum(row['accepted'] for row in eligible),
               'angleComparablePairs': len(deltas), 'stableImagePairs': sum(delta <= 15 for delta in deltas),
               'maximumImageAngleDelta': max(deltas, default=None), 'deploymentGatePassed': False}
    report = {'kind': 'offline_minimap_hsv_replay', 'inputOrNetworkCalls': 0, 'input': str(input_file),
              'inputSha256': hashlib.sha256(input_file.read_bytes()).hexdigest(),
              'sources': sources, 'summary': summary, 'frames': rows,
              'limitations': ['A color blob is not proof of a quest icon.',
                              'Ambiguous same-color components remain rejected; no highest-area fallback.',
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
