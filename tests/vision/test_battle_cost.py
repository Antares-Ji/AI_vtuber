"""Offline regression tests; no game/controller/model process is launched."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('battle_cost', ROOT/'scripts/battle_cost.py')
cost = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cost)


class BattleCostTests(unittest.TestCase):
    def test_actual_card_cost_changes_threshold(self):
        self.assertTrue(cost.affordable(22, cost.parse_cost('DP22')))
        self.assertFalse(cost.affordable(22, cost.parse_cost('DP24')))
        self.assertTrue(cost.affordable(82, cost.parse_cost('DP22')))
        self.assertTrue(cost.affordable(82, cost.parse_cost('DP24')))

    def test_unknown_and_ambiguous_never_authorize(self):
        for text in ('', 'unknown', 'DP', 'DP2A', 'DP22DP24', 'DP100', None):
            self.assertIsNone(cost.parse_cost(text))
            self.assertFalse(cost.affordable(82, cost.parse_cost(text)))
        self.assertFalse(cost.affordable(None, 22))
        self.assertFalse(cost.affordable(True, 0))
        self.assertEqual(cost.parse_cost('DP 0'), 0)

    def test_context_does_not_get_scaled_twice(self):
        calls = []
        def ocr(frame, box, label, scale):
            calls.append((frame, box, label, scale))
            return 'DP17'
        with patch.object(cost, 'cost_context', return_value='600x240-canvas'):
            self.assertEqual(cost.read_cost('frame', (1,2,3,4), ocr, 'balance'), 17)
        self.assertEqual(calls, [('600x240-canvas', (0,0,600,240), 'balance', 1)])

    def test_card_crop_tracks_current_portrait(self):
        self.assertEqual(cost.card_cost_box(1400), (1395,878,1450,919))
        self.assertEqual(cost.card_cost_box(1590)[2], 1600)


if __name__ == '__main__':
    unittest.main()
