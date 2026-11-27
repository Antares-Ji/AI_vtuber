"""Abstract base class for pluggable image generation/decomposition providers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from PIL import Image


@dataclass
class GenerationRequest:
    job_id: str
    model_id: str
    name: str = "姬岁歌（草案）"
    outfit_image_path: Path | None = None
    character_ref_path: Path | None = None
    prompt_notes: str = ""
    persona_mode: str = "dual"  # "sui" | "ge" | "dual"
    keep_input_as_base: bool = False  # If True, preserve input standing character directly as Pass 1
    canvas_width: int = 1024
    canvas_height: int = 1536
    seed: int = 42


@dataclass
class ProviderOutput:
    base_full_body: Image.Image
    layers: dict[str, Image.Image]
    ge_variant_layers: dict[str, Image.Image] = field(default_factory=dict)
    metadata: dict[str, object] = field(default_factory=dict)


class ImageGenerationProvider(ABC):
    """Provider abstraction allowing OpenAI GPT Image, Gemini, or local ComfyUI backends."""

    name: str = "base"

    @abstractmethod
    def generate_layers(self, request: GenerationRequest, work_dir: Path) -> ProviderOutput:
        """Generate canonical A-pose full-body illustration + 28+ layered RGBA parts + optional ge variant."""

    def review_image_quality(self, image: Image.Image, checklist: str) -> dict[str, object]:
        """Optional VLM-based QA check. Subclasses may override."""
        return {"enabled": False, "passed": True, "notes": ["VLM QA not configured for this provider"]}
