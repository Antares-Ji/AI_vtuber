import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from native_player_ocr import corroborate_player,corroborate_player_hud

def line(text,x=259,y=683,w=36,h=32,score=.99):
    return {'text':text,'confidence':score,'box':[[x,y],[x+w,y],[x+w,y+h],[x,y+h]]}

class PlayerOCRTests(unittest.TestCase):
    def setUp(self):self.player={'player':{'hp':75,'max_hp':80,'block':5}}
    def read(self,lines,player=None):return corroborate_player(player or self.player,{'lines':lines})['player']
    def test_matching_fraction_and_aligned_shield(self):
        self.assertEqual(self.read([line('75/80'),line('5',215,685,10,25)]),self.player['player'])
    def test_missing_or_buff_digit_never_confirms_block(self):
        for digits in [[],[line('5',240,730,10,20)],[line('5',550,680,10,20)],[line('5',215,685,10,25,score=.7)]]:
            self.assertEqual(self.read([line('75/80'),*digits]),{'hp':75,'max_hp':80,'block':None})
    def test_noisy_fraction_only_anchors_independent_shield(self):
        self.assertEqual(self.read([line('75%/.80',score=.86),line('5',215,685,10,25)]),{'hp':None,'max_hp':None,'block':5})
    def test_disagreement_missing_and_duplicate_fractions(self):
        for lines in [[],[line('1/1')],[line('75/80'),line('75/80',400)]]:
            self.assertEqual(self.read(lines),{'hp':None,'max_hp':None,'block':None})
    def test_unknown_or_disagreeing_qwen_is_not_filled_from_ocr(self):
        lines=[line('75/80'),line('5',215,685,10,25)]
        for p in [{'hp':None,'max_hp':None,'block':None},{'hp':1,'max_hp':1,'block':1}]:
            self.assertEqual(self.read(lines,{'player':p}),{'hp':None,'max_hp':None,'block':None})
    def test_malformed_boxes_and_ambiguous_shield_are_rejected(self):
        for box in [None,[],[[0,0]]*4,[[float('nan'),0]]*4,[[1001,0]]*4]:
            bad=line('75/80');bad['box']=box
            self.assertEqual(self.read([bad]),{'hp':None,'max_hp':None,'block':None})
        self.assertIsNone(self.read([line('75/80'),line('5',215,685,10,25),line('5',230,685,10,25)])['block'])

    def test_hud_reads_same_frame_health_but_never_block(self):
        checked=corroborate_player_hud(self.player,{'lines':[line('75/80',80,16,44,43),line('5',50,16,10,43)]})
        self.assertEqual(checked['player'],{'hp':75,'max_hp':80,'block':None})
        self.assertEqual(checked['ocr_check']['fields'],['hp','max_hp'])
        self.assertEqual(checked['ocr_check']['region'],'top_hud')

    def test_hud_does_not_fill_unknown_or_conflicting_visual_health(self):
        for player in ({'hp':None,'max_hp':None},{'hp':15,'max_hp':80},{'hp':True,'max_hp':80}):
            checked=corroborate_player_hud({'player':player},{'lines':[line('75/80',80,16)]})
            self.assertEqual(checked['player'],{'hp':None,'max_hp':None,'block':None})
            self.assertEqual(checked['ocr_check']['fields'],[])

    def test_hud_rejects_other_regions_noisy_low_confidence_and_ambiguous_text(self):
        cases=[[],[line('75/80')],[line('75/80',600,16)],[line('75/80',80,190)],
               [line('75/80',80,16,score=.85)],[line('75%80',80,16)],
               [line('75/80',80,16),line('75/80',300,16)]]
        for lines in cases:
            checked=corroborate_player_hud(self.player,{'lines':lines})
            self.assertEqual(checked['player'],{'hp':None,'max_hp':None,'block':None})
            self.assertEqual(checked['ocr_check']['status'],'unknown')

if __name__=='__main__':unittest.main()
