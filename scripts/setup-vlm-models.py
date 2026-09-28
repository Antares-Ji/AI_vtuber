"""Download official full Qwen weights and YOLO weights, with pinned revisions."""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'runtime' / 'vlm'
os.environ.setdefault('HF_HOME', str(BASE / 'hf-cache'))
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '120')

def download(repo, folder, patterns):
    from huggingface_hub import HfApi, snapshot_download
    info = HfApi().model_info(repo)
    target = BASE / 'models' / folder
    print(f'Downloading {repo}@{info.sha}', flush=True)
    snapshot_download(repo, revision=info.sha, local_dir=target,
                      allow_patterns=patterns, max_workers=4)
    manifest = {'repo': repo, 'revision': info.sha, 'path': str(target)}
    target.mkdir(parents=True, exist_ok=True)
    (target / 'download-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(json.dumps(manifest), flush=True)

if __name__ == '__main__':
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [pool.submit(download, 'Qwen/Qwen3-VL-4B-Instruct', 'Qwen3-VL-4B-Instruct',
                            ['*.json', '*.safetensors', '*.txt', '*.jinja', '*.model']),
                pool.submit(download, 'Ultralytics/YOLO11', 'YOLO11', ['yolo11n.pt'])]
        for job in jobs:
            job.result()
