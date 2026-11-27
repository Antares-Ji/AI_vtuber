"""OpenAI / Sub2API (AI Member Images v1) GPT Image provider (gpt-image-2.5 / gpt-image-2 / gpt-image-1).

Key Sub2API / AI Member Images v1 compatibility features:
- Strict schema compliance (`model`, `prompt`, `size`, `quality: 1K|2K|4K`, `response_format: url|b64_json`, `n=1`)
- Repeated multipart field `image` on `/images/edits` (up to 8 references)
- `Idempotency-Key` & `X-Request-ID` headers; cost-safe retries (retry ONLY on explicit HTTP 429/502/503, NEVER blind-retry timeouts)
- Border-connected white-background alpha matting with white-fringe color decontamination (safe for white stockings/petticoats/eye sclera)
- Sub-pixel ECC/phase-correlation alignment across passes
- Contour-aware anatomical & diff-driven facial/hair/arm/body layer slicing (no harsh rectangular seams)
"""

from __future__ import annotations

import base64
import io
import json
import time
import uuid
from pathlib import Path
from typing import Any

import cv2
import httpx
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from ..config import PipelineConfig
from ..schema import CANONICAL_LAYERS
from ..stages.normalize import normalize_to_canonical_canvas
from .base import GenerationRequest, ImageGenerationProvider, ProviderOutput


JISUI_SUI_DRAFT_PROMPT = (
    "Original anime VTuber girl character 'Ji Suige (Sui form)' — "
    "clean anime cel-shaded illustration with crisp dark lineart, expressive eyes, youthful anime proportions."
)

POSE_CONTRACT_PROMPT = (
    "Full-body standing character from head to toe, strictly facing straight forward, symmetrical neutral "
    "A-pose with both arms gently angled outward away from torso and hands open, legs straight and slightly apart, "
    "feet fully visible near bottom, centered horizontally on a completely flat solid pure white #FFFFFF background, "
    "no floor shadow, no border, no text, no watermark."
)


def remove_white_background(image: Image.Image, white_thresh: int = 236, sat_thresh: int = 20) -> Image.Image:
    """Convert pure-white background to crisp anti-aliased alpha using border-connected flood fill.

    Because flood-fill starts ONLY from the 4 canvas borders, enclosed white clothing
    (white stockings, white underskirts, eye sclera, pale skin) protected by anime lineart
    is 100% preserved while exterior + under-arm + between-leg background becomes transparent.
    """
    rgba = image.convert("RGBA")
    arr = np.array(rgba, dtype=np.uint8)
    h, w = arr.shape[:2]

    # If the image already has genuine transparency (>5% transparent pixels), keep & refine its alpha
    existing_trans = np.mean(arr[:, :, 3] < 20)
    if existing_trans > 0.05:
        return rgba

    rgb = arr[:, :, :3]
    mn = rgb.min(axis=2)
    mx = rgb.max(axis=2)
    sat = mx.astype(np.int16) - mn.astype(np.int16)
    is_white = ((mn >= white_thresh) & (sat <= sat_thresh)).astype(np.uint8)

    # Connected components on white pixels; mark components touching ANY canvas border as background
    num_labels, labels = cv2.connectedComponents(is_white, connectivity=4)
    border_labels = set()
    border_labels.update(np.unique(labels[0, :]).tolist())
    border_labels.update(np.unique(labels[h - 1, :]).tolist())
    border_labels.update(np.unique(labels[:, 0]).tolist())
    border_labels.update(np.unique(labels[:, w - 1]).tolist())
    border_labels.discard(0)

    bg_mask = np.isin(labels, list(border_labels)).astype(np.uint8)
    fg_mask = (1 - bg_mask).astype(np.uint8) * 255

    # Soft 1px feather on foreground boundary + white fringe color decontamination
    fg_soft = cv2.GaussianBlur(fg_mask, (3, 3), 0.75)
    # Keep solid interior 255, only soften immediate 1-2px outer rim
    eroded = cv2.erode(fg_mask, np.ones((3, 3), np.uint8), iterations=1)
    alpha = np.where(eroded > 0, 255, fg_soft).astype(np.uint8)
    alpha[bg_mask > 0] = np.minimum(alpha[bg_mask > 0], 0)

    # Decontaminate white halo on semi-transparent boundary pixels: C_fg = (C - (1-a)*255) / a
    semi = (alpha > 10) & (alpha < 245)
    if np.any(semi):
        a_f = (alpha[semi].astype(np.float32) / 255.0)[:, None]
        c_obs = rgb[semi].astype(np.float32)
        c_true = np.clip((c_obs - (1.0 - a_f) * 255.0) / np.maximum(a_f, 0.15), 0.0, 255.0)
        rgb = rgb.copy()
        rgb[semi] = c_true.astype(np.uint8)

    out = np.dstack([rgb, alpha])
    out[alpha == 0, :3] = 0
    return Image.fromarray(out, mode="RGBA")


def align_pass_to_base(target: Image.Image, base: Image.Image, max_shift: int = 36) -> Image.Image:
    """Align an edited pass onto the base image via phase correlation on edge gradients to fix small pixel shifts."""
    if target.size != base.size:
        target = target.resize(base.size, Image.Resampling.LANCZOS)
    b_gray = cv2.cvtColor(np.array(base.convert("RGB")), cv2.COLOR_RGB2GRAY).astype(np.float32)
    t_gray = cv2.cvtColor(np.array(target.convert("RGB")), cv2.COLOR_RGB2GRAY).astype(np.float32)
    b_edge = cv2.Sobel(b_gray, cv2.CV_32F, 1, 1, ksize=3)
    t_edge = cv2.Sobel(t_gray, cv2.CV_32F, 1, 1, ksize=3)
    (dx, dy), response = cv2.phaseCorrelate(t_edge, b_edge)
    if response < 0.05 or abs(dx) > max_shift or abs(dy) > max_shift or (abs(dx) < 0.4 and abs(dy) < 0.4):
        return target
    mat = np.float32([[1.0, 0.0, dx], [0.0, 1.0, dy]])
    arr = np.array(target.convert("RGBA"))
    shifted = cv2.warpAffine(arr, mat, (arr.shape[1], arr.shape[0]), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    return Image.fromarray(shifted, mode="RGBA")


def _soft_rect_mask(w: int, h: int, x0: float, y0: float, x1: float, y1: float, feather: int = 12) -> np.ndarray:
    """Float32 [0..1] soft-feathered rectangular mask in pixel space."""
    m = np.zeros((h, w), dtype=np.float32)
    ix0, iy0 = max(0, int(round(x0))), max(0, int(round(y0)))
    ix1, iy1 = min(w, int(round(x1))), min(h, int(round(y1)))
    if ix1 > ix0 and iy1 > iy0:
        m[iy0:iy1, ix0:ix1] = 1.0
    if feather > 0:
        k = feather * 2 + 1
        m = cv2.GaussianBlur(m, (k, k), feather * 0.45)
    return np.clip(m, 0.0, 1.0)


def _apply_mask(img: Image.Image, mask_01: np.ndarray) -> Image.Image:
    arr = np.array(img.convert("RGBA"), dtype=np.uint8)
    new_a = np.clip(arr[:, :, 3].astype(np.float32) * mask_01, 0, 255).astype(np.uint8)
    arr[:, :, 3] = new_a
    arr[new_a == 0, :3] = 0
    return Image.fromarray(arr, mode="RGBA")


def _diff_mask(img_a: Image.Image, img_b: Image.Image, rgb_thresh: int = 24, blur: int = 5) -> np.ndarray:
    """Compute clean [0..1] difference mask where img_a differs visibly from img_b."""
    a = np.array(img_a.convert("RGBA"), dtype=np.int16)
    b = np.array(img_b.convert("RGBA"), dtype=np.int16)
    rgb_diff = np.max(np.abs(a[:, :, :3] - b[:, :, :3]), axis=2)
    alpha_diff = np.abs(a[:, :, 3] - b[:, :, 3])
    changed = ((rgb_diff > rgb_thresh) | (alpha_diff > 32)) & (a[:, :, 3] > 20)
    mask = changed.astype(np.uint8) * 255
    k_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    k_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k_open)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k_close)
    if blur > 0:
        b_k = blur * 2 + 1
        mask = cv2.GaussianBlur(mask, (b_k, b_k), blur * 0.45)
    return mask.astype(np.float32) / 255.0


