import json
import sys
import tempfile
import unittest
from pathlib import Path
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from game_visual_memory import STORE, retrieve, _cached_feature

class MemoryTests(unittest.TestCase):
    def test_feature_cache_invalidates_changed_image(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'frame.png'
            Image.new('RGB', (32, 20), 'black').save(path)
            stat = path.stat()
            before = _cached_feature(str(path), stat.st_mtime_ns, stat.st_size)
            Image.new('RGB', (32, 20), 'white').save(path)
            import os
            os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000))
            stat = path.stat()
            after = _cached_feature(str(path), stat.st_mtime_ns, stat.st_size)
            self.assertEqual(float(before.mean()), 0)
            self.assertEqual(float(after.mean()), 1)
    def test_reference_retrieval_and_no_automatic_replay(self):
        memory = json.loads((STORE/'0-1.json').read_text(encoding='utf-8'))
        for frame in memory['frames']:
            result = retrieve(STORE / frame['image'])
            self.assertEqual(result['candidates'][0]['image'], str(STORE/frame['image']))
            self.assertFalse(result['identity_confirmed'])
            self.assertFalse(result['automatic_replay_allowed'])
    def test_unknown_stage_returns_no_plan(self):
        frame = next((STORE/'images').glob('*.png'))
        self.assertEqual(retrieve(frame, 'unknown')['candidates'], [])
    def test_geometry_change_not_replayed(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory)/'portrait.png'
            Image.new('RGB', (400, 800)).save(image)
            self.assertEqual(retrieve(image)['candidates'], [])
    def test_attempts_do_not_cross_yolo_split(self):
        frames = json.loads((STORE/'0-1.json').read_text(encoding='utf-8'))['frames']
        train = {f['session'] for f in frames if f['split']=='train'}
        val = {f['session'] for f in frames if f['split']=='val'}
        self.assertFalse(train & val)

if __name__ == '__main__':
    unittest.main()
