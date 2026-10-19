"""Flappy Bird agents: observations in, flap/idle action out."""
from pathlib import Path

import h5py
import numpy as np
import flappy_bird_gymnasium
from numba import njit


class PretrainedDQN:
    """NumPy inference for the package's original 12-feature Dueling DQN.

    ELU hidden layers and advantage head match tests/dueling.py. The value
    head and advantage mean are common to both actions, so argmax(A) is exact.
    No TensorFlow runtime or retraining is needed for these bundled weights.
    """

    def __init__(self):
        self.path = Path(flappy_bird_gymnasium.__file__).parent / "assets/model/model.h5"
        with h5py.File(self.path, "r") as f:
            self.layers = []
            for name in ("dense", "dense_1", "dense_3"):
                g = f[f"{name}/dueling_dqn/{name}"]
                self.layers.append((g["kernel:0"][:], g["bias:0"][:]))

    def act(self, obs):
        x = np.asarray(obs, dtype=np.float32)
        for w, b in self.layers[:-1]:
            x = x @ w + b
            negative = x < 0
            x[negative] = np.expm1(x[negative])
        w, b = self.layers[-1]
        return int(np.argmax(x @ w + b))


# Recursive JIT functions must not use disk caching here: Numba on Windows
# can reload stale recursion addresses and crash on the next process launch.
@njit(cache=False)
def _viable(t, y, velocity, lower, upper, failed, stamp):
    """Search for at least one collision-free action sequence, with memoization."""
    if y < lower[t] or y > upper[t]:
        return False
    if t == len(lower) - 1:
        return True
    index = y * 20 + velocity + 9
    if failed[t, index] == stamp:
        return False
    # Branch order only accelerates search; both actions are tested.
    preferred = int(y + 2 * velocity > (lower[t] + upper[t]) / 2 + 12)
    for choice in range(2):
        action = preferred if choice == 0 else 1 - preferred
        next_velocity = -9 if action else min(velocity + 1, 10)
        if _viable(t + 1, y + next_velocity, next_velocity, lower, upper, failed, stamp):
            return True
    failed[t, index] = stamp
    return False


@njit(cache=False)
def _safe_action(obs, proposed, horizon, failed, stamp):
    # These are the published default game dimensions and physics, not private
    # future state. The policy sees only the same public observation as the DQN.
    lower = np.full(horizon + 1, 2, dtype=np.int32)
    upper = np.full(horizon + 1, 377, dtype=np.int32)
    for t in range(1, horizon + 1):
        for i in range(3):
            x = int(obs[i * 3] * 288 - 4 * t)
            top = int(round(obs[i * 3 + 1] * 512))
            bottom = int(round(obs[i * 3 + 2] * 512))
            # The game reports unseen pipes as (288, 0, 512). They have no
            # collision constraints until their position actually becomes visible.
            if top == 0 and bottom == 512:
                continue
            if x < 57 + 34 and x + 52 > 57:
                lower[t] = max(lower[t], top + 2)
                upper[t] = min(upper[t], bottom - 24 - 2)
    y = int(round(obs[9] * 512))
    velocity = int(round(obs[10] * 10))
    for choice in range(2):
        action = proposed if choice == 0 else 1 - proposed
        next_velocity = -9 if action else min(velocity + 1, 10)
        if _viable(1, y + next_velocity, next_velocity, lower, upper, failed, stamp):
            return action, True
    return proposed, False


class GuardedDQN(PretrainedDQN):
    """Pretrained neural policy with a 36-frame physics look-ahead guard.

    The guard changes an action only when no safe continuation exists within
    its horizon. It never changes game state, collision rules, score or reward.
    """

    def __init__(self):
        super().__init__()
        self.horizon = 36
        self.failed = np.zeros((self.horizon + 1, 405 * 20), dtype=np.int64)
        self.decisions = 0
        self.interventions = 0
        self.no_safe_continuation = 0

    def act(self, obs):
        proposed = super().act(obs)
        self.decisions += 1
        action, safe = _safe_action(obs, proposed, self.horizon, self.failed, self.decisions)
        self.interventions += int(action != proposed)
        self.no_safe_continuation += int(not safe)
        return int(action)
