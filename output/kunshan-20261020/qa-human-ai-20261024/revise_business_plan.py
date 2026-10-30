from copy import deepcopy
from pathlib import Path
import json

from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'final/昆山杯-潮生智能-商业计划书.docx'
OUTPUT = ROOT / 'final/昆山杯-潮生智能-商业计划书-人机共播修订版.docx'
doc = Document(SOURCE)
paras = list(doc.paragraphs)
tables = list(doc.tables)
changes = []

def replace(i, text):
    p = paras[i]
    old = p.text
    rpr = deepcopy(p.runs[0]._r.rPr) if p.runs and p.runs[0]._r.rPr is not None else None
    p.clear()
    run = p.add_run(text)
    if rpr is not None:
        run._r.insert(0, rpr)
    changes.append({'paragraph': i, 'before': old, 'after': text})

replacements = {
3: '姬岁歌真人与AI共同直播及互动内容IP',
11: '潮生智能以原创角色姬岁歌为核心，打造真人与AI共同直播的互动娱乐节目。真人主动策划情境、制造笑点并把握现场节奏，AI结合角色性格作出回应与游戏选择。观众在两者的合作、分歧和相互理解中，持续认识角色与搭档。',
12: '项目从Bilibili直播与视频切片起步，通过人机互动名场面吸引观看，以连续节目和观众共创积累回访，再发展月度会员、纪念周边、品牌主题直播与游戏合作。真人的表达与现场判断、AI的即兴反应与角色记忆，共同构成内容产品。',
38: '姬岁歌拥有岁与歌两种人格表达。真人搭档主动设计挑战、抛出有趣的问题、制造可展开的分歧；AI按性格接梗、作出选择并承担游戏结果。节目既呈现AI的好奇、坚持与成长，也保留真人的惊讶、胜负欲和关心。直播高光剪成短片，再以任务后续吸引观众回到下一场。',
48: '第一层是娱乐：真人主动造梗、AI即兴接梗和真实游戏结果构成完整片段。第二层是参与：观众的建议进入挑战，结果在节目中得到回应。第三层是关系：观众看见AI怎样坚持、认错和兑现约定，也看见真人怎样惊讶、让步和支持搭档，从而期待下一次互动。',
75: '从音乐型VUP学习辨识标签，从游戏与杂谈型学习临场表达，从跨语言主播学习本土化互动，从双人组合学习关系推进。姬岁歌将这些经验落实为真人主动造梗、AI按性格回应、行动产生结果、共同经历下次接续，并用试播检验观众能否记住并愿意回来。',
86: '姬岁歌的节目主张是真人与AI一起完成可追踪的任务。真人持续创造值得回应的处境，AI在回答和行动中呈现性格，观众能够影响进程。双人格增加不同视角，真人搭档通过提问、接梗和追问结果，让人机关系成为可持续观看的内容。',
90: '姬岁歌的设定以岁与歌的平级关系为基础。岁偏向观察和理解，歌偏向选择和守护。她们在好奇、犹豫、坚持和兑现承诺中呈现人性化的一面；真人搭档以真实反应和现场选择回应，让双方关系随共同经历推进。',
93: '人机搭档：真人先设挑战、抛梗或作出预测，AI回应并执行。人格选择：岁与歌对同一局面给出不同判断，由真实结果展开讨论。观众共创：从弹幕选出可执行建议，完成后回应贡献者。成长连载：回顾上次失误或约定，让观众看见选择如何变化。',
95: '开播前明确当晚任务、角色立场，以及真人可主动设置的分歧和追问。策划准备触发条件与备用话题，给AI保留即兴回答和行动空间。场后记录观众记住的台词、真人反应和角色选择；人格切换由场景条件与导演判断共同控制。',
103: '第一分钟由真人提出木剑挑战，半开玩笑地问“你要先做队长还是先干活”。随后三分钟观察AI如何理解、回应并执行，真人结合实际进度追问。第五分钟核对库存，回收开场的梗并确认候选记忆；最后一分钟切换另一场次的上下文，检查能否准确接续约定。以上为拟试播脚本，完成后保存录屏与日志。',
105: '观众能带走一个有起因和结果的笑点、对人机搭档性格的认识，以及下一场约定。验收询问观众分别记住真人和AI的哪次反应、是否理解关系变化，并记录自愿继续观看。工程功能服务于这些完整片段和实际观看行为。',
111: '研发优先解决打断、重复说话、状态误读和执行中断，再打磨人格差异、语音情绪和接话节奏。每项功能对应具体节目问题：AI是否理解真人抛出的梗，能否保留自己的立场，口播是否符合实际行动，以及下一场能否准确提起共同经历。',
125: '下一阶段交付一场有亮点的人机共同直播。先制作10至15分钟样例，检验真人主动造梗、AI回应、真实结果和场后回收能否连贯，再扩展到30分钟、60分钟及完整场次。每周把观众最想继续看的部分与技术问题汇总为片段清单和修改记录。',
129: '完成原创形象首版、可辨识的双人格表达及稳定语音与游戏链路，形成3场内部试播、至少10个可用切片候选和一轮校内反馈。样例需包含真人主动造梗、AI按性格接话及任务结果；核对有效片段和回访后，再开始固定公开排期。',
132: '公开运营采用真人与AI共同直播，每周五天于北京时间20:00开播，初期每场约2小时。真人承担共同主演与主持职责，主动造梗、设置挑战并表达真实反应；姬岁歌负责角色回应、选择与游戏行动，导演关注技术状态、节奏及商业交付。',
136: '真人主动造梗并引导高光',
137: '每场准备可由真人主动发起的挑战、角色分歧和观众预测。真人抛出情境后，给AI接话和行动空间，再用结果回收笑点。每个笑点都应能追溯到现场互动；技术异常按应急流程处理，恢复后继续节目。',
139: '导演提交带时间戳的3至5个高光候选，标明真人抛梗、AI回应与结果。张乐溪选择因果完整的片段剪辑，运营记录观众使用的梗、退出点与下场期待；商业场另核对品牌信息、约定素材和交付清单。',
146: '每周发布4至5条重点切片，全年约200条，同步制作竖屏版本。优先选择真人抛梗、AI反应和真实结局构成的完整互动，让新观众迅速理解双方关系。保留反转、关心与角色变化，用后续任务预告引导回访，并统一系列标题和封面。',
164: '每周组织一次任务投票与共同事件回顾，收集观众建议和梗的二次创作。记录可采用的观众贡献与来源，下一场反馈使用结果。欢迎、投稿、问题反馈和重要说明入口由运营维护，使观众参与持续进入节目。',
170: '项目经营真人与AI搭档形成的角色关系和互动内容。前期通过节目、切片和社群积累回访，接受直播打赏；约10万主阵地粉丝后逐步推出会员、周边及品牌主题直播。人机共播的商业效果用实际留存、传播和合作交付验证，具体功能依平台规则办理。',
173: '会员围绕表情、纪念徽章、幕后内容和活动参与设计，公开节目保持可持续观看。周边优先选择角色立牌、徽章与纪念卡，使用观众能认出的台词、共同任务和人机名场面；小批量预售并明确交期，以复购和履约检验需求。',
174: '商业直播如何为合作方提供价值',
175: '拟提供品牌主题挑战、游戏体验回和联合任务。真人解释合作信息、演示并追问，AI从角色视角作出选择和回应，观众参与投票。每次合作约定直播段落、重点切片、素材使用和效果报告；报价依据实际观众数据及交付范围制定。',
177: '打赏和会员按平台到账记录，周边分列销售与履约成本，合作按合同节点收款。商业场逐次记录策划、真人工时、模型语音、剪辑和运营投入，核算单次贡献与回款周期，同时复盘观看、回访及合作续约。',
186: '每次合作围绕可参与的任务组织直播、切片与社群活动。真人把品牌主题转成可理解的挑战，AI保留角色立场，新老观众共同影响进程。场后报告交付完成情况、观看与参与数据，并跟踪下一场回访和合作续约。',
192: '每周项目会确认节目、版本及真人主持轮值。播前由主持、人格运营和导演共同审阅任务、抛梗机会、AI表达及备选话题；商业场增加交付核对。场后按观众反馈、片段效果和技术故障安排下一轮修改，项目管理维护负责人及版本记录。',
200: '按每周五天、全年约50周排期，计划约250场、500小时播出，对应日常现金预算约208元每场、104元每小时。此口径包含剪辑传播与社群现金支出，成员工时另记。共播效率需同时观察有效片段、回访及真人投入，公开运营起点与休播会影响场次数量。',
202: '投流先选择自然反馈良好的片段，社群预算保障日常回应与活动。模型和语音按场统计，减少无效重复调用。结合真人主持、策划及剪辑工时，核算每个有效切片和回访观众的投入，再决定栏目复用与商业报价。',
227: '内部试播分别评价真人主动造梗、AI接梗、双方人性化表现和完整任务的吸引力。观众反馈对应具体时间戳，导演记录笑点是否被理解、哪次反应值得分享，研发处理影响体验的问题，运营以自由观看和回访筛选栏目。',
230: '账号简介、直播说明及适当画面位置清晰说明AI角色与真人搭档分工。AI的情绪与性格属于角色表达；节目呈现可观察的回应和选择。真人保留真实观点，尊重观众自主选择，社群围绕共同兴趣与创作开展，付费权益清楚可核对。',
243: '观众、收入和预算采用首年目标口径，后续按月用实际观看与收支更新。共播优势、主动造梗和商业合作产品在内部试播与公开运营中逐项验证，保留版本、录屏、参与及履约记录。公开案例的日期与规模口径见下一章。',
}
for i, text in replacements.items():
    replace(i, text)

