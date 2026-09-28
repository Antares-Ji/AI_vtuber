import importlib.util
from pathlib import Path
import unittest
import numpy as np
import cv2
spec=importlib.util.spec_from_file_location('keypages',Path(__file__).resolve().parents[2]/'scripts/build-keypage-review.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class TranslationTests(unittest.TestCase):
    def test_bridge_full_viewport(self):
        rng=np.random.default_rng(12)
        content=rng.integers(0,256,(1800,810,3),dtype=np.uint8)
        content=cv2.GaussianBlur(content,(3,3),0)
        total=0
        for y in range(0,901,150):
            if y:
                match=m.translation(content[y-150:y-150+585],content[y:y+585])
                self.assertIsNotNone(match);self.assertAlmostEqual(match['dy'],150,delta=1);total+=match['dy']
        self.assertEqual(total,900)
    def test_unrelated_does_not_stitch(self):
        a=np.zeros((585,810,3),np.uint8);b=np.full_like(a,255)
        self.assertIsNone(m.translation(a,b))
    def test_temporal_grouping(self):
        self.assertEqual(m.groups([1,2,8,50]),[[1,2,8],[50]])

if __name__=='__main__':unittest.main()
