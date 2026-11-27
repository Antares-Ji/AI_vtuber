"""End-to-end stage-cached Rig2D Avatar Pipeline orchestrator."""

from __future__ import annotations

import json
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image

from .config import PipelineConfig
from .providers import (
    GenerationRequest,
    ImageGenerationProvider,
    OpenAIGptImageProvider,
    SyntheticDemoProvider,
)
from .schema import CANONICAL_LAYERS, Rig2DModel
from .stages.decompose import purify_layer_set
from .stages.normalize import normalize_to_canonical_canvas
from .stages.psd_io import export_layered_psd, import_layers_from_psd
from .stages.qa import run_rig_qa
from .stages.rig_builder import build_rig2d_package


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip()).strip("-").lower()
    return slug or f"avatar-{uuid.uuid4().hex[:6]}"


def create_provider(provider_name: str, config: PipelineConfig) -> ImageGenerationProvider:
    if provider_name == "synthetic_demo":
        return SyntheticDemoProvider()
    if provider_name == "openai_gpt_image":
        return OpenAIGptImageProvider(config)
    raise ValueError(f"Unsupported provider: {provider_name}")


class AvatarPipeline:
    """Orchestrates cached stage execution, PSD round-trip repack, joint override re-rig, and publishing."""

    def __init__(self, config: PipelineConfig | None = None):
        self.config = config or PipelineConfig.from_env()
        self.config.cache_dir.mkdir(parents=True, exist_ok=True)
        self.config.avatars_dir.mkdir(parents=True, exist_ok=True)

    def job_dir(self, job_id: str) -> Path:
        return self.config.cache_dir / job_id

    def _manifest_path(self, job_id: str) -> Path:
        return self.job_dir(job_id) / "manifest.json"

    def load_manifest(self, job_id: str) -> dict[str, Any]:
        path = self._manifest_path(job_id)
        if not path.is_file():
            raise FileNotFoundError(f"Job manifest not found: {job_id}")
        return json.loads(path.read_text(encoding="utf-8"))

    def save_manifest(self, job_id: str, manifest: dict[str, Any]) -> None:
        manifest["updatedAt"] = datetime.now(timezone.utc).isoformat()
        path = self._manifest_path(job_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    def list_jobs(self) -> list[dict[str, Any]]:
        jobs: list[dict[str, Any]] = []
        if not self.config.cache_dir.is_dir():
            return jobs
        for child in sorted(self.config.cache_dir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            mp = child / "manifest.json"
            if mp.is_file():
                try:
                    jobs.append(json.loads(mp.read_text(encoding="utf-8")))
                except Exception:  # noqa: BLE001
                    continue
        return jobs

    def _load_full_layers(self, job_dir: Path) -> tuple[dict[str, Image.Image], dict[str, Image.Image]]:
        base_dir = job_dir / "layers_full"
        ge_dir = job_dir / "layers_full_ge"
        base: dict[str, Image.Image] = {}
        ge: dict[str, Image.Image] = {}
        if base_dir.is_dir():
            for png in sorted(base_dir.glob("*.png")):
                base[png.stem] = Image.open(png).convert("RGBA")
        if ge_dir.is_dir():
            for png in sorted(ge_dir.glob("*.png")):
                ge[png.stem] = Image.open(png).convert("RGBA")
        return base, ge

    def _save_full_layers(
        self,
        job_dir: Path,
        base_layers: dict[str, Image.Image],
        ge_layers: dict[str, Image.Image],
    ) -> None:
        base_dir = job_dir / "layers_full"
        ge_dir = job_dir / "layers_full_ge"
        base_dir.mkdir(parents=True, exist_ok=True)
        for lid, img in base_layers.items():
            img.convert("RGBA").save(base_dir / f"{lid}.png")
        if ge_layers:
            ge_dir.mkdir(parents=True, exist_ok=True)
            for lid, img in ge_layers.items():
                img.convert("RGBA").save(ge_dir / f"{lid}.png")

    def _compose_preview(self, base_layers: dict[str, Image.Image], canvas_size: tuple[int, int]) -> Image.Image:
        canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
        skip_default = {
            "eye_l_lid_closed", "eye_r_lid_closed",
            "mouth_half", "mouth_open", "mouth_smile",
            "fx_blush", "fx_sparkle",
        }
        for spec in sorted(CANONICAL_LAYERS, key=lambda s: s.z_order):
            if spec.id in base_layers and spec.id not in skip_default:
                canvas.alpha_composite(base_layers[spec.id].convert("RGBA"))
        return canvas

    def run(
        self,
        model_id: str | None = None,
        name: str = "姬岁歌 · 潮汐常服（草案）",
        outfit_image_path: Path | None = None,
        character_ref_path: Path | None = None,
        prompt_notes: str = "",
        persona_mode: str = "dual",
        provider_name: str | None = None,
        keep_input_as_base: bool = False,
        publish: bool = False,
        job_id: str | None = None,
    ) -> dict[str, Any]:
        """Run full Stages 1->5 with disk stage caching and optional publish to AI_vtuber."""
        provider_name = provider_name or self.config.provider
        provider = create_provider(provider_name, self.config)
        clean_model_id = _slugify(model_id or name)
        job_id = job_id or f"{clean_model_id}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        jdir = self.job_dir(job_id)
        jdir.mkdir(parents=True, exist_ok=True)

        # Copy input references into job cache for reproducibility
        inputs_dir = jdir / "inputs"
        inputs_dir.mkdir(parents=True, exist_ok=True)
        cached_outfit: Path | None = None
        cached_char: Path | None = None
        if outfit_image_path and Path(outfit_image_path).is_file():
            cached_outfit = inputs_dir / f"outfit{Path(outfit_image_path).suffix.lower() or '.png'}"
            shutil.copy2(outfit_image_path, cached_outfit)
        if character_ref_path and Path(character_ref_path).is_file():
            cached_char = inputs_dir / f"character{Path(character_ref_path).suffix.lower() or '.png'}"
            shutil.copy2(character_ref_path, cached_char)

        canvas_size = (self.config.canvas_width, self.config.canvas_height)
        manifest: dict[str, Any] = {
            "jobId": job_id,
            "modelId": clean_model_id,
            "name": name,
            "provider": provider.name,
            "personaMode": persona_mode,
            "promptNotes": prompt_notes,
            "canvas": {"width": canvas_size[0], "height": canvas_size[1]},
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "stages": {},
            "publishedPath": None,
        }
        self.save_manifest(job_id, manifest)

        # Stage 1 & 2: Generate canonical standing art + multi-layer decomposition
        req = GenerationRequest(
            job_id=job_id,
            model_id=clean_model_id,
            name=name,
            outfit_image_path=cached_outfit,
            character_ref_path=cached_char,
            prompt_notes=prompt_notes,
            persona_mode=persona_mode,
            keep_input_as_base=keep_input_as_base,
            canvas_width=canvas_size[0],
            canvas_height=canvas_size[1],
        )
        raw_output = provider.generate_layers(req, jdir)
        norm_base, norm_meta = normalize_to_canonical_canvas(
            raw_output.base_full_body, canvas_size[0], canvas_size[1]
        )
        norm_base.save(jdir / "base_normalized.png")
        manifest["stages"]["stage1_normalize"] = {"status": "done", "meta": norm_meta}

        cleaned_layers = purify_layer_set(raw_output.layers, canvas_size)
        cleaned_ge = purify_layer_set(raw_output.ge_variant_layers, canvas_size)
        self._save_full_layers(jdir, cleaned_layers, cleaned_ge)
        manifest["stages"]["stage2_decompose"] = {
            "status": "done",
            "layerCount": len(cleaned_layers),
            "geLayerCount": len(cleaned_ge),
            "providerMeta": raw_output.metadata,
        }
        self.save_manifest(job_id, manifest)

        # Stage 3, 4, 5: PSD export -> auto-rigging -> QA
        return self._finish_rig_and_qa(
            job_id=job_id,
            manifest=manifest,
            base_layers=cleaned_layers,
            ge_layers=cleaned_ge,
            canvas_size=canvas_size,
            provider=provider,
            export_psd=True,
            publish=publish,
        )

    def rerig(
        self,
        job_id: str,
        joint_overrides: dict[str, dict[str, float]] | None = None,
        publish: bool = False,
    ) -> dict[str, Any]:
        """Fast re-rigging (<1s) using cached full-canvas layers + optional joint coordinate overrides."""
        jdir = self.job_dir(job_id)
        manifest = self.load_manifest(job_id)
        overrides_path = jdir / "rig_overrides.json"
        if joint_overrides is not None:
            overrides_path.write_text(json.dumps(joint_overrides, ensure_ascii=False, indent=2), encoding="utf-8")
        elif overrides_path.is_file():
            joint_overrides = json.loads(overrides_path.read_text(encoding="utf-8"))

        base_layers, ge_layers = self._load_full_layers(jdir)
        canvas_size = (int(manifest["canvas"]["width"]), int(manifest["canvas"]["height"]))
        return self._finish_rig_and_qa(
            job_id=job_id,
            manifest=manifest,
            base_layers=base_layers,
            ge_layers=ge_layers,
            canvas_size=canvas_size,
            provider=None,
            joint_overrides=joint_overrides,
            export_psd=False,
            publish=publish,
        )

    def repack_from_psd(
        self,
        job_id: str,
        psd_path: Path,
        publish: bool = False,
    ) -> dict[str, Any]:
        """Re-import an artist-edited Photoshop PSD into an existing job and re-rig immediately."""
        jdir = self.job_dir(job_id)
        manifest = self.load_manifest(job_id)
        raw_base, raw_ge, psd_size = import_layers_from_psd(psd_path)
        cleaned_base = purify_layer_set(raw_base, psd_size)
        cleaned_ge = purify_layer_set(raw_ge, psd_size)
        self._save_full_layers(jdir, cleaned_base, cleaned_ge)

        # Keep a copy of the edited PSD inside model package
        model_dir = jdir / "model"
        model_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(psd_path, model_dir / "layered.psd")

        manifest["canvas"] = {"width": psd_size[0], "height": psd_size[1]}
        manifest["stages"]["psd_repack"] = {
            "status": "done",
            "source": str(psd_path),
            "layerCount": len(cleaned_base),
            "geLayerCount": len(cleaned_ge),
        }
        overrides_path = jdir / "rig_overrides.json"
        joint_overrides = json.loads(overrides_path.read_text(encoding="utf-8")) if overrides_path.is_file() else None
        return self._finish_rig_and_qa(
            job_id=job_id,
            manifest=manifest,
            base_layers=cleaned_base,
            ge_layers=cleaned_ge,
            canvas_size=psd_size,
            provider=None,
            joint_overrides=joint_overrides,
            export_psd=False,
            publish=publish,
        )

    def _finish_rig_and_qa(
        self,
        job_id: str,
        manifest: dict[str, Any],
        base_layers: dict[str, Image.Image],
        ge_layers: dict[str, Image.Image],
        canvas_size: tuple[int, int],
        provider: ImageGenerationProvider | None,
        joint_overrides: dict[str, dict[str, float]] | None = None,
        export_psd: bool = True,
        publish: bool = False,
    ) -> dict[str, Any]:
        jdir = self.job_dir(job_id)
        model_dir = jdir / "model"
        model_dir.mkdir(parents=True, exist_ok=True)

        if export_psd:
            psd_path = export_layered_psd(
                base_layers,
                model_dir / "layered.psd",
                canvas_size=canvas_size,
                ge_variant_layers=ge_layers,
            )
            manifest["stages"]["stage3_psd"] = {"status": "done", "file": str(psd_path.name)}

        for stale_sub in (model_dir / "layers", model_dir / "variants"):
            if stale_sub.exists():
                shutil.rmtree(stale_sub)

        preview = self._compose_preview(base_layers, canvas_size)
        model: Rig2DModel = build_rig2d_package(
            model_id=manifest["modelId"],
            name=manifest["name"],
            layers=base_layers,
            canvas_size=canvas_size,
            output_dir=model_dir,
            provider_name=manifest["provider"],
            ge_variant_layers=ge_layers,
            preview_image=preview,
            psd_filename="layered.psd",
            joint_overrides=joint_overrides,
            draft=True,
        )

        qa_report = run_rig_qa(model, model_dir, preview_image=preview, provider=provider)
        model.qa = qa_report
        (model_dir / "model.rig2d.json").write_text(model.model_dump_json(indent=2), encoding="utf-8")

        manifest["stages"]["stage4_rig"] = {
            "status": "done",
            "boneCount": len(model.bones),
            "layerCount": len(model.layers),
            "physicsCount": len(model.physics),
        }
        manifest["stages"]["stage5_qa"] = qa_report
        self.save_manifest(job_id, manifest)

        if publish:
            pub_info = self.publish(job_id)
            manifest["publishedPath"] = pub_info["publicUrl"]
            self.save_manifest(job_id, manifest)

        return manifest

    def publish(self, job_id: str, target_model_id: str | None = None) -> dict[str, Any]:
        """Publish a job's rigged model directory atomically into AI_vtuber/public/avatars/<model_id>/."""
        jdir = self.job_dir(job_id)
        manifest = self.load_manifest(job_id)
        src_dir = jdir / "model"
        if not (src_dir / "model.rig2d.json").is_file():
            raise FileNotFoundError(f"Job {job_id} has not built model.rig2d.json yet")

        model_id = _slugify(target_model_id or manifest["modelId"])
        dest_dir = self.config.avatars_dir / model_id
        tmp_dir = self.config.avatars_dir / f".tmp-{model_id}-{uuid.uuid4().hex[:6]}"
        shutil.copytree(src_dir, tmp_dir)
        # Update model id inside published JSON if renamed
        model_json_path = tmp_dir / "model.rig2d.json"
        data = json.loads(model_json_path.read_text(encoding="utf-8"))
        data["id"] = model_id
        model_json_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

        if dest_dir.exists():
            shutil.rmtree(dest_dir)
        tmp_dir.rename(dest_dir)

        public_url = f"/avatars/{model_id}/model.rig2d.json"
        manifest["publishedPath"] = public_url
        self.save_manifest(job_id, manifest)
        return {
            "ok": True,
            "modelId": model_id,
            "destDir": str(dest_dir),
            "publicUrl": public_url,
        }
