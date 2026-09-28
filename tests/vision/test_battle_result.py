import sys,unittest
from pathlib import Path
import cv2
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts'))
from battle_result import lit_result_badges,result_stage_from_text
class SettlementRegression(unittest.TestCase):
    def test_ocr_stage_variants(self):
        self.assertEqual(result_stage_from_text('O 一 11 OPERATION 突 围'), '0-11')
        self.assertEqual(result_stage_from_text('OPERATION 1-1'), '1-1')
        self.assertIsNone(result_stage_from_text('OPERATION'))
        self.assertIsNone(result_stage_from_text('0-11 1-1'))
        self.assertIsNone(result_stage_from_text('0-0'))
    def test_actual_three_star_misread_as_zero(self):
        self.assertEqual(lit_result_badges(cv2.imread(str(ROOT/'runtime/vision/campaign-20260926/0-4/1790368943110/result.png'))),3)
    def test_actual_two_star(self):
        self.assertEqual(lit_result_badges(cv2.imread(str(ROOT/'runtime/vision/campaign-20260926/0-5/settlement-1790369852887321900/result.png'))),2)
    def test_action_end_title_can_mean_defeat(self):
        self.assertEqual(lit_result_badges(cv2.imread(str(ROOT/'runtime/vision/stage-0-7/1790372473304027000/before.png'))),0)
if __name__=='__main__':unittest.main()