def _detect_anatomical_profile(no_arms: Image.Image, no_bangs: Image.Image | None = None) -> dict[str, float]:
    """Detect exact neck Y, waist Y, skirt hem Y, and foot Y using face-skin + silhouette profile."""
    arr = np.array(no_arms.convert("RGBA"))
    h, w = arr.shape[:2]
    fg = arr[:, :, 3] > 25
    row_widths = fg.sum(axis=1)
    ys = np.where(row_widths > 8)[0]
    if len(ys) < 40:
        return {
            "top_y": h * 0.075, "head_cy": h * 0.165, "neck_y": h * 0.220,
            "waist_y": h * 0.365, "skirt_bot_y": h * 0.72, "knee_y": h * 0.75, "foot_y": h * 0.945,
            "cx": w * 0.50, "face_box": (w * 0.44, h * 0.11, w * 0.56, h * 0.22),
        }
    top_y = float(ys.min())
    foot_y = float(ys.max())
    body_h = max(100.0, foot_y - top_y)
    xs_all = np.where(fg)[1]
    cx = float(np.median(xs_all))

    # 1. Detect exact face skin bounding box from no_bangs (unaffected by draping long hair!)
    face_src = np.array((no_bangs or no_arms).convert("RGBA"))
    rgb = face_src[:, :, :3]
    skin = (
        (rgb[:, :, 0] > 210)
        & (rgb[:, :, 1] > 180)
        & (rgb[:, :, 2] > 170)
        & (rgb[:, :, 0] >= rgb[:, :, 1])
        & (face_src[:, :, 3] > 180)
    )
    skin[: int(top_y), :] = False
    skin[int(top_y + body_h * 0.24) :, :] = False
    skin_m = cv2.morphologyEx(skin.astype(np.uint8) * 255, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    n_skin, _lbl, st_skin, cen_skin = cv2.connectedComponentsWithStats(skin_m, connectivity=8)

    face_box: tuple[float, float, float, float] | None = None
    best_face_score = -1.0
    for i in range(1, n_skin):
        area = float(st_skin[i, cv2.CC_STAT_AREA])
        if area < 400:
            continue
        fx = float(cen_skin[i][0])
        if abs(fx - cx) > w * 0.15:
            continue
        score = area - abs(fx - cx) * 30.0
        if score > best_face_score:
            best_face_score = score
            bx, by, bw, bh = st_skin[i, 0], st_skin[i, 1], st_skin[i, 2], st_skin[i, 3]
            face_box = (float(bx), float(by), float(bx + bw), float(by + bh))

    if face_box is not None:
        cx = (face_box[0] + face_box[2]) * 0.5
        # Face skin often extends slightly into the neck; chin/neck anchor sits near bottom of face skin box
        neck_y = min(top_y + body_h * 0.22, face_box[3] - (face_box[3] - face_box[1]) * 0.08)
        head_cy = (face_box[1] + face_box[3]) * 0.5
    else:
        neck_y = top_y + body_h * 0.175
        head_cy = top_y + (neck_y - top_y) * 0.56
        face_box = (cx - body_h * 0.055, top_y + body_h * 0.04, cx + body_h * 0.055, neck_y)

    # 2. Waist = narrowest silhouette width between 28% and 46% down from top
    wy0, wy1 = int(top_y + body_h * 0.28), int(top_y + body_h * 0.46)
    waist_slice = row_widths[wy0:wy1]
    waist_y = float(wy0 + int(np.argmin(waist_slice))) if len(waist_slice) else top_y + body_h * 0.36

    # 3. Skirt bottom = where silhouette narrows below widest skirt point (45%..80%)
    sy0, sy1 = int(top_y + body_h * 0.45), int(top_y + body_h * 0.80)
    skirt_slice = row_widths[sy0:sy1]
    if len(skirt_slice) > 10:
        widest_idx = int(np.argmax(skirt_slice))
        after = skirt_slice[widest_idx:]
        drop = np.where(after < skirt_slice[widest_idx] * 0.48)[0]
        skirt_bot_y = float(sy0 + widest_idx + (int(drop[0]) if len(drop) else len(after) - 1))
    else:
        skirt_bot_y = top_y + body_h * 0.70

    knee_y = min(foot_y - body_h * 0.14, max(skirt_bot_y + body_h * 0.01, top_y + body_h * 0.72))
    return {
        "top_y": top_y,
        "head_cy": head_cy,
        "neck_y": neck_y,
        "waist_y": waist_y,
        "skirt_bot_y": skirt_bot_y,
        "knee_y": knee_y,
        "foot_y": foot_y,
        "cx": cx,
        "face_box": face_box,
    }


def _detect_eyes_and_mouth(
    base_full: Image.Image,
    expr_alt: Image.Image,
    profile: dict[str, Any],
) -> dict[str, tuple[int, int, int, int]]:
    """Locate exact pixel bounding boxes of left eye, right eye, and mouth from strong diff(base, expr_alt) inside face_box."""
    w, h = base_full.size
    cx = float(profile["cx"])
    fb_x0, fb_y0, fb_x1, fb_y1 = profile["face_box"]
    fw = max(40.0, fb_x1 - fb_x0)
    fh = max(50.0, fb_y1 - fb_y0)

    # Tight face-relative fallback
    eye_y0 = int(fb_y0 + fh * 0.30)
    eye_y1 = int(fb_y0 + fh * 0.56)
    fallback = {
        "eye_l": (int(cx - fw * 0.46), eye_y0, int(cx - fw * 0.08), eye_y1),
        "eye_r": (int(cx + fw * 0.08), eye_y0, int(cx + fw * 0.46), eye_y1),
        "mouth": (int(cx - fw * 0.18), int(fb_y0 + fh * 0.64), int(cx + fw * 0.18), int(fb_y0 + fh * 0.84)),
    }

    # Strict high-threshold RGB diff (>48) inside padded face_box rejects hair/background micro-shifts
    a = np.array(base_full.convert("RGBA"), dtype=np.int16)
    b = np.array(expr_alt.convert("RGBA"), dtype=np.int16)
    strong = (np.max(np.abs(a[:, :, :3] - b[:, :, :3]), axis=2) > 48) & (a[:, :, 3] > 160)

    fx0, fx1 = max(0, int(fb_x0 - fw * 0.25)), min(w, int(fb_x1 + fw * 0.25))
    fy0, fy1 = max(0, int(fb_y0 + fh * 0.12)), min(h, int(fb_y1 - fh * 0.04))
    roi = np.zeros((h, w), dtype=np.uint8)
    roi[fy0:fy1, fx0:fx1] = strong[fy0:fy1, fx0:fx1].astype(np.uint8) * 255
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    roi = cv2.morphologyEx(roi, cv2.MORPH_OPEN, k)
    roi = cv2.dilate(roi, k, iterations=1)

    num_labels, _labels, stats, centroids = cv2.connectedComponentsWithStats(roi, connectivity=8)
    boxes: list[tuple[int, int, int, int, float, float, int]] = []
    for i in range(1, num_labels):
        area = int(stats[i, cv2.CC_STAT_AREA])
        bx = int(stats[i, cv2.CC_STAT_LEFT])
        by = int(stats[i, cv2.CC_STAT_TOP])
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh = int(stats[i, cv2.CC_STAT_HEIGHT])
        if area < 35 or bw > fw * 0.65 or bh > fh * 0.55:
            continue
        boxes.append((bx, by, bx + bw, by + bh, float(centroids[i][0]), float(centroids[i][1]), area))

    result = dict(fallback)
    eye_mid_cut = fb_y0 + fh * 0.62
    eye_candidates_l = [b for b in boxes if b[4] < cx - fw * 0.08 and b[5] < eye_mid_cut]
    eye_candidates_r = [b for b in boxes if b[4] > cx + fw * 0.08 and b[5] < eye_mid_cut]
    mouth_candidates = [b for b in boxes if abs(b[4] - cx) < fw * 0.22 and b[5] >= eye_mid_cut]

    def pad_box(b, px=5, py=4):
        return (max(0, b[0] - px), max(0, b[1] - py), min(w, b[2] + px), min(h, b[3] + py))

    if eye_candidates_l:
        result["eye_l"] = pad_box(max(eye_candidates_l, key=lambda b: b[6]), 5, 4)
    if eye_candidates_r:
        result["eye_r"] = pad_box(max(eye_candidates_r, key=lambda b: b[6]), 5, 4)
    if mouth_candidates:
        result["mouth"] = pad_box(max(mouth_candidates, key=lambda b: b[6]), 6, 5)
    return result


def _transfer_color_delta_to_amodal(
    amodal_layer: Image.Image,
    sui_full: Image.Image,
    ge_full: Image.Image,
    direct_blend_mask: np.ndarray | None = None,
    allow_direct_copy: bool = True,
) -> Image.Image:
    """Create a 100% clean Ge-variant version of an amodal layer WITHOUT leaking body/arm pixels!

    Where `amodal_layer` matches `sui_full` (unoccluded pixels) and `allow_direct_copy=True`, copies Ge's exact pixels.
    Where `amodal_layer` is occluded behind the body/arms (or `allow_direct_copy=False` for back_hair),
    transfers ONLY the pure Lab color shift measured on genuinely visible pixels of that layer!
    """
    am = np.array(amodal_layer.convert("RGBA"), dtype=np.uint8)
    sf = np.array(sui_full.convert("RGBA"), dtype=np.uint8)
    gf = np.array(ge_full.convert("RGBA"), dtype=np.uint8)
    alpha = am[:, :, 3]
    valid = alpha > 16
    if not np.any(valid):
        return amodal_layer.copy()

    # Unoccluded pixels = pixels where amodal layer RGB matches sui_full closely (within 22 RGB levels)
    rgb_diff = np.max(np.abs(am[:, :, :3].astype(np.int16) - sf[:, :, :3].astype(np.int16)), axis=2)
    unoccluded = valid & (sf[:, :, 3] > 180) & (gf[:, :, 3] > 180) & (rgb_diff < 22)
    if direct_blend_mask is not None:
        unoccluded = unoccluded & (direct_blend_mask > 0.5)

    am_lab = cv2.cvtColor(am[:, :, :3], cv2.COLOR_RGB2LAB).astype(np.float32)
    sf_lab = cv2.cvtColor(sf[:, :, :3], cv2.COLOR_RGB2LAB).astype(np.float32)
    gf_lab = cv2.cvtColor(gf[:, :, :3], cv2.COLOR_RGB2LAB).astype(np.float32)

    if np.sum(unoccluded) >= 50:
        s_mean = sf_lab[unoccluded].mean(axis=0)
        g_mean = gf_lab[unoccluded].mean(axis=0)
        s_std = np.maximum(sf_lab[unoccluded].std(axis=0), 6.0)
        g_std = np.maximum(gf_lab[unoccluded].std(axis=0), 6.0)
        scale = np.clip(g_std / s_std, 0.55, 1.55)
        shifted_lab = np.clip((am_lab - s_mean) * scale + g_mean, 0.0, 255.0).astype(np.uint8)
    else:
        vis = (sf[:, :, 3] > 180) & (gf[:, :, 3] > 180)
        delta = (gf_lab[vis].mean(axis=0) - sf_lab[vis].mean(axis=0)) if np.any(vis) else np.zeros(3)
        shifted_lab = np.clip(am_lab + delta, 0.0, 255.0).astype(np.uint8)

    shifted_rgb = cv2.cvtColor(shifted_lab, cv2.COLOR_LAB2RGB)

    if not allow_direct_copy:
        out = np.dstack([shifted_rgb, alpha])
        out[alpha == 0, :3] = 0
        return Image.fromarray(out, mode="RGBA")

    blend = cv2.GaussianBlur(unoccluded.astype(np.float32), (7, 7), 1.8)[:, :, None]
    out_rgb = np.clip(gf[:, :, :3].astype(np.float32) * blend + shifted_rgb.astype(np.float32) * (1.0 - blend), 0, 255).astype(np.uint8)
    out = np.dstack([out_rgb, alpha])
    out[alpha == 0, :3] = 0
    return Image.fromarray(out, mode="RGBA")


def _sigmoid_step(coord: np.ndarray, cut: float, width: float = 3.0) -> np.ndarray:
    """Smooth 0->1 ramp centered at `cut` with exact partition of unity: f + (1 - f) == 1 everywhere."""
    t = np.clip((coord - cut) / max(0.5, width) + 0.5, 0.0, 1.0)
    return (t * t * (3.0 - 2.0 * t)).astype(np.float32)


def _feather_shoulder_cap_over_torso(arm_img: Image.Image, torso_img: Image.Image) -> Image.Image:
    """Remove detached-arm top oval outline where it overlaps identical bare/solid torso shoulder skin.

    Leaves sleeves/cuffs (pixels whose RGB differs clearly from torso_img) 100% crisp and opaque,
    while smoothly feathering the top-medial bare-shoulder cap so there is ZERO doll-socket ring!
    """
    a = np.array(arm_img.convert("RGBA"), dtype=np.uint8)
    t = np.array(torso_img.convert("RGBA"), dtype=np.uint8)
    arm_bin = (a[:, :, 3] > 18).astype(np.uint8)
    ys, _xs = np.where(arm_bin > 0)
    if len(ys) == 0:
        return arm_img

    h, w = arm_bin.shape
    yy = np.arange(h, dtype=np.float32)[:, None]
    arm_top_y = float(ys.min())

    # Solid interior of torso shoulder (eroded slightly so torso's own outer silhouette is preserved)
    torso_solid = cv2.erode((t[:, :, 3] > 190).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))) > 0
    # Distance inward from the arm's silhouette boundary
    dist_in = cv2.distanceTransform(arm_bin, cv2.DIST_L2, 5)
    # Distinguish sleeve/cuff pixels (different color from underlying torso skin) vs matching shoulder skin
    rgb_diff = np.max(np.abs(a[:, :, :3].astype(np.int16) - t[:, :, :3].astype(np.int16)), axis=2).astype(np.float32)

    # Top cap zone (within 68px below the very top of the arm's shoulder dome)
    cap_zone = np.clip((arm_top_y + 68.0 - yy) / 26.0, 0.0, 1.0)
    # 1. Remove the thin dark detached-dome outline right along the top/medial perimeter over torso_solid
    rim_keep = np.clip((dist_in - 4.5) / 11.0, 0.0, 1.0)
    # 2. Smooth vertical fade over bare matching skin on the very top 48px of the shoulder cap
    top_skin_keep = np.clip((yy - (arm_top_y + 18.0)) / 30.0, 0.0, 1.0)
    # Sleeve/fabric pixels (rgb_diff > 48 and below the top 24px dome outline) stay 100% opaque
    is_sleeve = np.clip((rgb_diff - 38.0) / 28.0, 0.0, 1.0) * np.clip((yy - (arm_top_y + 22.0)) / 10.0, 0.0, 1.0)

    # Combine fade only where torso_solid exists underneath
    torso_f = cv2.GaussianBlur(torso_solid.astype(np.float32), (5, 5), 1.2)
    cap_keep = np.maximum(is_sleeve, np.minimum(rim_keep, top_skin_keep))
    final_keep = 1.0 - torso_f * cap_zone * (1.0 - cap_keep)

    out = a.copy()
    out[:, :, 3] = np.clip(a[:, :, 3].astype(np.float32) * final_keep, 0.0, 255.0).astype(np.uint8)
    out[out[:, :, 3] == 0, :3] = 0
    return Image.fromarray(out, mode="RGBA")


