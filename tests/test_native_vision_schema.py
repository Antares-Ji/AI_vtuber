import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from native_vision_schema import hand_targets,whole_point,scene_observation,player_stats,battle_observation

class VisionSchemaTest(unittest.TestCase):
    def test_right_battle_crop_maps_enemy_and_button_back_to_original_frame(self):
        source={'scene':'battle','targets':[{'id':'enemy','kind':'enemy','point':[350,600]},
                {'id':'end','kind':'button','point':[800,810]}]}
        result=battle_observation(source,[.45,0,1,1])
        self.assertAlmostEqual(result['targets'][0]['point'][0],642.5)
        self.assertAlmostEqual(result['targets'][1]['point'][0],890)
        self.assertEqual(result['targets'][1]['point'][1],810)
        self.assertEqual(source['targets'][0]['point'],[350,600])
    def test_skill_release_ground_must_not_overlap_lower_hand_area(self):
        enemy={'id':'e','kind':'enemy','point':[792,634]}
        ground={'id':'g','kind':'ground','point':[400,700]}
        allowed={'id':'a','kind':'ground','point':[500,450]}
        value={'scene':'battle','targets':[enemy,ground,allowed]}
        result=battle_observation(value)
        self.assertEqual(result['targets'],[enemy,allowed])
        self.assertEqual(result['rejected_low_ground_targets'],1)
        self.assertEqual(value['targets'],[enemy,ground,allowed])
        with self.assertRaises(ValueError):battle_observation({'targets':[{'point':[float('nan'),400]}]})
    def test_player_numbers_are_bounded_integers_and_unknown_is_not_zero(self):
        self.assertEqual(player_stats({'hp':75,'max_hp':80,'block':'2/3'}),{'player':{'hp':75,'max_hp':80,'block':None}})
        self.assertIsNone(player_stats({})['player']['block'])
        self.assertEqual(player_stats({'hp':1,'max_hp':None})['player'],{'hp':None,'max_hp':None,'block':None})
        for value in [True,-1,float('nan'),100000,'5']:
            self.assertIsNone(player_stats({'block':value})['player']['block'])
        self.assertEqual(player_stats({'hp':90,'max_hp':80,'block':0}),{'player':{'hp':None,'max_hp':None,'block':0}})
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
