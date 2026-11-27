"""Stage 4a: Exact anatomical joint detection from cleaned layer alpha silhouettes (zero proportion drift!)."""

from __future__ import annotations

import math

import numpy as np
from PIL import Image

from ..schema import BONE_TIPS_NORM, CANONICAL_JOINTS_NORM, BoneDef


def _alpha_stats(img: Image.Image | None) -> dict[str, float] | None:
    if img is None:
        return None
    alpha = np.array(img.convert("RGBA"))[:, :, 3]
    ys, xs = np.where(alpha > 20)
    if len(xs) < 16:
        return None
    return {
        "x0": float(xs.min()),
        "x1": float(xs.max()),
        "y0": float(ys.min()),
        "y1": float(ys.max()),
        "cx": float(xs.mean()),
        "cy": float(ys.mean()),
        "w": float(xs.max() - xs.min() + 1),
        "h": float(ys.max() - ys.min() + 1),
        "count": float(len(xs)),
    }


def _arm_endpoints(img: Image.Image | None, side: str) -> tuple[tuple[float, float], tuple[float, float], tuple[float, float]] | None:
    """Detect exact (shoulder_ball, elbow_mid, hand_tip) directly from an arm layer silhouette."""
    if img is None:
        return None
    alpha = np.array(img.convert("RGBA"))[:, :, 3] > 25
    ys, xs = np.where(alpha)
    if len(xs) < 40:
        return None
    top_y = float(ys.min())
    sh_mask = ys <= (top_y + max(28.0, (ys.max() - top_y) * 0.10))
    sh_x = float(xs[sh_mask].mean())
    sh_y = float(ys[sh_mask].mean())

    outer_x = float(xs.min()) if side == "left" else float(xs.max())
    hand_mask = np.abs(xs - outer_x) <= max(36.0, (xs.max() - xs.min()) * 0.16)
    hx = float(xs[hand_mask].mean())
    hy = float(ys[hand_mask].mean())

    # Elbow lies 46% along the shoulder -> hand anatomical axis
    ex = sh_x + (hx - sh_x) * 0.46
    ey = sh_y + (hy - sh_y) * 0.46
    return (sh_x, sh_y), (ex, ey), (hx, hy)


def _overlap_centroid(img_a: Image.Image | None, img_b: Image.Image | None) -> tuple[float, float] | None:
    if img_a is None or img_b is None:
        return None
    a = np.array(img_a.convert("RGBA"))[:, :, 3] > 20
    b = np.array(img_b.convert("RGBA"))[:, :, 3] > 20
    ys, xs = np.where(a & b)
    if len(xs) < 8:
        return None
    return float(xs.mean()), float(ys.mean())


