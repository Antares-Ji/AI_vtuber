"""Stage 3: Standards-compliant layered Adobe PSD writer & Photoshop round-trip reader.

Writes nested Layer Groups (`lsct` section dividers + `luni` Unicode layer names +
PackBits RLE RGBA channels + composite merged image) readable by Adobe Photoshop 2026
and `psd-tools`. Also reads back edited PSDs to support fast re-rigging without re-calling
cloud image APIs (`repack --from-psd`).
"""

from __future__ import annotations

import io
import struct
from collections import OrderedDict
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image
from psd_tools import PSDImage

from ..schema import CANONICAL_LAYERS, CANONICAL_LAYER_MAP


def _packbits_encode_row(row: bytes) -> bytes:
    """Adobe TIFF/PSD PackBits RLE encoder for a single scanline."""
    n = len(row)
    if n == 0:
        return b""
    out = bytearray()
    i = 0
    while i < n:
        # Check for run of identical bytes (len >= 3)
        run_end = i + 1
        while run_end < n and row[run_end] == row[i] and (run_end - i) < 128:
            run_end += 1
        run_len = run_end - i
        if run_len >= 3:
            out.append((257 - run_len) & 0xFF)
            out.append(row[i])
            i = run_end
            continue

        # Literal run
        lit_start = i
        i += 1
        while i < n and (i - lit_start) < 128:
            if i + 2 < n and row[i] == row[i + 1] == row[i + 2]:
                break
            i += 1
        lit_len = i - lit_start
        out.append(lit_len - 1)
        out.extend(row[lit_start:i])
    return bytes(out)


def _encode_channel_rle(channel_2d: np.ndarray) -> bytes:
    """Encode a 2D uint8 channel using PSD Compression=1 (PackBits RLE)."""
    h, w = channel_2d.shape
    if h == 0 or w == 0:
        return struct.pack(">H", 0)
    rows = [_packbits_encode_row(channel_2d[y].tobytes()) for y in range(h)]
    counts = b"".join(struct.pack(">H", len(r)) for r in rows)
    return struct.pack(">H", 1) + counts + b"".join(rows)


def _pascal_string_padded4(text: str) -> bytes:
    encoded = text.encode("ascii", errors="replace")[:255]
    raw = bytes([len(encoded)]) + encoded
    pad = (4 - (len(raw) % 4)) % 4
    return raw + (b"\x00" * pad)


def _luni_block(name: str) -> bytes:
    utf16 = name.encode("utf-16-be")
    body = struct.pack(">I", len(name)) + utf16
    if len(body) % 2 == 1:
        body += b"\x00"
    return b"8BIMluni" + struct.pack(">I", len(body)) + body


def _lsct_block(divider_type: int, blend_pass: bool = False) -> bytes:
    if blend_pass:
        body = struct.pack(">I", divider_type) + b"8BIMpass"
    else:
        body = struct.pack(">I", divider_type)
    return b"8BIMlsct" + struct.pack(">I", len(body)) + body


def _build_layer_entry(
    name: str,
    image: Image.Image | None,
    visible: bool = True,
    divider_type: int | None = None,
) -> tuple[bytes, bytes]:
    """Build (layer_record_bytes, channel_data_bytes) for one PSD pixel layer or group divider."""
    if divider_type is not None:
        top = left = bottom = right = 0
        channel_blobs = [(-1, struct.pack(">H", 0)), (0, struct.pack(">H", 0)), (1, struct.pack(">H", 0)), (2, struct.pack(">H", 0))]
        blend_mode = b"pass" if divider_type == 1 else b"norm"
        # Bit 1 = hidden, Bit 3 = 1, Bit 4 = pixel data irrelevant for divider
        flags = 0x18 | (0x00 if visible else 0x02)
        extra_blocks = _luni_block(name) + _lsct_block(divider_type, blend_pass=(divider_type == 1))
    else:
        assert image is not None
        arr = np.array(image.convert("RGBA"), dtype=np.uint8)
        ys, xs = np.where(arr[:, :, 3] > 0)
        if len(xs) == 0:
            top = left = bottom = right = 0
            channel_blobs = [(-1, struct.pack(">H", 0)), (0, struct.pack(">H", 0)), (1, struct.pack(">H", 0)), (2, struct.pack(">H", 0))]
        else:
            top, bottom = int(ys.min()), int(ys.max()) + 1
            left, right = int(xs.min()), int(xs.max()) + 1
            sub = arr[top:bottom, left:right]
            channel_blobs = [
                (-1, _encode_channel_rle(sub[:, :, 3])),
                (0, _encode_channel_rle(sub[:, :, 0])),
                (1, _encode_channel_rle(sub[:, :, 1])),
                (2, _encode_channel_rle(sub[:, :, 2])),
            ]
        blend_mode = b"norm"
        flags = 0x00 if visible else 0x02
        extra_blocks = _luni_block(name)

    extra = io.BytesIO()
    extra.write(struct.pack(">I", 0))  # Layer mask data length
    extra.write(struct.pack(">I", 0))  # Layer blending ranges length
    extra.write(_pascal_string_padded4(name))
    extra.write(extra_blocks)
    extra_bytes = extra.getvalue()

    rec = io.BytesIO()
    rec.write(struct.pack(">iiiiH", top, left, bottom, right, len(channel_blobs)))
    for ch_id, ch_bytes in channel_blobs:
        rec.write(struct.pack(">hI", ch_id, len(ch_bytes)))
    rec.write(b"8BIM")
    rec.write(blend_mode)
    rec.write(struct.pack(">BBBB", 255, 0, flags, 0))
    rec.write(struct.pack(">I", len(extra_bytes)))
    rec.write(extra_bytes)

    return rec.getvalue(), b"".join(ch_bytes for _, ch_bytes in channel_blobs)