def cell(t, r, c, text):
    p = tables[t].cell(r, c).paragraphs[0]
    rpr = deepcopy(p.runs[0]._r.rPr) if p.runs and p.runs[0]._r.rPr is not None else None
    p.clear()
    run = p.add_run(text)
    if rpr is not None:
        run._r.insert(0, rpr)

cell(0,1,1,'真人与原创AI角色姬岁歌共同直播，以主动造梗、即兴回应、游戏任务和连续经历形成节目。')
cell(2,1,1,'真人设局造梗，AI按性格回应并行动，让观众看到完整结果。')
cell(2,2,1,'AI的好奇、坚持与认错，真人的惊讶、胜负欲与关心，通过具体互动被看见。')
cell(6,2,3,'真人主动造梗，与同体岁和歌共同完成任务，围绕真实结果推进关系。')
cell(7,4,0,'真人共同主演与导演协作')
cell(7,4,1,'已有取消、停止、记忆审核和状态入口；主动造梗与控场流程进入试播。')
cell(7,4,2,'真人能创造话题、回应AI并推进任务，异常时接住节目。')
cell(7,4,3,'有效互动片段、自由观看、中断时长、主持工时与退出点。')
cell(13,2,1,'真人设挑战并抛梗，AI回应、选择并完成主游戏任务。')
cell(13,2,2,'真人铺垫、AI即兴反应及真实结果构成完整片段。')
cell(13,4,1,'完成挑战或品牌主题任务，回收前半场的预测与分歧。')
cell(13,4,2,'角色选择、真人真实反应和结果回收形成高光。')
cell(15,2,1,'两段各6分钟样片，15人A/B、15人B/A；同轮只测试一项变化。')
cell(19,5,2,'双人格表达、人性化互动与造梗企划，记忆审核及日常社群维护。')
cell(19,6,2,'受众调研、共播效果分析、品牌方案与交付数据、活动增长。')
cell(19,9,2,'筛选抛梗与接梗片段，制作重点视频、商业素材和系列包装。')
cell(23,2,1,'复核人格归属、造梗企划、台词与游戏结果；区分角色表达与实际状态。')
cell(23,5,1,'核对合作信息、真人解释和AI表达，按合同交付直播、切片与效果报告。')

