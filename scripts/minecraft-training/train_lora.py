"""Train a LoRA adapter on a versioned Minecraft state-to-skill corpus."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODEL_PATH = Path(os.environ.get("QWEN_MODEL_PATH", r"E:\Qwen3.5-4B"))
DATA_PATH = ROOT / "data" / "minecraft-training" / "train.jsonl"
DEFAULT_OUT = ROOT / "runtime" / "minecraft-training" / "adapters" / "minecraft-survival-v1"


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-gpu-training", action="store_true", help="explicitly authorize allocating the GPU for training")
    parser.add_argument("--min-free-gib", type=float, default=6.0)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--data", type=Path, default=DATA_PATH, help="training JSONL; evaluation sets must never be passed here")
    parser.add_argument("--resume-adapter", type=Path, help="continue from an existing PEFT adapter; omit for fresh base initialization")
    parser.add_argument("--log-every-steps", type=int, default=4, help="flush loss and peak memory every N optimizer steps")
    parser.add_argument("--experiment", help="experiment label written to the training report")
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--max-length", type=int, default=1024)
    parser.add_argument("--rank", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20261013)
    parser.add_argument("--learning-rate", type=float, default=8e-5)
    parser.add_argument("--gradient-accumulation", type=int, default=4)
    return parser.parse_args()


def main():
    args = parse_args()
    if not args.allow_gpu_training:
        raise SystemExit("Refusing to start: pass --allow-gpu-training only after the inference service is stopped and GPU use is cleared.")
    if args.output.exists() and any(args.output.iterdir()):
        raise SystemExit(f"Refusing to overwrite existing adapter output: {args.output}")
    import torch
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is unavailable; no training was started.")
    free_bytes, total_bytes = torch.cuda.mem_get_info()
    free_gib = free_bytes / 1024**3
    print(f"GPU memory free={free_gib:.2f} GiB total={total_bytes / 1024**3:.2f} GiB")
    if free_gib < args.min_free_gib:
        raise SystemExit(f"Refusing to start: {free_gib:.2f} GiB free is below --min-free-gib {args.min_free_gib:.2f}.")

    from peft import LoraConfig, PeftModel, get_peft_model
    from transformers import AutoModelForMultimodalLM, AutoProcessor, BitsAndBytesConfig

    if not MODEL_PATH.exists():
        raise SystemExit(f"Model path not found: {MODEL_PATH}")
    data_path = args.data.resolve()
    if not data_path.is_file():
        raise SystemExit(f"Training data not found: {data_path}")
    records = [json.loads(line) for line in data_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(records) < 12:
        raise SystemExit(f"Too few training records: {len(records)}")
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)

    processor = AutoProcessor.from_pretrained(str(MODEL_PATH), trust_remote_code=True)
    tokenizer = processor.tokenizer
    if not tokenizer.chat_template:
        raise SystemExit("Base tokenizer has no chat template; refusing incompatible training format.")

    examples = []
    longest = 0
    for record in records:
        messages = record["messages"]
        # Match the inference template and mask system/user text from the loss.
        prompt_text = processor.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
        full_text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=False, enable_thinking=False)
        prompt_ids = tokenizer(prompt_text, add_special_tokens=False)["input_ids"]
        input_ids = tokenizer(full_text, add_special_tokens=False, truncation=True, max_length=args.max_length)["input_ids"]
        common = 0
        for a, b in zip(prompt_ids, input_ids):
            if a != b:
                break
            common += 1
        if common < len(prompt_ids):
            raise SystemExit(f"Chat template prefix mismatch for {record['id']}; refusing to mask the wrong tokens.")
        if common >= len(input_ids):
            raise SystemExit(f"No supervised output tokens remain for {record['id']}; increase --max-length.")
        labels = [-100] * common + input_ids[common:]
        examples.append((input_ids, labels, common))
        longest = max(longest, len(input_ids))
    print(f"Loaded {len(examples)} train records; max token length={longest}; max_length={args.max_length}")

    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    model = AutoModelForMultimodalLM.from_pretrained(
        str(MODEL_PATH), trust_remote_code=True, torch_dtype=torch.bfloat16,
        quantization_config=quantization, device_map="auto", low_cpu_mem_usage=True,
    )
    model.config.use_cache = False
    # Skip PEFT's generic k-bit helper: it upcasts all non-4bit weights to
    # fp32, including this model's large tied bf16 token embeddings/lm_head.
    # PEFT freezes the base when adapters are inserted below.
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    if hasattr(model, "enable_input_require_grads"):
        model.enable_input_require_grads()
    lora = LoraConfig(
        r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        bias="none", task_type="CAUSAL_LM",
    )
    resume_adapter = args.resume_adapter.resolve() if args.resume_adapter else None
    if resume_adapter:
        if not (resume_adapter / "adapter_config.json").is_file() or not (resume_adapter / "adapter_model.safetensors").is_file():
            raise SystemExit(f"Resume adapter is incomplete: {resume_adapter}")
        model = PeftModel.from_pretrained(model, str(resume_adapter), is_trainable=True)
    else:
        model = get_peft_model(model, lora)
    model.print_trainable_parameters()
    trainable = [p for p in model.parameters() if p.requires_grad]
    if not trainable:
        raise SystemExit("PEFT found no trainable parameters; no adapter will be saved.")
    optimizer = torch.optim.AdamW(trainable, lr=args.learning_rate)
    device = model.device
    model.train()
    args.output.mkdir(parents=True, exist_ok=True)
    history = []
    started = time.time()
    optimizer.zero_grad(set_to_none=True)
    step = 0
    step_losses = []
    for epoch in range(args.epochs):
        order = list(range(len(examples)))
        random.Random(args.seed + epoch).shuffle(order)
        losses = []
        for offset, index in enumerate(order):
            ids, labels, prompt_length = examples[index]
            input_ids = torch.tensor([ids], dtype=torch.long, device=device)
            attention = torch.ones_like(input_ids)
            # Qwen3.5 accepts arbitrary logits_to_keep positions. Compute the
            # LM head only where it predicts assistant tokens, avoiding a
            # full [sequence, 248k vocabulary] logits tensor per sample.
            positions = torch.arange(prompt_length - 1, len(ids) - 1, dtype=torch.long, device=device)
            targets = input_ids[:, prompt_length:]
            result = model(input_ids=input_ids, attention_mask=attention, logits_to_keep=positions, use_cache=False)
            logits = result.logits.float()
            if logits.shape[1] != targets.shape[1]:
                raise RuntimeError(f"Selective logits mismatch: {logits.shape[1]} vs {targets.shape[1]} targets")
            loss = torch.nn.functional.cross_entropy(logits.reshape(-1, logits.shape[-1]), targets.reshape(-1))
            if not torch.isfinite(loss):
                raise RuntimeError(f"Non-finite loss at epoch {epoch + 1}, sample {index}")
            (loss / args.gradient_accumulation).backward()
            losses.append(float(loss.detach().cpu()))
            step_losses.append(float(loss.detach().cpu()))
            last = offset + 1 == len(order)
            if (offset + 1) % args.gradient_accumulation == 0 or last:
                torch.nn.utils.clip_grad_norm_(trainable, 1.0)
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
                step += 1
                if step % max(1, args.log_every_steps) == 0 or last:
                    peak_now = torch.cuda.max_memory_allocated() / 1024**3
                    window_loss = sum(step_losses) / max(1, len(step_losses))
                    print(f"progress epoch={epoch + 1}/{args.epochs} optimizer_step={step} window_loss={window_loss:.4f} peak_allocated_gib={peak_now:.2f}", flush=True)
                step_losses.clear()
        epoch_loss = sum(losses) / max(1, len(losses))
        history.append({"epoch": epoch + 1, "mean_loss": epoch_loss, "optimizer_steps": step})
        checkpoint = args.output / f"checkpoint-epoch-{epoch + 1:02d}"
        model.save_pretrained(str(checkpoint), safe_serialization=True)
        print(f"epoch {epoch + 1}/{args.epochs}: mean_loss={epoch_loss:.4f} optimizer_steps={step} checkpoint={checkpoint}", flush=True)

    # Persist only PEFT weights/config. The base checkpoint remains untouched.
    model.save_pretrained(str(args.output), safe_serialization=True)
    processor.save_pretrained(str(args.output / "processor"))
    base_config = json.loads((MODEL_PATH / "config.json").read_text(encoding="utf-8"))
    peak_allocated = torch.cuda.max_memory_allocated() / 1024**3
    peak_reserved = torch.cuda.max_memory_reserved() / 1024**3
    report = {
        "experiment": args.experiment or f"minecraft-survival-policy-{data_path.stem}",
        "base_model_path": str(MODEL_PATH),
        "base_model_type": base_config.get("model_type"),
        "adapter_path": str(args.output),
        "training_data": str(data_path),
        "training_examples": len(records),
        "holdout_used_for_training": False,
        "training_provenance_counts": {key: sum(1 for r in records if r.get("provenance", "unknown") == key) for key in sorted({r.get("provenance", "unknown") for r in records})},
        "resume_adapter": str(resume_adapter) if resume_adapter else None,
        "initialization": "continued_from_adapter" if resume_adapter else "fresh_base_model",
        "seed": args.seed,
        "epochs": args.epochs,
        "max_length": args.max_length,
        "lora_rank": args.rank,
        "learning_rate": args.learning_rate,
        "train_jsonl_sha256": hashlib.sha256(data_path.read_bytes()).hexdigest(),
        "history": history,
        "peak_cuda_allocated_gib": round(peak_allocated, 2),
        "peak_cuda_reserved_gib": round(peak_reserved, 2),
        "elapsed_seconds": round(time.time() - started, 1),
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
        "adapter_files": [p.name for p in args.output.iterdir() if p.is_file()],
        "limitation": "Training loss is not a capability metric. Run the independent holdout evaluator and report limitations before claiming improvement.",
    }
    (args.output / "training-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