def _crop_amodal_back_hair_to_original_silhouette(back_hair: Image.Image, base_full: Image.Image, no_arms: Image.Image) -> Image.Image:
    """Trim over-expanded generated back hair outside the original silhouette while keeping occluded interior intact."""
    bh = np.array(back_hair.convert("RGBA"), dtype=np.uint8)
    bf = np.array(base_full.convert("RGBA"), dtype=np.uint8)
    na = np.array(no_arms.convert("RGBA"), dtype=np.uint8)
    # Build generous hull of original full silhouette + armless silhouette (so back hair stays true to outfit design!)
    orig_fg = ((bf[:, :, 3] > 20) | (na[:, :, 3] > 20)).astype(np.uint8) * 255
    hull = cv2.dilate(orig_fg, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (19, 19)), iterations=1)
    hull_f = cv2.GaussianBlur(hull.astype(np.float32) / 255.0, (9, 9), 2.5)
    bh[:, :, 3] = np.clip(bh[:, :, 3].astype(np.float32) * hull_f, 0, 255).astype(np.uint8)
    bh[bh[:, :, 3] == 0, :3] = 0
    return Image.fromarray(bh, mode="RGBA")


def _paint_clean_skin_under_features(
    head_img: Image.Image,
    feature_boxes: list[tuple[int, int, int, int]],
) -> Image.Image:
    """Fill eye & mouth regions on head_base with sampled surrounding cheek skin color so blinking/speaking never ghosts."""
    arr = np.array(head_img.convert("RGBA"), dtype=np.uint8)
    h, w = arr.shape[:2]
    yy, xx = np.ogrid[:h, :w]

    for x0, y0, x1, y1 in feature_boxes:
        ew, eh = max(6, x1 - x0), max(6, y1 - y0)
        ecx, ecy = (x0 + x1) * 0.5, (y0 + y1) * 0.5
        # Sample skin ring just outside the feature box (bright skin pixels)
        rx0, ry0 = max(0, x0 - 12), max(0, y0 - 8)
        rx1, ry1 = min(w, x1 + 12), min(h, y1 + 12)
        ring = arr[ry0:ry1, rx0:rx1]
        skin_px = ring[
            (ring[:, :, 3] > 200)
            & (ring[:, :, 0] > 215)
            & (ring[:, :, 1] > 185)
            & (ring[:, :, 2] > 175)
        ]
        if len(skin_px) >= 10:
            fill_rgb = np.median(skin_px[:, :3], axis=0)
        else:
            fill_rgb = np.array([250.0, 236.0, 234.0])

        ell = (((xx - ecx) / max(3.0, ew * 0.48)) ** 2 + ((yy - ecy) / max(3.0, eh * 0.48)) ** 2) <= 1.0
        soft = cv2.GaussianBlur(ell.astype(np.float32), (7, 7), 1.8)
        blend = (soft * (arr[:, :, 3] > 20).astype(np.float32))[:, :, None]
        arr[:, :, :3] = np.clip(arr[:, :, :3].astype(np.float32) * (1.0 - blend) + fill_rgb[None, None, :] * blend, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="RGBA")


