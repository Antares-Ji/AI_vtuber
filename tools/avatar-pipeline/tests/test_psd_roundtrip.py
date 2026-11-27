"""Verify standards-compliant Adobe PSD writer -> psd-tools reader round-trip."""

from __future__ import annotations

from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from psd_tools import PSDImage

from avatar_pipeline.stages.psd_io import export_layered_psd, import_layers_from_psd


def test_psd_groups_and_pixel_roundtrip(tmp_path: Path):
    w, h = 256, 384
    head = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(head).ellipse([80, 40, 176, 140], fill=(255, 232, 220, 255))

    torso = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(torso).rectangle([88, 150, 168, 260], fill=(96, 172, 224, 255))

    ge_torso = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(ge_torso).rectangle([88, 150, 168, 260], fill=(34, 48, 86, 255))

    psd_path = tmp_path / "test_avatar.psd"
    export_layered_psd(
        {"head_base": head, "torso_base": torso},
        psd_path,
        canvas_size=(w, h),
        ge_variant_layers={"torso_base": ge_torso},
    )
    assert psd_path.is_file()

    # Parse with psd-tools to confirm valid Adobe PSD structure + group folders
    parsed = PSDImage.open(str(psd_path))
    assert parsed.width == w
    assert parsed.height == h
    top_group_names = [layer.name for layer in parsed if layer.is_group()]
    assert "Head" in top_group_names
    assert "Torso" in top_group_names
    assert "Variant_Ge" in top_group_names

    # Import back and verify exact pixel values on both base and Ge variant layers
    base_out, ge_out, size = import_layers_from_psd(psd_path)
    assert size == (w, h)
    assert "head_base" in base_out and "torso_base" in base_out
    assert "torso_base" in ge_out
    assert np.array_equal(np.array(base_out["head_base"]), np.array(head))
    assert np.array_equal(np.array(base_out["torso_base"]), np.array(torso))
    assert np.array_equal(np.array(ge_out["torso_base"]), np.array(ge_torso))
