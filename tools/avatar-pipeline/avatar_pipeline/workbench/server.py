"""FastAPI server for the Rig2D local preview, joint drag-calibration, PSD repack & publish workbench."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ..config import PIPELINE_ROOT, REPO_ROOT, PipelineConfig
from ..pipeline import AvatarPipeline


STATIC_DIR = Path(__file__).resolve().parent / "static"


class JointOverridesPayload(BaseModel):
    overrides: dict[str, dict[str, float]]
    publish: bool = False


class PublishPayload(BaseModel):
    modelId: str | None = None


def create_app(config: PipelineConfig | None = None) -> FastAPI:
    cfg = config or PipelineConfig.from_env()
    pipeline = AvatarPipeline(cfg)

    app = FastAPI(title="Rig2D Avatar Calibration Workbench", version="0.1.0")
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/", response_class=HTMLResponse)
    def index():
        return (STATIC_DIR / "index.html").read_text(encoding="utf-8")

    # Serve PixiJS 8 & shared Rig2D engine directly from AI_vtuber repo so preview == live stage 100%!
    @app.get("/vendor/pixi8.min.js")
    def serve_pixi():
        pixi_path = REPO_ROOT / "node_modules" / "pixi.js" / "dist" / "pixi.min.js"
        if not pixi_path.is_file():
            raise HTTPException(status_code=404, detail="pixi.min.js not installed in repo node_modules")
        return FileResponse(str(pixi_path), media_type="application/javascript")

    @app.get("/vendor/rig2d-engine.js")
    def serve_engine():
        engine_path = REPO_ROOT / "public" / "rig2d-engine.js"
        if not engine_path.is_file():
            raise HTTPException(status_code=404, detail="public/rig2d-engine.js not found")
        return FileResponse(str(engine_path), media_type="application/javascript")

    @app.get("/api/health")
    def health():
        return {
            "ok": True,
            "providerDefault": cfg.provider,
            "openaiKeyConfigured": bool(cfg.openai_image_api_key),
            "openaiBaseUrl": cfg.openai_image_base_url,
            "cacheDir": str(cfg.cache_dir),
            "avatarsDir": str(cfg.avatars_dir),
        }

    @app.get("/api/jobs")
    def list_jobs():
        return {"jobs": pipeline.list_jobs()}

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        try:
            manifest = pipeline.load_manifest(job_id)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")
        jdir = pipeline.job_dir(job_id)
        overrides_path = jdir / "rig_overrides.json"
        overrides = json.loads(overrides_path.read_text(encoding="utf-8")) if overrides_path.is_file() else {}
        return {"manifest": manifest, "overrides": overrides}

    @app.post("/api/jobs")
    async def create_job(
        name: str = Form("姬岁歌 · 新服设（草案）"),
        modelId: str = Form(""),
        promptNotes: str = Form(""),
        personaMode: str = Form("dual"),
        provider: str = Form("synthetic_demo"),
        keepBase: bool = Form(False),
        publish: bool = Form(False),
        outfitImage: UploadFile | None = File(None),
        characterRef: UploadFile | None = File(None),
    ):
        tmp_dir = cfg.cache_dir / "_uploads"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        outfit_path: Path | None = None
        char_path: Path | None = None

        try:
            if outfitImage and outfitImage.filename:
                suffix = Path(outfitImage.filename).suffix or ".png"
                outfit_path = tmp_dir / f"outfit_{id(outfitImage)}{suffix}"
                outfit_path.write_bytes(await outfitImage.read())
            if characterRef and characterRef.filename:
                suffix = Path(characterRef.filename).suffix or ".png"
                char_path = tmp_dir / f"char_{id(characterRef)}{suffix}"
                char_path.write_bytes(await characterRef.read())

            manifest = pipeline.run(
                model_id=modelId or None,
                name=name,
                outfit_image_path=outfit_path,
                character_ref_path=char_path,
                prompt_notes=promptNotes,
                persona_mode=personaMode,
                provider_name=provider,
                keep_input_as_base=keepBase,
                publish=publish,
            )
            return JSONResponse(status_code=200, content={"ok": True, "manifest": manifest})
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(exc))
        finally:
            for p in (outfit_path, char_path):
                if p and p.is_file():
                    p.unlink(missing_ok=True)

    @app.post("/api/jobs/{job_id}/overrides")
    def save_overrides_and_rerig(job_id: str, payload: JointOverridesPayload):
        try:
            manifest = pipeline.rerig(job_id, joint_overrides=payload.overrides, publish=payload.publish)
            return {"ok": True, "manifest": manifest}
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/api/jobs/{job_id}/repack-psd")
    async def upload_psd_and_repack(
        job_id: str,
        psdFile: UploadFile = File(...),
        publish: bool = Form(False),
    ):
        jdir = pipeline.job_dir(job_id)
        if not jdir.is_dir():
            raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")
        uploaded_path = jdir / "edited_upload.psd"
        uploaded_path.write_bytes(await psdFile.read())
        try:
            manifest = pipeline.repack_from_psd(job_id, uploaded_path, publish=publish)
            return {"ok": True, "manifest": manifest}
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/api/jobs/{job_id}/publish")
    def publish_job(job_id: str, payload: PublishPayload | None = None):
        try:
            res = pipeline.publish(job_id, target_model_id=payload.modelId if payload else None)
            return res
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(exc))

    @app.get("/api/jobs/{job_id}/model/{rel_path:path}")
    def serve_job_model_asset(job_id: str, rel_path: str):
        model_root = (pipeline.job_dir(job_id) / "model").resolve()
        candidate = (model_root / rel_path).resolve()
        if not str(candidate).startswith(str(model_root)) or not candidate.is_file():
            raise HTTPException(status_code=404, detail="Model asset not found")
        return FileResponse(str(candidate))

    return app
