"""CLI entrypoint for the Rig2D Avatar Pipeline & Local Calibration Workbench.

Examples:
  # 1. Zero-cost offline demo generation + publish directly into AI_vtuber
  python run_pipeline.py demo --publish

  # 2. Generate from a real outfit image using OpenAI GPT Image API (key in .env.local)
  python run_pipeline.py generate --name "姬岁歌·海风礼服" --outfit path/to/outfit.png --publish

  # 3. Re-rig from Photoshop-edited layered.psd without re-calling image APIs
  python run_pipeline.py repack-psd --job-id <id> --psd path/to/edited.psd --publish

  # 4. Launch local Web Preview & Joint Calibration Workbench (http://127.0.0.1:8770)
  python run_pipeline.py workbench
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from avatar_pipeline.config import PipelineConfig
from avatar_pipeline.pipeline import AvatarPipeline


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Outfit Design -> Layered PSD -> Auto-Rigged Rig2D Pipeline")
    sub = parser.add_subparsers(dest="command", required=True)

    p_demo = sub.add_parser("demo", help="Run zero-cost offline 37-layer synthetic Ji Suige (draft) pipeline")
    p_demo.add_argument("--model-id", default="jisui-tidal-draft")
    p_demo.add_argument("--name", default="姬岁歌 · 潮汐常服（草案）")
    p_demo.add_argument("--outfit", type=Path, default=None, help="Optional outfit image to extract palette from")
    p_demo.add_argument("--publish", action="store_true", help="Publish directly to public/avatars/<model-id>/")

    p_gen = sub.add_parser("generate", help="Run full generation -> layered PSD -> auto-rig pipeline")
    p_gen.add_argument("--model-id", default=None)
    p_gen.add_argument("--name", required=True)
    p_gen.add_argument("--outfit", type=Path, default=None, help="Outfit design / reference / sketch image path")
    p_gen.add_argument("--character-ref", type=Path, default=None, help="Optional character face/hair reference image")
    p_gen.add_argument("--notes", default="", help="Optional text styling notes")
    p_gen.add_argument("--persona-mode", choices=("dual", "sui", "ge"), default="dual")
    p_gen.add_argument("--provider", choices=("openai_gpt_image", "synthetic_demo"), default=None)
    p_gen.add_argument("--keep-base", action="store_true", help="Preserve clean full-body standing input image directly as Pass 1 base art")
    p_gen.add_argument("--job-id", default=None, help="Reuse an existing job cache directory (skips already cached API passes)")
    p_gen.add_argument("--publish", action="store_true")

    p_rerig = sub.add_parser("rerig", help="Re-run auto-rigging on cached layers + rig_overrides.json")
    p_rerig.add_argument("--job-id", required=True)
    p_rerig.add_argument("--publish", action="store_true")

    p_psd = sub.add_parser("repack-psd", help="Re-import an edited Photoshop PSD and re-rig in seconds")
    p_psd.add_argument("--job-id", required=True)
    p_psd.add_argument("--psd", type=Path, required=True)
    p_psd.add_argument("--publish", action="store_true")

    p_pub = sub.add_parser("publish", help="Publish a completed job to AI_vtuber/public/avatars/")
    p_pub.add_argument("--job-id", required=True)
    p_pub.add_argument("--model-id", default=None)

    p_wb = sub.add_parser("workbench", help="Start local Web Preview & Joint Calibration Workbench")
    p_wb.add_argument("--host", default=None)
    p_wb.add_argument("--port", type=int, default=None)

    args = parser.parse_args(argv)
    config = PipelineConfig.from_env()
    pipeline = AvatarPipeline(config)

    if args.command == "demo":
        manifest = pipeline.run(
            model_id=args.model_id,
            name=args.name,
            outfit_image_path=args.outfit,
            persona_mode="dual",
            provider_name="synthetic_demo",
            publish=args.publish,
        )
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return 0 if manifest["stages"]["stage5_qa"]["passed"] else 1

    if args.command == "generate":
        manifest = pipeline.run(
            model_id=args.model_id,
            name=args.name,
            outfit_image_path=args.outfit,
            character_ref_path=args.character_ref,
            prompt_notes=args.notes,
            persona_mode=args.persona_mode,
            provider_name=args.provider,
            keep_input_as_base=args.keep_base,
            publish=args.publish,
            job_id=args.job_id,
        )
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return 0 if manifest["stages"]["stage5_qa"]["passed"] else 1

    if args.command == "rerig":
        manifest = pipeline.rerig(args.job_id, publish=args.publish)
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return 0

    if args.command == "repack-psd":
        manifest = pipeline.repack_from_psd(args.job_id, args.psd, publish=args.publish)
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return 0

    if args.command == "publish":
        res = pipeline.publish(args.job_id, target_model_id=args.model_id)
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0

    if args.command == "workbench":
        import uvicorn
        from avatar_pipeline.workbench.server import create_app

        host = args.host or config.workbench_host
        port = args.port or config.workbench_port
        print(f"Rig2D Calibration Workbench running at http://{host}:{port}")
        uvicorn.run(create_app(config), host=host, port=port, log_level="info")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
