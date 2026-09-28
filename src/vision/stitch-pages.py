"""Conservative vertical-scroll stitching. Originals are never changed."""
import json
import sys
from pathlib import Path
import cv2
import numpy as np


def alignment(a, b):
    if a.shape != b.shape:
        return None
    ga, gb = [cv2.cvtColor(im, cv2.COLOR_BGR2GRAY) for im in (a, b)]
    changed = cv2.absdiff(ga, gb) > 22
    ys = np.where(changed.mean(axis=1) > .12)[0]
    xs = np.where(changed.mean(axis=0) > .12)[0]
    if len(xs) < 100 or len(ys) < 100:
        return None
    x0, x1 = int(xs[0]), int(xs[-1] + 1)
    y0, y1 = int(ys[0]), int(ys[-1] + 1)
    aa, bb = ga[y0:y1, x0:x1], gb[y0:y1, x0:x1]
    orb = cv2.ORB_create(nfeatures=2500, fastThreshold=10)
    ka, da = orb.detectAndCompute(aa, None)
    kb, db = orb.detectAndCompute(bb, None)
    if da is None or db is None or len(db) < 2:
        return None
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(da, db, k=2)
    deltas = []
    for pair in pairs:
        if len(pair) != 2 or pair[0].distance >= .7 * pair[1].distance:
            continue
        m = pair[0]
        ax, ay = ka[m.queryIdx].pt
        bx, by = kb[m.trainIdx].pt
        if abs(ax - bx) < 2 and 12 < ay - by < .7 * (y1 - y0):
            deltas.append((ay - by, ax, ay))
    if len(deltas) < 16:
        return None
    values = np.array(deltas)
    # Select a consensus translation, then verify actual overlapping pixels.
    votes = [np.sum(abs(values[:, 0] - d) < 2) for d in values[:, 0]]
    mask = abs(values[:, 0] - values[np.argmax(votes), 0]) < 2
    support = values[mask]
    if len(support) < 16 or len(support) < .65 * len(values):
        return None
    dy = int(round(np.median(support[:, 0])))
    if np.ptp(support[:, 1]) < .35 * (x1 - x0) or np.ptp(support[:, 2]) < .2 * (y1 - y0):
        return None
    error = cv2.absdiff(aa[dy:], bb[:-dy])
    if error.mean() > 12 or (error > 30).mean() > .12:
        return None
    return dict(roi=[x0, y0, x1, y1], dy=dy, matches=len(support), overlapError=round(float(error.mean()), 2))


def stitch(folder):
    folder = Path(folder)
    manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
    segments, previous, canvas, current = [], None, None, None
    for frame in manifest['frames']:
        raw = np.fromfile(folder / frame['file'], dtype=np.uint8)
        im = cv2.imdecode(raw, cv2.IMREAD_COLOR)
        if im is None or im.shape[0] * im.shape[1] > 12000000:
            raise ValueError('Invalid or oversized frame')
        match = alignment(previous, im) if previous is not None else None
        if match and (current['roi'] is None or max(abs(a-b) for a,b in zip(current['roi'], match['roi'])) <= 4):
            x0, y0, x1, y1 = current['roi'] or match['roi']
            dy = match['dy']
            base = previous[y0:y1, x0:x1] if current['roi'] is None else canvas
            if (base.shape[0] + dy) * base.shape[1] <= 24000000:
                canvas = np.concatenate([base, im[y1-dy:y1, x0:x1]], axis=0)
                current['roi'] = [x0, y0, x1, y1]
                current['pieces'].append(dict(frame=frame['file'], offsetY=canvas.shape[0]-(y1-y0), **match))
                current['kind'] = 'scroll-content'
            else:
                match = None
        else:
            match = None
        if not match:
            if current is not None:
                cv2.imencode('.png', canvas)[1].tofile(folder / current['file'])
            canvas = im.copy()
            current = dict(file=f'segment-{len(segments)+1:03}.png', kind='original', roi=None,
                           reference=frame['file'], pieces=[dict(frame=frame['file'], offsetY=0)],
                           verified=False, reason='first-frame' if previous is None else 'alignment-uncertain-or-page-change')
            segments.append(current)
        previous = im
    if current is not None:
        cv2.imencode('.png', canvas)[1].tofile(folder / current['file'])
    return segments


if __name__ == '__main__':
    print(json.dumps(stitch(sys.argv[1]), ensure_ascii=True))
