import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/sts2'))
from native_card_ocr import corroborate_card


def line(text, x=500, y=600, score=.99):
    return {'text': text, 'confidence': score,
            'box': [[x-30,y], [x+30,y], [x+30,y+20], [x-30,y+20]]}


class CardOcrTests(unittest.TestCase):
    def setUp(self):
        self.card = {'cards': [{'name': '愤怒', 'cost': 0, 'type': '攻击',
                               'description': '造成4点伤害。将一张此牌的复制品加入你的弃牌堆。'}], 'uncertain': False}
        self.ocr = {'lines': [line('愤怒'), line('造成4点伤害。', y=750),
                              line('将一张此牌的复制品加入', y=780), line('你的弃牌堆。', y=810)]}

    def test_complete_rules_with_line_wrapping_and_punctuation(self):
        result = corroborate_card(self.card, self.ocr)
        self.assertFalse(result['uncertain'])
        self.assertEqual(result['cards'], self.card['cards'])
        self.assertEqual(result['ocr_check']['fields'], ['name', 'description'])

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

    def test_truncated_or_conflicting_rules(self):
        self.assertTrue(corroborate_card(self.card, {'lines': self.ocr['lines'][:-1]})['uncertain'])
        partial = copy.deepcopy(self.card)
        partial['cards'][0]['description'] = '造成4点伤害。'
        self.assertTrue(corroborate_card(partial, self.ocr)['uncertain'])
        self.ocr['lines'][1] = line('造成14点伤害。', y=750)
        self.assertTrue(corroborate_card(self.card, self.ocr)['uncertain'])

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


if __name__ == '__main__':
    unittest.main()
