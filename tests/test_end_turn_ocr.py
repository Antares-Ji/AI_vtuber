import unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from native_battle_ocr import end_turn_button

def line(text='结束第1回合',x=850,y=700,confidence=.99):
    return {'text':text,'confidence':confidence,'box':[[x,y],[x+80,y],[x+80,y+30],[x,y+30]]}
class EndTurnTests(unittest.TestCase):
    def test_only_unique_visible_right_hand_button_is_adopted(self):
        view={'targets':[{'id':'wrong','kind':'button','label':'结束回合','point':[500,500]}]}
        result=end_turn_button(view,{'lines':[line()]})
        self.assertEqual(result['targets'][0]['point'],[890,715]);self.assertTrue(result['targets'][0]['end_turn_ocr_checked'])
        for lines in [[],[line(),line(y=800)],[line(confidence=.89)],[line(x=300)],[line('回合结束时获得格挡')]]:
            self.assertEqual(end_turn_button(view,{'lines':lines})['targets'],[])
if __name__=='__main__':unittest.main()
