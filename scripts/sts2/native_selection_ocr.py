"""Cross-check labels on a visible choose-a-card panel; never choose a card."""
import math
import unicodedata


def text_key(value):
    return ''.join(unicodedata.normalize('NFKC', value).split()) if isinstance(value, str) else ''


def usable_lines(ocr):
    output = []
    for line in ocr.get('lines', []) if isinstance(ocr, dict) else []:
        if not isinstance(line, dict):
            continue
        confidence, box = line.get('confidence'), line.get('box')
        if type(confidence) not in (int, float) or not .9 <= confidence <= 1:
            continue
        if not isinstance(box, list) or len(box) != 4 or any(
            not isinstance(p, list) or len(p) != 2 or any(
                type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1000 for v in p
            ) for p in box
        ):
            continue
        label = text_key(line.get('text'))
        if label:
            output.append((label, sum(p[0] for p in box) / 4, sum(p[1] for p in box) / 4))
    return output


def corroborate_selection(parsed, ocr):
    if not isinstance(parsed, dict) or parsed.get('scene') not in ('selection', 'unknown'):
        raise ValueError('Selection or unknown scene required')
    lines = usable_lines(ocr)
    header = any(label == '选择一张牌' and 250 <= x <= 750 and 100 <= y <= 400 for label, x, y in lines)
    draw_pile = any(label.rstrip('。.') == '每回合开始时会从这里抽牌' and 250<=x<=750 and 850<=y<=980 for label,x,y in lines)
    if draw_pile and not header:
        return {'scene':'selection','summary':'正在查看抽牌堆，不是奖励选牌；卡牌列表不能打出或领取。',
                'targets':[], 'card_pile_view':'draw',
                'ocr_check':{'status':'corroborated','scope':'draw_pile_view'}}
    if not header:
        return {**parsed, 'ocr_check': {'status': 'not_applicable', 'reason': 'no_choose_card_header'}}
    targets = []
    for target in parsed['targets']:
        x, y = target['point']
        matches = [(name, lx, ly) for name, lx, ly in lines
                   if name == text_key(target['label']) and abs(lx - x) <= 100 and abs(ly - y) <= 250]
        supported = len(matches) == 1
        targets.append({**target, 'enabled': target.get('enabled', True) and supported,
                        'label': target['label'] if supported else '未核对的选牌候选（不可点击）',
                        'label_source': 'local_ocr' if supported else 'unconfirmed',
                        'label_status': 'corroborated' if supported else 'conflict_or_missing'})
    return {**parsed, 'targets': targets, 'ocr_check': {'status': 'checked', 'scope': 'choose_card_labels_only'}}
