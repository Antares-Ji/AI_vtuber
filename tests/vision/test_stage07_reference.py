import sys,unittest
from pathlib import Path
import cv2,numpy as np
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from stage07_reference import align

def read(path):return cv2.imdecode(np.fromfile(path,dtype=np.uint8),cv2.IMREAD_COLOR)

class Stage07ReferenceTests(unittest.TestCase):
    def test_current_bagpipe_selection_matches_verified_green_cell(self):
        image=read(ROOT/'runtime/vision/stage-0-7/1789208149030050100/风笛-selected.png')
        result=align(image,'风笛')
        self.assertGreater(result['inliers'],25)
        self.assertLess(abs(result['point'][0]-.585625),.02)
        self.assertLess(abs(result['point'][1]-.480469),.02)
    def test_blank_and_other_stage_do_not_supply_a_drop(self):
        images=[np.zeros((1024,1600,3),np.uint8),read(ROOT/'data/vision/deployment-references/0-1/selected.png')]
        for image in images:
            with self.assertRaises(RuntimeError):align(image,'风笛')
if __name__=='__main__':unittest.main()
