"""Stage 4b: Constrained Delaunay mesh triangulation & seamless anatomical LBS skinning."""

from __future__ import annotations

import math

import cv2
import numpy as np
from PIL import Image
from scipy.spatial import Delaunay

from ..schema import BoneDef, LayerSpec, MeshData


DENSITY_GRID: dict[str, tuple[int, int]] = {
    "low": (5, 5),
    "medium": (7, 9),
    "high": (11, 13),
    "ultra": (15, 25),
}


def compute_layer_bbox(img: Image.Image, pad: int = 4) -> tuple[int, int, int, int, float]:
    """Compute tight padded bounding box [x0, y0, x1, y1] and non-zero alpha coverage ratio."""
    arr = np.array(img.convert("RGBA"))
    alpha = arr[:, :, 3]
    h, w = alpha.shape
    ys, xs = np.where(alpha > 6)
    if len(xs) == 0:
        return (0, 0, 0, 0, 0.0)
    x0 = max(0, int(xs.min()) - pad)
    y0 = max(0, int(ys.min()) - pad)
    x1 = min(w, int(xs.max()) + 1 + pad)
    y1 = min(h, int(ys.max()) + 1 + pad)
    coverage = float(len(xs)) / float(max(1, (x1 - x0) * (y1 - y0)))
    return (x0, y0, x1, y1, round(coverage, 4))


def _point_to_segment_dist(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    seg_len_sq = vx * vx + vy * vy
    if seg_len_sq <= 1e-6:
        return math.hypot(wx, wy)
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / seg_len_sq))
    proj_x = ax + t * vx
    proj_y = ay + t * vy
    return math.hypot(px - proj_x, py - proj_y)


def _smoothstep(edge0: float, edge1: float, x: float) -> float:
    if abs(edge1 - edge0) < 1e-6:
        return 1.0 if x >= edge1 else 0.0
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


def _normalize_weights(pairs: list[tuple[int, float]]) -> list[list[float]]:
    filtered = [(idx, max(0.0, float(w))) for idx, w in pairs if w > 1e-4]
    if not filtered:
        return [[pairs[0][0], 1.0]]
    # Merge duplicate bone indices if any
    merged: dict[int, float] = {}
    for idx, w in filtered:
        merged[idx] = merged.get(idx, 0.0) + w
    top = sorted(merged.items(), key=lambda item: item[1], reverse=True)[:4]
    total = sum(val for _, val in top) or 1.0
    norm = [[idx, round(val / total, 5)] for idx, val in top]
    drift = round(1.0 - sum(p[1] for p in norm), 5)
    norm[0][1] = round(norm[0][1] + drift, 5)
    return norm


def _skin_unified_body_vertex(
    vx: float,
    vy: float,
    bones: list[BoneDef],
    bone_index_map: dict[str, int],
) -> list[list[float]]:
    """Seamless anatomical spine + anchored legs + flowing skirt hem weights on ONE unbroken body mesh."""
    i_root = bone_index_map["root"]
    i_hips = bone_index_map["hips"]
    i_spine = bone_index_map["spine"]
    i_chest = bone_index_map["chest"]
    i_neck = bone_index_map["neck"]

    b_root = bones[i_root]
    b_hips = bones[i_hips]
    b_spine = bones[i_spine]
    b_chest = bones[i_chest]
    b_neck = bones[i_neck]
    cx = b_hips.x

    # 1. Exact vertical piecewise spine welding:
    #    - At shoulder/chest height (vy near b_chest.y): 100% chest -> welded seamlessly to arms!
    #    - At neck height (vy <= b_neck.y): smoothly welded to neck -> head!
    #    - From hips down to shoes: smoothly anchors down to root -> feet stay planted!
    if vy <= b_neck.y:
        spine_w = [(i_neck, 0.85), (i_chest, 0.15)]
    elif vy <= b_chest.y:
        t = _smoothstep(b_neck.y, b_chest.y, vy)
        spine_w = [(i_neck, (1.0 - t) * 0.85), (i_chest, 0.15 + t * 0.85)]
    elif vy <= b_spine.y:
        t = _smoothstep(b_chest.y, b_spine.y, vy)
        spine_w = [(i_chest, 1.0 - t), (i_spine, t)]
    elif vy <= b_hips.y:
        t = _smoothstep(b_spine.y, b_hips.y, vy)
        spine_w = [(i_spine, 1.0 - t), (i_hips, t)]
    else:
        # Below hips: smoothly transition down to root so ankles & shoes stay planted on ground
        t = _smoothstep(b_hips.y, b_root.y - 60.0, vy)
        spine_w = [(i_hips, 1.0 - t), (i_root, t)]

    # 2. Gentle skirt-hem spring physics ONLY on flared outer dress hem (keeps center waist & legs rock solid!)
    if "skirt_l" in bone_index_map and "skirt_r" in bone_index_map and "skirt_c" in bone_index_map:
        b_sk_l = bones[bone_index_map["skirt_l"]]
        b_sk_c = bones[bone_index_map["skirt_c"]]
        b_sk_r = bones[bone_index_map["skirt_r"]]
        skirt_top = b_hips.y + 18.0
        skirt_bot = max(b_sk_l.tipY, b_sk_c.tipY, b_sk_r.tipY) + 30.0
        if skirt_top < vy < skirt_bot:
            # Ramp smoothly from 0 at waist to max 0.50 at outer hem, fading back to 0 near bare calves below hem
            v_fade_in = _smoothstep(skirt_top, skirt_top + 110.0, vy)
            v_fade_out = 1.0 - _smoothstep(skirt_bot - 90.0, skirt_bot, vy)
            # Only outer flared fabric swings strongly; inner leg column stays planted
            dist_x = abs(vx - cx)
            h_flare = _smoothstep(52.0, 140.0, dist_x)
            skirt_blend = 0.45 * v_fade_in * v_fade_out * h_flare
            if skirt_blend > 0.02:
                sk_idx = bone_index_map["skirt_l"] if vx < cx else bone_index_map["skirt_r"]
                scaled = [(idx, w * (1.0 - skirt_blend)) for idx, w in spine_w]
                scaled.append((sk_idx, skirt_blend))
                return _normalize_weights(scaled)

    return _normalize_weights(spine_w)


