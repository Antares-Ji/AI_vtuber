import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
import cv2
import numpy as np

spec = importlib.util.spec_from_file_location('stitch_pages', Path(__file__).resolve().parents[2] / 'src/vision/stitch-pages.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class PageStitchTest(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(71)
        self.doc = rng.integers(0, 255, (1400, 500, 3), dtype=np.uint8)
        self.doc = cv2.GaussianBlur(self.doc, (3, 3), 0)

    def frame(self, offset):
        image = np.full((650, 720, 3), 40, np.uint8)
        image[90:590, 180:680] = self.doc[offset:offset+500]
        return image

    def test_scroll_excludes_fixed_chrome(self):
        match = mod.alignment(self.frame(0), self.frame(150))
        self.assertIsNotNone(match)
        self.assertEqual(match['dy'], 150)
        self.assertEqual(match['roi'], [180, 90, 680, 590])

    def test_do_not_force_uncertain(self):
        self.assertIsNone(mod.alignment(self.frame(0), self.frame(0)))
        self.assertIsNone(mod.alignment(self.frame(150), self.frame(0)))
        self.assertIsNone(mod.alignment(self.frame(0), self.frame(700)))
        self.assertIsNone(mod.alignment(self.frame(0), np.zeros((100,100,3), np.uint8)))

    def test_batch_preserves_originals_and_mapping(self):
        with tempfile.TemporaryDirectory(prefix='vtuber-stitch-test-') as tmp:
            folder = Path(tmp)
            frames = []
            for i, offset in enumerate([0,150,300,850]):
                name = f'frame-{i+1:03}.jpg'
                cv2.imencode('.jpg', self.frame(offset), [cv2.IMWRITE_JPEG_QUALITY,94])[1].tofile(folder/name)
                frames.append(dict(file=name))
            originals = [(folder/f['file']).read_bytes() for f in frames]
            (folder/'manifest.json').write_text(json.dumps(dict(frames=frames)), encoding='utf-8')
            segments = mod.stitch(folder)
            self.assertEqual(len(segments), 2)
            self.assertEqual(len(segments[0]['pieces']), 3)
            result = cv2.imdecode(np.fromfile(folder/segments[0]['file'], np.uint8), 1)
            self.assertEqual(result.shape[:2], (800,500))
            self.assertEqual(originals, [(folder/f['file']).read_bytes() for f in frames])


if __name__ == '__main__':
    unittest.main()
