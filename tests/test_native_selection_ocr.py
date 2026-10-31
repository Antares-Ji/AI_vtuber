import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from native_selection_ocr import corroborate_selection


def line(text,x,y,confidence=.99):
    return {'text':text,'confidence':confidence,'box':[[x-10,y-10],[x+10,y-10],[x+10,y+10],[x-10,y+10]]}


def panel():
    return {'scene':'selection','summary':'选择一张牌','targets':[
        {'id':'a','label':'预备打击','point':[325,560],'enabled':True},
        {'id':'b','label':'尖枪','point':[500,560],'enabled':True},
        {'id':'skip','label':'跳过','point':[500,850],'enabled':True}]}


class SelectionOcrTests(unittest.TestCase):
    def test_unknown_scene_can_be_resolved_by_exact_draw_pile_footer_only(self):
        source={'scene':'unknown','summary':'未知','targets':[]}
        self.assertEqual(corroborate_selection(source,{'lines':[line('每回合开始时会从这里抽牌。',500,930)]})['card_pile_view'],'draw')
        self.assertEqual(corroborate_selection(source,{'lines':[]})['scene'],'unknown')

    def test_draw_pile_footer_is_not_a_reward_and_requires_current_high_confidence_text(self):
        footer=line('每回合开始时会从这里抽牌。',500,930)
        result=corroborate_selection(panel(),{'lines':[footer]})
        self.assertEqual(result['card_pile_view'],'draw');self.assertEqual(result['targets'],[])
        for wrong in [line('每回合开始时会从这里抽牌。',500,500),line('每回合开始时会从这里抽牌。',500,930,.89)]:
            self.assertNotIn('card_pile_view',corroborate_selection(panel(),{'lines':[wrong]}))
        self.assertNotIn('card_pile_view',corroborate_selection(panel(),{'lines':[footer,line('选择一张牌',500,240)]}))
    def test_conflicting_name_is_disabled_without_rewriting_it_as_another_card(self):
        result=corroborate_selection(panel(),{'lines':[line('选择一张牌',500,240),line('预备打击',325,430),line('头槌',500,430),line('跳过',500,850)]})
        self.assertEqual([t['enabled'] for t in result['targets']],[True,False,True])
        self.assertNotIn('尖枪',str(result));self.assertNotIn('头槌',str(result))
        self.assertEqual(result['ocr_check']['scope'],'choose_card_labels_only')

    def test_low_confidence_far_or_ambiguous_text_cannot_authorize_a_target(self):
        for labels in [[line('预备打击',325,430,.89)],[line('预备打击',700,430)],
                       [line('预备打击',325,100)],[line('预备打击',325,430),line('预备打击',330,440)]]:
            result=corroborate_selection(panel(),{'lines':[line('选择一张牌',500,240),*labels]})
            self.assertFalse(result['targets'][0]['enabled'])

    def test_details_without_choose_card_header_are_not_treated_as_reward_selection(self):
        result=corroborate_selection(panel(),{'lines':[line('预备打击',325,430)]})
        self.assertEqual(result['ocr_check']['status'],'not_applicable')
        self.assertEqual(result['targets'],panel()['targets'])

    def test_disabled_targets_stay_disabled_and_normalized_whitespace_is_supported(self):
        source=panel();source['targets'][0]['enabled']=False
        result=corroborate_selection(source,{'lines':[line('选择一张牌',500,240),line('预备 打击',325,430)]})
        self.assertFalse(result['targets'][0]['enabled'])
        self.assertEqual(result['targets'][0]['label_status'],'corroborated')

    def test_invalid_boxes_and_nonfinite_confidence_are_not_evidence(self):
        invalid=line('预备打击',325,430);invalid['box'][0][0]=float('nan')
        result=corroborate_selection(panel(),{'lines':[line('选择一张牌',500,240),invalid,line('预备打击',325,430,float('nan'))]})
        self.assertFalse(result['targets'][0]['enabled'])


if __name__=='__main__':unittest.main()
