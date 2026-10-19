"""CPU-only token audit for v5r2 candidate data; uses the base inference chat template."""
import json
import os
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODEL = os.environ.get("QWEN_MODEL_PATH", r"E:\Qwen3.5-4B")
OUT = ROOT / "output" / "minecraft-training" / "v5r2-candidate-token-audit.json"


def summarize(path, processor):
    records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    tokenizer = processor.tokenizer
    prompts, fulls, labels, ids = [], [], [], []
    history_outcomes = {"alreadyFull_noop": 0, "food_recovery": 0}
    for row in records:
        prompt = processor.apply_chat_template(row["messages"][:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
        full = processor.apply_chat_template(row["messages"], tokenize=False, add_generation_prompt=False, enable_thinking=False)
        pids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
        fids = tokenizer(full, add_special_tokens=False)["input_ids"]
        if fids[:len(pids)] != pids:
            raise ValueError(f"prompt/label token prefix mismatch: {row['id']}")
        prompts.append(len(pids)); fulls.append(len(fids)); labels.append(len(fids)-len(pids)); ids.append(row["id"])
        results = json.loads(row["messages"][1]["content"]).get("recentResults", [])
        if any(e.get("result", {}).get("alreadyFull") is True for e in results):
            history_outcomes["alreadyFull_noop"] += 1
        if any(e.get("action", {}).get("action") == "eat" and e.get("status") == "completed" and "foodAfter" in e.get("result", {}) and e.get("result", {}).get("alreadyFull") is not True for e in results):
            history_outcomes["food_recovery"] += 1
    ordered = sorted(prompts)
    p90 = ordered[min(len(ordered)-1, int((len(ordered)-1)*0.9))]
    full_ordered = sorted(fulls)
    return {
        "rows": len(records),
        "promptTokens": {"min": min(prompts), "median": statistics.median(prompts), "p90": p90, "max": max(prompts), "mean": round(statistics.mean(prompts), 1)},
        "fullSequenceTokens": {"min": min(fulls), "median": statistics.median(fulls), "p90": full_ordered[min(len(full_ordered)-1, int((len(full_ordered)-1)*0.9))], "max": max(fulls), "mean": round(statistics.mean(fulls), 1)},
        "assistantLabelTokens": {"min": min(labels), "max": max(labels), "mean": round(statistics.mean(labels), 1)},
        "completeAt2304": sum(n <= 2304 for n in fulls),
        "completeAt2560": sum(n <= 2560 for n in fulls),
        "prompts1800To2600": sum(1800 <= n <= 2600 for n in prompts),
        "sixRecentResults": sum(len(json.loads(row["messages"][1]["content"]).get("recentResults", [])) == 6 for row in records),
        "historyOutcomeOccurrences": history_outcomes,
        "longestIds": [ids[i] for i in sorted(range(len(fulls)), key=lambda i: fulls[i], reverse=True)[:3]],
    }


def main():
    from transformers import AutoProcessor
    processor = AutoProcessor.from_pretrained(MODEL, trust_remote_code=True)
    report = {}
    for name in ["train-v5r2-candidates.jsonl", "development-v5r2-candidates.jsonl", "train-v5r2-replay-candidates.jsonl"]:
        report[name] = summarize(ROOT / "data" / "minecraft-training" / name, processor)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
