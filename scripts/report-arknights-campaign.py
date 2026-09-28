"""Aggregate evidence, failures, operator observations and timing without relabeling raw predictions."""
import json,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/arknights-review-20260926'
CAMPAIGN=ROOT/'runtime/vision/campaign-20260926'

def main():
    state=json.loads((OUT/'campaign-state.json').read_text(encoding='utf8'))
    wins={x['stage']:x for x in state['verified_wins']}
    chapters=[];labels=[];defeats=[]
    def stage_order(path):
        try:return tuple(int(part) for part in path.name.split('-'))
        except ValueError:return (999,999)
    for stage in sorted(CAMPAIGN.iterdir(),key=stage_order):
        if not stage.is_dir() or not stage.name[:1].isdigit():continue
        trials=[];operators={}
        for run in sorted(stage.iterdir()):
            if not run.is_dir():continue
            events=[]
            if (run/'events.jsonl').exists():
                for line in (run/'events.jsonl').read_text(encoding='utf8').splitlines():
                    try:events.append(json.loads(line))
                    except json.JSONDecodeError:pass
            summary=json.loads((run/'summary.json').read_text(encoding='utf8')) if (run/'summary.json').exists() else {'status':'running'}
            metrics={'screenshots':sum(e['event']=='capture' for e in events),'model_calls':sum(e['event']=='local_analysis' for e in events),
                     'model_ms':round(sum(e.get('vlm_ms') or 0 for e in events if e['event']=='local_analysis'),1),
                     'landing_elapsed_s':[{'name':e['name'],'elapsed':e.get('t'),'remaining':e.get('remaining')} for e in events if e['event']=='landed']}
            for e in events:
                if e['event']=='operator_analysis':operators[e['name']]=e
                if e['event']=='capture' and e.get('label'):
                    labels.append({'stage':stage.name,'run':run.name,'path':e['path'],'label':e['label'],
                        'utc_ns':e.get('utc_ns'),'source':'program state label; screenshot requires review',
                        'training_eligible':False,'outcome':summary.get('outcome'),'program_error':summary.get('error')})
            trials.append({'run':run.name,'summary':summary,'metrics':metrics,'evidence_directory':str(run)})
            if summary.get('ok') and summary.get('outcome',{}).get('stage')==stage.name:
                wins[stage.name]={'stage':stage.name,'stars':summary['outcome'].get('stars'),'evidence':str(run/'result.png'),
                    'model_summary':str(run/'summary.json'),'verification':'local settlement model; see GPT audit for human-readable visual cross-check'}
        analysis=json.loads((stage/'analysis.json').read_text(encoding='utf8')) if (stage/'analysis.json').exists() else {}
        audit=json.loads((stage/'gpt-audit.json').read_text(encoding='utf8')) if (stage/'gpt-audit.json').exists() else None
        if audit:
            defeats.extend(dict(stage=stage.name,**failure) for failure in audit.get('verified_defeats',[]))
        if stage.name in wins and audit and audit.get('outcome')=='victory' and audit.get('stars') in (1,2,3):
            wins[stage.name]['raw_model_stars']=wins[stage.name].get('stars')
            wins[stage.name]['stars']=audit['stars']
            wins[stage.name]['verification']='Local settlement confirmation plus separate GPT screenshot audit'
        chapters.append({'stage':stage.name,'analysis':analysis,'gpt_audit':audit,'operators_observed':operators,'trials':trials})
    state.update(verified_wins=list(wins.values()),completed_battles=len(wins),status='running',
                 verified_defeats=defeats,confirmed_battle_count=len(wins)+len(defeats),
                 continue_after_0_8=True,stop_condition='User stop, actual usage limit or external blocker; checkpoint package before ending',
                 updated_at=time.strftime('%Y-%m-%d %H:%M:%S %z'))
    if chapters:state['current_stage']=chapters[-1]['stage']
    state['stage_order']=sorted(set(wins)|{c['stage'] for c in chapters},key=lambda value:tuple(map(int,value.split('-'))))
    (OUT/'campaign-state.json').write_text(json.dumps(state,ensure_ascii=False,indent=2),encoding='utf8')
    (OUT/'campaign-analysis.json').write_text(json.dumps(chapters,ensure_ascii=False,indent=2),encoding='utf8')
    (OUT/'current-run-labels.json').write_text(json.dumps(labels,ensure_ascii=False,indent=2),encoding='utf8')
    lines=['# 本轮关卡分析与优化记录','',f'更新：{state["updated_at"]}',
           '','0-8 后继续推进后续主线；跳过 TR 教学关。原始预测与 GPT 核验分开保存。实战采样不等于已训练新权重。',
           '', '已取得当前结算证据：'+ '、'.join(wins),
           '', f'已核验通关关卡 {len(wins)} 个，另有真实战败 {len(defeats)} 场；同一局暂停后恢复的程序尝试不重复计场。',
           '', '速度优化：常驻模型与控制器；YOLO定位卡片；当前绿色格内部校验；暗色姓名局部OCR；方向框检查点恢复；部署完成后识别1X再切2X。',
           '完整首帧到落地时间包含加载、等费用与暂停分析，不能用单次模型推理时间代替。']
    for chapter in chapters:
        lines+=['', '## '+chapter['stage'], '']
        if chapter['gpt_audit']:lines += [json.dumps(chapter['gpt_audit'],ensure_ascii=False,indent=2),'']
        lines+=['| 尝试 | 程序结果 | 截图数 | 模型调用 | 模型累计秒 |','|---|---|---:|---:|---:|']
        for trial in chapter['trials']:
            m=trial['metrics'];summary=trial['summary']
            label='结算胜利' if summary.get('ok') else summary.get('error',summary.get('status','unknown'))
            lines.append(f'| {trial["run"]} | {label} | {m["screenshots"]} | {m["model_calls"]} | {m["model_ms"]/1000:.2f} |')
        lines+=['','程序失败可能只是部署或识别失败，不代表游戏已经战败；恢复同一局的多次尝试不计多场战斗。','',
                '| 当前观察干员 | 攻击 | 防御 | 阻挡 | 技能 | 来源 |','|---|---:|---:|---:|---|---|']
        for name,event in chapter['operators_observed'].items():
            m=event['model'];lines.append(f'| {name} | {m.get("attack")} | {m.get("defense")} | {m.get("block")} | {m.get("skill")}：{m.get("skill_effect")} | 原始本地预测；OCR与截图见JSON |')
        lines+=['','完整地图预测、相似度、12名历史编队技能/范围来源和当前干员观察见 campaign-analysis.json；未知值保留 null。未核验范围不能当训练真值。']
    (OUT/'本轮关卡分析.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
    print(json.dumps({'wins':list(wins),'stages':len(chapters)},ensure_ascii=False))

if __name__=='__main__':main()
