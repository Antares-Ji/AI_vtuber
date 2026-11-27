"""Stage 5: Automated rule-based & optional VLM quality assurance for Rig2D packages."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image
from psd_tools import PSDImage

from ..providers.base import ImageGenerationProvider
from ..schema import CANONICAL_LAYERS, Rig2DModel


def run_rig_qa(
    model: Rig2DModel,
    model_dir: Path,
    preview_image: Image.Image | None = None,
    provider: ImageGenerationProvider | None = None,
) -> dict[str, Any]:
    """Validate layer completeness, mesh & bone weight math, texture files, PSD integrity, and optional VLM checks."""
    checks: list[dict[str, Any]] = []
    warnings: list[str] = []
    errors: list[str] = []

    present_ids = {layer.id for layer in model.layers}
    required_ids = [spec.id for spec in CANONICAL_LAYERS if spec.required]
    missing_required = [lid for lid in required_ids if lid not in present_ids]
    checks.append({
        "name": "required_layers_present",
        "passed": len(missing_required) == 0,
        "detail": f"{len(present_ids)} layers exported; missing required: {missing_required or 'none'}",
    })
    if missing_required:
        warnings.append(f"缺少必要图层：{', '.join(missing_required)}")

    # Texture files exist on disk
    missing_textures: list[str] = []
    for layer in model.layers:
        if not (model_dir / layer.texture).is_file():
            missing_textures.append(layer.texture)
    for variant in model.variants.values():
        for rel in variant.textures.values():
            if not (model_dir / rel).is_file():
                missing_textures.append(rel)
    checks.append({
        "name": "texture_files_exist",
        "passed": len(missing_textures) == 0,
        "detail": "all texture PNGs verified" if not missing_textures else f"missing: {missing_textures}",
    })
    if missing_textures:
        errors.append(f"缺失贴图文件：{', '.join(missing_textures)}")

    # Bones within canvas bounds & positive lengths
    w, h = model.canvas.width, model.canvas.height
    bad_bones = [
        b.id
        for b in model.bones
        if not (-0.1 * w <= b.x <= 1.1 * w and -0.1 * h <= b.y <= 1.1 * h and b.length > 0)
    ]
    checks.append({
        "name": "bones_geometry_valid",
        "passed": len(bad_bones) == 0,
        "detail": f"{len(model.bones)} bones valid" if not bad_bones else f"out-of-bounds bones: {bad_bones}",
    })
    if bad_bones:
        errors.append(f"骨骼坐标异常：{', '.join(bad_bones)}")

    # Mesh indices, UVs, and normalized LBS bone weights sum == 1.0
    bad_meshes: list[str] = []
    total_verts = 0
    total_tris = 0
    num_bones = len(model.bones)
    for layer in model.layers:
        v_count = len(layer.mesh.positions) // 2
        total_verts += v_count
        total_tris += len(layer.mesh.indices) // 3
        if v_count < 3 or len(layer.mesh.uvs) != len(layer.mesh.positions) or len(layer.mesh.weights) != v_count:
            bad_meshes.append(f"{layer.id}:vertex_count_mismatch")
            continue
        if any(idx < 0 or idx >= v_count for idx in layer.mesh.indices):
            bad_meshes.append(f"{layer.id}:index_out_of_range")
            continue
        if any(u < -1e-4 or u > 1.0001 for u in layer.mesh.uvs):
            bad_meshes.append(f"{layer.id}:uv_out_of_range")
            continue
        for vw in layer.mesh.weights:
            w_sum = sum(pair[1] for pair in vw)
            if abs(w_sum - 1.0) > 1e-2 or any(pair[0] < 0 or pair[0] >= num_bones for pair in vw):
                bad_meshes.append(f"{layer.id}:invalid_weights")
                break
    checks.append({
        "name": "mesh_and_weights_valid",
        "passed": len(bad_meshes) == 0,
        "detail": f"{total_verts} verts / {total_tris} tris across {len(model.layers)} meshes"
        if not bad_meshes
        else f"bad meshes: {bad_meshes}",
    })
    if bad_meshes:
        errors.append(f"网格或蒙皮权重错误：{', '.join(bad_meshes)}")

    # PSD round-trip verification
    psd_ok = True
    psd_detail = "no PSD exported"
    if model.psdFile:
        psd_path = model_dir / model.psdFile
        if not psd_path.is_file():
            psd_ok = False
            psd_detail = f"missing PSD file {model.psdFile}"
            errors.append(psd_detail)
        else:
            try:
                parsed = PSDImage.open(str(psd_path))
                psd_ok = parsed.width == w and parsed.height == h and len(list(parsed.descendants())) > 0
                psd_detail = f"PSD verified ({parsed.width}x{parsed.height}, {len(list(parsed.descendants()))} nodes)"
            except Exception as exc:  # noqa: BLE001
                psd_ok = False
                psd_detail = f"PSD parse failed: {exc}"
                errors.append(psd_detail)
    checks.append({"name": "psd_integrity", "passed": psd_ok, "detail": psd_detail})

    # Dual-persona Ge variant check
    ge_variant = model.variants.get("ge")
    ge_tex_count = len(ge_variant.textures) if ge_variant else 0
    checks.append({
        "name": "dual_persona_variant",
        "passed": ge_variant is not None,
        "detail": f"Ge variant configured with {ge_tex_count} differential layer textures",
    })

    # Optional VLM check
    vlm_report = {"enabled": False, "passed": True, "notes": []}
    if provider is not None and preview_image is not None:
        vlm_report = provider.review_image_quality(
            preview_image,
            "Front-facing standing A-pose anime character, clean silhouette, two intact hands and legs, no severe holes or misalignments",
        )
        if vlm_report.get("enabled") and not vlm_report.get("passed"):
            warnings.append(f"VLM 视觉审查建议复核：{vlm_report.get('issues', [])}")

    passed = len(errors) == 0 and all(c["passed"] for c in checks if c["name"] != "required_layers_present")
    return {
        "passed": passed,
        "errors": errors,
        "warnings": warnings,
        "stats": {
            "layerCount": len(model.layers),
            "boneCount": len(model.bones),
            "physicsCount": len(model.physics),
            "vertexCount": total_verts,
            "triangleCount": total_tris,
            "geVariantTextures": ge_tex_count,
        },
        "checks": checks,
        "vlm": vlm_report,
    }
