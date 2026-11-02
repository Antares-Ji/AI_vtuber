"""Call the existing official DeepSeek transport for an already validated crop."""
import base64
import io
import json
import os
import subprocess


def read_cloud(root, image, prompt, max_tokens):
    buffer = io.BytesIO()
    image.save(buffer, format='JPEG', quality=95)
    payload = {'prompt': prompt, 'maxTokens': max_tokens,
               'image': 'data:image/jpeg;base64,' + base64.b64encode(buffer.getvalue()).decode('ascii')}
    result = subprocess.run(
        [str(root/'runtime/node/node.exe'), str(root/'src/sts2/cloud-vision.cjs')],
        input=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=65, cwd=root,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        raise ValueError('Cloud vision failed: ' + result.stderr.decode('utf-8', errors='replace')[:300])
    return json.loads(result.stdout)


def provider_evidence(parsed):
    """Keep local OCR provenance distinct from the remote visual inference."""
    if not isinstance(parsed, dict):
        return parsed
    for target in parsed.get('targets', []):
        if target.get('cost_source') == 'local_vlm_ocr':
            target['cost_source'] = 'cloud_vlm_local_ocr'
        if target.get('grounding') == 'local_cv_qwen':
            target['grounding'] = 'local_cv_cloud_vlm'
    grounding = parsed.get('map_grounding')
    if isinstance(grounding, dict) and grounding.get('source') == 'local_cv_qwen':
        grounding['source'] = 'local_cv_cloud_vlm'
        parsed['summary'] = '云端视觉依据本地像素标注报告直接相连的节点；进入结果待后续画面验证。'
    return parsed
