import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location('replay', Path(__file__).resolve().parents[1] / 'scripts/genshin/replay-minimap.py')
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.rng = np.random.default_rng(8)
        self.template = self.rng.integers(0, 256, (28,28), dtype=np.uint8)
        self.image = self.rng.integers(0, 256, (1080,1920,3), dtype=np.uint8)

    def insert(self, x, y):
        self.image[y:y+28,x:x+28] = self.template[:,:,None]

    def test_exact_unique_target_and_duplicate_colour_merge(self):
        self.insert(212,111)
        result = replay.observe(self.image, [('yellow',self.template),('blue',self.template)])
        self.assertTrue(result['accepted'])
        self.assertEqual(result['matchCount'],1)
        self.assertAlmostEqual(result['imageBearingDegrees'],0)
        self.assertIsNone(result['gameBearingDegrees'])

    def test_two_targets_remain_ambiguous(self):
        self.insert(212,111)
        self.insert(100,111)
        result = replay.observe(self.image,[('test',self.template)])
        self.assertEqual(result['matchCount'],2)
        self.assertFalse(result['accepted'])

    def test_noise_and_center_dont_authorize_bearing(self):
        self.assertFalse(replay.observe(self.image,[('test',self.template)])['accepted'])
        self.insert(154,111)
        self.assertFalse(replay.observe(self.image,[('test',self.template)])['accepted'])

    def test_angle_wrap_and_hud_not_ping(self):
        self.assertEqual(replay.angle_delta(179,-179),2)
        self.assertEqual(replay.angle_delta(0,90),90)
        rows=[{'text':'前去查看详情','box':[80,250,180,30]},
              {'text':'283m','box':[80,285,50,20],'source':'quest_distance_crop'},
              {'text':'24m','box':[1804,83,81,21]}]
        self.assertEqual(replay.hud(rows),{'stage':'前去查看详情','meters':283})


if __name__ == '__main__':
    unittest.main()
