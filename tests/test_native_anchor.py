import unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from native_anchor import anchor_geometry,anchor_result

class AnchorTests(unittest.TestCase):
    def test_crop_conversion_and_roundtrip_point_are_measured_not_model_generated(self):
        anchor={'point':[.6,.8],'cardName':'防御'}
        relative=anchor_geometry(anchor,(400,500,800,1000),(1000,1000))
        self.assertEqual(relative,[.5,.6])
        result=anchor_result({'anchor_inside':True,'card_name':'防御','target_point':[999,999]},anchor,relative)
        self.assertEqual(result['target_point'],[500,600])
    def test_wrong_card_unknown_or_nonboolean_cannot_confirm(self):
        for parsed in [None,{}, {'anchor_inside':True,'card_name':'打击'},{'anchor_inside':1,'card_name':'防御'},{'anchor_inside':False,'card_name':'防御'}]:
            result=anchor_result(parsed,{'cardName':'防御'},[.5,.6])
            self.assertFalse(result['target_visible']);self.assertIsNone(result['target_point'])
    def test_malformed_or_outside_anchor_is_rejected(self):
        for point in [[.1,.8],[float('nan'),.8],[True,.8],[.6,1.1],[]]:
            with self.assertRaises(ValueError):anchor_geometry({'point':point,'cardName':'防御'},(400,500,800,1000),(1000,1000))

if __name__=='__main__':unittest.main()
