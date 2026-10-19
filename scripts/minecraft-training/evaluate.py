"""Evaluate strict atomic-skill predictions on the independent holdout."""
from __future__ import annotations

import argparse
import json
import os
import time
import subprocess
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
MODEL_PATH = Path(os.environ.get("QWEN_MODEL_PATH", r"E:\Qwen3.5-4B"))
HOLDOUT = ROOT / "data" / "minecraft-training" / "holdout.jsonl"
CONTRACT_JS = ROOT / "scripts" / "minecraft-training" / "export_contract.js"
CONTRACT_V1 = ROOT / "data" / "minecraft-training" / "contract-v1.json"


def args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--mode", choices=("endpoint", "direct"), required=True)
    p.add_argument("--base-url", default=os.environ.get("LOCAL_LLM_BASE_URL", "http://127.0.0.1:11435/v1"))
    p.add_argument("--model", default=os.environ.get("LOCAL_LLM_MODEL", "qwen3.5-4b"))
    p.add_argument("--adapter", type=Path)
    p.add_argument("--allow-gpu-inference", action="store_true")
    p.add_argument("--min-free-gib", type=float, default=11.0)
    p.add_argument("--output", type=Path, required=True, help="raw predictions JSONL path")
    p.add_argument("--data", type=Path, default=HOLDOUT, help="evaluation JSONL; defaults to the frozen v1 final holdout")
    p.add_argument("--contract", type=Path, default=CONTRACT_V1, help="action schema contract for this evaluation set")
    return p.parse_args()


def load_contract(contract_path):
    if contract_path.exists():
        return json.loads(contract_path.read_text(encoding="utf-8"))
    return json.loads(subprocess.check_output(["node", str(CONTRACT_JS)], cwd=ROOT, text=True, encoding="utf-8"))


def valid_action(action, schema):
    if not isinstance(action, dict):
        return False
    branch = next((b for b in schema["oneOf"] if b["properties"]["action"].get("const") == action.get("action")), None)
    if branch is None or set(action) != set(branch["properties"]):
        return False
    for name, rule in branch["properties"].items():
        if "enum" in rule and action[name] not in rule["enum"]:
            return False
        if rule.get("type") == "integer" and (type(action[name]) is not int or not rule["minimum"] <= action[name] <= rule["maximum"]):
            return False
    return True


def endpoint_health(base_url, expected_adapter):
    from urllib.parse import urlsplit, urlunsplit
    parts = urlsplit(base_url.rstrip("/"))
    path = parts.path.removesuffix("/v1").rstrip("/") + "/health"
    health_url = urlunsplit((parts.scheme, parts.netloc, path, "", ""))
    with urlopen(health_url, timeout=5) as response:
        status = json.loads(response.read().decode("utf-8"))
    if not status.get("ok"):
        raise SystemExit(f"Endpoint health is not ready: {status}")
    actual = status.get("adapter")
    if status.get("adapter_loaded", bool(actual)) != bool(actual):
        raise SystemExit(f"Endpoint health adapter fields disagree: {status}")
    if bool(actual) != bool(expected_adapter):
        raise SystemExit(f"Endpoint adapter mismatch: expected {expected_adapter or 'base only'}, got {actual or 'base only'}")
    if expected_adapter:
        try:
            same_path = Path(actual).resolve() == Path(expected_adapter).resolve()
        except OSError:
            same_path = str(actual).casefold() == str(expected_adapter).casefold()
        if not same_path:
            raise SystemExit(f"Endpoint adapter path mismatch: expected {expected_adapter}, got {actual}")
    return health_url, status


def predict_endpoint(record, base_url, model_name):
    started = time.perf_counter()
    body = json.dumps({"model": model_name, "task": "minecraft-survival", "messages": record["messages"][:-1], "temperature": 0, "max_tokens": 128}, ensure_ascii=False).encode("utf-8")
    request = Request(base_url.rstrip("/") + "/chat/completions", data=body, headers={"content-type": "application/json"}, method="POST")
    with urlopen(request, timeout=90) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return str(payload["choices"][0]["message"].get("content", "")), round((time.perf_counter() - started) * 1000, 1), payload.get("metadata")


