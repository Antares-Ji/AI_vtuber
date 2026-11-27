"""Configuration & environment loader for the Rig2D avatar pipeline."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


PIPELINE_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = PIPELINE_ROOT.parent.parent
PUBLIC_AVATARS_DIR = REPO_ROOT / "public" / "avatars"
DEFAULT_CACHE_DIR = PIPELINE_ROOT / "cache"
CHARACTER_BASE_DIR = PIPELINE_ROOT / "character_base"


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def load_repo_env() -> dict[str, str]:
    """Load .env and .env.local from repo root without overwriting explicit process env."""
    merged: dict[str, str] = {}
    for filename in (".env", ".env.local"):
        merged.update(_parse_env_file(REPO_ROOT / filename))
    for key, val in merged.items():
        if key not in os.environ and val != "":
            os.environ[key] = val
    return merged


@dataclass
class PipelineConfig:
    provider: str = "openai_gpt_image"
    openai_image_api_key: str = ""
    openai_image_base_url: str = "https://api.openai.com/v1"
    openai_image_model: str = "gpt-image-2.5"
    openai_image_quality: str = "2K"
    openai_image_response_format: str = "url"
    openai_vision_model: str = "gpt-4o-mini"
    canvas_width: int = 1024
    canvas_height: int = 1536
    cache_dir: Path = field(default_factory=lambda: DEFAULT_CACHE_DIR)
    avatars_dir: Path = field(default_factory=lambda: PUBLIC_AVATARS_DIR)
    workbench_host: str = "127.0.0.1"
    workbench_port: int = 8770
    request_timeout_s: float = 360.0
    max_retries: int = 2
    enable_vlm_qa: bool = False

    def is_sub2api_style(self) -> bool:
        """Detect Sub2API / AI Member Images v1 contract (strict schema, quality=1K/2K/4K, image field)."""
        url_lower = self.openai_image_base_url.lower()
        model_lower = self.openai_image_model.lower()
        return (
            "ai-member" in url_lower
            or "sub2api" in url_lower
            or model_lower.startswith("gpt-image-2")
            or self.openai_image_quality.upper() in ("1K", "2K", "4K")
        )

    @classmethod
    def from_env(cls) -> "PipelineConfig":
        load_repo_env()
        api_key = (
            os.environ.get("OPENAI_IMAGE_API_KEY")
            or os.environ.get("AI_MEMBER_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or ""
        ).strip()
        base_url = (
            os.environ.get("OPENAI_IMAGE_BASE_URL")
            or "https://api.openai.com/v1"
        ).strip().rstrip("/")
        provider = os.environ.get("AVATAR_PIPELINE_PROVIDER", "openai_gpt_image").strip()
        return cls(
            provider=provider,
            openai_image_api_key=api_key,
            openai_image_base_url=base_url,
            openai_image_model=os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-2.5").strip(),
            openai_image_quality=os.environ.get("OPENAI_IMAGE_QUALITY", "2K").strip(),
            openai_image_response_format=os.environ.get("OPENAI_IMAGE_RESPONSE_FORMAT", "url").strip(),
            openai_vision_model=os.environ.get("OPENAI_VISION_MODEL", "gpt-4o-mini").strip(),
            workbench_host=os.environ.get("AVATAR_WORKBENCH_HOST", "127.0.0.1").strip(),
            workbench_port=int(os.environ.get("AVATAR_WORKBENCH_PORT", "8770")),
            enable_vlm_qa=os.environ.get("AVATAR_ENABLE_VLM_QA", "false").lower() == "true",
        )
