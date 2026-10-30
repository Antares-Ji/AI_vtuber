import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from native_battle_ocr import enemy_health

def line(text,x=780,y=682,w=30,h=32,score=.999):
    return {'text':text,'confidence':score,'box':[[x,y],[x+w,y],[x+w,y+h],[x,y+h]]}
def enemy(i='e',x=793,y=562,label='紫色毛茸茸敌人，头顶数字18，攻击意图未知'):
    return {'id':i,'kind':'enemy','label':label,'point':[x,y],'enabled':True}
def read(targets,lines):return enemy_health({'scene':'battle','targets':targets},{'lines':lines})

class BattleOCRTests(unittest.TestCase):
    def test_intent_numeral_never_becomes_health(self):
        original=enemy();result=read([original],[line('18',780,500,15),line('5/55')])['targets'][0]
        self.assertEqual((result['enemy']['hp'],result['enemy']['max_hp']),(5,55))
        self.assertNotIn('18',result['label']);self.assertEqual(result['visual_description'],original['label'])
        self.assertEqual(result['point'],original['point']);self.assertEqual(result['id'],original['id'])
    def test_separate_enemy_fractions_ignore_player_and_energy(self):
        result=read([enemy('left',640,620,label='甲虫 7/39'),enemy()],
                    [line('12/80',260),line('2/3',60,810),line('7/39',630),line('5/55')])
        self.assertEqual([t['enemy']['hp'] for t in result['targets']],[7,5])
        self.assertEqual(result['targets'][0]['enemy']['health_status'],'corroborated')
    def test_ambiguous_fractions_or_owners_remain_unknown(self):
        for targets,lines in [([enemy()],[line('5/55'),line('7/39',760)]),
                              ([enemy('a',770),enemy('b',810)],[line('5/55')])]:
            self.assertTrue(all(t['enemy']['hp'] is None for t in read(targets,lines)['targets']))
    def test_conflicting_visual_fraction_not_silently_overwritten(self):
        target=read([enemy(label='敌人 18/55')],[line('5/55')])['targets'][0]
        self.assertIsNone(target['enemy']['hp']);self.assertEqual(target['enemy']['health_status'],'conflict')
    def test_missing_low_confidence_invalid_and_distant_fractions(self):
        for lines in [[],[line('18')],[line('5/55',score=.89)],[line('80/5')],[line('0/0')],
                      [line('5/55',400)],[line('5/55',780,400)],[line('5/55',780,800)]]:
            self.assertIsNone(read([enemy()],lines)['targets'][0]['enemy']['hp'])
    def test_zero_health_and_non_enemy_targets_preserved(self):
        button={'id':'end','kind':'button','label':'结束回合','point':[885,810]}
        result=read([enemy(),button],[line('0/55')])
        self.assertEqual(result['targets'][0]['enemy']['hp'],0);self.assertEqual(result['targets'][1],button)
    def test_malformed_boxes_rejected(self):
        for box in [None,[],[[float('nan'),0]]*4,[[0,0]]*4]:
            item=line('5/55');item['box']=box
            self.assertIsNone(read([enemy()],[item])['targets'][0]['enemy']['hp'])

if __name__=='__main__':unittest.main()
