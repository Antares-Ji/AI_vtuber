"""Local full-weight VLM inference and small, explicitly non-evaluative training pilots."""
import argparse
import json
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'runtime' / 'vlm'
os.environ.setdefault('HF_HOME', str(BASE / 'hf-cache'))
os.environ.setdefault('YOLO_CONFIG_DIR', str(BASE / 'yolo-config'))
os.environ.setdefault('MPLCONFIGDIR', str(BASE / 'matplotlib'))
os.environ.setdefault('HF_HUB_OFFLINE', '1')
for directory in ['yolo-config', 'matplotlib']:
    (BASE / directory).mkdir(parents=True, exist_ok=True)

def save(name, data):
    BASE.mkdir(parents=True, exist_ok=True)
    (BASE / name).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

def load_vlm():
    import torch
    from transformers import AutoProcessor, Qwen3VLForConditionalGeneration
    path = BASE / 'models' / 'Qwen3-VL-4B-Instruct'
    processor = AutoProcessor.from_pretrained(path, local_files_only=True)
    processor.image_processor.size = {'shortest_edge': 65536, 'longest_edge': 262144}
    # Let Transformers choose the available accelerator placement instead of
    # assuming a particular CUDA device index.
    model = Qwen3VLForConditionalGeneration.from_pretrained(
        path, dtype=torch.bfloat16, device_map='auto',
        attn_implementation='sdpa', local_files_only=True)
    return processor, model

def messages(image, prompt):
    return [{'role': 'user', 'content': [
        {'type': 'image', 'image': image}, {'type': 'text', 'text': prompt}]}]

def infer(args):
    import torch
    from PIL import Image
    from ultralytics import YOLO
    image = Image.open(args.image).convert('RGB')
    detector = YOLO(str(BASE / 'models' / 'YOLO11' / 'yolo11n.pt'))
    # Generic COCO detections are context only, never UI click coordinates.
    start = time.perf_counter()
    result = detector.predict(image, verbose=False)[0]
    yolo_ms = (time.perf_counter() - start) * 1000
    detections = [{'label': result.names[int(b.cls.item())],
                   'confidence': float(b.conf.item()), 'xyxy': b.xyxy[0].tolist()}
                  for b in result.boxes]
    processor, model = load_vlm()
    prompt = ('只回答一个简短JSON对象，字段scene、blocking_dialog、visible_buttons。'
              'scene只能选home/settings/battle/notice/login/unknown。'
              '不输出角色名字、资源数值或剧情，不猜测模糊文字。blocking_dialog没有则为null。'
              'visible_buttons最多列出5个能看清的按钮文字，不输出坐标。'
              '仅依据图像，不执行操作。以下是通用YOLO检测候选，可能不适用于游戏UI，'
              '请核查后采用：' + json.dumps(detections, ensure_ascii=False))
    inputs = processor.apply_chat_template(messages(image, prompt), tokenize=True,
        add_generation_prompt=True, return_dict=True, return_tensors='pt').to(model.device)
    torch.cuda.synchronize()
    start = time.perf_counter()
    with torch.inference_mode():
        output = model.generate(**inputs, max_new_tokens=160, do_sample=False)
    torch.cuda.synchronize()
    report = {'image': str(args.image), 'vlm_dtype': 'bfloat16', 'quantized': False,
              'yolo_scope': 'COCO context only; not trained game UI detection',
              'yolo_ms_including_first_warmup': yolo_ms, 'detections': detections,
              'vlm_ms': (time.perf_counter() - start) * 1000,
              'description': processor.decode(output[0, inputs.input_ids.shape[1]:], skip_special_tokens=True),
              'peak_gpu_allocated_gb': torch.cuda.max_memory_allocated() / 2**30,
              'live_rounds_completed': 0}
    save('inference.json', report)
    print(json.dumps(report, ensure_ascii=False), flush=True)

