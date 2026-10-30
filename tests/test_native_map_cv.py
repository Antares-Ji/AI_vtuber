import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from native_map_cv import map_candidates,map_observation,annotate_candidates,local_candidates

class MapCVTest(unittest.TestCase):
    def setUp(self):
        self.candidates={'red':[{'id':'R1','point':[400,600]}],'dark':[{'id':'N1','point':[400,450]},{'id':'N2','point':[400,650]}]}
        self.selected={'marker_id':'R1','marker_confirmed':True,'next_nodes':[{'id':'N1','label':'敌人','directly_connected':True}]}
    def test_coordinates_come_from_pixels_not_generated_json(self):
        self.selected['next_nodes'][0]['point']=[999,999]
        view=map_observation(self.selected,self.candidates)
        self.assertEqual(view['targets'][0]['point'],[400,450])
        self.assertEqual(view['map_grounding']['source'],'local_cv_qwen')
    def test_unknown_unconfirmed_current_and_unconnected_nodes_fail(self):
        for mutation in [dict(id='invented'),dict(id='N2'),dict(directly_connected=False),dict(label='')]:
            selected={**self.selected,'next_nodes':[{**self.selected['next_nodes'][0],**mutation}]}
            with self.assertRaises(ValueError):map_observation(selected,self.candidates)
        for mutation in [dict(marker_id='missing'),dict(marker_confirmed=False),dict(next_nodes=[]),dict(next_nodes=self.selected['next_nodes']*2)]:
            with self.assertRaises(ValueError):map_observation({**self.selected,**mutation},self.candidates)
    def test_pixel_candidates_and_annotation_are_resolution_relative(self):
        from PIL import Image,ImageDraw
        for width,height in [(1000,600),(1600,960)]:
            im=Image.new('RGB',(width,height),'#ddccb0');draw=ImageDraw.Draw(im)
            draw.rectangle((width*.39,height*.58,width*.41,height*.62),fill='red')
            draw.rectangle((width*.39,height*.43,width*.41,height*.47),fill='black')
            draw.rectangle((0,0,width*.05,height*.05),fill='red')
            found=map_candidates(im)
            self.assertEqual(len(found['red']),1)
            self.assertEqual(len(found['dark']),1)
            self.assertLessEqual(abs(found['red'][0]['point'][1]-600),2)
            self.assertLessEqual(abs(found['dark'][0]['point'][1]-450),2)
            rendered=annotate_candidates(im,found)
            self.assertEqual(rendered.size,im.size)
            self.assertNotEqual(rendered.tobytes(),im.tobytes())
    def test_blank_frame_does_not_make_game_targets(self):
        from PIL import Image
        candidates=map_candidates(Image.new('RGB',(1000,600),'white'))
        self.assertEqual(candidates['red'],[]);self.assertEqual(candidates['dark'],[])
        with self.assertRaises(ValueError):map_observation(self.selected,candidates)
    def test_local_focus_excludes_current_or_completed_nodes_and_rejects_ambiguous_markers(self):
        filtered=local_candidates(self.candidates)
        self.assertEqual([n['id'] for n in filtered['dark']],['N1'])
        self.assertEqual(len(self.candidates['dark']),2)
        for red in [[],self.candidates['red']*2]:
            with self.assertRaises(ValueError):local_candidates({**self.candidates,'red':red})

if __name__=='__main__':unittest.main()
