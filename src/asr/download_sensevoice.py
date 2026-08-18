from pathlib import Path

from huggingface_hub import snapshot_download


project_root = Path(__file__).resolve().parents[2]
target = project_root / "runtime" / "sensevoice-small"
target.mkdir(parents=True, exist_ok=True)

print(f"Downloading SenseVoiceSmall to {target}", flush=True)
snapshot_download(repo_id="FunAudioLLM/SenseVoiceSmall", local_dir=str(target))
print("SenseVoiceSmall download complete.", flush=True)