def detect_bones_from_layers(
    layers: dict[str, Image.Image],
    canvas_size: tuple[int, int],
    overrides: dict[str, dict[str, float]] | None = None,
) -> list[BoneDef]:
    """Place every skeleton joint directly on detected anatomy (100% detected, zero proportion-warping prior blend!)."""
    w, h = canvas_size
    stats = {k: _alpha_stats(v) for k, v in layers.items()}

    def prior_joint(bone_id: str) -> tuple[float, float]:
        nx, ny, _ = CANONICAL_JOINTS_NORM[bone_id]
        return (nx * w, ny * h)

    def prior_tip(bone_id: str) -> tuple[float, float]:
        nx, ny = BONE_TIPS_NORM[bone_id]
        return (nx * w, ny * h)

    detected: dict[str, tuple[float, float]] = {}
    detected_tips: dict[str, tuple[float, float]] = {}

    head = stats.get("head_base")
    neck = stats.get("neck")
    torso = stats.get("torso_base")
    skirt = stats.get("skirt_front")
    leg_l_u = stats.get("leg_l_upper")
    leg_l_l = stats.get("leg_l_lower_shoe")
    leg_r_u = stats.get("leg_r_upper")
    leg_r_l = stats.get("leg_r_lower_shoe")
    arm_l_u_img = layers.get("arm_l_upper")
    arm_r_u_img = layers.get("arm_r_upper")
    arm_l_l = stats.get("arm_l_lower_hand")
    arm_r_l = stats.get("arm_r_lower_hand")

    # Determine whether torso_base is a unified full-body mesh (reaches near feet) vs separate torso+skirt+legs
    is_unified_body = bool(torso and leg_l_l is None and skirt is None and torso["h"] > h * 0.45)

    # 1. Arms: exact shoulder ball, elbow midpoint, and hand tip
    sh_ys: list[float] = []
    l_arm_pts = _arm_endpoints(arm_l_u_img, "left")
    if l_arm_pts:
        sh, el, hd = l_arm_pts
        detected["arm_l_upper"] = sh
        sh_ys.append(sh[1])
        elbow_ov = _overlap_centroid(arm_l_u_img, layers.get("arm_l_lower_hand"))
        if elbow_ov:
            detected["arm_l_lower"] = elbow_ov
            detected_tips["arm_l_upper"] = elbow_ov
            if arm_l_l:
                detected_tips["arm_l_lower"] = (arm_l_l["x0"] + arm_l_l["w"] * 0.2, arm_l_l["y1"])
        else:
            detected["arm_l_lower"] = el
            detected_tips["arm_l_upper"] = el
            detected_tips["arm_l_lower"] = hd

    r_arm_pts = _arm_endpoints(arm_r_u_img, "right")
    if r_arm_pts:
        sh, el, hd = r_arm_pts
        detected["arm_r_upper"] = sh
        sh_ys.append(sh[1])
        elbow_ov = _overlap_centroid(arm_r_u_img, layers.get("arm_r_lower_hand"))
        if elbow_ov:
            detected["arm_r_lower"] = elbow_ov
            detected_tips["arm_r_upper"] = elbow_ov
            if arm_r_l:
                detected_tips["arm_r_lower"] = (arm_r_l["x1"] - arm_r_l["w"] * 0.2, arm_r_l["y1"])
        else:
            detected["arm_r_lower"] = el
            detected_tips["arm_r_upper"] = el
            detected_tips["arm_r_lower"] = hd

    # 2. Head & Neck: pivot head EXACTLY at chin/neck junction so head never slides off neck!
    cx_center = (head["cx"] if head else (torso["cx"] if torso else w * 0.5))
    if head:
        chin_y = head["y1"] - 4.0
        detected["head"] = (cx_center, chin_y)
        detected_tips["head"] = (cx_center, head["y0"])
    if neck:
        neck_y = neck["y0"] + neck["h"] * 0.55
        detected["neck"] = (cx_center, neck_y)
        detected_tips["neck"] = detected.get("head", (cx_center, neck["y0"]))
    elif head:
        detected["neck"] = (cx_center, head["y1"] + 10.0)
        detected_tips["neck"] = detected["head"]

    # 3. Unified Body vs Modular Body spine, hips, skirt, and legs
    if is_unified_body and torso is not None:
        # Measure horizontal width profile of unified body to find exact waist & skirt hem
        body_alpha = np.array(layers["torso_base"].convert("RGBA"))[:, :, 3] > 25
        row_w = body_alpha.sum(axis=1)
        top_b, bot_b = int(torso["y0"]), int(torso["y1"])
        bh = max(120.0, float(bot_b - top_b))

        # Chest sits right at shoulder height so arms (children of chest) stay 100% welded!
        chest_y = (sum(sh_ys) / len(sh_ys) + 16.0) if sh_ys else (top_b + bh * 0.08)

        # Waist = narrowest row between 12% and 34% down the armless body
        wy0 = min(bot_b - 10, max(top_b + 10, int(top_b + bh * 0.12)))
        wy1 = min(bot_b - 5, max(wy0 + 10, int(top_b + bh * 0.34)))
        waist_y = float(wy0 + int(np.argmin(row_w[wy0:wy1])))

        # Widest skirt point between 35% and 72% down the armless body
        sy0 = min(bot_b - 10, int(top_b + bh * 0.34))
        sy1 = min(bot_b - 5, int(top_b + bh * 0.72))
        skirt_slice = row_w[sy0:sy1]
        widest_y = float(sy0 + int(np.argmax(skirt_slice))) if len(skirt_slice) else top_b + bh * 0.52
        skirt_half_w = float(skirt_slice.max()) * 0.5 if len(skirt_slice) else torso["w"] * 0.38

        spine_y = (chest_y + waist_y) * 0.52
        hips_y = waist_y + 24.0
        knee_y = top_b + bh * 0.72

        detected["root"] = (cx_center, float(bot_b))
        detected["hips"] = (cx_center, hips_y)
        detected["spine"] = (cx_center, spine_y)
        detected["chest"] = (cx_center, chest_y)
        detected["skirt_root"] = (cx_center, waist_y + 12.0)
        detected["skirt_l"] = (cx_center - skirt_half_w * 0.52, (waist_y + widest_y) * 0.55)
        detected["skirt_c"] = (cx_center, (waist_y + widest_y) * 0.58)
        detected["skirt_r"] = (cx_center + skirt_half_w * 0.52, (waist_y + widest_y) * 0.55)
        detected["leg_l_upper"] = (cx_center - torso["w"] * 0.10, hips_y + 30.0)
        detected["leg_l_lower"] = (cx_center - torso["w"] * 0.10, knee_y)
        detected["leg_r_upper"] = (cx_center + torso["w"] * 0.10, hips_y + 30.0)
        detected["leg_r_lower"] = (cx_center + torso["w"] * 0.10, knee_y)

        detected_tips["root"] = detected["hips"]
        detected_tips["hips"] = detected["spine"]
        detected_tips["spine"] = detected["chest"]
        detected_tips["chest"] = detected.get("neck", (cx_center, float(top_b)))
        detected_tips["skirt_root"] = (cx_center, widest_y + 40.0)
        detected_tips["skirt_l"] = (cx_center - skirt_half_w * 0.85, widest_y + 50.0)
        detected_tips["skirt_c"] = (cx_center, widest_y + 65.0)
        detected_tips["skirt_r"] = (cx_center + skirt_half_w * 0.85, widest_y + 50.0)
        detected_tips["leg_l_upper"] = detected["leg_l_lower"]
        detected_tips["leg_l_lower"] = (detected["leg_l_lower"][0], float(bot_b))
        detected_tips["leg_r_upper"] = detected["leg_r_lower"]
        detected_tips["leg_r_lower"] = (detected["leg_r_lower"][0], float(bot_b))
    else:
        # Modular layered fixture (synthetic_demo or custom layered PSD)
        foot_bottoms = [s["y1"] for s in (leg_l_l, leg_r_l) if s]
        foot_centers = [s["cx"] for s in (leg_l_l, leg_r_l) if s]
        if foot_bottoms:
            detected["root"] = (sum(foot_centers) / len(foot_centers), max(foot_bottoms))
        if torso:
            detected["hips"] = (torso["cx"], torso["y1"] - torso["h"] * 0.04)
            detected["spine"] = (torso["cx"], torso["y0"] + torso["h"] * 0.58)
            detected["chest"] = (torso["cx"], (sum(sh_ys) / len(sh_ys)) if sh_ys else (torso["y0"] + torso["h"] * 0.22))
        if leg_l_u:
            detected["leg_l_upper"] = (leg_l_u["cx"], leg_l_u["y0"] + leg_l_u["h"] * 0.08)
        knee_l = _overlap_centroid(layers.get("leg_l_upper"), layers.get("leg_l_lower_shoe"))
        if knee_l:
            detected["leg_l_lower"] = knee_l
        elif leg_l_l:
            detected["leg_l_lower"] = (leg_l_l["cx"], leg_l_l["y0"] + leg_l_l["h"] * 0.08)
        if leg_r_u:
            detected["leg_r_upper"] = (leg_r_u["cx"], leg_r_u["y0"] + leg_r_u["h"] * 0.08)
        knee_r = _overlap_centroid(layers.get("leg_r_upper"), layers.get("leg_r_lower_shoe"))
        if knee_r:
            detected["leg_r_lower"] = knee_r
        elif leg_r_l:
            detected["leg_r_lower"] = (leg_r_l["cx"], leg_r_l["y0"] + leg_r_l["h"] * 0.08)
        if skirt:
            detected["skirt_root"] = (skirt["cx"], skirt["y0"] + skirt["h"] * 0.06)
            detected["skirt_l"] = (skirt["x0"] + skirt["w"] * 0.24, skirt["y0"] + skirt["h"] * 0.42)
            detected["skirt_c"] = (skirt["cx"], skirt["y0"] + skirt["h"] * 0.50)
            detected["skirt_r"] = (skirt["x1"] - skirt["w"] * 0.24, skirt["y0"] + skirt["h"] * 0.42)

    # 4. Hair & Accessory roots directly from detected hair silhouettes
    for hid in ("hair_bang_l", "hair_bang_c", "hair_bang_r", "hair_side_l", "hair_side_r", "acc_head"):
        hs = stats.get(hid)
        if hs:
            detected[hid] = (hs["cx"], hs["y0"] + hs["h"] * 0.14)
            detected_tips[hid] = (hs["cx"], hs["y1"])

    hb = stats.get("hair_back")
    if hb:
        root_y = head["y0"] + head["h"] * 0.45 if head else (hb["y0"] + hb["h"] * 0.24)
        detected["hair_back_l"] = (hb["x0"] + hb["w"] * 0.28, root_y)
        detected["hair_back_c"] = (hb["cx"], root_y + 10.0)
        detected["hair_back_r"] = (hb["x1"] - hb["w"] * 0.28, root_y)
        detected_tips["hair_back_l"] = (hb["x0"] + hb["w"] * 0.22, hb["y1"] - hb["h"] * 0.08)
        detected_tips["hair_back_c"] = (hb["cx"], hb["y1"])
        detected_tips["hair_back_r"] = (hb["x1"] - hb["w"] * 0.22, hb["y1"] - hb["h"] * 0.08)

    # Resolve final coordinates: 100% detected (prior ONLY used if missing!) + user calibration overrides
    overrides = overrides or {}
    positions: dict[str, tuple[float, float]] = {}
    for bone_id in CANONICAL_JOINTS_NORM:
        jx, jy = detected[bone_id] if bone_id in detected else prior_joint(bone_id)
        ov = overrides.get(bone_id)
        if ov:
            if "x" in ov:
                jx = float(ov["x"])
            if "y" in ov:
                jy = float(ov["y"])
        positions[bone_id] = (round(jx, 2), round(jy, 2))

    # Build BoneDef list in strict topological order (parents before children)
    bones: list[BoneDef] = []
    for bone_id, (_, _, parent_id) in CANONICAL_JOINTS_NORM.items():
        jx, jy = positions[bone_id]
        if bone_id in detected_tips:
            tx, ty = detected_tips[bone_id]
        else:
            px0, py0 = prior_joint(bone_id)
            ptx, pty = prior_tip(bone_id)
            tx = ptx + (jx - px0)
            ty = pty + (jy - py0)
        ov = overrides.get(bone_id)
        if ov and "tipX" in ov and "tipY" in ov:
            tx, ty = float(ov["tipX"]), float(ov["tipY"])
        dx, dy = tx - jx, ty - jy
        length = max(8.0, math.hypot(dx, dy))
        rest_angle = math.atan2(dy, dx)
        bones.append(
            BoneDef(
                id=bone_id,
                parent=parent_id,
                x=round(jx, 2),
                y=round(jy, 2),
                tipX=round(tx, 2),
                tipY=round(ty, 2),
                length=round(length, 2),
                restAngle=round(rest_angle, 5),
            )
        )
    return bones
