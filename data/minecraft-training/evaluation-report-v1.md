# Minecraft survival LoRA v1 evaluation

## Run

- Base model: `E:\Qwen3.5-4B`, served as `qwen3.5-4b` with NF4 quantization.
- Training set: 39 synthetic examples; independent holdout: 20 separately authored synthetic examples. The holdout was not used for training or tuning.
- Training: QLoRA, rank 8, 4 epochs, learning rate `8e-5`; 306.1 seconds; peak CUDA allocated memory 4.09 GiB.
- Adapter: `runtime/minecraft-training/adapters/minecraft-survival-v1/adapter_model.safetensors` (42,504,600 bytes). The base model was not modified.
- Adapter was loaded by the endpoint and each evaluated response reported `metadata.used_adapter=true` with the expected adapter path.

## Holdout results

| Metric | Base | LoRA | Change |
|---|---:|---:|---:|
| Exact action-object match | 3/20 (15%) | 9/20 (45%) | +30 percentage points |
| Strict JSON/schema valid | 17/20 (85%) | 20/20 (100%) | +15 percentage points |
| Threat-priority match | 2/2 (100%) | 2/2 (100%) | unchanged |
| Progression exact match | 1/15 (6.7%) | 6/15 (40%) | +33.3 percentage points |

These are exact matches against authored action labels. They do not measure successful Mineflayer execution, survival duration, or generalization to unseen game worlds. The sample is small, entirely synthetic, and the adapter still makes consequential planning errors; in particular, it can miss urgent retreat and portal-material prerequisites. Treat this as a promising feasibility result, not evidence of robust gameplay improvement. The next validation should use newly collected real-world states and report execution outcomes separately from label agreement.

## Reproduction and artifacts

Training command:

```powershell
runtime/minecraft-training/.venv/Scripts/python.exe scripts/minecraft-training/train_lora.py --allow-gpu-training --min-free-gib 6.0
```

The original base endpoint predictions, adapter endpoint predictions, individual metric reports, and their comparison are in `output/minecraft-training/` (`baseline.jsonl`, `adapter-v1.jsonl`, `baseline.report.json`, `adapter-v1.report.json`, `comparison-v1.json`). The frozen v1 schema/prompt contract is `contract-v1.json`; v2 schema changes and recovery cases are kept separate.
