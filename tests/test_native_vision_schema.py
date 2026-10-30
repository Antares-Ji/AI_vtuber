import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from native_vision_schema import hand_targets,whole_point

class VisionSchemaTest(unittest.TestCase):
    def test_crop_points_map_back_to_original_game_client(self):
        point=whole_point([500,500],[0,.72,1,1])
        self.assertAlmostEqual(point[0],500);self.assertAlmostEqual(point[1],860)
    def test_unknown_card_text_stays_unknown(self):
        result=hand_targets({'cards':[{'name':None,'cost':'1','point':[500,500]}]},[0,.72,1,1])[0]
        self.assertIsNone(result['card']['name']);self.assertIsNone(result['card']['cost'])
        self.assertIsNone(result['card']['description']);self.assertEqual(result['kind'],'card')
    def test_invalid_points_and_unbounded_hands_fail(self):
        for point in [[True,1],[float('nan'),0],[1001,0],None]:
            with self.assertRaises(ValueError):whole_point(point)
        with self.assertRaises(ValueError):hand_targets({'cards':[{}]*13})

if __name__=='__main__':unittest.main()
