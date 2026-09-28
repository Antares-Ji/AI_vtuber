"""CPU synthetic geometry regressions. No screenshots, game or models."""
import importlib.util
from pathlib import Path
import unittest
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('current_geometry', ROOT/'scripts/current_deployment_geometry.py')
geometry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geometry)


class GeometryTest(unittest.TestCase):
    def frame(self):
        return np.zeros((1024, 1600, 3), np.uint8)

    def test_current_green_interior_and_paused_darkness(self):
        frame = self.frame()
        cv2.rectangle(frame, (650, 360), (740, 450), (10, 40, 10), -1)
        self.assertEqual(geometry.green_target(frame, [700/1600, 400/1024]), [700/1600, 400/1024])
        with self.assertRaises(ValueError):
            geometry.green_target(frame, [700/1600, 400/1024], paused=False)

    def test_no_green_ui_only_and_large_projection_fail(self):
        frame = self.frame()
        cv2.rectangle(frame, (600, 880), (750, 990), (10, 180, 10), -1)
        with self.assertRaises(ValueError):
            geometry.green_target(frame, [700/1600, 930/1024])
        cv2.rectangle(frame, (650, 360), (740, 450), (10, 180, 10), -1)
        with self.assertRaises(ValueError):
            geometry.green_target(frame, [900/1600, 400/1024])

    def test_narrow_border_is_not_safe_interior(self):
        frame = self.frame()
        cv2.rectangle(frame, (650, 360), (740, 450), (10, 180, 10), 8)
        with self.assertRaises(ValueError):
            geometry.green_target(frame, [700/1600, 400/1024])

    def test_invalid_coordinates_and_scale_fail(self):
        for proposal in ([True, .5], [float('nan'), .5], [1.1, .5], [.5], 'center'):
            with self.assertRaises(ValueError):
                geometry.green_target(self.frame(), proposal)
        with self.assertRaises(ValueError):
            geometry.direction_center(np.zeros((512,800,3), np.uint8))

    def diamond(self, frame, x, y):
        vertices = np.array([[x,y-60],[x+65,y],[x,y+60],[x-65,y]], np.int32)
        cv2.polylines(frame, [vertices], True, (230,230,230), 6)

    def test_unique_direction_diamond_and_absent(self):
        frame = self.frame()
        self.assertIsNone(geometry.direction_center(frame))
        self.diamond(frame, 800, 450)
        point = geometry.direction_center(frame)
        self.assertIsNotNone(point)
        self.assertAlmostEqual(point[0], .5, places=3)
        self.assertAlmostEqual(point[1], 450/1024, places=3)

    def test_white_rectangle_and_multiple_diamonds_do_not_authorize(self):
        frame = self.frame()
        cv2.rectangle(frame, (650, 360), (750, 450), (230,230,230), -1)
        self.assertIsNone(geometry.direction_center(frame))
        self.diamond(frame, 1000, 500)
        self.diamond(frame, 1250, 500)
        self.assertIsNone(geometry.direction_center(frame))


if __name__ == '__main__':
    unittest.main()
