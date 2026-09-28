"""Small stage-specific YOLO + Qwen LoRA pilot, split by play attempt."""
import argparse
import importlib.util
import json
import shutil
import hashlib
from datetime import datetime, timezone
from uuid import uuid4
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'runtime/vision/stage-memory'
OUT = None

def load_experiment():
    spec = importlib.util.spec_from_file_location('experiment', Path(__file__).with_name('vlm-experiment.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def partition_frames(frames, store=STORE):
    selected = [f for f in frames if f.get('reviewed_by') and f.get('split') in ('train', 'val')]
    sessions, hashes = {}, {}
    for frame in selected:
        session = frame.get('session')
        if not session or session == 'unassigned':
            raise ValueError('Reviewed frame requires a session')
        split = frame['split']
        if sessions.setdefault(session, split) != split:
            raise ValueError('Session leaks across splits: ' + session)
        image = (store / frame['image']).resolve()
        if not image.is_relative_to(store.resolve()):
            raise ValueError('Image escapes manifest directory')
        digest = hashlib.sha256(image.read_bytes()).hexdigest()
        if frame.get('sha256') != digest:
            raise ValueError('Image hash differs from reviewed manifest: ' + frame['image'])
        if hashes.setdefault(digest, split) != split:
            raise ValueError('Image hash leaks across splits: ' + digest)
    groups = {split: [f for f in selected if f['split'] == split] for split in ('train', 'val')}
    if not all(groups.values()):
        raise ValueError('Both reviewed train and validation frames are required')
    return groups

def split_report(frames):
    return {split: dict(images=sum(f['split'] == split for f in frames),
                       sessions=sorted({f['session'] for f in frames if f['split'] == split}),
                       hashes=sorted({f['sha256'] for f in frames if f['split'] == split}))
            for split in ('train', 'val')}

def create_run_directory():
    run = ROOT / 'runtime/vlm/training/stage-memory-manifest-runs' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid4().hex[:8])
    run.mkdir(parents=True, exist_ok=False)
    return run

def save(name, value):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')

def train_yolo(frames, epochs):
    partition_frames(frames)
    experiment = load_experiment()
    import yaml
    from ultralytics import YOLO, settings
    settings.update({'sync': False})
    dataset = OUT / 'dataset'
    selected = [f for f in frames if f.get('reviewed_by') and f['split'] in ('train', 'val')
                and f['phase'] in ('battle', 'paused')]
    if not all(any(f['split'] == split for f in selected) for split in ('train', 'val')):
        raise ValueError('YOLO phase subset requires both train and validation frames')
    # Visually reviewed normal-camera landmarks; no enemy or operator pseudo-labels.
    boxes = [(0, .793, .395, .873, .578), (1, .085, .276, .219, .460)]
    for index, frame in enumerate(selected):
        split = frame['split']
        name = f"{index}-{frame['sha256']}{Path(frame['image']).suffix}"
        for folder in ('images', 'labels'):
            (dataset / folder / split).mkdir(parents=True, exist_ok=True)
        shutil.copy2(STORE / frame['image'], dataset / 'images' / split / name)
        labels = ['%d %.6f %.6f %.6f %.6f' % (c, (x1+x2)/2, (y1+y2)/2, x2-x1, y2-y1)
                  for c, x1, y1, x2, y2 in boxes]
        (dataset / 'labels' / split / Path(name).with_suffix('.txt')).write_text('\n'.join(labels), encoding='utf-8')
    config = dict(path=str(dataset.resolve()), train='images/train', val='images/val',
                  names={0: 'enemy_entry', 1: 'protection_target'})
    datafile = dataset / 'data.yaml'
    datafile.write_text(yaml.safe_dump(config), encoding='utf-8')
    detector = YOLO(str(experiment.BASE / 'models/YOLO11/yolo11n.pt'))
    detector.train(data=str(datafile), epochs=epochs, imgsz=640, batch=1, workers=0,
        amp=False, plots=False, seed=17, fliplr=0, mosaic=0,
        project=str(OUT), name='yolo', exist_ok=True)
    report = dict(epochs=epochs, train_images=sum(f['split']=='train' for f in selected),
        val_images=sum(f['split']=='val' for f in selected), split=split_report(selected),
        weights=str(detector.trainer.best), metrics=detector.metrics.results_dict,
        limitation='Same map/camera only; no held-out stage. Classes are landmarks, not enemies, cards or deployable tiles.')
    save('yolo-report.json', report)

def train_qwen(frames, steps):
    groups = partition_frames(frames)
    train, val = groups['train'], groups['val']
    experiment = load_experiment()
    import torch
    from PIL import Image
    from peft import LoraConfig, get_peft_model
    processor, base = experiment.load_vlm()
    query = '识别明日方舟画面。只返回JSON：phase为battle/paused/selection/direction/result之一；deployment_confirmed为是否有已落地的我方干员。不要把敌人或拖动预览当成已部署干员。'
    def evaluate(model):
        result = []
        model.eval()
        for frame in val:
            inputs = processor.apply_chat_template(experiment.messages(Image.open(STORE / frame['image']).convert('RGB'), query),
                tokenize=True, add_generation_prompt=True, return_dict=True, return_tensors='pt').to(model.device)
            with torch.inference_mode():
                output = model.generate(**inputs, max_new_tokens=70, do_sample=False)
            raw = processor.decode(output[0, inputs.input_ids.shape[1]:], skip_special_tokens=True)
            try:
                parsed = json.loads(raw.strip().removeprefix('```json').removesuffix('```').strip())
            except ValueError:
                parsed = None
            expected = {k:frame[k] for k in ('phase', 'deployment_confirmed')}
            result.append(dict(image=frame['image'], expected=expected, parsed=parsed, raw=raw, correct=parsed==expected))
        return result
    before = evaluate(base)
    save('qwen-before.json', before)
    model = get_peft_model(base, LoraConfig(r=4, lora_alpha=8,
        target_modules=r'.*language_model.*\.(q_proj|v_proj)', task_type='CAUSAL_LM'))
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant': False})
    model.config.use_cache = False
    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-5)
    losses = []
    model.train()
    for step in range(steps):
        frame = train[step % len(train)]
        conversation = experiment.messages(Image.open(STORE / frame['image']).convert('RGB'), query)
        prefix = processor.apply_chat_template(conversation, tokenize=True, add_generation_prompt=True, return_dict=True, return_tensors='pt')
        answer = json.dumps({k:frame[k] for k in ('phase', 'deployment_confirmed')})
        conversation.append({'role':'assistant', 'content':[{'type':'text', 'text':answer}]})
        inputs = processor.apply_chat_template(conversation, tokenize=True, add_generation_prompt=False, return_dict=True, return_tensors='pt').to(model.device)
        labels = inputs.input_ids.clone()
        labels[:, :prefix.input_ids.shape[1]] = -100
        optimizer.zero_grad(set_to_none=True)
        loss = model(**inputs, labels=labels).loss
        if not torch.isfinite(loss):
            raise ValueError('Nonfinite loss')
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1)
        optimizer.step()
        losses.append(float(loss.detach()))
        print(f'Qwen LoRA {step+1}/{steps}: {losses[-1]:.4f}', flush=True)
    model.save_pretrained(OUT / 'qwen-adapter')
    after = evaluate(model)
    save('qwen-report.json', dict(steps=steps, train_images=len(train), val_images=len(val), losses=losses,
        before=before, after=after, adapter=str(OUT/'qwen-adapter'),
        promoted=False, split=split_report(frames),
        limitation='One stage; class coverage depends on manifest split. Pilot only; no validated deployment recognition recall.'))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['yolo', 'qwen'])
    parser.add_argument('--steps', type=int, default=10)
    args = parser.parse_args()
    if not 1 <= args.steps <= 100:
        parser.error('steps must be 1..100')
    manifest = json.loads((STORE/'0-1.json').read_text(encoding='utf-8'))
    groups = partition_frames(manifest['frames'])
    frames = groups['train'] + groups['val']
    OUT = create_run_directory()
    save('manifest.json', manifest)
    save('split.json', split_report(frames))
    {'yolo':train_yolo, 'qwen':train_qwen}[args.mode](frames, args.steps)