def _skin_arm_full_vertex(
    vx: float,
    vy: float,
    spec: LayerSpec,
    bones: list[BoneDef],
    bone_index_map: dict[str, int],
) -> list[list[float]]:
    """Directional arm-axis skinning: deltoid welds organically to chest, upper sleeve follows arm_upper, bend only past elbow."""
    upper_id = "arm_l_upper" if spec.side == "left" else "arm_r_upper"
    lower_id = "arm_l_lower" if spec.side == "left" else "arm_r_lower"
    i_up = bone_index_map[upper_id]
    i_lo = bone_index_map[lower_id]
    b_up = bones[i_up]
    b_lo = bones[i_lo]

    ax, ay = b_lo.x - b_up.x, b_lo.y - b_up.y
    seg_len_sq = max(16.0, ax * ax + ay * ay)
    # Parameter t along shoulder (t=0) -> elbow (t=1) -> hand (t~2)
    t = ((vx - b_up.x) * ax + (vy - b_up.y) * ay) / seg_len_sq

    # Upper shoulder dome (t < 0.24) welds smoothly to chest so the bare shoulder never pops like a wooden socket!
    w_chest = 0.0
    if "chest" in bone_index_map and t < 0.24:
        w_chest = (1.0 - _smoothstep(-0.18, 0.24, t)) * 0.78

    # Smooth elbow bend ONLY past t=0.65 (upper sleeve & shoulder stay rock-solid!)
    w_lo = _smoothstep(0.65, 1.35, t) * (1.0 - w_chest)
    w_up = max(0.0, 1.0 - w_chest - w_lo)
    pairs: list[tuple[int, float]] = [(i_up, w_up), (i_lo, w_lo)]
    if w_chest > 1e-3:
        pairs.append((bone_index_map["chest"], w_chest))
    return _normalize_weights(pairs)


def _skin_hair_vertex(
    vx: float,
    vy: float,
    allowed_bones: list[tuple[int, BoneDef]],
    bones: list[BoneDef],
    bone_index_map: dict[str, int],
) -> list[list[float]]:
    """Hair root stays 100% pinned to head bone; hair tips blend smoothly into spring physics bones!"""
    head_idx = bone_index_map.get("head")
    phys_bones = [(b_idx, b) for b_idx, b in allowed_bones if b_idx != head_idx]
    if head_idx is None or not phys_bones:
        return [[allowed_bones[0][0], 1.0]]

    # Find nearest physics bone root/tip
    best_idx, best_b = min(phys_bones, key=lambda item: _point_to_segment_dist(vx, vy, item[1].x, item[1].y, item[1].tipX, item[1].tipY))
    # Vertical projection along root -> tip: root stays pinned to head, lower tips swing with spring
    dy = max(25.0, best_b.tipY - best_b.y)
    t = _smoothstep(best_b.y + dy * 0.12, best_b.y + dy * 0.88, vy)
    return _normalize_weights([(head_idx, 1.0 - t * 0.85), (best_idx, t * 0.85)])


