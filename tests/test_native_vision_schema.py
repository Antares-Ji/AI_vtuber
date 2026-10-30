import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from native_vision_schema import hand_targets,whole_point,scene_observation

class VisionSchemaTest(unittest.TestCase):
    def test_end_turn_button_is_not_evidence_that_battle_has_ended(self):
        for label in ['结束第1回合','结束回合','End Turn']:
            value={'scene':'room','summary':'战斗结束','targets':[{'id':'t1','label':label,'point':[890,810]}]}
            fixed=scene_observation(value)
            self.assertEqual(fixed['scene'],'battle')
            self.assertEqual(fixed['scene_correction'],'room_conflicts_with_visible_end_turn_control')
            self.assertEqual(value['scene'],'room')
        value={'scene':'room','targets':[{'id':'t1','label':'前进','point':[890,810]}]}
        self.assertEqual(scene_observation(value),value)
    def test_scene_coordinates_without_labels_are_not_silently_accepted(self):
        with self.assertRaises(ValueError):scene_observation({'scene':'reward','points':[[436,379]]})
        result=scene_observation({'scene':'reward','points':[['金币',436,379]]})
        self.assertNotIn('points',result)
        self.assertEqual(result['targets'],[{'id':'t1','label':'金币','point':[436,379],'enabled':True}])
        direct={'scene':'reward','targets':result['targets']}
        self.assertEqual(scene_observation(direct),direct)
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
