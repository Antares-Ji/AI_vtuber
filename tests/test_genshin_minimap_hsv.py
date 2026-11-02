import importlib.util
from pathlib import Path
import unittest
import cv2
import numpy as np

spec = importlib.util.spec_from_file_location('hsv_replay', Path(__file__).resolve().parents[1]/'scripts/genshin/replay-minimap-hsv.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class HsvTests(unittest.TestCase):
    def setUp(self):
        hsv = np.full((10, 10, 3), (130, 120, 250), np.uint8)
        self.color = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)
        self.source = {'file': 'fixture', 'colorRange': module.color_range(self.color)}
        self.image = np.zeros((1080, 1920, 3), np.uint8)

    def test_unique_blob_supplies_image_angle_but_no_game_direction(self):
        self.image[120:130, 215:225] = self.color
        result = module.detect(self.image, [self.source])
        self.assertTrue(result['accepted'])
        self.assertAlmostEqual(result['imageBearingDegrees'], -0.556, places=2)
        self.assertIsNone(result['gameBearingDegrees'])

    def test_close_components_from_one_color_are_not_merged(self):
        self.image[120:124, 215:219] = self.color[:4, :4]
        self.image[120:124, 221:225] = self.color[:4, :4]
        result = module.detect(self.image, [self.source])
        self.assertEqual(len(result['candidates']), 2)
        self.assertFalse(result['accepted'])

    def test_center_and_outside_circle_are_not_targets(self):
        self.image[120:130, 163:173] = self.color
        self.image[20:30, 63:73] = self.color
        self.assertFalse(module.detect(self.image, [self.source])['accepted'])

    def test_duplicate_color_definitions_merge_same_component(self):
        self.image[120:130, 215:225] = self.color
        duplicate = {**self.source, 'file': 'duplicate'}
        self.assertEqual(len(module.detect(self.image, [self.source, duplicate])['candidates']), 1)

    def test_hue_wrap_and_empty_resource(self):
        hsv = np.full((10, 10, 3), (179, 200, 250), np.uint8)
        hsv[:4, :, 0] = 0
        color = module.color_range(cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR))
        self.assertLessEqual(color['hueOffsets'][1]-color['hueOffsets'][0], 6)
        with self.assertRaises(ValueError):
            module.color_range(np.zeros((12, 12, 3), np.uint8))


if __name__ == '__main__':
    unittest.main()
