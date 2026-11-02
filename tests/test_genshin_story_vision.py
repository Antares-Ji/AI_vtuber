import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from genshin_vision_schema import story_observation

class StoryVisionTests(unittest.TestCase):
    def sample(self):
        return {'scene':'world','summary':'人物站在道路上','visible_text':[],'uncertain':False,'navigation':{'marker':'not_visible','terrain':'open','movement':'standing','evidence':'没有看见任务标记'}}
    def test_world_evidence_is_preserved(self):
        value=self.sample()
        self.assertEqual(story_observation(value),value)
    def test_menu_cannot_reuse_world_navigation(self):
        value=self.sample();value['scene']='menu';value['navigation']['marker']='center'
        self.assertEqual(story_observation(value)['navigation']['terrain'],'unknown')
        self.assertEqual(story_observation(value)['navigation']['marker'],'not_visible')
    def test_invalid_extra_coordinates_or_actions_are_rejected(self):
        for field,value in [('point',[300,300]),('key','W')]:
            item=self.sample();item['navigation'][field]=value
            with self.assertRaises(ValueError):story_observation(item)

if __name__=='__main__':unittest.main()