def train_yolo(args):
    import shutil
    from ultralytics import YOLO, settings
    settings.update({'sync': False})
    data = json.loads((ROOT / 'public/annotations/home-reviewed.json').read_text(encoding='utf-8'))
    dataset = BASE / 'pilot-data'
    (dataset / 'images/train').mkdir(parents=True, exist_ok=True)
    (dataset / 'labels/train').mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / 'public/annotations' / data['image'], dataset / 'images/train/home.jpg')
    labels = []
    for b in data['boxes']:
        if b.get('uncertain'):
            continue
        labels.append(f"0 {(b['x'] + b['w']/2)/data['width']} {(b['y'] + b['h']/2)/data['height']} {b['w']/data['width']} {b['h']/data['height']}")
    (dataset / 'labels/train/home.txt').write_text('\n'.join(labels), encoding='utf-8')
    # Ultralytics requires a val path even for a training smoke test. This is NOT held-out evaluation.
    config = {'path': str(dataset), 'train': 'images/train', 'val': 'images/train', 'names': {0: 'ui_region'}}
    import yaml
    (dataset / 'data.yaml').write_text(yaml.safe_dump(config), encoding='utf-8')
    model = YOLO(str(BASE / 'models/YOLO11/yolo11n.pt'))
    model.train(data=str(dataset / 'data.yaml'), epochs=args.steps, batch=1,
        imgsz=640, workers=0, amp=False, val=False, plots=False,
        fliplr=0, mosaic=0, project=str(BASE / 'training'), name='yolo-pilot',
        exist_ok=True, seed=17)
    save('yolo-training.json', {'status': 'completed', 'epochs': args.steps,
        'unique_source_images': 1, 'boxes': len(labels), 'heldout_evaluation': False,
        'purpose': 'training pipeline smoke test only; metrics are in-sample',
        'weights': str(model.trainer.best)})

def train_vlm(args):
    import torch
    from PIL import Image
    from peft import LoraConfig, get_peft_model
    processor, base_model = load_vlm()
    # Preserve the full base weights; optimize only text attention adapters.
    model = get_peft_model(base_model, LoraConfig(r=4, lora_alpha=8,
        target_modules=r'.*language_model.*\.(q_proj|v_proj)', task_type='CAUSAL_LM'))
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant': False})
    model.config.use_cache = False
    model.train()
    data = json.loads((ROOT / 'public/annotations/home-reviewed.json').read_text(encoding='utf-8'))
    image = Image.open(ROOT / 'public/annotations' / data['image']).convert('RGB')
    boxes = [b for b in data['boxes'] if not b.get('uncertain')]
    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-5)
    losses = []
    for step in range(args.steps):
        box = boxes[step % len(boxes)]
        crop = image.crop((box['x'], box['y'], box['x']+box['w'], box['y']+box['h']))
        query = messages(crop, '这张明日方舟界面裁剪图里的按钮是什么？')
        prefix = processor.apply_chat_template(query, tokenize=True, add_generation_prompt=True,
            return_dict=True, return_tensors='pt')
        query.append({'role': 'assistant', 'content': [{'type': 'text', 'text': box['label']}]})
        batch = processor.apply_chat_template(query, tokenize=True, add_generation_prompt=False,
            return_dict=True, return_tensors='pt').to(model.device)
        labels = batch.input_ids.clone()
        labels[:, :prefix.input_ids.shape[1]] = -100
        if (labels != -100).sum().item() == 0:
            raise ValueError('No supervised answer tokens')
        optimizer.zero_grad(set_to_none=True)
        loss = model(**batch, labels=labels).loss
        if not torch.isfinite(loss):
            raise ValueError('Non-finite training loss')
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        losses.append(float(loss.detach()))
        print(f'LoRA step {step+1}/{args.steps}: loss={losses[-1]}', flush=True)
    output = BASE / 'training/vlm-lora-pilot'
    model.save_pretrained(output)
    processor.save_pretrained(output)
    save('vlm-training.json', {'status': 'completed', 'method': 'BF16 base + LoRA',
        'steps': args.steps, 'losses': losses, 'unique_source_images': 1,
        'heldout_evaluation': False, 'adapter': str(output),
        'purpose': 'training pipeline smoke test; not evidence of improved accuracy'})

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['infer', 'train-yolo', 'train-vlm'])
    parser.add_argument('--image', type=Path, default=ROOT / 'public/annotations/home-reference-20260907.jpg')
    parser.add_argument('--steps', type=int, default=3)
    args = parser.parse_args()
    if args.steps < 1:
        parser.error('--steps must be positive')
    {'infer': infer, 'train-yolo': train_yolo, 'train-vlm': train_vlm}[args.mode](args)
