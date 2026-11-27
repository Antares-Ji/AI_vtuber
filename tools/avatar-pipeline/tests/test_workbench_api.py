"""FastAPI TestClient integration tests for the Local Calibration Workbench."""

from __future__ import annotations

from pathlib import Path
from fastapi.testclient import TestClient

from avatar_pipeline.config import PipelineConfig
from avatar_pipeline.workbench.server import create_app


def test_workbench_full_lifecycle(tmp_path: Path):
    cfg = PipelineConfig(
        canvas_width=512,
        canvas_height=768,
        cache_dir=tmp_path / "cache",
        avatars_dir=tmp_path / "avatars",
    )
    app = create_app(cfg)
    client = TestClient(app)

    r_health = client.get("/api/health")
    assert r_health.status_code == 200
    assert r_health.json()["ok"] is True

    # 1. Create job via multipart form
    r_create = client.post(
        "/api/jobs",
        data={
            "name": "姬岁歌 · 校准台测试",
            "modelId": "wb-test",
            "provider": "synthetic_demo",
            "personaMode": "dual",
            "publish": "false",
        },
    )
    assert r_create.status_code == 200
    manifest = r_create.json()["manifest"]
    job_id = manifest["jobId"]
    assert manifest["stages"]["stage5_qa"]["passed"] is True

    # 2. Fetch model JSON & PSD from job asset route
    r_model = client.get(f"/api/jobs/{job_id}/model/model.rig2d.json")
    assert r_model.status_code == 200
    assert r_model.json()["schemaVersion"] == "rig2d-v1"

    r_psd = client.get(f"/api/jobs/{job_id}/model/layered.psd")
    assert r_psd.status_code == 200
    assert r_psd.content[:4] == b"8BPS"

    # 3. Save dragged bone joint overrides & fast re-rig
    r_ov = client.post(
        f"/api/jobs/{job_id}/overrides",
        json={"overrides": {"neck": {"x": 258, "y": 238}}, "publish": False},
    )
    assert r_ov.status_code == 200
    assert r_ov.json()["manifest"]["stages"]["stage5_qa"]["passed"] is True

    # 4. Upload edited PSD to repack-psd
    r_repack = client.post(
        f"/api/jobs/{job_id}/repack-psd",
        files={"psdFile": ("edited.psd", r_psd.content, "application/octet-stream")},
        data={"publish": "false"},
    )
    assert r_repack.status_code == 200
    assert r_repack.json()["manifest"]["stages"]["stage5_qa"]["passed"] is True

    # 5. Publish to AI_vtuber avatars dir
    r_pub = client.post(f"/api/jobs/{job_id}/publish", json={})
    assert r_pub.status_code == 200
    assert r_pub.json()["publicUrl"] == "/avatars/wb-test/model.rig2d.json"
    assert (cfg.avatars_dir / "wb-test" / "model.rig2d.json").is_file()
