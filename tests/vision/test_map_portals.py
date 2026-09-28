import sys,unittest,cv2
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts'))
from map_portals import portal_candidates

class PortalCandidatesTests(unittest.TestCase):
    def read(self,stage):
        return cv2.imread(str(ROOT/'runtime/vision/campaign-20260926'/stage/'map-preview.png'))
    def test_two_protected_exits(self):
        found=portal_candidates(self.read('1-1'))
        self.assertEqual({x['position'] for x in found['blue']},{'右中','中下'})
        self.assertEqual(len(found['red']),2)
    def test_single_exit_three_entries(self):
        found=portal_candidates(self.read('0-11'))
        self.assertEqual(len(found['blue']),1)
        self.assertEqual(len(found['red']),3)

if __name__=='__main__':unittest.main()
