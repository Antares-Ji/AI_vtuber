"""Require current-image title and complete rule text before trusting a card read.

This checks transcription only. It does not select a card, repair its rules from
game knowledge, or establish that a model's card location is actionable.
"""
from native_player_ocr import ocr_lines
import re
import math


def card_ocr_hints(ocr, crop_bounds, original_size):
    """Map original-image OCR boxes into the actual pixel crop shown to the VLM.

    Return hints only; corroboration continues using the original OCR evidence.
    Use rounded pixel bounds from image cropping, not ideal normalized bounds.
    """
    if len(original_size) != 2 or any(type(n) is not int or n <= 0 for n in original_size):
        raise ValueError('Positive original image dimensions required')
    if len(crop_bounds) != 4 or any(type(n) is not int for n in crop_bounds):
        raise ValueError('Integer pixel crop bounds required')
    left, top, right, bottom = crop_bounds
    width, height = original_size
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        raise ValueError('Crop must be inside original image')
    hints = []
    for text, score, box in ocr_lines(ocr):
        if score < .9:
            continue
        mapped = [(box[0]*width/1000-left)/(right-left)*1000,
                  (box[1]*height/1000-top)/(bottom-top)*1000,
                  (box[2]*width/1000-left)/(right-left)*1000,
                  (box[3]*height/1000-top)/(bottom-top)*1000]
        # OCR serializes original normalized points to two decimals. Permit
        # only the corresponding rounding tolerance, not out-of-crop text.
        tolerance = max(width/(right-left), height/(bottom-top))*.0051
        if any(not math.isfinite(n) or n < -tolerance or n > 1000+tolerance for n in mapped):
            continue
        hints.append({'text':text, 'box':[round(max(0,min(1000,n)),2) for n in mapped]})
    return hints[:80]


def compact(text):
    return ''.join(c for c in text if c.isalnum() or c in '+-%％')


def corroborate_card(parsed, ocr):
    def reject(reason):
        return {'cards': [], 'uncertain': True,
                'ocr_check': {'status': 'unknown', 'reason': reason}}
    if not isinstance(parsed, dict) or parsed.get('uncertain') is not False:
        return reject('incomplete_visual_card')
    cards = parsed.get('cards')
    if not isinstance(cards, list) or len(cards) != 1 or not isinstance(cards[0], dict):
        return reject('single_card_required')
    card = cards[0]
    if any(not isinstance(card.get(k), str) or not card[k].strip() for k in ('name', 'type', 'description')) or type(card.get('cost')) is not int or card['cost'] < 0:
        return reject('incomplete_visual_card')
    if not isinstance(ocr, dict) or not isinstance(ocr.get('lines'), list):
        return reject('missing_ocr_lines')
    lines = [line for line in ocr_lines(ocr) if line[1] >= .9]
    titles = [line for line in lines if compact(line[0]) == compact(card['name'])]
    if len(titles) != 1:
        return reject('ambiguous_or_missing_card_title')
    _, _, (x0, y0, x1, y1) = titles[0]
    cx = (x0 + x1) / 2
    # Only nearby text below the identified title may corroborate its rules.
    # A neighboring card's title/type/effect cannot be concatenated by the VLM.
    body = sorted([line for line in lines if line[2][1] > y1 and
                   line[2][3] - y1 <= 450 and
                   abs((line[2][0] + line[2][2]) / 2 - cx) <= 70],
                  key=lambda line: (line[2][1], line[2][0]))
    rules = compact(card['description'])
    if not rules:
        return reject('missing_rules')
    # Exclude only explicit card type labels and bare HUD/cost numerals. Every
    # remaining nearby text line must be accounted for, including trailing rules
    # such as exhaust; a correct damage sentence alone is not a complete card.
    rule_lines = [line for line in body if line[0] not in ('攻击', '技能', '能力') and
                  not re.fullmatch(r'\d+(?:[/／]\d+)?', line[0])]
    if ''.join(compact(line[0]) for line in rule_lines) != rules:
        return reject('rule_text_missing_or_conflicting')
    return {'cards': [dict(card)], 'uncertain': False,
            'ocr_check': {'status': 'corroborated', 'reason': 'same_frame_title_and_complete_rules',
                          'fields': ['name', 'description']}}
