"""Require current-image title, type and complete rules before trusting a card read.

This checks transcription only. It does not select a card, repair its rules from
game knowledge, or establish that a model's card location is actionable.
"""
from native_player_ocr import ocr_lines
import re
import math

CARD_TYPES = {'攻击': '攻击', '技能': '技能', '能力': '能力', '状态': '状态', '诅咒': '诅咒',
              'attack': '攻击', 'skill': '技能', 'power': '能力', 'status': '状态', 'curse': '诅咒'}


def card_type(text):
    return CARD_TYPES.get(compact(text).lower())


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
    if len(titles) > 1:
        # Hover lifts one title above the remaining fanned hand. Duplicate
        # names alone are not a conflict when exactly one title is clearly
        # raised. Still require its own complete type/rules below, and leave
        # input ownership/location to current-frame grounding in the caller.
        raised = [title for title in titles if all(
            other is title or other[2][1] - title[2][3] >= 80
            for other in titles)]
        titles = raised
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
    # Independently check the printed type row. A nonempty VLM string such as
    # "换能" must not authorize a play even when its title and effect agree.
    # Normalize language labels only; never infer type from a name or effect.
    visual_type = card_type(card['type'])
    type_lines = [line for line in body if card_type(line[0])]
    if not visual_type or len(type_lines) != 1 or card_type(type_lines[0][0]) != visual_type:
        return reject('card_type_missing_or_conflicting')
    rules = compact(card['description'])
    if not rules:
        return reject('missing_rules')
    # Exclude only explicit card type labels and bare HUD/cost numerals. Every
    # remaining nearby text line must be accounted for, including trailing rules
    # such as exhaust; a correct damage sentence alone is not a complete card.
    rule_lines = [line for line in body if not card_type(line[0]) and
                  not re.fullmatch(r'\d+(?:[/／]\d+)?', line[0])]
    if not rule_lines or type_lines[0][2][3] > min(line[2][1] for line in rule_lines):
        return reject('card_type_outside_type_row')
    if ''.join(compact(line[0]) for line in rule_lines) != rules:
        return reject('rule_text_missing_or_conflicting')
    return {'cards': [dict(card)], 'uncertain': False,
            'ocr_check': {'status': 'corroborated', 'reason': 'same_frame_title_type_and_complete_rules',
                          'fields': ['name', 'type', 'description']}}
