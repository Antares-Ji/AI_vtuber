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

    def test_category_filters_colors_without_fallback(self):
        rows = [{'center': [220, 125], 'sources': ['quest-marker-blue.png']},
                {'center': [200, 125], 'sources': ['minimap-commission.png']}]
        selected, reason = module.select_candidate(rows, [62, 19, 212, 212], '委托任务')
        self.assertEqual(selected, rows[1])
        self.assertEqual(reason, 'category_unique')
        self.assertIsNone(module.select_candidate(rows[:1], [62, 19, 212, 212], '委托任务')[0])

    def test_single_rim_component_preferred_but_two_rim_components_rejected(self):
        rows = [{'center': [260, 125], 'sources': ['fixture']},
                {'center': [210, 125], 'sources': ['fixture']}]
        self.assertEqual(module.select_candidate(rows, [62, 19, 212, 212])[0], rows[0])
        rows.append({'center': [80, 125], 'sources': ['fixture']})
        self.assertIsNone(module.select_candidate(rows, [62, 19, 212, 212])[0])

    def test_unknown_category_does_not_choose_between_different_colors_by_radius(self):
        rows = [{'center': [260, 125], 'sources': ['quest-marker-blue.png']},
                {'center': [210, 125], 'sources': ['quest-marker.png']}]
        self.assertIsNone(module.select_candidate(rows, [62, 19, 212, 212])[0])

    def test_menu_category_requires_selected_title_in_its_own_group(self):
        rows = [{'text': '委托任务', 'box': [185, 300, 105, 28]},
                {'text': '世界任务', 'box': [185, 450, 105, 28]},
                {'text': '任务甲', 'box': [170, 500, 110, 29]},
                {'text': '任务甲', 'box': [875, 120, 140, 37]},
                {'text': '前去查看详情', 'box': [925, 252, 153, 29]},
                {'text': '停止追踪', 'box': [1500, 980, 120, 35]}]
        self.assertEqual(module.menu_category(rows)['category'], '世界任务')
        self.assertIsNone(module.menu_category(rows[:2]+rows[3:]))
        self.assertIsNone(module.menu_category(rows[:-1]))

    def test_category_history_cannot_leak_future_or_ambiguous_identity(self):
        row = {'at': 1000, 'hud': {'stage': '前去查看详情', 'meters': 100}}
        history = [{'at': 900, 'stage': '前去查看详情', 'quest': '甲', 'category': '委托任务'},
                   {'at': 1100, 'stage': '前去查看详情', 'quest': '乙', 'category': '世界任务'}]
        self.assertEqual(module.category_for_frame(row, history)['quest'], '甲')
        self.assertIsNone(module.category_for_frame(row, history, '乙'))
        history[1]['at'] = 950
        self.assertIsNone(module.category_for_frame(row, history))
        self.assertEqual(module.category_for_frame(row, history, '甲')['quest'], '甲')


if __name__ == '__main__':
    unittest.main()
