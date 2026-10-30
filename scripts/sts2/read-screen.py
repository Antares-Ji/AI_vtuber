"""Offline Qwen3-VL OCR. Evidence is immutable; no OCR output is promoted to fact here."""
import argparse
import hashlib
import json
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('HF_HOME', str(ROOT / 'runtime/vlm/hf-cache'))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('images', nargs='+', type=Path)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--gpu-gib', type=int, default=5)
    args = p.parse_args()
    import torch
    from PIL import Image
    from transformers import AutoProcessor, Qwen3VLForConditionalGeneration
    model_path = ROOT / 'runtime/vlm/models/Qwen3-VL-4B-Instruct'
    started = time.time()
    processor = AutoProcessor.from_pretrained(model_path, local_files_only=True)
    processor.image_processor.size = {'shortest_edge': 65536, 'longest_edge': 1048576}
    model = Qwen3VLForConditionalGeneration.from_pretrained(
        model_path, local_files_only=True, dtype=torch.bfloat16, device_map='auto',
        max_memory={0: f'{args.gpu_gib}GiB', 'cpu': '32GiB'}, attn_implementation='sdpa')
    results = []
    for file in args.images:
        prompt = ('逐字读取这张杀戮尖塔2游戏截图。不要凭游戏知识补全。只返回JSON：'
                  '{"screen":"界面类型","visible_text":["逐行原文"],'
                  '"cards":[{"name":"原文","cost":"数字或null","description":"原文",'
                  '"uncertain":true}],"uncertain_text":["看不清的部分"]}。'
                  '看不清用null或标记uncertain。没有卡牌时cards为空数组。不得推测协同。')
        with Image.open(file) as im:
            messages = [{'role': 'user', 'content': [{'type': 'image', 'image': im.convert('RGB')}, {'type': 'text', 'text': prompt}]}]
            inputs = processor.apply_chat_template(messages, tokenize=True, add_generation_prompt=True,
                                                  return_dict=True, return_tensors='pt').to(model.device)
            with torch.inference_mode():
                tokens = model.generate(**inputs, max_new_tokens=1200, do_sample=False)
            raw = processor.batch_decode(tokens[:, inputs.input_ids.shape[1]:], skip_special_tokens=True)[0]
        try:
            parsed = json.loads(raw.removeprefix('```json').removeprefix('```').removesuffix('```').strip())
        except json.JSONDecodeError:
            parsed = None
        results.append({'image': str(file.resolve()), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
                        'model': str(model_path), 'raw': raw, 'parsed': parsed, 'status': 'unverified_ocr',
                        'captured_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps({'schema': 1, 'seconds': time.time()-started, 'observations': results}, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'image': file.name, 'parsed': parsed is not None, 'seconds': round(time.time()-started, 1)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
