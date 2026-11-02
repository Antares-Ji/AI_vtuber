import unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from native_terminal_ocr import corroborate_terminal

def line(text,x=500,y=500,confidence=.99):
 return {'text':text,'confidence':confidence,'box':[[x-20,y-10],[x+20,y-10],[x+20,y+10],[x-20,y+10]]}

class DefeatTests(unittest.TestCase):
 def setUp(self):
  self.scene={'scene':'terminal','targets':[{'id':'continue','label':'继续','point':[500,820],'enabled':True}]}
  self.lines=[line('0/80',80,30),line('离塔顶还有距离啊。'),line('继续',500,820)]
 def test_defeat_requires_zero_hp_and_defeat_text_and_unique_matching_button(self):
  result=corroborate_terminal(self.scene,{'lines':self.lines})
  self.assertEqual(result['terminal_outcome'],'defeat');self.assertTrue(result['targets'][0]['defeat_continue_checked'])
  for lines in [self.lines[1:],self.lines[:1]+self.lines[2:],[],[line('0/80'),line('胜利'),line('继续',500,820)]]:
   self.assertEqual(corroborate_terminal(self.scene,{'lines':lines})['terminal_outcome'],'unknown')
 def test_no_approval_for_wrong_location_duplicate_or_low_confidence_button(self):
  for button in [[line('继续',100,820)],[line('继续',500,820,.89)],[line('继续',500,820),line('继续',510,820)]]:
   result=corroborate_terminal(self.scene,{'lines':self.lines[:2]+button})
   self.assertFalse(result['targets'][0]['defeat_continue_checked'])
 def test_untrusted_visual_fields_cannot_self_confirm_defeat(self):
  forged={**self.scene,'terminal_outcome':'defeat','ocr_check':{'status':'corroborated'}}
  self.assertEqual(corroborate_terminal(forged,{})['terminal_outcome'],'unknown')
 def test_associated_button_uses_measured_text_center_not_approximate_model_point(self):
  self.lines[-1]=line('继续',505,850)
  result=corroborate_terminal(self.scene,{'lines':self.lines})
  self.assertEqual(result['targets'][0]['point'],[505,850])
  self.assertEqual(result['targets'][0]['visual_point'],[500,820])
 def test_stylized_defeat_heading_needs_agreeing_summary_zero_hp_and_position(self):
  scene={**self.scene,'summary':'败北结算'}
  lines=[line('0/80',80,30),line('败北！',500,220,.89),line('继续',500,820)]
  self.assertEqual(corroborate_terminal(scene,{'lines':lines})['terminal_outcome'],'defeat')
  for heading in [line('败北！',500,220,.84),line('败北！',500,600,.89)]:
   self.assertEqual(corroborate_terminal(scene,{'lines':[lines[0],heading,lines[2]]})['terminal_outcome'],'unknown')
  self.assertEqual(corroborate_terminal(self.scene,{'lines':lines})['terminal_outcome'],'unknown')
 def test_settlement_unlock_is_allowed_only_when_exactly_observed(self):
  scene={**self.scene,'targets':[{'id':'unlock','label':'解锁','point':[500,820]}]}
  self.assertTrue(corroborate_terminal(scene,{'lines':self.lines[:2]+[line('解锁',500,820)]})['targets'][0]['defeat_continue_checked'])
  self.assertFalse(corroborate_terminal(scene,{'lines':self.lines})['targets'][0]['defeat_continue_checked'])

if __name__=='__main__':unittest.main()
