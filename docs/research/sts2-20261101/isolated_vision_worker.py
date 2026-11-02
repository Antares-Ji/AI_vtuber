"""Run the existing read-only observer with cache disabled for inference timing."""
import sys, runpy
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'scripts/sts2'))
import vision_cache
vision_cache.VisionCache.get=lambda self,key: None
runpy.run_path(str(ROOT/'scripts/sts2/native_vision.py'),run_name='__main__')
