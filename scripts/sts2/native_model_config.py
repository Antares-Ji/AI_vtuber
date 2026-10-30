"""Validate a complete local Qwen checkpoint before replacing a running worker."""
import json
from pathlib import Path

def resolve_model_dir(root,requested=None):
    root=Path(root).resolve()
    directory=Path(requested) if requested else root/'runtime/vlm/models/Qwen3-VL-4B-Instruct'
    if not directory.is_absolute():directory=root/directory
    directory=directory.resolve()
    config=json.loads((directory/'config.json').read_text(encoding='utf-8'))
    if config.get('model_type')!='qwen3_vl':raise ValueError('Expected a local qwen3_vl checkpoint')
    index=directory/'model.safetensors.index.json'
    files=set(json.loads(index.read_text(encoding='utf-8')).get('weight_map',{}).values()) if index.exists() else {'model.safetensors'}
    if not files:raise ValueError('Checkpoint contains no weight shards')
    for name in files:
        if not isinstance(name,str):raise ValueError('Invalid checkpoint shard name')
        shard=(directory/name).resolve()
        if not shard.is_relative_to(directory) or shard.suffix!='.safetensors' or not shard.is_file() or shard.stat().st_size==0:
            raise ValueError('Checkpoint weight shards are incomplete or outside the model directory')
    return directory
