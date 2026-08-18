"""scenes.py —— 场景分类 v2（任务书 §5 Phase C）。

每个场景至少组合两类互相独立的证据；低置信度必须落入 unknown；
输出候选分数与 evidence，方便验收误判。ROI 全部使用相对坐标。
"""
import os
import sys

import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import features
import roi

SCENE_NAMES = ["gameplay", "results", "songSelect", "pause", "fail", "unknown"]

# 判定阈值：最高候选低于此值 -> unknown
CONFIDENCE_MIN = 0.42


def compute_features(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    return {
        "width": width,
        "height": height,
        "circles": features.circle_candidates(gray, width, height),
        "edgeDensity": features.edge_density(gray),
        "brightness": features.brightness(gray),
        "saturated": features.saturated_ratio(image),
        "stripes": features.horizontal_stripes(image),
        "boxes": features.layout_box_count(image),
    }


# ---------- 各场景打分（返回 (score, evidence)） ----------

def score_gameplay(image, gray, feats):
    evidence = []
    circle_score = min(1.0, feats["circles"] / 6.0)
    if feats["circles"] >= 3:
        evidence.append("playfield-circle-pattern")
    combo_white = roi.white_ratio(gray, 0.60, 0.03, 0.98, 0.16)
    if combo_white > 0.008:
        evidence.append("active-combo-region")
    health_green = roi.green_ratio(image, 0.02, 0.90, 0.34, 0.985)
    if health_green > 0.04:
        evidence.append("health-bar-region")
    edge_mid = 0.05 <= feats["edgeDensity"] <= 0.45
    score = 0.40 * circle_score + 0.30 * min(1.0, combo_white * 40) + 0.30 * min(1.0, health_green * 6)
    if not edge_mid:
        score *= 0.8
    return round(score, 3), evidence


def score_results(image, gray, feats):
    evidence = []
    card_brightness = roi.relative_center_brightness(gray, 0.15, 0.15, 0.85, 0.85)
    if card_brightness > 0.02:
        evidence.append("centered-card-region")
    acc_green = roi.green_ratio(image, 0.20, 0.18, 0.50, 0.42)
    if acc_green > 0.02:
        evidence.append("large-green-accuracy-digits")
    grade_yellow = roi.yellow_ratio(image, 0.58, 0.12, 0.88, 0.32)
    if grade_yellow > 0.01:
        evidence.append("grade-region")
    low_playfield = feats["circles"] < 3
    if low_playfield:
        evidence.append("low-playfield-activity")
    acc_norm = min(1.0, acc_green * 10)
    score = (0.50 * acc_norm
             + 0.20 * roi.normalize(card_brightness, 0.0, 0.12)
             + 0.15 * min(1.0, grade_yellow * 8)
             + 0.15 * (1.0 if low_playfield else 0.0))
    return round(score, 3), evidence


def score_song_select(image, gray, feats):
    evidence = []
    stripes = feats["stripes"]
    stripe_score = min(1.0, stripes / 4.0)
    if stripes >= 3:
        evidence.append("horizontal-list-stripes")
    # 左右亮度差只有与列表条结构同时出现才算封面证据（否则渐变等图会误报）
    cover_diff = 0.0
    if stripes >= 2:
        cover_diff = abs(roi.roi_mean(gray, 0.04, 0.14, 0.26, 0.62) - roi.roi_mean(gray, 0.30, 0.14, 0.90, 0.62)) / 255.0
        if cover_diff > 0.04:
            evidence.append("cover-vs-list-region-difference")
    low_playfield = feats["circles"] < 2
    if low_playfield:
        evidence.append("no-playfield-circles")
    score = 0.45 * stripe_score + 0.30 * roi.normalize(cover_diff, 0.0, 0.15) + 0.25 * (1.0 if low_playfield else 0.0)
    return round(score, 3), evidence


def score_pause(image, gray, feats):
    evidence = []
    center_block = roi.relative_center_brightness(gray, 0.25, 0.32, 0.75, 0.67)
    if center_block > 0.03:
        evidence.append("centered-menu-block")
    dark = feats["brightness"] < 0.35
    if dark:
        evidence.append("dimmed-background")
    low_activity = feats["circles"] < 3 and feats["edgeDensity"] < 0.10
    if low_activity:
        evidence.append("low-motion-layout")
    has_green_digits = roi.green_ratio(image, 0.20, 0.18, 0.50, 0.42) > 0.02
    score = (0.40 * roi.normalize(center_block, 0.0, 0.10)
             + 0.35 * (1.0 if dark else 0.0)
             + 0.25 * (1.0 if low_activity else 0.0))
    # 完全不暗的画面（如桌面）不可能是暂停菜单；结算绿字存在时也降权
    if not dark:
        score *= 0.55
    if has_green_digits:
        score *= 0.7
    return round(score, 3), evidence


def score_fail(image, gray, feats):
    evidence = []
    center_red = roi.red_ratio(image, 0.28, 0.35, 0.72, 0.65)
    if center_red > 0.02:
        evidence.append("red-fail-overlay")
    dark = feats["brightness"] < 0.35
    if dark:
        evidence.append("dimmed-background")
    low_activity = feats["circles"] < 3 and feats["edgeDensity"] < 0.10
    if low_activity:
        evidence.append("low-motion-layout")
    has_green_digits = roi.green_ratio(image, 0.20, 0.18, 0.50, 0.42) > 0.02
    score = 0.55 * min(1.0, center_red * 12) + 0.25 * (1.0 if dark else 0.0) + 0.20 * (1.0 if low_activity else 0.0)
    if not dark:
        score *= 0.7
    if has_green_digits:
        score *= 0.6
    return round(score, 3), evidence


def score_unknown(image, gray, feats):
    evidence = []
    if feats["brightness"] < 0.04:
        evidence.append("black-screen")
    if feats["brightness"] > 0.97:
        evidence.append("overexposed")
    if feats["edgeDensity"] < 0.005:
        evidence.append("low-texture")
    noise = 0.15 if not evidence else 0.05
    return noise, evidence


_SCORERS = [
    ("gameplay", score_gameplay),
    ("results", score_results),
    ("songSelect", score_song_select),
    ("pause", score_pause),
    ("fail", score_fail),
    ("unknown", score_unknown),
]


def classify(image):
    """返回 {name, confidence, candidates, evidence}。"""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    feats = compute_features(image)
    candidates = {}

    # 质量护栏：极端亮度/超高边缘密度（噪声）直接判 unknown，不做场景竞争
    if feats["brightness"] < 0.04 or feats["brightness"] > 0.97 or feats["edgeDensity"] > 0.55:
        guard_evidence = []
        if feats["brightness"] < 0.04:
            guard_evidence.append("black-screen")
        if feats["brightness"] > 0.97:
            guard_evidence.append("overexposed")
        if feats["edgeDensity"] > 0.55:
            guard_evidence.append("high-edge-noise")
        candidates = {name: 0.0 for name in SCENE_NAMES}
        candidates["unknown"] = 0.6
        return {"name": "unknown", "confidence": 0.6, "candidates": candidates, "evidence": guard_evidence}

    best_name = "unknown"
    best_score = 0.0
    best_evidence = []
    for name, scorer in _SCORERS:
        score, evidence = scorer(image, gray, feats)
        candidates[name] = round(score, 3)
        if score > best_score:
            best_name = name
            best_score = score
            best_evidence = evidence
    if best_name != "unknown" and best_score < CONFIDENCE_MIN:
        best_name = "unknown"
    return {
        "name": best_name,
        "confidence": round(best_score, 3),
        "candidates": candidates,
        "evidence": best_evidence,
    }
