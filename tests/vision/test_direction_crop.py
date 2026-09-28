import sys,unittest
from pathlib import Path
import cv2,numpy as np
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from local_battle_followup import ref

class DirectionCropTests(unittest.TestCase):
    def inspect(self,path):
        image=cv2.imdecode(np.fromfile(ROOT/path,np.uint8),cv2.IMREAD_COLOR)
        self.assertIsNotNone(image)
        return ref.inspect_frame(image,'direction')

    def test_lower_left_pending_direction(self):
        found=self.inspect('runtime/vision/campaign-20260926/0-10/1790373364730/failure.png')
        self.assertTrue(found['ok'])
        self.assertLess(abs(found['target_point'][0]-.434),.02)
        self.assertLess(abs(found['target_point'][1]-.596),.02)

    def test_result_artwork_is_not_direction(self):
        self.assertFalse(self.inspect('runtime/vision/campaign-20260926/0-9/1790371889536/result.png')['ok'])

    def test_cancel_panel_partly_occludes_profile_rule(self):
        found=self.inspect('runtime/vision/campaign-20260926/0-10/1790373496598/failure.png')
        self.assertTrue(found['ok'])
        self.assertLess(abs(found['target_point'][0]-.36),.02)

    def test_skill_selection_diamond_is_not_deployment(self):
        self.assertFalse(self.inspect('runtime/vision/campaign-20260926/0-10/1790373708529/failure.png')['ok'])

    def test_upper_row_cancel_panel(self):
        found=self.inspect('runtime/vision/campaign-20260926/0-11/1790374180061/failure.png')
        self.assertTrue(found['ok'])
        self.assertLess(abs(found['target_point'][0]-.545),.03)

    def test_landed_operator_is_not_pending(self):
        paths=list((ROOT/'runtime/vision/campaign-20260926/0-10/1790372918133').glob('*-landed.png'))
        self.assertGreaterEqual(len(paths),2)
        for path in paths:self.assertFalse(self.inspect(path)['ok'])

if __name__=='__main__':unittest.main()
