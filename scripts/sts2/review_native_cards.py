"""Persist screenshot-reviewed labels separately from raw model output."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'runtime/game-input/learning'
# These labels were read from the saved hover screenshots during this live run.
labels={
'1793034575006013900':('痛击',2,'攻击','造成8点伤害。给予2层易伤。'),
'1793034635542156700':('燃烧契约+',1,'技能','消耗1张牌。抽3张牌。'),
'1793034762301815400':('战斗专注',0,'技能','抽3张牌。你在本回合内不能再抽任何牌。'),
'1793034820401297600':('打击',0,'攻击','造成9点伤害。永恒。'),
'1793034856827403300':('愤怒',0,'攻击','造成6点伤害。将一张此牌的复制品加入你的弃牌堆。'),
'1793034948973673700':('巨像',1,'技能','获得5点格挡。在本回合中，有易伤状态的敌人对你造成的伤害降低50%。'),
'1793034965733212000':('武装',1,'技能','获得5点格挡。升级你手牌中的一张牌。'),
'1793035143645081600':('狂怒',0,'技能','打出此牌后，你在这个回合内每打出一张攻击牌，获得3点格挡。'),
'1793035221810597200':('防御',1,'技能','获得5点格挡。'),
'1793035325936802000':('耸肩无视',1,'技能','获得8点格挡。抽1张牌。'),
'1793035372944939000':('岿然不动',2,'技能','获得30点格挡。消耗。'),
'1793035535061740800':('剑柄打击',1,'攻击','造成9点伤害。抽1张牌。'),
'1793035565378868800':('御血术',1,'攻击','失去2点生命。造成15点伤害。'),
'1793035827954628800':('惊逃+',1,'能力','在你的回合结束时，随机打出你手牌中的1张攻击牌攻击随机敌人。'),
'1793036828936668900':('痛殴',1,'攻击','造成4点伤害两次。消耗你的手牌中随机一张攻击牌，并将它的伤害添加给这张牌。'),
'1793041407039103300':('武装+',1,'技能','获得5点格挡。升级你手牌中的所有牌。'),
}
rows=[]
for file in sorted(BASE.glob('vision-*.json')):
    raw=json.loads(file.read_text(encoding='utf-8'));run=Path(raw['source_image']).parent.name
    if run not in labels or raw.get('target') not in ('',None,'None'):continue
    name,cost,kind,description=labels[run]
    expected={'name':name,'cost':cost,'type':kind,'description':description}
    cards=(raw.get('parsed') or {}).get('cards') or []
    rows.append({'source_image':raw['source_image'],'crop':raw.get('crop'),'model_record':str(file),'model':raw['model'],'seconds':raw['seconds'],'observed_card':expected,'raw_card':cards[0] if cards else None,'exact_fields_match':bool(cards and cards[0]==expected),'review_method':'Codex visual review of saved screenshot','training_performed':False,'scope':'current run; relic modifiers may change card values'})
(BASE/'reviewed-cards.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'reviewed_observations':len(rows),'unique_cards':len(set(r['observed_card']['name'] for r in rows)),'exact_matches':sum(r['exact_fields_match'] for r in rows),'output':str(BASE/'reviewed-cards.json')},ensure_ascii=False))