def export_layered_psd(
    layers: dict[str, Image.Image],
    output_path: Path,
    canvas_size: tuple[int, int],
    ge_variant_layers: dict[str, Image.Image] | None = None,
) -> Path:
    """Export canonical layers (grouped into Photoshop folders) into an editable .psd file."""
    w, h = canvas_size
    hidden_default = {"eye_l_lid_closed", "eye_r_lid_closed", "mouth_half", "mouth_open", "mouth_smile", "fx_blush", "fx_sparkle"}

    # Group canonical layers preserving bottom-to-top zOrder
    groups: OrderedDict[str, list[tuple[str, Image.Image, bool]]] = OrderedDict()
    ordered_specs = sorted(CANONICAL_LAYERS, key=lambda s: s.z_order)
    seen = set()
    for spec in ordered_specs:
        if spec.id in layers:
            groups.setdefault(spec.group, []).append((spec.id, layers[spec.id], spec.id not in hidden_default))
            seen.add(spec.id)
    for extra_id, img in layers.items():
        if extra_id not in seen:
            groups.setdefault("Extra", []).append((extra_id, img, True))

    if ge_variant_layers:
        for layer_id, img in ge_variant_layers.items():
            groups.setdefault("Variant_Ge", []).append((f"ge__{layer_id}", img, False))

    # Build PSD records bottom-to-top: for each folder -> divider(3) -> children -> folder(1)
    records: list[bytes] = []
    channels: list[bytes] = []
    for group_name, items in groups.items():
        group_visible = group_name != "Variant_Ge"
        r_div, c_div = _build_layer_entry("</Layer group>", None, visible=group_visible, divider_type=3)
        records.append(r_div)
        channels.append(c_div)
        for layer_name, img, vis in items:
            r_lyr, c_lyr = _build_layer_entry(layer_name, img, visible=vis and group_visible)
            records.append(r_lyr)
            channels.append(c_lyr)
        r_open, c_open = _build_layer_entry(group_name, None, visible=group_visible, divider_type=1)
        records.append(r_open)
        channels.append(c_open)

    # Composite visible layers for PSD merged preview
    merged = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for spec in ordered_specs:
        if spec.id in layers and spec.id not in hidden_default:
            merged.alpha_composite(layers[spec.id].convert("RGBA"))
    merged_arr = np.array(merged, dtype=np.uint8)

    # Layer info block
    layer_info_body = struct.pack(">h", -len(records)) + b"".join(records) + b"".join(channels)
    if len(layer_info_body) % 2 == 1:
        layer_info_body += b"\x00"
    layer_and_mask = struct.pack(">I", len(layer_info_body)) + layer_info_body + struct.pack(">I", 0)
    if len(layer_and_mask) % 2 == 1:
        layer_and_mask += b"\x00"

    # Merged image section (Compression=1 PackBits RLE, channels R, G, B, A)
    merged_rows: list[bytes] = []
    merged_counts: list[bytes] = []
    for ch_idx in (0, 1, 2, 3):
        plane = merged_arr[:, :, ch_idx]
        for y in range(h):
            encoded_row = _packbits_encode_row(plane[y].tobytes())
            merged_counts.append(struct.pack(">H", len(encoded_row)))
            merged_rows.append(encoded_row)
    merged_section = struct.pack(">H", 1) + b"".join(merged_counts) + b"".join(merged_rows)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("wb") as f:
        # 1. File Header
        f.write(b"8BPS")
        f.write(struct.pack(">H", 1))
        f.write(b"\x00" * 6)
        f.write(struct.pack(">HIIHH", 4, h, w, 8, 3))
        # 2. Color Mode Data
        f.write(struct.pack(">I", 0))
        # 3. Image Resources
        f.write(struct.pack(">I", 0))
        # 4. Layer & Mask Info
        f.write(struct.pack(">I", len(layer_and_mask)))
        f.write(layer_and_mask)
        # 5. Merged Image Data
        f.write(merged_section)

    return output_path


def _iter_psd_pixel_layers(container: Iterable, group_path: list[str] | None = None):
    group_path = group_path or []
    for layer in container:
        if layer.is_group():
            yield from _iter_psd_pixel_layers(layer, group_path + [layer.name])
        else:
            yield (layer.name, list(group_path), layer)


def import_layers_from_psd(psd_path: Path) -> tuple[dict[str, Image.Image], dict[str, Image.Image], tuple[int, int]]:
    """Read an edited Photoshop PSD back into canonical full-canvas RGBA layers + optional ge variant layers."""
    psd = PSDImage.open(str(psd_path))
    w, h = int(psd.width), int(psd.height)
    base_layers: dict[str, Image.Image] = {}
    ge_layers: dict[str, Image.Image] = {}

    for raw_name, groups, layer in _iter_psd_pixel_layers(psd):
        name = raw_name.strip()
        full = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        if layer.width > 0 and layer.height > 0:
            pil_img = layer.topil()
            if pil_img is not None:
                full.alpha_composite(pil_img.convert("RGBA"), (int(layer.left), int(layer.top)))

        if name.startswith("ge__") or "Variant_Ge" in groups:
            clean_id = name[4:] if name.startswith("ge__") else name
            ge_layers[clean_id] = full
        else:
            # Match canonical layer ID directly or by display name
            matched_id = name
            if name not in CANONICAL_LAYER_MAP:
                for spec in CANONICAL_LAYERS:
                    if spec.display_name == name:
                        matched_id = spec.id
                        break
            base_layers[matched_id] = full

    return base_layers, ge_layers, (w, h)
