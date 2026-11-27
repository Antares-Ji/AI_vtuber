"""Stage 4c: Rig2D model package builder (textures, meshes, weights, physics, variants, model.rig2d.json)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image

from ..schema import (
    CANONICAL_LAYERS,
    CANONICAL_LAYER_MAP,
    DEFAULT_PHYSICS_CHAINS,
    EMOTION_PRESETS,
    MOTION_PRESETS,
    PERSONA_PROFILES,
    CanvasSpec,
    LayerDef,
    LayerSpec,
    PhysicsDef,
    Rig2DModel,
    VariantDef,
)
from .landmarks import detect_bones_from_layers
from .mesher import build_layer_mesh, compute_layer_bbox


def build_rig2d_package(
    model_id: str,
    name: str,
    layers: dict[str, Image.Image],
    canvas_size: tuple[int, int],
    output_dir: Path,
    provider_name: str,
    ge_variant_layers: dict[str, Image.Image] | None = None,
    preview_image: Image.Image | None = None,
    psd_filename: str | None = "layered.psd",
    joint_overrides: dict[str, dict[str, float]] | None = None,
    draft: bool = True,
    character_base: str = "jisui-draft",
) -> Rig2DModel:
    """Assemble a complete self-contained Rig2D model directory ready for AI_vtuber or workbench preview."""
    w, h = canvas_size
    output_dir.mkdir(parents=True, exist_ok=True)
    layers_dir = output_dir / "layers"
    layers_dir.mkdir(parents=True, exist_ok=True)

    ge_variant_layers = ge_variant_layers or {}
    ge_dir = output_dir / "variants" / "ge"
    if ge_variant_layers:
        ge_dir.mkdir(parents=True, exist_ok=True)

    # 1. Detect skeleton joints from alpha silhouettes + overrides
    bones = detect_bones_from_layers(layers, canvas_size, overrides=joint_overrides)
    bone_map = {b.id: b for b in bones}

    # 2. Export cropped layer textures, exact-bbox-matched Ge variant textures, and Delaunay skinned meshes
    ordered_specs: list[LayerSpec] = list(sorted(CANONICAL_LAYERS, key=lambda s: s.z_order))
    known_ids = {s.id for s in ordered_specs}
    next_z = 200
    for extra_id in layers:
        if extra_id not in known_ids:
            ordered_specs.append(
                LayerSpec(
                    id=extra_id,
                    group="Extra",
                    display_name=extra_id,
                    z_order=next_z,
                    parent_bone="chest",
                    bones=("chest", "spine"),
                    role="accessory",
                    required=False,
                    mesh_density="low",
                )
            )
            next_z += 1

    layer_defs: list[LayerDef] = []
    ge_texture_overrides: dict[str, str] = {}

    for spec in ordered_specs:
        img = layers.get(spec.id)
        if img is None:
            continue
        x0, y0, x1, y1, coverage = compute_layer_bbox(img, pad=4)
        if x1 <= x0 or y1 <= y0:
            continue

        # Save tightly cropped base (Sui) texture
        crop = img.convert("RGBA").crop((x0, y0, x1, y1))
        rel_tex = f"layers/{spec.id}.png"
        crop.save(output_dir / rel_tex)

        # Save Ge variant texture cropped to the EXACT SAME bbox so UVs stay 100% locked during crossfade!
        if spec.id in ge_variant_layers:
            ge_img = ge_variant_layers[spec.id].convert("RGBA")
            if ge_img.size != (w, h):
                ge_img = ge_img.resize((w, h), Image.Resampling.LANCZOS)
            ge_crop = ge_img.crop((x0, y0, x1, y1))
            ge_rel = f"variants/ge/{spec.id}.png"
            ge_crop.save(output_dir / ge_rel)
            ge_texture_overrides[spec.id] = ge_rel

        mesh = build_layer_mesh(img, spec, bones, (x0, y0, x1, y1))
        parent_bone = bone_map.get(spec.parent_bone, bones[0])
        layer_defs.append(
            LayerDef(
                id=spec.id,
                group=spec.group,
                displayName=spec.display_name,
                texture=rel_tex,
                zOrder=spec.z_order,
                parentBone=parent_bone.id,
                role=spec.role,
                side=spec.side,
                parallaxX=spec.parallax_x,
                parallaxY=spec.parallax_y,
                bbox=[x0, y0, x1, y1],
                pivot=[parent_bone.x, parent_bone.y],
                alphaCoverage=coverage,
                mesh=mesh,
            )
        )

    # 3. Save preview thumbnail
    preview_rel: str | None = None
    if preview_image is not None:
        preview_rel = "preview.png"
        thumb = preview_image.convert("RGBA")
        thumb.thumbnail((512, 768), Image.Resampling.LANCZOS)
        thumb.save(output_dir / preview_rel)

    # 4. Build variant map (always define sui + ge profiles so persona posture/gaze shifts even if ge textures absent)
    variants: dict[str, VariantDef] = {
        "sui": VariantDef(
            id="sui",
            displayName=PERSONA_PROFILES["sui"]["displayName"],
            textures={},
            profile=PERSONA_PROFILES["sui"],
        ),
        "ge": VariantDef(
            id="ge",
            displayName=PERSONA_PROFILES["ge"]["displayName"],
            textures=ge_texture_overrides,
            profile=PERSONA_PROFILES["ge"],
        ),
    }

    physics_defs = [PhysicsDef(**item) for item in DEFAULT_PHYSICS_CHAINS if item["bone"] in bone_map]

    model = Rig2DModel(
        id=model_id,
        name=name,
        draft=draft,
        characterBase=character_base,
        createdAt=datetime.now(timezone.utc).isoformat(),
        provider=provider_name,
        psdFile=psd_filename if (psd_filename and (output_dir / psd_filename).is_file()) else None,
        previewImage=preview_rel,
        canvas=CanvasSpec(width=w, height=h, anchorX=0.5, anchorY=0.945),
        bones=bones,
        layers=layer_defs,
        physics=physics_defs,
        variants=variants,
        expressions=dict(EMOTION_PRESETS),
        motions=dict(MOTION_PRESETS),
    )

    model_json_path = output_dir / "model.rig2d.json"
    model_json_path.write_text(model.model_dump_json(indent=2), encoding="utf-8")
    return model
