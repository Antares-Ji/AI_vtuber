"""Stage 2: Local alpha matte purification, halo decontamination, and layer pack validation."""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image


def clean_layer_alpha(image: Image.Image, min_alpha: int = 8, remove_specks_px: int = 12) -> Image.Image:
    """Remove stray semi-transparent noise pixels and decontaminate edge halos."""
    rgba = image.convert("RGBA")
    arr = np.array(rgba, dtype=np.uint8)
    alpha = arr[:, :, 3]

    # Clamp near-zero alpha noise
    alpha[alpha < min_alpha] = 0

    # Remove tiny isolated connected components (floating artifacts)
    binary = (alpha >= min_alpha).astype(np.uint8)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if num_labels > 1:
        for label_idx in range(1, num_labels):
            if stats[label_idx, cv2.CC_STAT_AREA] < remove_specks_px:
                alpha[labels == label_idx] = 0

    # Zero out RGB in fully transparent pixels to prevent WebGL bilinear fringe bleed
    transparent = alpha == 0
    arr[transparent, 0] = 0
    arr[transparent, 1] = 0
    arr[transparent, 2] = 0
    arr[:, :, 3] = alpha

    return Image.fromarray(arr, mode="RGBA")


def purify_layer_set(
    layers: dict[str, Image.Image],
    canvas_size: tuple[int, int],
) -> dict[str, Image.Image]:
    """Ensure every layer matches target canvas dimensions and has clean premultiply-safe alpha."""
    cleaned: dict[str, Image.Image] = {}
    w, h = canvas_size
    for layer_id, img in layers.items():
        if img.size != (w, h):
            img = img.resize((w, h), Image.Resampling.LANCZOS)
        cleaned[layer_id] = clean_layer_alpha(img)
    return cleaned
