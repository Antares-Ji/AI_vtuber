import sys,unittest
from pathlib import Path
import cv2,numpy as np
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from battle_pause import read_pause

class ActualPauseRegression(unittest.TestCase):
    def test_previously_stale_paused_frame(self):
        path=ROOT/'runtime/vision/campaign-20260926/0-4/1790368544186/latest.png'
        image=cv2.imdecode(np.fromfile(path,np.uint8),1)
        self.assertTrue(read_pause(image)[0])
    def test_verified_resumed_frame(self):
        path=ROOT/'runtime/vision/campaign-20260926/0-4/1790368943110/all-deployed.png'
        image=cv2.imdecode(np.fromfile(path,np.uint8),1)
        self.assertFalse(read_pause(image)[0])
    def test_no_ui_refuses_blind_toggle(self):
        with self.assertRaises(RuntimeError):read_pause(np.zeros((1024,1600,3),np.uint8))
    def test_dark_opening_animation(self):
        path=ROOT/'runtime/vision/campaign-20260926/0-5/1790369073310/failure.png'
        self.assertFalse(read_pause(cv2.imdecode(np.fromfile(path,np.uint8),1))[0])
    def test_dark_pending_direction(self):
        path=ROOT/'runtime/vision/campaign-20260926/0-5/1790369148537/failure.png'
        self.assertTrue(read_pause(cv2.imdecode(np.fromfile(path,np.uint8),1))[0])
if __name__=='__main__':unittest.main()
