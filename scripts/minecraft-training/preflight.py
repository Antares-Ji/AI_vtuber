"""CPU-only checks for dependency, chat-template, and token lengths."""
import json
import os
import subprocess
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODEL = os.environ.get("QWEN_MODEL_PATH", r"E:\Qwen3.5-4B")
CORPUS = ROOT / "data" / "minecraft-training" / "train.jsonl"
CONTRACT = ROOT / "scripts" / "minecraft-training" / "export_contract.js"
FROZEN_CONTRACT = ROOT / "data" / "minecraft-training" / "contract-v1.json"


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data",type=Path,default=CORPUS)
    parser.add_argument("--contract",type=Path,default=FROZEN_CONTRACT)
    args=parser.parse_args()
    import torch
    import transformers
    import bitsandbytes
    import accelerate
    import peft
    from transformers import AutoProcessor

    processor = AutoProcessor.from_pretrained(MODEL, trust_remote_code=True)
    tokenizer = processor.tokenizer
    contract = json.loads(args.contract.read_text(encoding="utf-8")) if args.contract.exists() else json.loads(subprocess.check_output(["node", str(CONTRACT)], cwd=ROOT, text=True, encoding="utf-8"))
    errors, lengths = [], []
    records = [json.loads(line) for line in args.data.read_text(encoding="utf-8").splitlines() if line.strip()]
    for record in records:
        prompt = processor.apply_chat_template(record["messages"][:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
        full = processor.apply_chat_template(record["messages"], tokenize=False, add_generation_prompt=False, enable_thinking=False)
        prompt_ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
        input_ids = tokenizer(full, add_special_tokens=False)["input_ids"]
        common = 0
        for x, y in zip(prompt_ids, input_ids):
            if x != y:
                break
            common += 1
        if common != len(prompt_ids):
            errors.append(f"{record['id']}: prompt/target token prefix mismatch ({common}/{len(prompt_ids)})")
        if len(input_ids) <= common:
            errors.append(f"{record['id']}: no answer tokens")
        lengths.append(len(input_ids))
    report = {
        "cpu_only": True,
        "model_path": MODEL,
        "data_path": str(args.data.resolve()),
        "contract_path": str(args.contract.resolve()),
        "examples": len(records),
        "max_input_tokens": max(lengths, default=0),
        "mean_input_tokens": round(sum(lengths) / len(lengths), 1) if lengths else None,
        "action_variants": len(contract["schema"]["oneOf"]),
        "versions": {"torch": torch.__version__, "transformers": transformers.__version__, "bitsandbytes": bitsandbytes.__version__, "accelerate": accelerate.__version__, "peft": peft.__version__},
        "errors": errors,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
