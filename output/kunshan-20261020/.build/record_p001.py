from pathlib import Path
import json

build = Path(__file__).resolve().parent
prefix = (build / 'revise_plan.py').read_text(encoding='utf-8').split('# The revised plan follows')[0]
exec(compile(prefix, str(build/'revise_plan.py'), 'exec'))
header.text = '潮生智能    姬岁歌受众调研'
footer.runs[0].text = '2026年10月22日    '
for run in header.runs: run.font.size = Pt(8)
for run in footer.runs: run.font.size = Pt(8)
p('姬岁歌受众前测访谈记录', style='Title')
p('P001  首份前测口述整理', style='Subtitle')
p('本记录整理受访者的既往观看习惯，用于后续样片体验分层和访谈追问。当前完成前测口述采集，样片观看、自由选择与七天回访接续开展。')
table(['题项','已记录回答','待补信息'],[
['Q1 参与条件','本段口述尚未涉及。','成年确认及参与同意。'],
['Q2 观看频率','每周4次以上，主要因赛事直播观看；口述提到VCT CN。','确认所看的VUP主持或虚拟主播内容。'],
['Q3 内容类型','游戏直播、AI内容。',''],
['Q4 单次时长','直播通常超过30分钟。','长视频时长可另问。'],
['Q5 主动回看','创作者：航航 hang。原因：关闭弹幕后直播较安静，专心讲解比赛，且“福利比较好”。','账号链接及“福利”的具体含义。'],
['Q6 AI主播经验','回答未看过Neuro-sama、Lumi/Nox。','AI主播总体熟悉程度的选项。'],
['Q7 项目关系','认识项目成员；招募关系为舍友。','是否参与过项目制作。'],
['Q8 创作者付费','有付费，受访者表示较少。','礼物、会员、周边等类别；金额自愿回答。'],
['Q9 计时与回访','访谈者估计问答约3分钟。','研究计时同意、七天回访同意；实际起止未记录。'],
],[3.1,8.2,5.4])
h('初步受众画像与下一步')
p('该受访者经常观看赛事直播，对安静、聚焦比赛讲解的内容有明确偏好，同时接触游戏与AI内容。暂按游戏与AI兴趣候选样本整理；确认VUP观看范围后再分层。熟人关系在分析中单列。')
p('后续样片重点观察：AI与真人的对话是否干扰任务理解，节奏是否舒适，以及角色互动能否提供再次观看的理由。记录自由观看时长、具体片段回忆和实际回访。')
p('补问顺序：成年与参与同意 → 是否参与制作 → 计时及回访同意 → VUP观看范围与AI主播熟悉程度 → 付费类别。', bold=True)
out = ROOT/'research'/'姬岁歌-受众前测记录-P001.docx'
out.parent.mkdir(parents=True,exist_ok=True)
doc.core_properties.title = '姬岁歌受众前测访谈记录'
doc.core_properties.author = '潮生智能团队'
doc.save(out)
record = {
  'participant_id':'P001', 'recorded_on':'2026-10-22',
  'status':'前测口述已整理，参与条件与同意待确认',
  'recruitment_relationship':'项目成员舍友，熟人样本',
  'cohort':'待确认VUP观看范围，游戏AI兴趣候选',
  'age18_confirmed':None,'participation_consent':None,'project_contributor':None,
  'Q2':{'answer':'每周4次以上','option':'D','context':'主要因赛事直播，口述提到VCT CN','vup_scope_confirmed':False},
  'Q3':{'answers':['游戏直播','AI内容'],'options':['A','D']},
  'Q4':{'answer':'直播超过30分钟','option':'D','long_video_answer':None},
  'Q5':{'creator':'航航 hang','user_correction_raw':'航航hang行、','account_url':None,'reason':'关闭弹幕后直播较安静，专心讲解比赛，福利比较好','benefits_meaning':None},
  'Q6':{'overall_familiarity':None,'neuro_watched':False,'lumi_nox_watched':False},
  'Q7':{'knows_project_member':True,'project_contributor':None},
  'Q8':{'paid_before':True,'description':'较少','categories':None,'amount':None},
  'Q9':{'timing_consent':None,'followup_consent':None,'estimated_interview_minutes':3,'estimate_source':'访谈者口述估计','actual_duration_sec':None},
  'required_watch_sec':None,'optional_watch_sec':None,'return7d':None,'quote_permission':None,
  'sample_watch_status':'尚未记录样片体验',
}
(out.parent/'P001-pretest.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
print(out)
