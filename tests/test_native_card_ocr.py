import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/sts2'))
from native_card_ocr import corroborate_card, card_ocr_hints


def line(text, x=500, y=600, score=.99):
    return {'text': text, 'confidence': score,
            'box': [[x-30,y], [x+30,y], [x+30,y+20], [x-30,y+20]]}


class CardOcrTests(unittest.TestCase):
    def setUp(self):
        self.card = {'cards': [{'name': '愤怒', 'cost': 0, 'type': '攻击',
                               'description': '造成4点伤害。将一张此牌的复制品加入你的弃牌堆。'}], 'uncertain': False}
        self.ocr = {'lines': [line('愤怒'), line('攻击', y=710), line('造成4点伤害。', y=750),
                              line('将一张此牌的复制品加入', y=780), line('你的弃牌堆。', y=810)]}

    def test_complete_rules_with_line_wrapping_and_punctuation(self):
        result = corroborate_card(self.card, self.ocr)
        self.assertFalse(result['uncertain'])
        self.assertEqual(result['cards'], self.card['cards'])
        self.assertEqual(result['ocr_check']['fields'], ['name', 'type', 'description'])

    def test_wrong_damage_and_substring_are_rejected(self):
        for damage in ('1', '14', '6'):
            candidate = copy.deepcopy(self.card)
            candidate['cards'][0]['description'] = candidate['cards'][0]['description'].replace('4', damage)
            self.assertEqual(corroborate_card(candidate, self.ocr)['cards'], [])

    def test_neighbor_rules_and_invented_title_are_rejected(self):
        wrong = copy.deepcopy(self.ocr)
        wrong['lines'][0] = line('突破', x=625)
        candidate = copy.deepcopy(self.card)
        candidate['cards'][0]['name'] = '突破'
        self.assertTrue(corroborate_card(candidate, wrong)['uncertain'])
        candidate['cards'][0]['name'] = '道成'
        self.assertTrue(corroborate_card(candidate, self.ocr)['uncertain'])

    def test_missing_low_confidence_or_duplicate_title(self):
        for title in ([], [line('愤怒', score=.89)], [line('愤怒'), line('愤怒', x=650)]):
            self.assertTrue(corroborate_card(self.card, {'lines': title+self.ocr['lines'][1:]})['uncertain'])

    def test_raised_duplicate_title_requires_its_own_complete_rules(self):
        # Same-name folded neighbors must not invalidate the single fully
        # expanded card, but same-height/close titles remain ambiguous.
        for y in (720,820):
            evidence=copy.deepcopy(self.ocr)
            evidence['lines'] += [line('愤怒',x=650,y=y),line('愤怒',x=350,y=y)]
            self.assertFalse(corroborate_card(self.card,evidence)['uncertain'])
            evidence['lines']=[item for item in evidence['lines'] if item['text']!='攻击']
            self.assertTrue(corroborate_card(self.card,evidence)['uncertain'])
        evidence=copy.deepcopy(self.ocr);evidence['lines'].append(line('愤怒',x=650,y=699))
        self.assertTrue(corroborate_card(self.card,evidence)['uncertain'])

    def test_truncated_or_conflicting_rules(self):
        self.assertTrue(corroborate_card(self.card, {'lines': self.ocr['lines'][:-1]})['uncertain'])
        partial = copy.deepcopy(self.card)
        partial['cards'][0]['description'] = '造成4点伤害。'
        self.assertTrue(corroborate_card(partial, self.ocr)['uncertain'])
        self.ocr['lines'][2] = line('造成14点伤害。', y=750)
        self.assertTrue(corroborate_card(self.card, self.ocr)['uncertain'])

    def test_type_conflicts_and_invented_types_are_rejected(self):
        for kind in ('技能', '换能', '防御'):
            candidate = copy.deepcopy(self.card)
            candidate['cards'][0]['type'] = kind
            result = corroborate_card(candidate, self.ocr)
            self.assertEqual(result['cards'], [])
            self.assertEqual(result['ocr_check']['reason'], 'card_type_missing_or_conflicting')

    def test_type_requires_unique_nearby_high_confidence_row(self):
        for replacement in ([], [line('攻击', score=.89, y=710)],
                            [line('攻击', x=650, y=710)],
                            [line('攻击', y=710), line('攻击', y=730)],
                            [line('攻击', y=710), line('技能', y=730)]):
            ocr = copy.deepcopy(self.ocr)
            ocr['lines'][1:2] = replacement
            self.assertEqual(corroborate_card(self.card, ocr)['cards'], [])

    def test_type_below_effect_is_not_a_type_row(self):
        self.ocr['lines'][1] = line('攻击', y=850)
        self.assertEqual(corroborate_card(self.card, self.ocr)['ocr_check']['reason'],
                         'card_type_outside_type_row')

    def test_language_normalization_keeps_original_model_fields(self):
        for name in ('attack', 'ATTACK', ' 攻击 '):
            candidate = copy.deepcopy(self.card)
            candidate['cards'][0]['type'] = name
            self.assertEqual(corroborate_card(candidate, self.ocr)['cards'], candidate['cards'])
        self.ocr['lines'][1] = line('Attack', y=710)
        self.assertEqual(corroborate_card(self.card, self.ocr)['cards'], self.card['cards'])

    def test_incomplete_vision_is_never_filled_from_ocr(self):
        for field in ('cost', 'type', 'name', 'description'):
            candidate = copy.deepcopy(self.card)
            candidate['cards'][0][field] = None
            self.assertTrue(corroborate_card(candidate, self.ocr)['uncertain'])
        self.card['uncertain'] = True
        self.assertTrue(corroborate_card(self.card, self.ocr)['uncertain'])

    def test_malformed_ocr_and_non_card_shapes(self):
        for parsed in (None, [], {}, {'cards':[None], 'uncertain':False}):
            self.assertTrue(corroborate_card(parsed, self.ocr)['uncertain'])
        for ocr in (None, [], {}, {'lines':None}, {'lines':[line('愤怒'), {'text':'造成4点伤害。', 'confidence':float('nan'), 'box':[]}]}):
            self.assertTrue(corroborate_card(self.card, ocr)['uncertain'])

    def test_hints_align_with_displayed_crop_without_mutating_evidence(self):
        original = copy.deepcopy(self.ocr)
        hints = card_ocr_hints(self.ocr, (250,500,750,1000), (1000,1000))
        self.assertEqual(hints[0], {'text':'愤怒','box':[440,200,560,240]})
        self.assertEqual(self.ocr, original)
        self.assertEqual(corroborate_card(self.card,self.ocr)['cards'],self.card['cards'])

    def test_whole_frame_and_rounded_pixel_crop(self):
        self.assertEqual(card_ocr_hints({'lines':[line('牌')]},(0,0,1000,1000),(1000,1000))[0]['box'],[470,600,530,620])
        item = {'text':'边界', 'confidence':.99, 'box':[[179.15,200],[602.61,200],[602.61,400],[179.15,400]]}
        hints = card_ocr_hints({'lines':[item]},(55,10,185,90),(307,100))
        self.assertEqual(len(hints),1)
        self.assertEqual(hints[0]['box'][0],0)
        self.assertEqual(hints[0]['box'][2],1000)

    def test_hints_exclude_outside_low_confidence_and_invalid_boxes(self):
        ocr={'lines':[line('inside',x=500),line('outside',x=100),line('crossing',x=260),line('uncertain',score=.85),{'text':'bad','confidence':.99,'box':[]}]}
        self.assertEqual([h['text'] for h in card_ocr_hints(ocr,(250,500,750,1000),(1000,1000))],['inside'])
        for bounds in ((0,0,0,10),(-1,0,10,10),(0,0,1001,10),(0,0,float('nan'),10)):
            with self.assertRaises(ValueError):card_ocr_hints(ocr,bounds,(1000,1000))


if __name__ == '__main__':
    unittest.main()
