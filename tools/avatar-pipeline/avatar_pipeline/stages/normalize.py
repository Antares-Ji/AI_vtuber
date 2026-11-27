"""Stage 1: Canonical canvas & A-pose bounding normalization."""

from __future__ import annotations

import numpy as np
from PIL import Image


def normalize_to_canonical_canvas(
    image: Image.Image,
    target_width: int = 1024,
    target_height: int = 1536,
    target_top_ratio: float = 0.075,
    target_bottom_ratio: float = 0.948,
) -> tuple[Image.Image, dict[str, float]]:
    """Center and scale an RGBA standing illustration so head top and feet align to canonical anchors."""
    rgba = image.convert("RGBA")
    arr = np.array(rgba)
    alpha = arr[:, :, 3]
    ys, xs = np.where(alpha > 16)
    if len(xs) == 0 or len(ys) == 0:
        return Image.new("RGBA", (target_width, target_height), (0, 0, 0, 0)), {
            "scale": 1.0,
            "offsetX": 0.0,
            "offsetY": 0.0,
            "empty": True,
        }

    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    crop = rgba.crop((x0, y0, x1, y1))
    crop_w, crop_h = crop.size

    desired_h = int(target_height * (target_bottom_ratio - target_top_ratio))
    scale = min(desired_h / max(1, crop_h), (target_width * 0.86) / max(1, crop_w))
    new_w = max(1, int(round(crop_w * scale)))
    new_h = max(1, int(round(crop_h * scale)))
    resized = crop.resize((new_w, new_h), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (target_width, target_height), (0, 0, 0, 0))
    paste_x = (target_width - new_w) // 2
    paste_y = int(round(target_height * target_bottom_ratio)) - new_h
    paste_y = max(0, min(target_height - new_h, paste_y))
    canvas.alpha_composite(resized, (paste_x, paste_y))

    return canvas, {
        "scale": round(scale, 5),
        "offsetX": float(paste_x - x0 * scale),
        "offsetY": float(paste_y - y0 * scale),
        "srcBBox": [x0, y0, x1, y1],
        "dstBBox": [paste_x, paste_y, paste_x + new_w, paste_y + new_h],
        "empty": False,
    }
