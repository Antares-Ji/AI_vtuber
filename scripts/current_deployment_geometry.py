"""Current selected-frame geometry only. No map references, model or input calls.

Green establishes current placement legality, not terrain type or strategy.
The caller must confirm operator identity and high-ground semantics separately.
"""
import math
import cv2
import numpy as np

MAP_BOX = (430, 160, 1480, 800)


def _frame(frame):
    if not isinstance(frame, np.ndarray) or frame.shape != (1024, 1600, 3):
        raise ValueError('Expected current BGR frame at 1600x1024')


def _point(proposal):
    if not isinstance(proposal, (list, tuple)) or len(proposal) != 2:
        raise ValueError('Expected normalized model proposal')
    if any(type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1
           for value in proposal):
        raise ValueError('Invalid normalized model proposal')
    return np.array(proposal, dtype=np.float64) * [1600, 1024]


def green_target(frame, proposal, paused=True):
    """Project at most 45 pixels into a current green interior (>12px margin).

    UI exclusions are layout bounds, not stored deployment coordinates. Unknown
    candidates and candidates outside the current legal mask fail closed.
    """
    _frame(frame)
    point = _point(proposal)
    b, g, r = cv2.split(frame.astype(np.float32))
    mask = ((g > r * 1.15) & (g > b * 1.05) & (g > (18 if paused else 60))).astype(np.uint8)
    x1, y1, x2, y2 = MAP_BOX
    mask[:y1] = 0
    mask[y2:] = 0
    mask[:, :x1] = 0
    mask[:, x2:] = 0
    interior = cv2.distanceTransform(mask, cv2.DIST_L2, 5) > 12
    ys, xs = np.where(interior)
    if not len(xs):
        raise ValueError('No current legal green interior')
    distance = (xs - point[0]) ** 2 + (ys - point[1]) ** 2
    index = int(distance.argmin())
    if distance[index] > 45 ** 2:
        raise ValueError('Model proposal exceeds 45px from current legal green interior')
    return [float(xs[index] / 1600), float(ys[index] / 1024)]


def direction_center(frame):
    """Locate a unique current pale diamond; ambiguous or absent returns None.

    This is only a geometric gate. Identity/profile and the direction phase must
    also be confirmed by the caller; white map objects are not semantic proof.
    """
    _frame(frame)
    values = frame.astype(np.int16)
    low = values.min(axis=2)
    spread = values.max(axis=2) - low
    mask = ((low > 150) & (spread < 40)).astype(np.uint8) * 255
    x1, y1, x2, y2 = MAP_BOX
    mask[:y1] = 0
    mask[y2:] = 0
    mask[:, :x1] = 0
    mask[:, x2:] = 0
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if not 1000 <= area <= 40000:
            continue
        polygon = cv2.approxPolyDP(contour, cv2.arcLength(contour, True) * .035, True)
        if len(polygon) != 4 or not cv2.isContourConvex(polygon):
            continue
        x, y, width, height = cv2.boundingRect(polygon)
        if not 45 <= width <= 300 or not 45 <= height <= 300 or not .6 <= width / height <= 1.6:
            continue
        corners = polygon[:, 0].astype(float)
        center = corners.mean(axis=0)
        # A direction diamond has top/bottom tips and left/right tips, unlike
        # axis-aligned white UI boxes. Do not choose a largest object blindly.
        dx = np.abs(corners[:, 0] - center[0])
        dy = np.abs(corners[:, 1] - center[1])
        vertical = dx < width * .15
        horizontal = dy < height * .15
        if vertical.sum() != 2 or horizontal.sum() != 2 or (vertical & horizontal).any():
            continue
        candidates.append([float(center[0] / 1600), float(center[1] / 1024)])
    return candidates[0] if len(candidates) == 1 else None
