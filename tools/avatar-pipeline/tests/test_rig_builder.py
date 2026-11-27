"""Tests for end-to-end synthetic rigging, overrides, PSD repack, QA, and OpenAI GPT Image provider."""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import httpx
import pytest
from PIL import Image, ImageDraw

from avatar_pipeline.config import PipelineConfig
from avatar_pipeline.pipeline import AvatarPipeline
from avatar_pipeline.providers.base import GenerationRequest
from avatar_pipeline.providers.openai_gpt_image import OpenAIGptImageProvider


def _make_config(tmp_path: Path, **kwargs) -> PipelineConfig:
    return PipelineConfig(
        canvas_width=512,
        canvas_height=768,
        cache_dir=tmp_path / "cache",
        avatars_dir=tmp_path / "avatars",
        **kwargs,
    )


def test_full_synthetic_pipeline_rerig_repack_and_publish(tmp_path: Path):
    # Create a crimson/gold mock outfit reference image to verify palette extraction
    outfit_img = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    ImageDraw.Draw(outfit_img).rectangle([40, 40, 216, 220], fill=(195, 58, 92, 255))
    outfit_path = tmp_path / "crimson_outfit.png"
    outfit_img.save(outfit_path)

    cfg = _make_config(tmp_path)
    pipe = AvatarPipeline(cfg)

    manifest = pipe.run(
        model_id="jisui-crimson-test",
        name="姬岁歌 · 绯潮测试",
        outfit_image_path=outfit_path,
        persona_mode="dual",
        provider_name="synthetic_demo",
        publish=True,
    )

    qa = manifest["stages"]["stage5_qa"]
    assert qa["passed"] is True, f"QA failed: {qa}"
    assert qa["stats"]["layerCount"] >= 30
    assert qa["stats"]["boneCount"] >= 20
    assert qa["stats"]["geVariantTextures"] >= 10
    assert manifest["publishedPath"] == "/avatars/jisui-crimson-test/model.rig2d.json"

    # Verify published files & exact model.rig2d.json contract
    pub_dir = cfg.avatars_dir / "jisui-crimson-test"
    model_json = json.loads((pub_dir / "model.rig2d.json").read_text(encoding="utf-8"))
    assert model_json["schemaVersion"] == "rig2d-v1"
    assert len(model_json["expressions"]) == 22
    assert len(model_json["motions"]) >= 7
    assert "sui" in model_json["variants"] and "ge" in model_json["variants"]
    assert (pub_dir / "layered.psd").is_file()
    assert (pub_dir / "preview.png").is_file()

    # Verify fast joint override re-rig moves the target bone cleanly
    job_id = manifest["jobId"]
    rerig_manifest = pipe.rerig(job_id, joint_overrides={"head": {"x": 260.0, "y": 175.0}}, publish=True)
    assert rerig_manifest["stages"]["stage5_qa"]["passed"] is True
    updated_model = json.loads((pub_dir / "model.rig2d.json").read_text(encoding="utf-8"))
    head_bone = next(b for b in updated_model["bones"] if b["id"] == "head")
    assert head_bone["x"] == 260.0 and head_bone["y"] == 175.0

    # Verify PSD round-trip repack works cleanly without re-calling image provider
    repacked = pipe.repack_from_psd(job_id, pub_dir / "layered.psd", publish=True)
    assert repacked["stages"]["stage5_qa"]["passed"] is True
    assert repacked["stages"]["psd_repack"]["layerCount"] >= 30


def test_openai_gpt_image_provider_requires_key(tmp_path: Path):
    cfg = _make_config(tmp_path, openai_image_api_key="")
    provider = OpenAIGptImageProvider(cfg)
    req = GenerationRequest(job_id="no-key", model_id="no-key", canvas_width=512, canvas_height=768)
    with pytest.raises(RuntimeError, match="OPENAI_IMAGE_API_KEY"):
        provider.generate_layers(req, tmp_path / "work")


def test_openai_gpt_image_provider_http_contract(tmp_path: Path):
    # Return a tiny valid white-background PNG (matching Sub2API url response contract)
    sample = Image.new("RGB", (64, 96), (255, 255, 255))
    d = ImageDraw.Draw(sample)
    d.ellipse([14, 10, 50, 86], fill=(120, 180, 230), outline=(30, 30, 40), width=2)
    # Enclosed white stocking patch inside outline — must NOT be eaten by border flood-fill!
    d.rectangle([24, 52, 40, 74], fill=(252, 252, 252))
    buf = io.BytesIO()
    sample.save(buf, format="PNG")
    png_bytes = buf.getvalue()

    seen_requests: list[tuple[str, str]] = []
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        seen_requests.append((request.method, str(request.url)))
        if request.method == "GET" and str(request.url).endswith("/dl.png"):
            return httpx.Response(200, content=png_bytes, headers={"content-type": "image/png"})
        call_count += 1
        # Verify retry on transient 429 on very first API call
        if call_count == 1:
            return httpx.Response(429, json={"error": {"type": "rate_limit", "message": "busy"}})
        assert request.headers["Authorization"] == "Bearer sk-test-mock"
        assert len(request.headers.get("Idempotency-Key", "")) >= 8
        body_text = request.content.decode("latin1", errors="ignore")
        assert 'name="image"' in body_text, "Sub2API edits must use repeated multipart field name 'image'"
        assert 'name="quality"' in body_text and "2K" in body_text
        assert 'name="background"' not in body_text, "Sub2API strict schema rejects background field"
        return httpx.Response(200, json={"data": [{"url": "https://relay.example.test/dl.png"}]})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    cfg = _make_config(
        tmp_path,
        openai_image_api_key="sk-test-mock",
        openai_image_base_url="https://ai-api.ai-member.icu/v1",
        openai_image_model="gpt-image-2.5",
        openai_image_quality="2K",
        openai_image_response_format="url",
    )
    provider = OpenAIGptImageProvider(cfg, http_client=client)
    outfit_path = tmp_path / "outfit.png"
    sample.save(outfit_path)

    req = GenerationRequest(
        job_id="mock-gpt25",
        model_id="mock-gpt25",
        outfit_image_path=outfit_path,
        persona_mode="dual",
        keep_input_as_base=True,
        canvas_width=256,
        canvas_height=384,
    )
    out = provider.generate_layers(req, tmp_path / "work")
    client.close()

    assert out.base_full_body.size == (256, 384)
    # Corners must be transparent (white background removed) while enclosed white interior stays opaque
    assert out.base_full_body.getpixel((2, 2))[3] == 0
    assert out.base_full_body.getpixel((128, 250))[3] > 200
    assert len(out.layers) >= 30
    assert len(out.ge_variant_layers) >= 8
    assert any(url.endswith("/v1/images/edits") for _, url in seen_requests)
    assert call_count == 7  # 1 transient 429 retry + 6 edit passes (Pass 1 kept input directly!)