def build_layer_mesh(
    img: Image.Image,
    spec: LayerSpec,
    bones: list[BoneDef],
    bbox: tuple[int, int, int, int],
) -> MeshData:
    """Build an adaptive Delaunay mesh over the layer's padded alpha silhouette + seamless LBS bone weights."""
    x0, y0, x1, y1 = bbox
    bw, bh = x1 - x0, y1 - y0
    if bw <= 1 or bh <= 1:
        return MeshData()

    bone_index_map = {b.id: idx for idx, b in enumerate(bones)}
    allowed_ids = [bid for bid in spec.bones if bid in bone_index_map]
    if not allowed_ids:
        allowed_ids = [spec.parent_bone if spec.parent_bone in bone_index_map else bones[0].id]
    allowed_bones = [(bone_index_map[bid], bones[bone_index_map[bid]]) for bid in allowed_ids]

    # Build dilated silhouette mask in local crop space so triangles cover 100% of opaque pixels without clipping
    alpha_crop = np.array(img.convert("RGBA"))[y0:y1, x0:x1, 3]
    binary = (alpha_crop > 4).astype(np.uint8)
    dilate_r = max(5, int(min(bw, bh) * 0.08))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_r * 2 + 1, dilate_r * 2 + 1))
    hull_mask = cv2.dilate(binary, kernel)

    # Use high-density grid for unified body, standard density for modular parts
    density_key = spec.mesh_density
    if spec.role == "unified_body" and bh < 500:
        density_key = "high"
    gx, gy = DENSITY_GRID.get(density_key, (7, 9))
    xs = np.linspace(0.0, float(bw), gx)
    ys = np.linspace(0.0, float(bh), gy)

    pts_local = [(float(xv), float(yv)) for yv in ys for xv in xs]
    pts_arr = np.array(pts_local, dtype=np.float64)
    tri = Delaunay(pts_arr)
    kept_simplices: list[tuple[int, int, int]] = []
    for s0, s1, s2 in tri.simplices:
        p0, p1, p2 = pts_arr[s0], pts_arr[s1], pts_arr[s2]
        cx_l = int(np.clip((p0[0] + p1[0] + p2[0]) / 3.0, 0, bw - 1))
        cy_l = int(np.clip((p0[1] + p1[1] + p2[1]) / 3.0, 0, bh - 1))
        tx0 = int(np.clip(min(p0[0], p1[0], p2[0]), 0, bw - 1))
        tx1 = int(np.clip(max(p0[0], p1[0], p2[0]) + 1, 1, bw))
        ty0 = int(np.clip(min(p0[1], p1[1], p2[1]), 0, bh - 1))
        ty1 = int(np.clip(max(p0[1], p1[1], p2[1]) + 1, 1, bh))
        if hull_mask[cy_l, cx_l] > 0 or np.any(binary[ty0:ty1, tx0:tx1] > 0):
            kept_simplices.append((int(s0), int(s1), int(s2)))

    if not kept_simplices:
        pts_arr = np.array([[0.0, 0.0], [float(bw), 0.0], [float(bw), float(bh)], [0.0, float(bh)]])
        kept_simplices = [(0, 1, 2), (0, 2, 3)]

    used_indices = sorted({idx for simp in kept_simplices for idx in simp})
    remap = {old: new for new, old in enumerate(used_indices)}

    positions: list[float] = []
    uvs: list[float] = []
    weights: list[list[list[float]]] = []
    sigma = max(24.0, math.hypot(bw, bh) * 0.22)

    rigid_face_roles = {"eye_sclera", "eye_iris", "eye_open", "eye_closed", "brow", "mouth", "fx"}
    is_tall_unified = spec.role == "unified_body" and bh > 450 and all(
        k in bone_index_map for k in ("root", "hips", "spine", "chest", "neck")
    )
    is_full_arm = spec.role == "arm_full" and all(
        k in bone_index_map for k in ("arm_l_upper", "arm_l_lower", "arm_r_upper", "arm_r_lower")
    )

    for old_idx in used_indices:
        lx, ly = float(pts_arr[old_idx, 0]), float(pts_arr[old_idx, 1])
        vx = x0 + lx
        vy = y0 + ly
        u = max(0.0, min(1.0, lx / float(bw)))
        v = max(0.0, min(1.0, ly / float(bh)))
        positions.extend([round(vx, 2), round(vy, 2)])
        uvs.extend([round(u, 5), round(v, 5)])

        if len(allowed_bones) == 1 or spec.role in rigid_face_roles:
            weights.append([[allowed_bones[0][0], 1.0]])
        elif is_tall_unified:
            weights.append(_skin_unified_body_vertex(vx, vy, bones, bone_index_map))
        elif is_full_arm:
            weights.append(_skin_arm_full_vertex(vx, vy, spec, bones, bone_index_map))
        elif spec.role == "hair":
            weights.append(_skin_hair_vertex(vx, vy, allowed_bones, bones, bone_index_map))
        else:
            scored: list[tuple[int, float]] = []
            for b_idx, bone in allowed_bones:
                dist = _point_to_segment_dist(vx, vy, bone.x, bone.y, bone.tipX, bone.tipY)
                w_val = 1.0 / ((dist / sigma) ** 2.4 + 0.06)
                scored.append((b_idx, w_val))
            weights.append(_normalize_weights(scored))

    indices: list[int] = []
    for s0, s1, s2 in kept_simplices:
        indices.extend([remap[s0], remap[s1], remap[s2]])

    return MeshData(positions=positions, uvs=uvs, indices=indices, weights=weights)