def run_direct(records, cli):
    import torch
    if not cli.allow_gpu_inference:
        raise SystemExit("Refusing direct GPU inference; pass --allow-gpu-inference after arranging GPU availability.")
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is unavailable.")
    free_bytes, total_bytes = torch.cuda.mem_get_info()
    free_gib = free_bytes / 1024**3
    print(f"GPU memory free={free_gib:.2f} GiB total={total_bytes / 1024**3:.2f} GiB")
    if free_gib < cli.min_free_gib:
        raise SystemExit(f"Refusing direct inference: free VRAM {free_gib:.2f} GiB is below {cli.min_free_gib:.2f} GiB.")
    from transformers import AutoModelForMultimodalLM, AutoProcessor, BitsAndBytesConfig
    processor = AutoProcessor.from_pretrained(str(MODEL_PATH), trust_remote_code=True)
    model = AutoModelForMultimodalLM.from_pretrained(
        str(MODEL_PATH), trust_remote_code=True, torch_dtype=torch.bfloat16,
        quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True),
        device_map="auto", low_cpu_mem_usage=True,
    )
    if cli.adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, str(cli.adapter), is_trainable=False)
    model.eval()
    predictions, latencies = [], []
    for i, record in enumerate(records, 1):
        prompt = processor.apply_chat_template(record["messages"][:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
        inputs = processor(text=prompt, return_tensors="pt").to(model.device)
        started = time.perf_counter()
        with torch.inference_mode():
            output = model.generate(**inputs, max_new_tokens=128, do_sample=False)
        new_tokens = output[0, inputs["input_ids"].shape[1]:]
        predictions.append(processor.decode(new_tokens, skip_special_tokens=True).strip())
        latencies.append(round((time.perf_counter() - started) * 1000, 1))
        print(f"evaluated {i}/{len(records)}")
    return predictions, latencies


def main():
    cli = args()
    data_path = cli.data.resolve()
    records = [json.loads(line) for line in data_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    contract = load_contract(cli.contract.resolve())
    if cli.mode == "endpoint":
        health_url, health = endpoint_health(cli.base_url, cli.adapter)
        predicted = [predict_endpoint(row, cli.base_url, cli.model) for row in records]
        raw = [item[0] for item in predicted]
        latencies = [item[1] for item in predicted]
        request_metadata = [item[2] for item in predicted]
        active_adapter = health.get("adapter")
        actual_model = health.get("model")
    else:
        raw, latencies = run_direct(records, cli)
        request_metadata = [{"task": "minecraft-survival", "used_adapter": bool(cli.adapter), "adapter_path": str(cli.adapter) if cli.adapter else None} for _ in records]
        active_adapter = str(cli.adapter) if cli.adapter else None
        actual_model = str(MODEL_PATH)
        health_url = None
    results = []
    for row, response in zip(records, raw):
        metadata = request_metadata[len(results)]
        if cli.adapter and (not metadata or metadata.get("task") != "minecraft-survival" or metadata.get("used_adapter") is not True):
            raise SystemExit(f"Adapter request metadata missing or incorrect for {row['id']}: {metadata}")
        if cli.adapter and str(Path(metadata.get("adapter_path", "")).resolve()).casefold() != str(cli.adapter.resolve()).casefold():
            raise SystemExit(f"Adapter request path mismatch for {row['id']}: {metadata}")
        parsed = None
        parse_error = None
        try:
            parsed = json.loads(response)
        except Exception as error:
            parse_error = type(error).__name__
        valid = valid_action(parsed, contract["schema"])
        expected = row["action"]
        action_name_match = isinstance(parsed, dict) and parsed.get("action") == expected.get("action")
        threat_case = bool(row["state"].get("threats"))
        progression_case = expected["action"] not in ("flee", "eat", "observe")
        results.append({
            "id": row["id"], "scenario": row["scenario"], "provenance": row["provenance"],
            "expected": expected, "raw": response, "predicted": parsed,
            "parse_error": parse_error, "schema_valid": valid, "exact_match": valid and parsed == expected,
            "action_name_match": action_name_match,
            "latency_ms": latencies[len(results)],
            "request_metadata": metadata,
            "threat_priority_case": threat_case,
            "threat_priority_pass": (parsed or {}).get("action") == "flee" if threat_case else None,
            "progression_case": progression_case,
            "progression_match": bool(valid and parsed == expected) if progression_case else None,
        })
    cli.output.parent.mkdir(parents=True, exist_ok=True)
    cli.output.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in results), encoding="utf-8")
    total = len(results)
    matches = sum(r["exact_match"] for r in results)
    valid = sum(r["schema_valid"] for r in results)
    threat = [r for r in results if r["threat_priority_case"]]
    progress = [r for r in results if r["progression_case"]]
    report = {
        "mode": cli.mode, "base_model": actual_model, "adapter": active_adapter,
        "health_url": health_url,
        "evaluation_data": str(data_path), "evaluation_contract": str(cli.contract.resolve()),
        "holdout_file": str(data_path) if data_path == HOLDOUT.resolve() else None,
        "raw_predictions": str(cli.output), "n": total,
        "exact_action_object_accuracy": matches / total if total else None,
        "action_name_accuracy": sum(r["action_name_match"] for r in results) / total if total else None,
        "strict_json_schema_valid_rate": valid / total if total else None,
        "threat_priority_accuracy": sum(r["threat_priority_pass"] for r in threat) / len(threat) if threat else None,
        "progression_exact_accuracy": sum(r["progression_match"] for r in progress) / len(progress) if progress else None,
        "threat_cases": len(threat), "progression_cases": len(progress),
        "final_holdout": data_path == HOLDOUT.resolve(),
        "limitation": "Scores measure agreement with authored next-skill labels, not gameplay success or broad generalization. Use the development set for checkpoint selection and the final holdout only for final audit.",
    }
    report_path = cli.output.with_suffix(".report.json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