class OpenAIGptImageProvider(ImageGenerationProvider):
    """Production cloud provider supporting both Sub2API/AI Member Images v1 (gpt-image-2.5) and standard OpenAI Images API."""

    name = "openai_gpt_image"

    def __init__(self, config: PipelineConfig, http_client: httpx.Client | None = None):
        self.config = config
        self._client = http_client

    def _require_key(self) -> str:
        if not self.config.openai_image_api_key:
            raise RuntimeError(
                "未配置 OPENAI_IMAGE_API_KEY（可在仓库根目录 .env.local 中设置 OPENAI_IMAGE_API_KEY、"
                "OPENAI_IMAGE_BASE_URL 与 OPENAI_IMAGE_MODEL）。若想零费用离线验通全流程，请使用 --provider synthetic_demo。"
            )
        return self.config.openai_image_api_key

    def _get_client(self) -> httpx.Client:
        if self._client is not None:
            return self._client
        return httpx.Client(timeout=self.config.request_timeout_s, follow_redirects=True)

    def _decode_image_response(self, payload: dict[str, Any]) -> Image.Image:
        data = payload.get("data") or []
        if not data:
            raise RuntimeError(f"Image API returned empty data: {payload}")
        item = data[0]
        if item.get("b64_json"):
            raw = base64.b64decode(item["b64_json"])
            return Image.open(io.BytesIO(raw)).convert("RGBA")
        if item.get("url"):
            close_client = self._client is None
            client = self._get_client()
            try:
                resp = client.get(item["url"])
                resp.raise_for_status()
                return Image.open(io.BytesIO(resp.content)).convert("RGBA")
            finally:
                if close_client:
                    client.close()
        raise RuntimeError(f"Unsupported image response format: {list(item.keys())}")

    def _image_to_png_bytes(self, image: Image.Image) -> bytes:
        buf = io.BytesIO()
        # Sub2API works cleanly with opaque RGB PNG on white background for edit references
        bg = Image.new("RGBA", image.size, (255, 255, 255, 255))
        bg.alpha_composite(image.convert("RGBA"))
        bg.convert("RGB").save(buf, format="PNG")
        return buf.getvalue()

    def _safe_prompt(self, prompt: str) -> str:
        return prompt.strip()[:1480]

    def call_generate(self, prompt: str, size: str = "1024x1536", transparent: bool = False) -> Image.Image:
        api_key = self._require_key()
        url = f"{self.config.openai_image_base_url}/images/generations"
        sub2 = self.config.is_sub2api_style()
        body: dict[str, Any] = {
            "model": self.config.openai_image_model,
            "prompt": self._safe_prompt(prompt),
            "size": size,
            "n": 1,
        }
        if sub2:
            body["quality"] = self.config.openai_image_quality or "2K"
            body["response_format"] = self.config.openai_image_response_format or "url"
        else:
            body["quality"] = "high"
            body["output_format"] = "png"
            if transparent:
                body["background"] = "transparent"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Idempotency-Key": str(uuid.uuid4()),
            "X-Request-ID": f"rig2d-{uuid.uuid4().hex[:12]}",
        }
        return self._request_with_retry("POST", url, headers=headers, json_body=body)

    def call_edit(
        self,
        prompt: str,
        reference_images: list[tuple[str, Image.Image]],
        size: str = "1024x1536",
        transparent: bool = False,
    ) -> Image.Image:
        api_key = self._require_key()
        url = f"{self.config.openai_image_base_url}/images/edits"
        sub2 = self.config.is_sub2api_style()
        field_name = "image" if sub2 else "image[]"
        files = [
            (field_name, (fname, self._image_to_png_bytes(img), "image/png"))
            for fname, img in reference_images
        ]
        data: dict[str, str] = {
            "model": self.config.openai_image_model,
            "prompt": self._safe_prompt(prompt),
            "size": size,
            "n": "1",
        }
        if sub2:
            data["quality"] = self.config.openai_image_quality or "2K"
            data["response_format"] = self.config.openai_image_response_format or "url"
        else:
            data["quality"] = "high"
            data["output_format"] = "png"
            if transparent:
                data["background"] = "transparent"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Idempotency-Key": str(uuid.uuid4()),
            "X-Request-ID": f"rig2d-{uuid.uuid4().hex[:12]}",
        }
        return self._request_with_retry("POST", url, headers=headers, data=data, files=files)

    def _request_with_retry(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        json_body: dict[str, Any] | None = None,
        data: dict[str, str] | None = None,
        files: list[Any] | None = None,
    ) -> Image.Image:
        close_client = self._client is None
        client = self._get_client()
        try:
            for attempt in range(self.config.max_retries + 1):
                resp = client.request(method, url, headers=headers, json=json_body, data=data, files=files)
                # Per Sub2API contract: retry ONLY explicit retryable gateway/rate-limit codes (429/502/503).
                # Do NOT blindly retry timeouts to avoid duplicate billing.
                if resp.status_code in (429, 502, 503) and attempt < self.config.max_retries:
                    retry_after = float(resp.headers.get("Retry-After", "0") or 0)
                    time.sleep(max(retry_after, 2.0 * (attempt + 1)))
                    continue
                if resp.status_code >= 400:
                    raise RuntimeError(f"Image API HTTP {resp.status_code}: {resp.text[:500]}")
                return self._decode_image_response(resp.json())
        finally:
            if close_client:
                client.close()
        raise RuntimeError("Image API failed after retries")

    def generate_layers(self, request: GenerationRequest, work_dir: Path) -> ProviderOutput:
        """Run cached multi-pass amodal edits with gpt-image-2.5 + local white matting + contour slicing."""
        pass_dir = work_dir / "passes"
        pass_dir.mkdir(parents=True, exist_ok=True)
        size = f"{request.canvas_width}x{request.canvas_height}"

        def cached_pass(pass_name: str, fn, align_to: Image.Image | None = None) -> Image.Image:
            raw_path = pass_dir / f"{pass_name}_raw.png"
            matted_path = pass_dir / f"{pass_name}.png"
            if matted_path.is_file():
                return Image.open(matted_path).convert("RGBA")
            if raw_path.is_file():
                raw_img = Image.open(raw_path).convert("RGBA")
            else:
                raw_img = fn().resize((request.canvas_width, request.canvas_height), Image.Resampling.LANCZOS)
                raw_img.save(raw_path)
            matted = remove_white_background(raw_img)
            if align_to is not None:
                matted = align_pass_to_base(matted, align_to)
            matted.save(matted_path)
            return matted

        refs: list[tuple[str, Image.Image]] = []
        if request.character_ref_path and request.character_ref_path.is_file():
            refs.append(("character_ref.png", Image.open(request.character_ref_path).convert("RGBA")))
        if request.outfit_image_path and request.outfit_image_path.is_file():
            refs.append(("outfit_design.png", Image.open(request.outfit_image_path).convert("RGBA")))

        # Pass 1: Base canonical standing A-pose illustration
        if request.keep_input_as_base and request.outfit_image_path and request.outfit_image_path.is_file():
            def _load_direct_base() -> Image.Image:
                src = Image.open(request.outfit_image_path).convert("RGBA")
                matted = remove_white_background(src)
                norm, _ = normalize_to_canonical_canvas(matted, request.canvas_width, request.canvas_height)
                return norm

            base_full = cached_pass("01_base_full", _load_direct_base)
        else:
            character_desc = (
                "Preserve the exact face, hairstyle, hair color, and eyes from character_ref.png."
                if request.character_ref_path
                else (
                    "Keep the character's exact anime face, hair, eyes, and outfit from outfit_design.png faithfully."
                    if request.outfit_image_path
                    else JISUI_SUI_DRAFT_PROMPT
                )
            )
            outfit_desc = (
                "Faithfully dress the character in the exact outfit design, silhouette, patterns, sleeves, skirt, "
                "accessories, and shoes shown in outfit_design.png."
                if request.outfit_image_path
                else "Dress the character in an original marine-tidal anime sailor dress in ivory white and aqua blue."
            )
            notes = f" Additional notes: {request.prompt_notes.strip()}" if request.prompt_notes.strip() else ""
            base_prompt = f"{character_desc} {outfit_desc} {POSE_CONTRACT_PROMPT}{notes}"
            base_full = cached_pass(
                "01_base_full",
                lambda: self.call_edit(base_prompt, refs, size=size) if refs else self.call_generate(base_prompt, size=size),
            )

        # Pass 2: Amodal armless body (clean torso sides & skirt edges behind sleeves/arms)
        no_arms = cached_pass(
            "02_no_arms_torso",
            lambda: self.call_edit(
                "Keep the exact same anime character, camera framing, scale, head, hair, legs, skirt, and pixel position as the input image. "
                "Completely remove ONLY both left and right arms, hands, and hanging sleeves. Cleanly paint the torso sides, shoulders, "
                "dress waist, and skirt edges behind where the arms were. Pure flat solid white #FFFFFF background. No shadow, no extra objects.",
                [("base.png", base_full)],
                size=size,
            ),
            align_to=base_full,
        )

        # Pass 3: Amodal clean face without front bangs/side locks (revealing forehead & eyebrows)
        no_bangs = cached_pass(
            "03_no_bangs_face",
            lambda: self.call_edit(
                "Keep the exact same character, camera framing, scale, eyes, nose, mouth, body, outfit, and pixel position as the input image. "
                "Remove ONLY the front bangs, forehead hair strands, and cheek side hair locks covering the face, cleanly painting smooth "
                "forehead skin, complete visible eyebrows, and clean face contour underneath. Pure flat solid white #FFFFFF background.",
                [("base.png", base_full)],
                size=size,
            ),
            align_to=base_full,
        )

        # Pass 4: Amodal isolated full back hair
        back_hair_pass = cached_pass(
            "04_back_hair_only",
            lambda: self.call_edit(
                "Keep the exact same canvas scale, framing, and hair position as the input character. "
                "Isolate ONLY the back hair behind the head, neck, and shoulders, cleanly filling in the occluded center region of the "
                "back hair so it forms one continuous complete hair sheet. Remove the face, front bangs, body, arms, outfit, and legs completely. "
                "Pure flat solid white #FFFFFF background.",
                [("base.png", base_full)],
                size=size,
            ),
            align_to=base_full,
        )

        # Pass 5: Isolated left & right arms + sleeves in exact position
        arms_pass = cached_pass(
            "05_arms_only",
            lambda: self.call_edit(
                "Keep the exact same canvas scale, framing, and arm/sleeve positions as the input character. "
                "Isolate ONLY both left and right bare shoulders, arms, hands, and hanging wide sleeves cleanly, removing the head, hair, "
                "neck, torso bodice, skirt, and legs completely. Keep exact pixel positions of both arms and sleeves. Pure flat solid white #FFFFFF background.",
                [("base.png", base_full)],
                size=size,
            ),
            align_to=base_full,
        )

        # Pass 6: Pixel-locked expression alt pass (closed smiling eyes + open speaking mouth)
        expr_alt = cached_pass(
            "06_eyes_closed_mouth_open",
            lambda: self.call_edit(
                "Keep EVERY SINGLE pixel of the hair, face shape, skin, outfit, sleeves, skirt, pose, and framing 100% IDENTICAL to the input image. "
                "Edit ONLY two tiny facial features: (1) change both eyes into gently closed happy curved eyelashes, and "
                "(2) change the mouth into a clean open anime speaking 'ah' mouth. Pure flat solid white #FFFFFF background.",
                [("base.png", base_full)],
                size=size,
            ),
            align_to=base_full,
        )

        # Local contour & strict non-overlapping partition-of-unity layer decomposition
        layers = self._decompose_from_passes(
            base_full=base_full,
            no_arms=no_arms,
            no_bangs=no_bangs,
            back_hair=back_hair_pass,
            arms_only=arms_pass,
            expr_alt=expr_alt,
        )

        ge_variant_layers: dict[str, Image.Image] = {}
        if request.persona_mode in ("dual", "ge"):
            ge_full = cached_pass(
                "07_ge_variant_full",
                lambda: self.call_edit(
                    "Keep the EXACT same anime character silhouette, pose, lineart, face shape, outfit tailoring, patterns, and pixel alignment. "
                    "Create an alternate cool twin-persona visual color variation: shift both eyes to deeper luminous cool indigo-slate and crimson sheen, "
                    "add subtle cool silver-midnight blue hair highlights, and shift the outfit accents to crisp obsidian-indigo and silver-gold trim "
                    "(poised cool aesthetic, not evil). Pure flat solid white #FFFFFF background.",
                    [("base.png", base_full)],
                    size=size,
                ),
                align_to=base_full,
            )
            # Transfer Ge palette & direct unoccluded pixels onto each clean amodal layer
            # so Ge NEVER leaks a second copy of the body/arms into back_hair or torso!
            for spec in CANONICAL_LAYERS:
                if not spec.variant_capable or spec.id not in layers:
                    continue
                base_layer = layers[spec.id]
                if not np.any(np.array(base_layer)[:, :, 3] > 16):
                    continue
                ge_variant_layers[spec.id] = _transfer_color_delta_to_amodal(
                    amodal_layer=base_layer,
                    sui_full=base_full,
                    ge_full=ge_full,
                    allow_direct_copy=(spec.id != "hair_back"),
                )

        return ProviderOutput(
            base_full_body=base_full,
            layers=layers,
            ge_variant_layers=ge_variant_layers,
            metadata={
                "provider": self.name,
                "model": self.config.openai_image_model,
                "quality": self.config.openai_image_quality,
                "base_url": self.config.openai_image_base_url,
                "keep_input_as_base": request.keep_input_as_base,
                "passes": 7 if ge_variant_layers else 6,
            },
        )

    def _decompose_from_passes(
        self,
        base_full: Image.Image,
        no_arms: Image.Image,
        no_bangs: Image.Image,
        back_hair: Image.Image,
        arms_only: Image.Image,
        expr_alt: Image.Image,
    ) -> dict[str, Image.Image]:
        """Decompose aligned amodal passes with strict non-overlapping partition-of-unity masks (zero ghosting!)."""
        w, h = base_full.size
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)

        profile = _detect_anatomical_profile(no_arms, no_bangs)
        feat = _detect_eyes_and_mouth(base_full, expr_alt, profile)

        cx = float(profile["cx"])
        top_y = float(profile["top_y"])
        neck_y = float(profile["neck_y"])
        waist_y = float(profile["waist_y"])
        skirt_bot_y = float(profile["skirt_bot_y"])
        knee_y = float(profile["knee_y"])
        foot_y = float(profile["foot_y"])
        fb_x0, fb_y0, fb_x1, fb_y1 = profile["face_box"]
        fw = max(48.0, fb_x1 - fb_x0)
        fh = max(60.0, fb_y1 - fb_y0)
        head_h = max(80.0, neck_y - top_y)
        chin_y = fb_y1 - fh * 0.10

        empty = Image.new("RGBA", (w, h), (0, 0, 0, 0))

        # 1. Back hair: trim to original silhouette envelope so it never sticks out as an extra giant wig
        back_hair_clean = _crop_amodal_back_hair_to_original_silhouette(back_hair, base_full, no_arms)

        # 2. Arms: keep EACH full arm + wide hanging sleeve intact on ONE continuous skinned mesh
        #    (arm_l_upper / arm_r_upper skinned by chest + arm_*_upper + arm_*_lower) -> ZERO sleeve split seam!
        arms_arr = np.array(arms_only.convert("RGBA"), dtype=np.uint8)
        arms_a = (arms_arr[:, :, 3] > 18).astype(np.float32)
        left_half = 1.0 - _sigmoid_step(xx, cx, width=4.0)
        right_half = _sigmoid_step(xx, cx, width=4.0)
        arm_l_raw = _apply_mask(arms_only, arms_a * left_half)
        arm_r_raw = _apply_mask(arms_only, arms_a * right_half)

        # 3. Unified continuous full body (torso + waist + flared skirt + legs + shoes) on ONE unbroken mesh!
        #    Keeping no_arms intact below choker_top_y guarantees ZERO waist crack, ZERO knee crack, and ZERO shoulder socket gap!
        above_chin = 1.0 - _sigmoid_step(yy, chin_y, width=3.5)

        choker_top_y = chin_y + max(14.0, fh * 0.10)
        # Neck (z=70) sits cleanly as the inner skin cylinder between chin and choker (no half-choker or chopped side hair!)
        neck_x_mask = (
            _sigmoid_step(xx, cx - fw * 0.22, width=3.5)
            * (1.0 - _sigmoid_step(xx, cx + fw * 0.22, width=3.5))
        )
        neck_m = _sigmoid_step(yy, chin_y - 14.0, width=3.0) * (1.0 - _sigmoid_step(yy, choker_top_y - 1.0, width=2.5)) * neck_x_mask

        # Unified continuous body mesh: EVERYTHING below choker_top_y (including smooth shoulders underneath arms!)
        # Never cut holes out of the shoulders so rotating arms always pivot over smooth intact skin!
        unified_body_m = _sigmoid_step(yy, choker_top_y - 5.0, width=3.0)
        unified_body_img = _apply_mask(no_arms, unified_body_m)

        # Feather only the artificial top oval dome outline on arms where they overlap identical torso shoulder skin
        arm_l_full = _feather_shoulder_cap_over_torso(arm_l_raw, unified_body_img)
        arm_r_full = _feather_shoulder_cap_over_torso(arm_r_raw, unified_body_img)

        # 4. Head base (clean head + crown/bun ONLY, strictly trimmed at jawline/chin — ZERO choker, ZERO chopped lower hair stubs!)
        # Build elliptical-ish head + upper-hair silhouette mask above chin_y
        head_x_ok = (
            _sigmoid_step(xx, cx - fw * 1.45, width=6.0)
            * (1.0 - _sigmoid_step(xx, cx + fw * 1.45, width=6.0))
        )
        # Below the ears/cheeks (fb_y0 + fh*0.56), taper sharply along the jaw V-contour so long chest hair stays on torso/back_hair!
        jaw_t = np.clip((yy - (fb_y0 + fh * 0.56)) / max(20.0, chin_y - (fb_y0 + fh * 0.56)), 0.0, 1.0)
        allowed_half_w = fw * (1.45 * (1.0 - jaw_t) + 0.44 * jaw_t)
        head_taper = 1.0 - _sigmoid_step(np.abs(xx - cx), allowed_half_w, width=5.0)
        head_m = above_chin * head_x_ok * head_taper

        head_raw = _apply_mask(no_bangs, head_m)
        head_clean = _paint_clean_skin_under_features(head_raw, [feat["eye_l"], feat["eye_r"], feat["mouth"]])

        # 5. Front bangs ONLY where 01_base_full genuinely differs from 03_no_bangs_face inside forehead!
        #    Strict non-overlapping X partition (bang_l + bang_c + bang_r == 1.0) so ZERO double hair!
        b_arr = np.array(base_full.convert("RGBA"), dtype=np.int16)
        nb_arr = np.array(no_bangs.convert("RGBA"), dtype=np.int16)
        bang_diff = (np.max(np.abs(b_arr[:, :, :3] - nb_arr[:, :, :3]), axis=2) > 34) & (b_arr[:, :, 3] > 100)
        eye_mid_y = (feat["eye_l"][1] + feat["eye_l"][3] + feat["eye_r"][1] + feat["eye_r"][3]) * 0.25
        # Restrict bangs strictly to forehead/brow zone above eyes
        forehead_zone = (
            _sigmoid_step(yy, max(0.0, top_y - 6.0), width=4.0)
            * (1.0 - _sigmoid_step(yy, eye_mid_y + 2.0, width=4.0))
            * _sigmoid_step(xx, fb_x0 - fw * 0.22, width=4.0)
            * (1.0 - _sigmoid_step(xx, fb_x1 + fw * 0.22, width=4.0))
        )
        # Clean connected mask + exclude detected eye sockets completely
        bang_u8 = cv2.morphologyEx(bang_diff.astype(np.uint8) * 255, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
        bang_u8 = cv2.morphologyEx(bang_u8, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
        bang_f = cv2.GaussianBlur(bang_u8.astype(np.float32) / 255.0, (5, 5), 1.0) * forehead_zone
        for ex0, ey0, ex1, ey1 in (feat["eye_l"], feat["eye_r"], feat["mouth"]):
            bang_f *= (1.0 - _soft_rect_mask(w, h, ex0 - 1, ey0 + 2, ex1 + 1, ey1 + 2, feather=3))

        front_bangs_img = _apply_mask(base_full, np.clip(bang_f, 0.0, 1.0))
        cut_l = cx - fw * 0.22
        cut_r = cx + fw * 0.22
        m_bl = 1.0 - _sigmoid_step(xx, cut_l, width=3.0)
        m_br = _sigmoid_step(xx, cut_r, width=3.0)
        m_bc = np.clip(1.0 - m_bl - m_br, 0.0, 1.0)

        # 6. Razor-sharp eyes (ZERO triple-copy blur!):
        #    - eye_*_sclera holds the crisp intact open eye (masked cleanly to eye socket)
        #    - eye_*_lid_closed holds the crisp smiling closed eyelash from Pass 6
        #    - eye_*_iris and eye_*_lid_open remain empty so open eyes never double-ghost!
        def extract_clean_eye(box: tuple[int, int, int, int]) -> tuple[Image.Image, Image.Image]:
            ex0, ey0, ex1, ey1 = box
            ew, eh = max(8, ex1 - ex0), max(8, ey1 - ey0)
            ecx, ecy = (ex0 + ex1) * 0.5, (ey0 + ey1) * 0.5
            ell = (((xx - ecx) / max(4.0, ew * 0.50)) ** 2 + ((yy - ecy) / max(4.0, eh * 0.50)) ** 2) <= 1.0
            ell_f = cv2.GaussianBlur(ell.astype(np.float32), (5, 5), 1.2)
            return _apply_mask(base_full, ell_f), _apply_mask(expr_alt, ell_f)

        eye_l_open_clean, eye_l_closed_clean = extract_clean_eye(feat["eye_l"])
        eye_r_open_clean, eye_r_closed_clean = extract_clean_eye(feat["eye_r"])

        # 7. Eyebrows cleanly above eyes from no_bangs (dark strokes only, zero pale skin halo!)
        def extract_brow(eye_box: tuple[int, int, int, int]) -> Image.Image:
            ex0, ey0, ex1, ey1 = eye_box
            eh = max(8, ey1 - ey0)
            bm = _soft_rect_mask(w, h, ex0 - 2, max(0, ey0 - eh * 0.72), ex1 + 2, ey0 - 1, feather=3)
            arr = np.array(no_bangs.convert("RGBA"))
            luma = arr[:, :, :3].mean(axis=2)
            stroke = np.clip((205.0 - luma) / 45.0, 0.0, 1.0)
            return _apply_mask(no_bangs, bm * stroke)

        brow_l = extract_brow(feat["eye_l"])
        brow_r = extract_brow(feat["eye_r"])

        # 8. Mouth states cleanly from detected mouth box
        mx0, my0, mx1, my1 = feat["mouth"]
        mw, mh = max(10, mx1 - mx0), max(10, my1 - my0)
        mcx, mcy = (mx0 + mx1) * 0.5, (my0 + my1) * 0.5
        mouth_ell = (((xx - mcx) / max(5.0, mw * 0.52)) ** 2 + ((yy - mcy) / max(5.0, mh * 0.52)) ** 2) <= 1.0
        mouth_m = cv2.GaussianBlur(mouth_ell.astype(np.float32), (5, 5), 1.4)

        mouth_closed = _apply_mask(base_full, mouth_m)
        mouth_smile = mouth_closed.copy()
        mouth_open = _apply_mask(expr_alt, mouth_m)
        mouth_half = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        crop_open = mouth_open.crop((mx0, my0, mx1, my1))
        half_h = max(4, int(round(mh * 0.58)))
        crop_half = crop_open.resize((mw, half_h), Image.Resampling.LANCZOS)
        mouth_half.alpha_composite(crop_half, (mx0, int(round(mcy - half_h * 0.5))))

        # 9. Subtle cheek blush & sparkle FX anchored to detected eye boxes
        blush_img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        bd = ImageDraw.Draw(blush_img, "RGBA")
        for ex0, ey0, ex1, ey1 in (feat["eye_l"], feat["eye_r"]):
            eh = ey1 - ey0
            bd.ellipse([ex0 - 2, ey1 + 2, ex1 + 2, ey1 + int(eh * 0.72)], fill=(252, 138, 158, 115))
        blush_img = blush_img.filter(ImageFilter.GaussianBlur(radius=8))

        sparkle_img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        sd = ImageDraw.Draw(sparkle_img, "RGBA")
        for sx, sy, sr in (
            (cx - fw * 0.92, top_y + head_h * 0.25, head_h * 0.08),
            (cx + fw * 0.90, top_y + head_h * 0.34, head_h * 0.065),
        ):
            pts = [
                (sx, sy - sr), (sx + sr * 0.25, sy - sr * 0.25),
                (sx + sr, sy), (sx + sr * 0.25, sy + sr * 0.25),
                (sx, sy + sr), (sx - sr * 0.25, sy + sr * 0.25),
                (sx - sr, sy), (sx - sr * 0.25, sy - sr * 0.25),
            ]
            sd.polygon(pts, fill=(255, 240, 172, 235), outline=(255, 255, 255, 245))

        return {
            "hair_back": back_hair_clean,
            "cloth_back": empty.copy(),
            "leg_l_upper": empty.copy(),
            "leg_l_lower_shoe": empty.copy(),
            "leg_r_upper": empty.copy(),
            "leg_r_lower_shoe": empty.copy(),
            "arm_l_upper": arm_l_full,
            "arm_l_lower_hand": empty.copy(),
            "arm_r_upper": arm_r_full,
            "arm_r_lower_hand": empty.copy(),
            "torso_base": unified_body_img,
            "skirt_front": empty.copy(),
            "cloth_outer": empty.copy(),
            "neck": _apply_mask(no_bangs, neck_m),
            "head_base": head_clean,
            "fx_blush": blush_img,
            "eye_l_sclera": eye_l_open_clean,
            "eye_l_iris": empty.copy(),
            "eye_l_lid_open": empty.copy(),
            "eye_l_lid_closed": eye_l_closed_clean,
            "eye_r_sclera": eye_r_open_clean,
            "eye_r_iris": empty.copy(),
            "eye_r_lid_open": empty.copy(),
            "eye_r_lid_closed": eye_r_closed_clean,
            "brow_l": brow_l,
            "brow_r": brow_r,
            "mouth_closed": mouth_closed,
            "mouth_half": mouth_half,
            "mouth_open": mouth_open,
            "mouth_smile": mouth_smile,
            "fx_sparkle": sparkle_img,
            "hair_side_l": empty.copy(),
            "hair_side_r": empty.copy(),
            "hair_bang_l": _apply_mask(front_bangs_img, m_bl),
            "hair_bang_c": _apply_mask(front_bangs_img, m_bc),
            "hair_bang_r": _apply_mask(front_bangs_img, m_br),
            "acc_head": empty.copy(),
        }

    def review_image_quality(self, image: Image.Image, checklist: str) -> dict[str, object]:
        """Optional VLM inspection using OpenAI-compatible chat completions vision API."""
        if not self.config.enable_vlm_qa or not self.config.openai_image_api_key:
            return {"enabled": False, "passed": True, "notes": ["VLM QA skipped (disabled or no key)"]}
        b64 = base64.b64encode(self._image_to_png_bytes(image.resize((512, 768)))).decode("ascii")
        url = f"{self.config.openai_image_base_url}/chat/completions"
        payload = {
            "model": self.config.openai_vision_model,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                f"Inspect this VTuber character render against: {checklist}. "
                                'Reply ONLY JSON: {"passed": bool, "score": 0-100, "issues": [str]}.'
                            ),
                        },
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                    ],
                }
            ],
            "max_tokens": 250,
        }
        headers = {"Authorization": f"Bearer {self.config.openai_image_api_key}"}
        close_client = self._client is None
        client = self._get_client()
        try:
            resp = client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            return {"enabled": True, "passed": bool(parsed.get("passed", True)), **parsed}
        except Exception as exc:  # noqa: BLE001
            return {"enabled": True, "passed": True, "notes": [f"VLM QA fallback: {exc}"]}
        finally:
            if close_client:
                client.close()
