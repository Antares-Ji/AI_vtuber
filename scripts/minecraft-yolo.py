"""CPU-only contextual detections; COCO labels are not Minecraft entities."""
import json
import os
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('YOLO_CONFIG_DIR', str(ROOT / 'runtime/vlm/yolo-config'))
from ultralytics import YOLO
model = YOLO(str(ROOT / 'runtime/vlm/models/YOLO11/yolo11n.pt'))
result = model.predict(sys.argv[1], device='cpu', imgsz=416, verbose=False)[0]
print(json.dumps({'scope': 'COCO only, not trained for Minecraft', 'detections': [
    {'label': result.names[int(b.cls.item())], 'confidence': round(float(b.conf.item()), 3)}
    for b in result.boxes][:8]}))
