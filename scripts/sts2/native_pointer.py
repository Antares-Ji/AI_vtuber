"""Bounded relative pointer positioning; callers own foreground and input guards."""
import math
import time


def relative_move(target, read_position, send_delta, guard, duration=.35,
                  clock=time.monotonic, sleep=time.sleep, sample=lambda point: None):
    if len(target) != 2 or any(not math.isfinite(v) for v in target):
        raise ValueError('Finite screen target required')
    if not .02 <= duration <= 5:
        raise ValueError('Invalid relative move duration')
    start = read_position()
    started = clock()
    # Mouse acceleration is not assumed to be 1:1. Small relative counts are
    # corrected using measured position, without changing Windows mouse settings.
    while True:
        guard()
        now = clock()
        point = read_position()
        sample(point)
        if now - started >= duration and max(abs(target[i]-point[i]) for i in (0, 1)) <= 2:
            return point
        if now - started >= duration + 1.5:
            raise TimeoutError('Relative pointer did not reach the observed target')
        t = min(1, (now-started)/duration)
        q = t*t*t*(10+t*(-15+6*t))
        destination = [start[i]+(target[i]-start[i])*q for i in (0, 1)]
        delta = []
        for i in (0, 1):
            error = destination[i]-point[i]
            count = 0 if abs(error) <= 1 else max(-12, min(12, round(error/4) or (1 if error > 0 else -1)))
            delta.append(count)
        if any(delta):
            send_delta(*delta)
        sleep(1/120)