def p(text, style='Normal'):
    el = doc.add_paragraph(text, style)
    return el._p

def table(headers, rows, widths):
    t = doc.add_table(rows=1, cols=len(headers))
    t.autofit = False
    total = sum(widths)
    for i,w in enumerate(widths):
        t.columns[i].width = Cm(w)
    for j,h in enumerate(headers):
        t.rows[0].cells[j].text = h
    for row in rows:
        cells = t.add_row().cells
        for j,s in enumerate(row): cells[j].text = s
    for ri,row in enumerate(t.rows):
        trpr = row._tr.get_or_add_trPr()
        cant = OxmlElement('w:cantSplit'); trpr.append(cant)
        if ri == 0:
            repeat=OxmlElement('w:tblHeader'); trpr.append(repeat)
        for ci,c in enumerate(row.cells):
            c.width = Cm(widths[ci])
            c.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            tcpr=c._tc.get_or_add_tcPr()
            shd=OxmlElement('w:shd'); shd.set(qn('w:fill'),'173F4B' if ri == 0 else ('F2F5F6' if ri%2 == 0 else 'FFFFFF')); tcpr.append(shd)
            borders=OxmlElement('w:tcBorders')
            for side in ['top','left','bottom','right']:
                e=OxmlElement('w:'+side); e.set(qn('w:val'),'single'); e.set(qn('w:sz'),'4'); e.set(qn('w:color'),'D9D9D9'); borders.append(e)
            tcpr.append(borders)
            margins=OxmlElement('w:tcMar')
            for side,val in [('top','95'),('bottom','95'),('left','100'),('right','100')]:
                e=OxmlElement('w:'+side); e.set(qn('w:w'),val); e.set(qn('w:type'),'dxa'); margins.append(e)
            tcpr.append(margins)
            for para in c.paragraphs:
                para.paragraph_format.space_before = Pt(0)
                para.paragraph_format.space_after = Pt(0)
                para.paragraph_format.line_spacing = 1.12
                for run in para.runs:
                    run.font.name='Microsoft YaHei'; run._element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'),'Microsoft YaHei')
                    run.font.size=Pt(9)
                    run.font.bold = ri == 0
                    run.font.color.rgb=RGBColor.from_string('FFFFFF' if ri == 0 else '20343C')
    return t._tbl

