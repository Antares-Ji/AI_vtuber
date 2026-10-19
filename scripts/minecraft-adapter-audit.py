"""CPU-only read-only inspection of saved LoRA tensors and endpoint health."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen
import torch
from safetensors import safe_open

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("adapter", type=Path)
parser.add_argument("--health-url", default="http://127.0.0.1:11435/health")
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
weight_file = args.adapter / "adapter_model.safetensors"
config_file = args.adapter / "adapter_config.json"
config = json.loads(config_file.read_text(encoding="utf-8"))
rows = []
with safe_open(str(weight_file), framework="pt", device="cpu") as weights:
    for name in weights.keys():
        tensor = weights.get_tensor(name).float()
        rows.append({"name": name, "shape": list(tensor.shape), "parameters": tensor.numel(), "finite": bool(torch.isfinite(tensor).all()), "nonzero": int(torch.count_nonzero(tensor)), "absolute_max": float(tensor.abs().max())})
try:
    with urlopen(args.health_url, timeout=5) as response:
        health = json.loads(response.read().decode("utf-8"))
except Exception as error:
    health = {"error": str(error)}
b_rows = [row for row in rows if ".lora_B." in row["name"]]
report = {
    "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "adapter": str(args.adapter.resolve()), "weights_sha256": hashlib.sha256(weight_file.read_bytes()).hexdigest(),
    "weights_bytes": weight_file.stat().st_size, "peft_type": config.get("peft_type"), "rank": config.get("r"),
    "tensor_count": len(rows), "parameter_count": sum(row["parameters"] for row in rows),
    "all_finite": all(row["finite"] for row in rows), "lora_b_tensor_count": len(b_rows),
    "nonzero_lora_b_tensors": sum(row["nonzero"] > 0 for row in b_rows),
    "health": health, "tensors": rows,
    "limits": ["This CPU inspection does not execute inference or game actions.", "Nonzero finite LoRA B tensors are evidence of nontrivial saved adapter weights, not a capability score.", "Endpoint health reports loading only; actual per-request use requires completion metadata.used_adapter."]
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({key: value for key, value in report.items() if key != "tensors"}, ensure_ascii=False, indent=2))
