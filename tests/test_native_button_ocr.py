import unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from native_button_ocr import ground_buttons,chapter_story

def line(text,x=500,y=866,confidence=.99):return {'text':text,'confidence':confidence,'box':[[x-15,y-10],[x+15,y-10],[x+15,y+10],[x-15,y+10]]}
class ButtonTests(unittest.TestCase):
 def setUp(self):self.scene={'scene':'event','targets':[{'id':'next','label':'继续','point':[500,833],'enabled':True}]}
 def test_button_uses_current_measured_center(self):
  r=ground_buttons(self.scene,{'lines':[line('继续')]});self.assertEqual(r['targets'][0]['point'],[500,866]);self.assertTrue(r['targets'][0]['enabled'])
 def test_missing_ambiguous_distant_and_low_confidence_disable_button(self):
  for lines in [[],[line('继续'),line('继续',520)],[line('继续',100)],[line('继续',confidence=.89)]]:
   self.assertFalse(ground_buttons(self.scene,{'lines':lines})['targets'][0]['enabled'])
 def test_non_button_choices_and_disabled_status_are_preserved(self):
  source={'scene':'event','targets':[{'id':'choice','label':'失去6点生命','point':[500,500],'enabled':True}]}
  self.assertEqual(ground_buttons(source,{}),source)
  self.scene['targets'][0]['enabled']=False
  self.assertFalse(ground_buttons(self.scene,{'lines':[line('继续')]})['targets'][0]['enabled'])
 def test_exact_chapter_open_header_resolves_story_not_terminal(self):
  scene={'scene':'terminal','targets':[]}
  self.assertEqual(chapter_story(scene,{'lines':[line('第4章 - 开放')]})['scene'],'event')
  for lines in [[],[line('第4章 - 开放',confidence=.89)],[line('第4章 - 开放'),line('胜利')],[line('第4章 - 开放'),line('败北！')]]:
   self.assertEqual(chapter_story(scene,{'lines':lines})['scene'],'terminal')
if __name__=='__main__':unittest.main()