def new_page_before(anchor_index, elements):
    # Insert after the source page break, which immediately precedes the anchor.
    anchor=paras[anchor_index]._p
    for el in elements:
        anchor.addprevious(el)
    br=doc.add_paragraph(); br.add_run().add_break(__import__('docx').enum.text.WD_BREAK.PAGE)
    anchor.addprevious(br._p)

new_page_before(43, [
    p('人和AI共同直播的优势','Heading 1'),
    p('真人与AI搭档的价值来自互相触发：真人理解现场、主动设题并组织情节，AI从角色视角给出回应和行动。节目围绕双方关系持续推进，技术能力由此转化为可观看、可剪辑和可合作的内容。以下是团队的产品判断，需要试播数据验证。'),
    table(['比较维度','真人直播常见条件','AI独立直播需解决的问题','本项目共播设计'],[
        ['话题与节奏','可依现场经验追问、转场。','低信息时可能重复或失去任务。','真人设题、造梗与转场，AI围绕任务回应。'],
        ['角色与反差','依靠个人经历与表达形成辨识。','需要通过行动保持性格和上下文。','真人与AI的不同理解带来反差，结果检验选择。'],
        ['连续关系','通过经历与观众建立熟悉感。','需要可靠记忆和明确的接续内容。','真人确认事件，AI在后续节目兑现约定。'],
        ['商业交付','可解释信息、演示并现场协调。','品牌事实、节奏和临场处置需监督。','真人负责信息与控场，AI参与角色化任务。'],
    ],[2.0,4.0,4.1,6.5]),
    p('共播优势怎样转化为经营价值','Heading 2'),
    p('完整互动片段用于切片获客，角色关系与未完成任务用于推动回访，共同语言和观众贡献用于社群经营。形成稳定受众后，主题任务可承接商业直播，名场面可延伸为会员内容和纪念周边。各环节分别记录观看、回访、参与及实际回款，避免把热闹直接等同于收益。'),
    p('验证共播效果与投入','Heading 2'),
    p('首轮先验证共播节目能否吸引观众；后续用任务、时长与制作条件接近的样片，比较真人主导、AI主导和共播片段，并记录既往观看习惯。重点看自由观看、完整片段回忆、七天回访与每个有效切片的投入。真人主持、策划和审核工时计入经营评估，现阶段不预设共播必然降低成本。'),
])

