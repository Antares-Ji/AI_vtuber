import importlib.util
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('followup',ROOT/'scripts/local_battle_followup.py')
followup=importlib.util.module_from_spec(spec);spec.loader.exec_module(followup)

class FollowupVisionTests(unittest.TestCase):
    def test_split_fa_glyph_in_recorded_defense_label(self):
        stats=followup.combat_stats('攻击 1641 防 御 840 氵 去 抗 0 阻 挡 2 技 能')
        self.assertEqual(stats['防御'],840)
        self.assertEqual(stats['阻挡'],2)
    def test_noisy_attack_ocr_is_not_parsed_as_one(self):
        stats=followup.combat_stats('攻击 1M1 防御 840 法抗 0 阻挡 2 技能')
        self.assertIsNone(stats['攻击']);self.assertEqual(stats['防御'],840);self.assertEqual(stats['阻挡'],2)
    def test_card_availability_changes_after_spending(self):
        bright=followup.ref.reference('tray-affordable.png')
        spent=followup.ref.read(ROOT/'runtime/vision/realtime-deployment/1789196923599/landed.png')
        for slot in range(3):self.assertTrue(followup.slot_state(bright,slot)['ready'])
        self.assertFalse(followup.slot_state(spent,0)['present'])
        for slot in [1,2]:
            # The disabled-card hatching can obscure the portrait template.
            # YOLO handles card presence; this reference gates affordability.
            self.assertFalse(followup.slot_state(spent,slot)['ready'])
    def test_green_target_rejects_high_platform_and_nonbattle(self):
        selected=followup.ref.read(ROOT/'runtime/vision/realtime-deployment/1789196923599/selected.png')
        point=followup.green_target(selected,[.778,.442])
        self.assertLess(abs(point[0]-.778),.04)
        with self.assertRaises(RuntimeError):followup.green_target(selected,[.67,.29])
        with self.assertRaises(RuntimeError):followup.green_target(followup.ref.reference('result.png'),[.778,.442])
    def test_proven_multi_plan_aligns_and_rejects_occupied_cell(self):
        for slot in [2,3]:
            self.assertTrue(followup.ref.inspect(followup.ref.REF/f'multi-{slot}-green.png',f'multi-tile-{slot}')['ok'])
        occupied=ROOT/'runtime/vision/realtime-deployment/1789198468204/card-3-green.png'
        self.assertFalse(followup.ref.inspect(occupied,'multi-tile-3')['ok'])
        self.assertTrue(followup.ref.inspect(occupied,'profile')['ok'])
        self.assertFalse(followup.ref.inspect(followup.ref.REF/'landed.png','profile')['ok'])

if __name__=='__main__':unittest.main()
