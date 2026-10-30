"""Normalize model coordinates to the original screenshot, never invent targets."""
import math

def scene_observation(parsed):
    if not isinstance(parsed, dict) or 'points' not in parsed: return parsed
    points=parsed['points']
    if not isinstance(points,list) or len(points)>8: raise ValueError('Invalid scene target list')
    targets=[]
    for index,item in enumerate(points):
        if not isinstance(item,list) or len(item)!=3 or not isinstance(item[0],str) or not item[0].strip():
            raise ValueError('Scene coordinates require visible target labels')
        targets.append({'id':'t'+str(index+1),'label':item[0],'point':whole_point(item[1:]),'enabled':True})
    return {**{key:value for key,value in parsed.items() if key!='points'},'targets':targets}

def whole_point(point, crop=None):
    if not isinstance(point, list) or len(point) != 2 or any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1000 for v in point):
        raise ValueError('Invalid model point')
    if crop is None: return point
    return [(crop[0] + point[0] / 1000 * (crop[2] - crop[0])) * 1000,
            (crop[1] + point[1] / 1000 * (crop[3] - crop[1])) * 1000]

def hand_targets(parsed, crop=None):
    if not isinstance(parsed, dict) or not isinstance(parsed.get('cards'), list) or len(parsed['cards']) > 12:
        raise ValueError('Missing bounded hand observations')
    targets = []
    for index, card in enumerate(parsed['cards']):
        if not isinstance(card, dict): raise ValueError('Invalid card observation')
        point = whole_point(card.get('point'), crop)
        name = card.get('name') if isinstance(card.get('name'), str) else None
        cost = card.get('cost')
        if type(cost) is not int or not 0 <= cost <= 99: cost = None
        targets.append({'id': 'hand-' + str(index + 1), 'kind': 'card',
                        'label': name or '未读清的手牌', 'point': point, 'enabled': True,
                        'card': {'name': name, 'cost': cost, 'type': None, 'description': None}})
    return targets