new_page_before(99, [
    p('AI与真人的人性化表现','Heading 1'),
    p('观众需要从具体互动中理解角色在意什么。姬岁歌的人性化通过好奇、犹豫、坚持、承认失误和兑现约定来呈现，真人搭档则保留真实的惊讶、困惑、胜负欲和关心。双方可以提出不同意见，关系随实际选择变化。'),
    table(['人物侧面','AI的角色表达','真人的现场回应','观众可观察的变化'],[
        ['好奇与理解','岁追问观众为何提出某个建议。','解释自己的动机，邀请她试一次。','角色能否理解他人理由并调整选择。'],
        ['坚持与取舍','歌说明为什么想继续挑战。','表达担心，商量可接受的风险。','双方从分歧走向一个明确决定。'],
        ['失误与认错','承认刚才判断与结果有偏差。','承认自己的预测也可能出错，一起复盘。','失误有后续行动，玩笑不靠持续羞辱。'],
        ['关心与互助','任务受挫时回应搭档，提出下一步。','及时解释困境，给AI表达和行动空间。','相互支持落实到任务与节目选择。'],
        ['约定与成长','记起确认过的目标，说明进展。','指出与上一场的差别，兑现自己的承诺。','老观众看见接续，新观众理解变化。'],
    ],[2.1,4.7,4.9,4.9]),
    p('拟试播片段 木剑队长','Heading 2'),
    p('真人问：“你要先做队长还是先干活？”AI可以认真解释，也可以把任务交还给搭档。真人根据即时回答追问；若木剑制作成功，就回收“队长资格”的玩笑，若未成功，就一起核对缺少的材料。笑点、关心和胜负欲都依实际反应展开，台词示例不计作已完成成果。'),
    p('表达与验收边界','Heading 2'),
    p('AI情绪属于角色表达，实际能力和游戏进度以可核对结果为准。试播分别询问观众记住了AI和真人的哪次反应、能否解释双方为何改变决定，再核对录屏时间戳及七天回访。只会复述设定而记不住互动时，优先修改场景和表达。'),
])

new_page_before(141, [
    p('真人主动造梗与AI即兴接梗','Heading 1'),
    p('真人承担内容创作者与共同主演职责。每场准备可触发互动的情境，主动设问、提出带有反差的目标或邀请观众预测。AI回答和行动保持即兴，真人再依据结果追问、让步或反击。策划提供发生趣事的机会，导演负责节奏与必要的接管。'),
    table(['环节','真人与导演的工作','AI与观众的空间','保留记录'],[
        ['播前准备','明确任务、抛梗切入点和备用话题。','设定角色目标，不预写全部回答。','任务卡、角色立场与触发条件。'],
        ['主动抛梗','提出可理解的分歧、预测或反向挑战。','AI先表态，观众投票或提供建议。','抛梗时刻、原问题与弹幕来源。'],
        ['即兴展开','听完回答再追问，让AI完成短行动。','允许拒绝、反问及不同选择。','接话等待、真人介入与实际动作。'],
        ['结果回收','用真实结果回应开场预测和分歧。','AI解释选择，观众评价或提出续集。','结果、完整片段及观众反应。'],
        ['场后复用','选择切片，审核共同事件并更新企划。','被采用的建议在下一场得到回应。','切片时间戳、记忆来源与后续目标。'],
    ],[2.0,5.2,5.1,4.3]),
    p('可持续使用的栏目原型','Heading 2'),
    p('“谁来当队长”让真人与AI先给出不同方案，再用游戏结果讨论；“你猜她会怎么选”邀请观众预测双人格面对同一局面的反应；“上次的承诺”回访未完成任务和老梗。每个栏目保留明确入口与结尾，内容随真实事件更换，避免反复要求AI给出同一个笑点。'),
    p('如何判断主动造梗有效','Heading 2'),
    p('导演记录每个预设触发点是否被理解、是否展开为完整互动、是否成为可用切片，以及观众在哪一刻退出。每场保留3至5个高光候选，候选不直接视为成片。后续比较有无主动抛梗的同类样片，结合自由观看、回访与真人工时，决定保留和调整哪些设计。'),
])

