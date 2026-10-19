"""Frozen holdout endpoint audit, yielding to live gameplay. Never loads a model."""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("frozen_evaluator", Path(__file__).with_name("evaluate.py"))
evaluator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluator)


def get(url):
    with urlopen(url, timeout=8) as response:
        return json.load(response)


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapter", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    cli = parser.parse_args()
    holdout = ROOT / "data/minecraft-training/holdout.jsonl"
    contract_file = ROOT / "data/minecraft-training/contract-v1.json"
    rubric = ROOT / "output/minecraft-training/independent-review/rubric-v1.json"
    records = [json.loads(line) for line in holdout.read_text(encoding="utf-8").splitlines() if line]
    schema = json.loads(contract_file.read_text(encoding="utf-8"))["schema"]
    expected_adapter = str(cli.adapter.resolve()).casefold()
    cli.output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {"started_at": stamp(), "adapter": str(cli.adapter.resolve()), "generation": {"temperature": 0, "max_tokens": 128, "task": "minecraft-survival"},
                "sources_sha256": {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [holdout, contract_file, rubric]},
                "requests": [], "limits": ["Sequential endpoint requests; no model loaded by this script.", "Admission checks are best-effort; gameplay can race between preflight and submission.", "Transport/503 errors are retries or audit interruption, never fabricated model failures."]}
    manifest_path = cli.output.with_suffix(".manifest.json")
    def save_manifest():
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with cli.output.open("x", encoding="utf-8") as output:
        for index, record in enumerate(records, 1):
            deadline = time.monotonic() + 300
            attempts = 0
            while True:
                if time.monotonic() > deadline:
                    save_manifest()
                    raise RuntimeError("Audit yielded for five minutes; stopped with partial evidence, no invented predictions")
                health = get("http://127.0.0.1:11435/health")
                state = get("http://127.0.0.1:3000/api/minecraft/loop")
                if health.get("generation_busy") or health.get("generation", {}).get("queued", 0) or state.get("running"):
                    time.sleep(1)
                    continue
                if str(Path(health.get("adapter", "")).resolve()).casefold() != expected_adapter:
                    raise RuntimeError("Endpoint adapter changed; audit stopped")
                request_started = stamp()
                try:
                    raw, latency, metadata = evaluator.predict_endpoint(record, "http://127.0.0.1:11435/v1", "qwen3.5-4b")
                except HTTPError as error:
                    attempts += 1
                    manifest["requests"].append({"id": record["id"], "started_at": request_started, "status": error.code, "retry": attempts})
                    save_manifest()
                    if error.code != 503 or attempts >= 3:
                        raise
                    time.sleep(1)
                    continue
                break
            if not metadata or metadata.get("used_adapter") is not True or metadata.get("task") != "minecraft-survival" or str(Path(metadata.get("adapter_path", "")).resolve()).casefold() != expected_adapter:
                raise RuntimeError(f"Wrong or missing per-response adapter metadata: {metadata}")
            try:
                predicted = json.loads(raw)
                parse_error = None
            except ValueError as error:
                predicted = None
                parse_error = type(error).__name__
            valid = evaluator.valid_action(predicted, schema)
            row = {"id": record["id"], "scenario": record["scenario"], "provenance": record["provenance"], "expected": record["action"], "raw": raw, "predicted": predicted,
                   "parse_error": parse_error, "schema_valid": valid, "exact_match": valid and predicted == record["action"], "latency_ms": latency, "request_metadata": metadata,
                   "request_started_at": request_started, "response_at": stamp(), "input_messages_sha256": hashlib.sha256(json.dumps(record["messages"][:-1], ensure_ascii=False, sort_keys=True).encode()).hexdigest()}
            output.write(json.dumps(row, ensure_ascii=False) + "\n")
            output.flush()
            manifest["requests"].append({"id": record["id"], "started_at": request_started, "finished_at": row["response_at"], "status": 200, "live_step_before": state.get("step"), "used_adapter": metadata["used_adapter"]})
            save_manifest()
            print(f"frozen endpoint audit {index}/{len(records)} recorded; yielding to gameplay", flush=True)
            time.sleep(1)
    manifest["finished_at"] = stamp()
    save_manifest()


if __name__ == "__main__":
    main()
