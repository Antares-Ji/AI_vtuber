"""High-craft procedural anime 28+ layer fixture provider (Ji Suige draft: Sui & Ge).

Allows 100% offline, zero-cost end-to-end verification of:
- Multi-layer RGBA rendering (2x supersampled anti-aliased anime illustration)
- Outfit palette extraction when an outfit reference image is supplied
- Photoshop layered PSD export & round-trip import
- Automated keypoint detection, Delaunay triangulation, bone weight skinning & spring physics
- Full AI_vtuber PixiJS 8 Rig2D rendering, continuous RMS lip-sync, 22 emotions, and Sui/Ge texture crossfade
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from .base import GenerationRequest, ImageGenerationProvider, ProviderOutput


def _rgba(r: int, g: int, b: int, a: int = 255) -> tuple[int, int, int, int]:
    return (max(0, min(255, int(r))), max(0, min(255, int(g))), max(0, min(255, int(b))), max(0, min(255, int(a))))


def _blend(c1: tuple[int, int, int], c2: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return (
        int(c1[0] + (c2[0] - c1[0]) * t),
        int(c1[1] + (c2[1] - c1[1]) * t),
        int(c1[2] + (c2[2] - c1[2]) * t),
    )


def _extract_outfit_palette(image_path: Path | None) -> dict[str, tuple[int, int, int]]:
    """Extract primary & accent colors from an optional input outfit image for offline preview fidelity."""
    default = {
        "dress_light": (244, 249, 255),
        "dress_mid": (170, 212, 236),
        "dress_dark": (72, 126, 174),
        "accent": (94, 186, 214),
        "ribbon": (66, 152, 206),
    }
    if not image_path or not image_path.is_file():
        return default
    try:
        img = Image.open(image_path).convert("RGBA").resize((96, 96))
        arr = np.array(img)
        mask = (arr[:, :, 3] > 60) & (arr[:, :, :3].mean(axis=2) < 248) & (arr[:, :, :3].mean(axis=2) > 15)
        pixels = arr[:, :, :3][mask]
        if len(pixels) < 20:
            return default
        # Compute saturation to pick vibrant outfit accent and balanced main tone
        mx = pixels.max(axis=1).astype(np.float32)
        mn = pixels.min(axis=1).astype(np.float32)
        sat = (mx - mn) / np.maximum(mx, 1.0)
        main_rgb = tuple(int(v) for v in np.median(pixels, axis=0))
        vibrant = pixels[sat > np.percentile(sat, 72)]
        accent_rgb = tuple(int(v) for v in np.median(vibrant, axis=0)) if len(vibrant) > 5 else main_rgb
        return {
            "dress_light": _blend(main_rgb, (250, 252, 255), 0.62),
            "dress_mid": _blend(main_rgb, accent_rgb, 0.40),
            "dress_dark": _blend(accent_rgb, (26, 36, 58), 0.45),
            "accent": accent_rgb,
            "ribbon": _blend(accent_rgb, (34, 48, 86), 0.22),
        }
    except Exception:  # noqa: BLE001
        return default


def _bezier(p0, p1, p2, p3, steps: int = 24) -> list[tuple[float, float]]:
    pts = []
    for i in range(steps + 1):
        t = i / steps
        mt = 1.0 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


class SyntheticDemoProvider(ImageGenerationProvider):
    """Generates a complete, clean, anime-styled 37-layer Ji Suige (draft) + Ge variant offline."""

    name = "synthetic_demo"

    def _palette_for(self, mode: str, outfit_palette: dict[str, tuple[int, int, int]]) -> dict[str, tuple[int, int, int]]:
        if mode == "ge":
            # 歌（守潮成歌）：更冷静利落的深暮蓝/冷银发挑染、深靛青瞳色、暗调层次服装（非邪恶化）
            return {
                "line": (36, 38, 56),
                "skin": (253, 238, 228),
                "skin_shadow": (233, 204, 194),
                "hair_base": (146, 162, 194),
                "hair_shadow": (88, 102, 144),
                "hair_highlight": (214, 226, 246),
                "hair_streak": (56, 78, 128),
                "eye_top": (32, 54, 108),
                "eye_mid": (58, 108, 162),
                "eye_bot": (118, 198, 214),
                "dress_light": _blend(outfit_palette["dress_light"], (48, 58, 84), 0.64),
                "dress_mid": _blend(outfit_palette["dress_mid"], (36, 48, 78), 0.58),
                "dress_dark": _blend(outfit_palette["dress_dark"], (22, 28, 48), 0.55),
                "accent": (184, 72, 108),
                "ribbon": (52, 86, 138),
                "shoe": (34, 40, 62),
                "sock": (46, 52, 74),
                "blush": (232, 122, 142),
                "sparkle": (152, 224, 248),
            }
        # 岁（听潮记岁）：柔和清亮银冰蓝发、清透海蓝瞳、柔和低对比潮汐水手风连衣裙
        return {
            "line": (68, 62, 76),
            "skin": (255, 241, 232),
            "skin_shadow": (239, 211, 200),
            "hair_base": (204, 224, 242),
            "hair_shadow": (146, 178, 214),
            "hair_highlight": (244, 251, 255),
            "hair_streak": (122, 192, 224),
            "eye_top": (48, 98, 168),
            "eye_mid": (82, 164, 218),
            "eye_bot": (166, 232, 246),
            "dress_light": outfit_palette["dress_light"],
            "dress_mid": outfit_palette["dress_mid"],
            "dress_dark": outfit_palette["dress_dark"],
            "accent": outfit_palette["accent"],
            "ribbon": outfit_palette["ribbon"],
            "shoe": (66, 84, 118),
            "sock": (244, 248, 254),
            "blush": (252, 148, 164),
            "sparkle": (255, 236, 148),
        }

    def _new_ss_layer(self, w: int, h: int, ss: int = 2) -> tuple[Image.Image, ImageDraw.ImageDraw]:
        img = Image.new("RGBA", (w * ss, h * ss), (0, 0, 0, 0))
        return img, ImageDraw.Draw(img, "RGBA")

    def _downscale(self, img: Image.Image, w: int, h: int) -> Image.Image:
        return img.resize((w, h), Image.Resampling.LANCZOS)

    def _render_variant(self, w: int, h: int, pal: dict[str, tuple[int, int, int]]) -> dict[str, Image.Image]:
        ss = 2
        W, H = w * ss, h * ss
        lw = max(3, int(W * 0.0028))
        line = _rgba(*pal["line"], 245)

        def px(nx: float, ny: float) -> tuple[float, float]:
            return (nx * W, ny * H)

        def make_layer(draw_fn) -> Image.Image:
            img, d = self._new_ss_layer(w, h, ss)
            draw_fn(img, d)
            return self._downscale(img, w, h)

        # 1. Back hair (full amodal silhouette behind head & torso)
        def draw_hair_back(_img, d):
            outer = (
                _bezier(px(0.50, 0.075), px(0.32, 0.085), px(0.31, 0.30), px(0.325, 0.545), 28)
                + _bezier(px(0.325, 0.545), px(0.37, 0.595), px(0.43, 0.565), px(0.46, 0.585), 12)
                + _bezier(px(0.46, 0.585), px(0.50, 0.610), px(0.50, 0.610), px(0.54, 0.585), 10)
                + _bezier(px(0.54, 0.585), px(0.57, 0.565), px(0.63, 0.595), px(0.675, 0.545), 12)
                + _bezier(px(0.675, 0.545), px(0.69, 0.30), px(0.68, 0.085), px(0.50, 0.075), 28)
            )
            d.polygon(outer, fill=_rgba(*pal["hair_shadow"]), outline=line, width=lw)
            inner = (
                _bezier(px(0.50, 0.095), px(0.36, 0.11), px(0.355, 0.32), px(0.365, 0.52), 20)
                + [px(0.50, 0.565)]
                + _bezier(px(0.635, 0.52), px(0.645, 0.32), px(0.64, 0.11), px(0.50, 0.095), 20)
            )
            d.polygon(inner, fill=_rgba(*pal["hair_base"]))
            # Inner colored hair streaks (strong visual difference between Sui and Ge)
            for sx in (0.385, 0.615):
                streak = [px(sx - 0.022, 0.32), px(sx + 0.022, 0.32), px(sx + 0.015, 0.54), px(sx - 0.012, 0.54)]
                d.polygon(streak, fill=_rgba(*pal["hair_streak"], 195))

        # 2. Back cloth (back cape / ribbon tails)
        def draw_cloth_back(_img, d):
            cape = [
                px(0.405, 0.365), px(0.595, 0.365),
                px(0.655, 0.695), px(0.575, 0.675), px(0.500, 0.715), px(0.425, 0.675), px(0.345, 0.695),
            ]
            d.polygon(cape, fill=_rgba(*pal["dress_dark"], 235), outline=line, width=lw)

        # 3-6. Legs & Shoes (Left / Right Upper & Lower)
        def draw_leg_upper(side: str):
            s = -1 if side == "left" else 1
            cx = 0.50 + s * 0.045
            def _fn(_img, d):
                poly = [
                    px(cx - 0.036, 0.555), px(cx + 0.036, 0.555),
                    px(cx + 0.029, 0.768), px(cx - 0.029, 0.768),
                ]
                d.polygon(poly, fill=_rgba(*pal["skin"]), outline=line, width=lw)
                # Soft thigh shadow under skirt
                d.polygon([px(cx - 0.034, 0.555), px(cx + 0.034, 0.555), px(cx + 0.031, 0.685), px(cx - 0.031, 0.685)], fill=_rgba(*pal["skin_shadow"], 150))
            return _fn

        def draw_leg_lower(side: str):
            s = -1 if side == "left" else 1
            cx = 0.50 + s * 0.048
            def _fn(_img, d):
                # Seamless skin overlap cap at knee (no internal horizontal seam stroke)
                d.ellipse([px(cx - 0.027, 0.734), px(cx + 0.027, 0.776)], fill=_rgba(*pal["skin"]))
                calf = [
                    px(cx - 0.027, 0.752), px(cx + 0.027, 0.752),
                    px(cx + 0.019, 0.905), px(cx - 0.019, 0.905),
                ]
                d.polygon(calf, fill=_rgba(*pal["skin"]))
                d.line([px(cx - 0.027, 0.752), px(cx - 0.019, 0.905)], fill=line, width=lw)
                d.line([px(cx + 0.027, 0.752), px(cx + 0.019, 0.905)], fill=line, width=lw)
                # Mid-calf sock with trim
                sock = [
                    px(cx - 0.025, 0.805), px(cx + 0.025, 0.805),
                    px(cx + 0.019, 0.908), px(cx - 0.019, 0.908),
                ]
                d.polygon(sock, fill=_rgba(*pal["sock"]), outline=line, width=lw)
                d.line([px(cx - 0.024, 0.816), px(cx + 0.024, 0.816)], fill=_rgba(*pal["accent"]), width=lw + 2)
                # Anime Mary-Jane / loafer shoe
                shoe = [
                    px(cx - 0.023, 0.896), px(cx + 0.023, 0.896),
                    px(cx + 0.030 + s * 0.008, 0.946), px(cx - 0.030 + s * 0.008, 0.946),
                ]
                d.polygon(shoe, fill=_rgba(*pal["shoe"]), outline=line, width=lw)
                d.line([px(cx - 0.022, 0.914), px(cx + 0.022, 0.914)], fill=_rgba(*pal["ribbon"]), width=lw + 1)
            return _fn

        # 7-10. Arms & Sleeves (Left / Right Upper & Lower+Hand)
        def draw_arm_upper(side: str):
            s = -1 if side == "left" else 1
            sx, sy = 0.50 + s * 0.098, 0.372
            ex, ey = 0.50 + s * 0.148, 0.485
            def _fn(_img, d):
                # Puffed/sailor sleeve with clean rounded shoulder cap (no seam stroke across chest)
                d.ellipse([px(sx - 0.030, sy - 0.020), px(sx + 0.030, sy + 0.024)], fill=_rgba(*pal["dress_light"]))
                sleeve = [
                    px(sx - s * 0.020, sy - 0.012), px(sx + s * 0.028, sy - 0.006),
                    px(ex + s * 0.028, ey + 0.004), px(ex - s * 0.024, ey + 0.012),
                ]
                d.polygon(sleeve, fill=_rgba(*pal["dress_light"]), outline=line, width=lw)
                # Cuff accent band
                d.line([px(ex - s * 0.022, ey - 0.004), px(ex + s * 0.026, ey - 0.012)], fill=_rgba(*pal["accent"]), width=lw + 4)
            return _fn

        def draw_arm_lower(side: str):
            s = -1 if side == "left" else 1
            ex, ey = 0.50 + s * 0.148, 0.485
            hx, hy = 0.50 + s * 0.190, 0.592
            def _fn(_img, d):
                # Seamless elbow overlap circle (no horizontal divider stroke) + forearm
                d.ellipse([px(ex - 0.017, ey - 0.014), px(ex + 0.017, ey + 0.014)], fill=_rgba(*pal["skin"]))
                forearm = [
                    px(ex - 0.017, ey - 0.004), px(ex + 0.017, ey - 0.004),
                    px(hx + 0.014, hy - 0.010), px(hx - 0.014, hy - 0.010),
                ]
                d.polygon(forearm, fill=_rgba(*pal["skin"]))
                d.line([px(ex - 0.017, ey - 0.004), px(hx - 0.014, hy - 0.010)], fill=line, width=lw)
                d.line([px(ex + 0.017, ey - 0.004), px(hx + 0.014, hy - 0.010)], fill=line, width=lw)
                # Wristband accent
                d.line([px(hx - 0.015, hy - 0.016), px(hx + 0.015, hy - 0.016)], fill=_rgba(*pal["ribbon"]), width=lw + 3)
                # Soft anime hand with thumb
                d.ellipse([px(hx - 0.017, hy - 0.012), px(hx + 0.017, hy + 0.028)], fill=_rgba(*pal["skin"]), outline=line, width=lw)
                d.ellipse([px(hx - s * 0.018 - 0.007, hy - 0.002), px(hx - s * 0.018 + 0.007, hy + 0.016)], fill=_rgba(*pal["skin"]), outline=line, width=lw)
            return _fn

        # 11. Torso & Bodice (amodal clean without arms)
        def draw_torso(_img, d):
            bodice = [
                px(0.415, 0.352), px(0.500, 0.338), px(0.585, 0.352),
                px(0.570, 0.448), px(0.558, 0.552), px(0.442, 0.552), px(0.430, 0.448),
            ]
            d.polygon(bodice, fill=_rgba(*pal["dress_light"]), outline=line, width=lw)
            # Soft shading panel + waist corset belt
            d.polygon([px(0.432, 0.448), px(0.568, 0.448), px(0.558, 0.552), px(0.442, 0.552)], fill=_rgba(*pal["dress_mid"], 165))
            d.polygon([px(0.438, 0.512), px(0.562, 0.512), px(0.560, 0.552), px(0.440, 0.552)], fill=_rgba(*pal["dress_dark"]), outline=line, width=lw)
            # Decorative buttons
            for by in (0.418, 0.452, 0.486):
                d.ellipse([px(0.494, by - 0.005), px(0.506, by + 0.005)], fill=_rgba(*pal["accent"]), outline=line, width=max(2, lw - 1))

        # 12. Skirt front (multi-pleated flexible dress skirt)
        def draw_skirt_front(_img, d):
            skirt = (
                [px(0.438, 0.542), px(0.562, 0.542)]
                + _bezier(px(0.562, 0.542), px(0.615, 0.612), px(0.645, 0.665), px(0.652, 0.708), 12)
                + [px(0.595, 0.696), px(0.550, 0.716), px(0.500, 0.704), px(0.450, 0.716), px(0.405, 0.696), px(0.348, 0.708)]
                + _bezier(px(0.348, 0.708), px(0.355, 0.665), px(0.385, 0.612), px(0.438, 0.542), 12)
            )
            d.polygon(skirt, fill=_rgba(*pal["dress_mid"]), outline=line, width=lw)
            # Pleat shadow wedges
            for x_top, x_bot in ((0.460, 0.410), (0.500, 0.500), (0.540, 0.590)):
                pleat = [px(x_top - 0.008, 0.550), px(x_top + 0.008, 0.550), px(x_bot + 0.022, 0.705), px(x_bot - 0.022, 0.705)]
                d.polygon(pleat, fill=_rgba(*pal["dress_dark"], 115))
            # Lower tidal hem trim
            d.line([px(0.355, 0.688), px(0.450, 0.698), px(0.500, 0.688), px(0.550, 0.698), px(0.645, 0.688)], fill=_rgba(*pal["accent"]), width=lw + 4)
            d.line([px(0.362, 0.674), px(0.500, 0.674), px(0.638, 0.674)], fill=_rgba(*pal["dress_light"], 220), width=lw)

        # 13. Outer collar & bow tie
        def draw_cloth_outer(_img, d):
            # Sailor V-collar
            collar_l = [px(0.458, 0.342), px(0.415, 0.360), px(0.435, 0.415), px(0.500, 0.405)]
            collar_r = [px(0.542, 0.342), px(0.585, 0.360), px(0.565, 0.415), px(0.500, 0.405)]
            d.polygon(collar_l, fill=_rgba(*pal["dress_dark"]), outline=line, width=lw)
            d.polygon(collar_r, fill=_rgba(*pal["dress_dark"]), outline=line, width=lw)
            # Bow ribbon
            bow_l = [px(0.496, 0.398), px(0.452, 0.382), px(0.458, 0.422)]
            bow_r = [px(0.504, 0.398), px(0.548, 0.382), px(0.542, 0.422)]
            tail_l = [px(0.494, 0.404), px(0.474, 0.452), px(0.492, 0.448)]
            tail_r = [px(0.506, 0.404), px(0.526, 0.452), px(0.508, 0.448)]
            for poly in (tail_l, tail_r, bow_l, bow_r):
                d.polygon(poly, fill=_rgba(*pal["ribbon"]), outline=line, width=lw)
            d.ellipse([px(0.489, 0.391), px(0.511, 0.409)], fill=_rgba(*pal["accent"]), outline=line, width=lw)

        # 14. Neck
        def draw_neck(_img, d):
            d.polygon([px(0.474, 0.282), px(0.526, 0.282), px(0.532, 0.356), px(0.468, 0.356)], fill=_rgba(*pal["skin"]), outline=line, width=lw)
            d.polygon([px(0.475, 0.285), px(0.525, 0.285), px(0.524, 0.322), px(0.476, 0.322)], fill=_rgba(*pal["skin_shadow"], 180))

        # 15. Clean Amodal Head Base + Ears (no bangs, no facial features)
        def draw_head_base(_img, d):
            # Ears
            d.ellipse([px(0.392, 0.205), px(0.418, 0.248)], fill=_rgba(*pal["skin"]), outline=line, width=lw)
            d.ellipse([px(0.582, 0.205), px(0.608, 0.248)], fill=_rgba(*pal["skin"]), outline=line, width=lw)
            # Anime jawline & smooth cranium
            face = (
                _bezier(px(0.500, 0.105), px(0.405, 0.105), px(0.398, 0.185), px(0.408, 0.242), 20)
                + _bezier(px(0.408, 0.242), px(0.422, 0.286), px(0.470, 0.305), px(0.500, 0.306), 16)
                + _bezier(px(0.500, 0.306), px(0.530, 0.305), px(0.578, 0.286), px(0.592, 0.242), 16)
                + _bezier(px(0.592, 0.242), px(0.602, 0.185), px(0.595, 0.105), px(0.500, 0.105), 20)
            )
            d.polygon(face, fill=_rgba(*pal["skin"]), outline=line, width=lw)
            # Hairline crown base color so bangs never show bald gaps
            crown = _bezier(px(0.404, 0.178), px(0.412, 0.102), px(0.588, 0.102), px(0.596, 0.178), 24) + [px(0.500, 0.155)]
            d.polygon(crown, fill=_rgba(*pal["hair_base"]))
            # Tiny anime nose dot
            d.line([px(0.499, 0.246), px(0.502, 0.253)], fill=_rgba(*pal["skin_shadow"], 230), width=max(2, lw - 1))

        # 16. Blush FX
        def draw_blush(img, d):
            for cx in (0.436, 0.564):
                d.ellipse([px(cx - 0.028, 0.240), px(cx + 0.028, 0.262)], fill=_rgba(*pal["blush"], 145))
                for dx in (-0.012, 0.0, 0.012):
                    d.line([px(cx + dx - 0.004, 0.256), px(cx + dx + 0.004, 0.246)], fill=_rgba(*pal["blush"], 210), width=max(2, lw - 1))
            blurred = img.filter(ImageFilter.GaussianBlur(radius=4))
            img.paste(blurred)

        # 17-24. Eyes (Sclera, Iris, Open Lid, Closed Lid) for Left & Right
        def eye_center(side: str) -> tuple[float, float]:
            return (0.452 if side == "left" else 0.548, 0.220)

        def draw_eye_sclera(side: str):
            cx, cy = eye_center(side)
            def _fn(_img, d):
                d.ellipse([px(cx - 0.029, cy - 0.018), px(cx + 0.029, cy + 0.018)], fill=_rgba(252, 253, 255, 255))
                # Soft upper sclera shadow
                d.chord([px(cx - 0.029, cy - 0.018), px(cx + 0.029, cy + 0.018)], start=190, end=350, fill=_rgba(210, 220, 236, 175))
            return _fn

        def draw_eye_iris(side: str):
            cx, cy = eye_center(side)
            def _fn(_img, d):
                # Layered anime iris gradient
                d.ellipse([px(cx - 0.018, cy - 0.016), px(cx + 0.018, cy + 0.016)], fill=_rgba(*pal["eye_top"]), outline=line, width=max(2, lw - 1))
                d.ellipse([px(cx - 0.015, cy - 0.006), px(cx + 0.015, cy + 0.014)], fill=_rgba(*pal["eye_mid"]))
                d.ellipse([px(cx - 0.011, cy + 0.001), px(cx + 0.011, cy + 0.013)], fill=_rgba(*pal["eye_bot"]))
                # Pupil
                d.ellipse([px(cx - 0.0065, cy - 0.0055), px(cx + 0.0065, cy + 0.0065)], fill=_rgba(24, 30, 52))
                # Specular highlights
                d.ellipse([px(cx - 0.011, cy - 0.011), px(cx - 0.003, cy - 0.003)], fill=_rgba(255, 255, 255, 245))
                d.ellipse([px(cx + 0.005, cy + 0.004), px(cx + 0.010, cy + 0.009)], fill=_rgba(255, 255, 255, 210))
            return _fn

        def draw_eye_lid_open(side: str):
            cx, cy = eye_center(side)
            s = -1 if side == "left" else 1
            def _fn(_img, d):
                # Thick expressive upper eyelash curve + subtle double eyelid crease
                lash = _bezier(px(cx - 0.032, cy - 0.003), px(cx - 0.015, cy - 0.024), px(cx + 0.015, cy - 0.024), px(cx + 0.032, cy - 0.004), 20)
                d.line(lash, fill=line, width=lw + 6, joint="curve")
                wing = [px(cx + s * 0.028, cy - 0.007), px(cx + s * 0.036, cy - 0.012)]
                d.line(wing, fill=line, width=lw + 3)
                crease = _bezier(px(cx - 0.022, cy - 0.020), px(cx - 0.005, cy - 0.028), px(cx + 0.010, cy - 0.027), px(cx + 0.022, cy - 0.019), 14)
                d.line(crease, fill=_rgba(*pal["skin_shadow"], 210), width=max(2, lw - 1))
                # Subtle lower lash
                lower = _bezier(px(cx - 0.018, cy + 0.016), px(cx, cy + 0.019), px(cx, cy + 0.019), px(cx + 0.018, cy + 0.016), 12)
                d.line(lower, fill=_rgba(*pal["line"], 140), width=max(2, lw - 1))
            return _fn

        def draw_eye_lid_closed(side: str):
            cx, cy = eye_center(side)
            def _fn(_img, d):
                # Skin patch to cleanly cover sclera/iris when fully closed + gentle smiling closed lash
                d.ellipse([px(cx - 0.031, cy - 0.020), px(cx + 0.031, cy + 0.020)], fill=_rgba(*pal["skin"]))
                arc = _bezier(px(cx - 0.030, cy + 0.004), px(cx - 0.012, cy - 0.008), px(cx + 0.012, cy - 0.008), px(cx + 0.030, cy + 0.004), 18)
                d.line(arc, fill=line, width=lw + 5, joint="curve")
            return _fn

        # 25-26. Eyebrows
        def draw_brow(side: str):
            cx = 0.452 if side == "left" else 0.548
            cy = 0.184
            def _fn(_img, d):
                pts = _bezier(px(cx - 0.026, cy + 0.004), px(cx - 0.008, cy - 0.006), px(cx + 0.010, cy - 0.006), px(cx + 0.026, cy + 0.002), 14)
                d.line(pts, fill=_rgba(*pal["hair_shadow"]), width=lw + 2, joint="curve")
            return _fn

        # 27-30. Mouth shapes (closed, half, open, smile)
        def draw_mouth_closed(_img, d):
            pts = _bezier(px(0.483, 0.270), px(0.494, 0.274), px(0.506, 0.274), px(0.517, 0.270), 14)
            d.line(pts, fill=line, width=lw + 1, joint="curve")

        def draw_mouth_smile(_img, d):
            pts = _bezier(px(0.479, 0.267), px(0.492, 0.279), px(0.508, 0.279), px(0.521, 0.267), 16)
            d.line(pts, fill=line, width=lw + 2, joint="curve")

        def draw_mouth_half(_img, d):
            d.ellipse([px(0.486, 0.264), px(0.514, 0.279)], fill=_rgba(214, 108, 122), outline=line, width=lw)
            d.ellipse([px(0.491, 0.271), px(0.509, 0.278)], fill=_rgba(242, 152, 164))

        def draw_mouth_open(_img, d):
            d.ellipse([px(0.483, 0.261), px(0.517, 0.285)], fill=_rgba(196, 86, 104), outline=line, width=lw)
            d.chord([px(0.485, 0.261), px(0.515, 0.272)], start=0, end=180, fill=_rgba(252, 250, 250))
            d.ellipse([px(0.489, 0.273), px(0.511, 0.284)], fill=_rgba(238, 140, 154))

        # 31. Sparkle FX
        def draw_sparkle(_img, d):
            for cx, cy, r in ((0.365, 0.140, 0.016), (0.635, 0.155, 0.013), (0.618, 0.120, 0.008)):
                pts = [
                    px(cx, cy - r), px(cx + r * 0.25, cy - r * 0.25),
                    px(cx + r, cy), px(cx + r * 0.25, cy + r * 0.25),
                    px(cx, cy + r), px(cx - r * 0.25, cy + r * 0.25),
                    px(cx - r, cy), px(cx - r * 0.25, cy - r * 0.25),
                ]
                d.polygon(pts, fill=_rgba(*pal["sparkle"], 235), outline=_rgba(255, 255, 255, 240), width=2)

        # 32-36. Front Hair Strands (side_l, side_r, bang_l, bang_c, bang_r)
        def draw_side_hair(side: str):
            s = -1 if side == "left" else 1
            def _fn(_img, d):
                poly = (
                    _bezier(px(0.50 + s * 0.095, 0.135), px(0.50 + s * 0.132, 0.205), px(0.50 + s * 0.128, 0.315), px(0.50 + s * 0.105, 0.415), 20)
                    + _bezier(px(0.50 + s * 0.105, 0.415), px(0.50 + s * 0.088, 0.345), px(0.50 + s * 0.090, 0.250), px(0.50 + s * 0.075, 0.175), 16)
                )
                d.polygon(poly, fill=_rgba(*pal["hair_base"]), outline=line, width=lw)
                streak = [
                    px(0.50 + s * 0.100, 0.265), px(0.50 + s * 0.114, 0.270),
                    px(0.50 + s * 0.106, 0.398), px(0.50 + s * 0.096, 0.375),
                ]
                d.polygon(streak, fill=_rgba(*pal["hair_streak"], 190))
            return _fn

        def draw_bang_l(_img, d):
            poly = (
                _bezier(px(0.495, 0.092), px(0.415, 0.098), px(0.392, 0.155), px(0.396, 0.212), 18)
                + [px(0.422, 0.195), px(0.432, 0.218), px(0.456, 0.192), px(0.474, 0.206)]
                + _bezier(px(0.474, 0.206), px(0.476, 0.155), px(0.486, 0.120), px(0.495, 0.092), 12)
            )
            d.polygon(poly, fill=_rgba(*pal["hair_base"]), outline=line, width=lw)
            # Specular halo highlight
            d.line([px(0.422, 0.146), px(0.464, 0.138)], fill=_rgba(*pal["hair_highlight"], 230), width=lw + 5)

        def draw_bang_c(_img, d):
            poly = [
                px(0.468, 0.094), px(0.532, 0.094),
                px(0.534, 0.188), px(0.514, 0.216), px(0.500, 0.196), px(0.486, 0.218), px(0.466, 0.188),
            ]
            d.polygon(poly, fill=_rgba(*pal["hair_base"]), outline=line, width=lw)
            d.line([px(0.476, 0.136), px(0.524, 0.136)], fill=_rgba(*pal["hair_highlight"], 240), width=lw + 6)

        def draw_bang_r(_img, d):
            poly = (
                _bezier(px(0.505, 0.092), px(0.585, 0.098), px(0.608, 0.155), px(0.604, 0.212), 18)
                + [px(0.578, 0.195), px(0.568, 0.218), px(0.544, 0.192), px(0.526, 0.206)]
                + _bezier(px(0.526, 0.206), px(0.524, 0.155), px(0.514, 0.120), px(0.505, 0.092), 12)
            )
            d.polygon(poly, fill=_rgba(*pal["hair_base"]), outline=line, width=lw)
            d.line([px(0.536, 0.138), px(0.578, 0.146)], fill=_rgba(*pal["hair_highlight"], 230), width=lw + 5)

        # 37. Head Accessory (Tidal crest hairpin)
        def draw_acc_head(_img, d):
            # Crescent wave ornament + ribbon pins on left temple
            d.polygon([px(0.398, 0.132), px(0.365, 0.118), px(0.376, 0.150)], fill=_rgba(*pal["ribbon"]), outline=line, width=lw)
            d.polygon([px(0.398, 0.136), px(0.372, 0.158), px(0.402, 0.162)], fill=_rgba(*pal["dress_dark"]), outline=line, width=lw)
            d.ellipse([px(0.386, 0.126), px(0.410, 0.150)], fill=_rgba(*pal["accent"]), outline=line, width=lw)
            d.ellipse([px(0.393, 0.132), px(0.403, 0.142)], fill=_rgba(255, 255, 255, 230))

        return {
            "hair_back": make_layer(draw_hair_back),
            "cloth_back": make_layer(draw_cloth_back),
            "leg_l_upper": make_layer(draw_leg_upper("left")),
            "leg_l_lower_shoe": make_layer(draw_leg_lower("left")),
            "leg_r_upper": make_layer(draw_leg_upper("right")),
            "leg_r_lower_shoe": make_layer(draw_leg_lower("right")),
            "arm_l_upper": make_layer(draw_arm_upper("left")),
            "arm_l_lower_hand": make_layer(draw_arm_lower("left")),
            "arm_r_upper": make_layer(draw_arm_upper("right")),
            "arm_r_lower_hand": make_layer(draw_arm_lower("right")),
            "torso_base": make_layer(draw_torso),
            "skirt_front": make_layer(draw_skirt_front),
            "cloth_outer": make_layer(draw_cloth_outer),
            "neck": make_layer(draw_neck),
            "head_base": make_layer(draw_head_base),
            "fx_blush": make_layer(draw_blush),
            "eye_l_sclera": make_layer(draw_eye_sclera("left")),
            "eye_l_iris": make_layer(draw_eye_iris("left")),
            "eye_l_lid_open": make_layer(draw_eye_lid_open("left")),
            "eye_l_lid_closed": make_layer(draw_eye_lid_closed("left")),
            "eye_r_sclera": make_layer(draw_eye_sclera("right")),
            "eye_r_iris": make_layer(draw_eye_iris("right")),
            "eye_r_lid_open": make_layer(draw_eye_lid_open("right")),
            "eye_r_lid_closed": make_layer(draw_eye_lid_closed("right")),
            "brow_l": make_layer(draw_brow("left")),
            "brow_r": make_layer(draw_brow("right")),
            "mouth_closed": make_layer(draw_mouth_closed),
            "mouth_half": make_layer(draw_mouth_half),
            "mouth_open": make_layer(draw_mouth_open),
            "mouth_smile": make_layer(draw_mouth_smile),
            "fx_sparkle": make_layer(draw_sparkle),
            "hair_side_l": make_layer(draw_side_hair("left")),
            "hair_side_r": make_layer(draw_side_hair("right")),
            "hair_bang_l": make_layer(draw_bang_l),
            "hair_bang_c": make_layer(draw_bang_c),
            "hair_bang_r": make_layer(draw_bang_r),
            "acc_head": make_layer(draw_acc_head),
        }

    def _composite_preview(self, layers: dict[str, Image.Image], w: int, h: int) -> Image.Image:
        canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        skip_default = {"eye_l_lid_closed", "eye_r_lid_closed", "mouth_half", "mouth_open", "mouth_smile", "fx_blush", "fx_sparkle"}
        for layer_id, img in layers.items():
            if layer_id in skip_default:
                continue
            canvas.alpha_composite(img)
        return canvas

    def generate_layers(self, request: GenerationRequest, work_dir: Path) -> ProviderOutput:
        w, h = request.canvas_width, request.canvas_height
        outfit_pal = _extract_outfit_palette(request.outfit_image_path)
        sui_layers = self._render_variant(w, h, self._palette_for("sui", outfit_pal))
        ge_variant_layers: dict[str, Image.Image] = {}
        if request.persona_mode in ("dual", "ge"):
            ge_all = self._render_variant(w, h, self._palette_for("ge", outfit_pal))
            variant_keys = {
                "hair_back", "cloth_back", "leg_l_lower_shoe", "leg_r_lower_shoe",
                "arm_l_upper", "arm_r_upper", "torso_base", "skirt_front", "cloth_outer",
                "eye_l_iris", "eye_r_iris", "hair_side_l", "hair_side_r",
                "hair_bang_l", "hair_bang_c", "hair_bang_r", "acc_head",
            }
            ge_variant_layers = {k: ge_all[k] for k in variant_keys if k in ge_all}

        preview = self._composite_preview(sui_layers, w, h)
        return ProviderOutput(
            base_full_body=preview,
            layers=sui_layers,
            ge_variant_layers=ge_variant_layers,
            metadata={
                "provider": self.name,
                "draft": True,
                "extracted_palette_from": str(request.outfit_image_path) if request.outfit_image_path else None,
            },
        )