new_page_before(179, [
    p('商业直播的合作产品与交付','Heading 1'),
    p('商业直播围绕真人与AI共同完成的任务设计。真人提供信息解释、现场演示和节奏控制，AI以角色视角参与体验与讨论，观众通过预测、投票或挑战建议进入节目。合作目标是形成可观看的内容与可核对的交付，报价以真实受众数据、制作工时和素材使用范围为基础。'),
    table(['合作产品','节目设计与分工','拟约定交付','效果观察'],[
        ['品牌主题挑战','真人介绍主题和体验事实，AI参与受主题约束的选择。','主题直播段落、重点切片、约定素材。','观看、参与、切片表现及约定的点击数据。'],
        ['游戏体验回','真人说明规则并制造分歧，AI操作或判断，观众预测。','体验直播、结果片段与活动总结。','停留、评论主题及可获取的体验入口数据。'],
        ['联合系列栏目','围绕同一主题安排多场任务，回收上场约定。','系列场次、连载切片及阶段报告。','跨场回访、参与延续与合作续约。'],
        ['角色与内容授权','选择已被观众识别的形象、台词或共同事件。','经确认的授权素材、用途及期限。','履约、实际结算和后续合作意向。'],
    ],[2.4,5.5,4.9,3.8]),
    p('从合作需求到结案','Heading 2'),
    p('市场运营确认目标人群、主题和评价方式；主持、人格运营与导演共同编排任务、信息点及备选话题；播前核对事实和约定表达，播中标记交付时间戳，播后提交切片与效果报告。AI的即兴表达由真人跟进，涉及产品事实和合作承诺的内容由真人确认。'),
    p('收入与成本如何落到单次合作','Heading 2'),
    p('商业报价计入策划与真人工时、模型语音、剪辑、运营及素材使用要求。按平台可取得的数据报告观看和参与，只有具备商家或平台归因数据时才报告转化。首年按2次、每次5000元的目标测算，实际收入以签约和结算为准；达到经营节点后用实际报价、结算和续约更新。'),
    p('经营优先级','Heading 2'),
    p('优先选择能进入既有栏目、符合角色与受众兴趣的合作，再决定是否扩展系列和授权。商业段落与日常节目使用相同的回访指标，出现持续流失时复盘频次和内容安排。会员、周边与合作分别核算，避免将同一传播结果重复计为收入。'),
])

# The source has a static table of contents. Page numbers are refreshed from the rendered PDF.
toc_pages = [3,5,7,11,14,16,17,19,20,22,24,25,26,27,28,29,30,31]
for index,page in enumerate(toc_pages, start=16):
    title=paras[index].text.split('\t')[0]
    replace(index,f'{title}\t{page}')
for index,label,page in [(16,'人和AI共同直播的优势',4),(19,'AI与真人的人性化表现',12),(23,'真人主动造梗与AI即兴接梗',18),(25,'商业直播的合作产品与交付',23)]:
    new=deepcopy(paras[index]._p)
    from docx.text.paragraph import Paragraph
    added=Paragraph(new,paras[index]._parent)
    added.clear(); added.add_run(f'{label}\t{page}')
    added.paragraph_format.left_indent=Cm(0.45)
    for run in added.runs: run.font.size=Pt(9)
    paras[index]._p.addnext(new)
for section in doc.sections:
    for container in [section.header,section.footer]:
        for para in container.paragraphs:
            for run in para.runs:
                if '2026年10月21日' in run.text:
                    run.text=run.text.replace('2026年10月21日','2026年10月24日')
                if '姬岁歌AI虚拟主播商业计划书' in run.text:
                    run.text=run.text.replace('姬岁歌AI虚拟主播商业计划书','姬岁歌人机共播商业计划书')

# Preserve original typography; keep all headings and titles black.
for name in ['Title','Subtitle','Heading 1','Heading 2','Heading 3']:
    style=doc.styles[name]
    style.font.color.rgb=RGBColor(0,0,0)
    if name.startswith('Heading'):
        style.paragraph_format.keep_with_next=True
for para in doc.paragraphs:
    if para.style.name in ['Title','Subtitle','Heading 1','Heading 2','Heading 3']:
        for run in para.runs:
            run.font.color.rgb=RGBColor(0,0,0)
        pr=para._p.pPr
        if pr is not None:
            for el in list(pr):
                if el.tag in [qn('w:pBdr'),qn('w:shd')]: pr.remove(el)

doc.core_properties.title='潮生智能真人与AI共同直播商业计划书'
doc.core_properties.subject='姬岁歌人机共同直播 人格化互动 主动造梗与商业化运营'
doc.save(OUTPUT)
Path(__file__).with_name('revision-log.json').write_text(json.dumps(changes,ensure_ascii=False,indent=2),encoding='utf-8')
print(OUTPUT)
print(f'Edited {len(changes)} paragraphs; inserted four substantive pages; retained original numerical forecasts.')
