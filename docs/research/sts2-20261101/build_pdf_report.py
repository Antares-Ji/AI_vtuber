"""Professional Chinese report built exclusively from recorded measurements."""
from pathlib import Path
import json,statistics,hashlib,math,html,sys
# Both runtimes are CPython 3.12.14: reuse the bundled PDF libraries without
# modifying the game's environment or installing new packages into it.
sys.path.append('C:/Users/Antares.Ji/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/Lib/site-packages')
from collections import defaultdict
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.font_manager import FontProperties
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer,Table,TableStyle,PageBreak,Image,Flowable,KeepTogether

ROOT=Path(__file__).resolve().parents[3]
DATA=Path(__file__).resolve().parent
OUT=ROOT/'output/pdf';OUT.mkdir(parents=True,exist_ok=True)
TMP=ROOT/'tmp/pdfs/shiyanbaogao1';TMP.mkdir(parents=True,exist_ok=True)
R=json.loads((DATA/'replay-20261101T141827Z/results.json').read_text(encoding='utf-8'))
S=json.loads((DATA/'replay-summary.json').read_text(encoding='utf-8'))
E=json.loads((DATA/'environment.json').read_text(encoding='utf-8'))
W=json.loads((DATA/'weight-metadata.json').read_text(encoding='utf-8'))
assert R['complete'] and sum(len(c['rows']) for c in R['conditions'])==54
FONTS=Path('C:/Windows/Fonts')
pdfmetrics.registerFont(TTFont('CN',str(FONTS/'msyh.ttc'),subfontIndex=0))
pdfmetrics.registerFont(TTFont('CN-Bold',str(FONTS/'simhei.ttf')))
pdfmetrics.registerFontFamily('CN',normal='CN',bold='CN-Bold',italic='CN',boldItalic='CN-Bold')
FP=FontProperties(fname=str(FONTS/'msyh.ttc'))
plt.rcParams.update({'font.family':FP.get_name(),'font.sans-serif':[FP.get_name()],'axes.unicode_minus':False,'font.size':10})
NAVY=colors.HexColor('#15324B');TEAL=colors.HexColor('#087F8C');ORANGE=colors.HexColor('#CF7A2C');INK=colors.HexColor('#24384A');GRAY=colors.HexColor('#657787');LIGHT=colors.HexColor('#EEF4F7');LINE=colors.HexColor('#D5E0E7')
PALETTE=['#2675A7','#D18A35','#248C76']
WIDTH,HEIGHT=A4;M=49;CW=WIDTH-2*M
styles={
 'body':ParagraphStyle('body',fontName='CN',fontSize=10.2,leading=16.5,textColor=INK,spaceAfter=9,wordWrap='CJK'),
 'small':ParagraphStyle('small',fontName='CN',fontSize=8.4,leading=13,textColor=GRAY,spaceAfter=6,wordWrap='CJK'),
 'h1':ParagraphStyle('h1',fontName='CN-Bold',fontSize=21,leading=28,textColor=NAVY,spaceAfter=17,wordWrap='CJK'),
 'h2':ParagraphStyle('h2',fontName='CN-Bold',fontSize=12.5,leading=19,textColor=TEAL,spaceBefore=8,spaceAfter=8,wordWrap='CJK'),
 'cell':ParagraphStyle('cell',fontName='CN',fontSize=8.7,leading=13.2,textColor=INK,wordWrap='CJK'),
 'th':ParagraphStyle('th',fontName='CN-Bold',fontSize=8.7,leading=13.2,textColor=colors.white,wordWrap='CJK'),
 'call':ParagraphStyle('call',fontName='CN',fontSize=10.1,leading=17,textColor=NAVY,wordWrap='CJK'),
}
story=[];source=[]
def p(text,style='body'):
    story.append(Paragraph(text,styles[style]));source.append(text)
def h(text):p(text,'h2')
def new(no,title,subtitle=None):
    if story:story.append(PageBreak())
    p(f'{no:02d}  /  {title}','h1')
    if subtitle:p(subtitle,'small')
    source.append('\n')
def table(headers,rows,widths=None,size=8.7):
    cell=ParagraphStyle('temp',parent=styles['cell'],fontSize=size,leading=size*1.5)
    cells=[[Paragraph(html.escape(str(v)),styles['th']) for v in headers]]
    cells += [[Paragraph(html.escape(str(v)),cell) for v in row] for row in rows]
    widths=[CW*w for w in widths] if widths else [CW/len(headers)]*len(headers)
    t=Table(cells,colWidths=widths,repeatRows=1,hAlign='LEFT')
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),NAVY),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,LIGHT]),('LINEBELOW',(0,-1),(-1,-1),.5,LINE)]))
    story.extend([t,Spacer(1,10)])
    source.append('| '+' | '.join(map(str,headers))+' |')
    source.extend('| '+' | '.join(map(str,row))+' |' for row in rows)
def callout(title,text):
    cell=Paragraph(f'<b>{title}</b><br/>{text}',styles['call'])
    t=Table([[cell]],colWidths=[CW]);t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),LIGHT),('BOX',(0,0),(-1,-1),.7,LINE),('LEFTPADDING',(0,0),(-1,-1),12),('RIGHTPADDING',(0,0),(-1,-1),12),('TOPPADDING',(0,0),(-1,-1),11),('BOTTOMPADDING',(0,0),(-1,-1),11)]))
    story.extend([t,Spacer(1,12)]);source.extend([title,text])
def fig(path,height):story.extend([Image(str(path),width=CW,height=height),Spacer(1,6)])
def clean_plot(ax):
    ax.spines[['top','right']].set_visible(False);ax.grid(axis='x',alpha=.16);ax.set_axisbelow(True)
def savefig(name,fig):
    path=TMP/(name+'.png');fig.savefig(path,dpi=230,bbox_inches='tight',facecolor='white');plt.close(fig);return path
names=['本地 4B NF4','本地 8B NF4','云端 Flash']
cases=[c['name'] for c in R['cases']]
case_cn=['手牌费用冲突','高体型敌人','完整牌面类型','抽牌堆查看','遮挡玩家生命','展开手牌']
case_labels=dict(zip(cases,case_cn))
cond=S['conditions']

# Scientific figures derived from the recorded observations.
f,ax=plt.subplots(figsize=(8.2,3.1))
means=[x['mean_s'] for x in cond]
ax.barh(names[::-1],means[::-1],color=PALETTE[::-1],height=.48)
for i,v in enumerate(means[::-1]):ax.text(v+.1,i,f'{v:.3f} s',va='center',fontproperties=FP)
ax.set_xlim(0,7);ax.set_xlabel('观察接口平均墙钟时间 / 秒',fontproperties=FP);clean_plot(ax)
for l in ax.get_yticklabels():l.set_fontproperties(FP)
latency=savefig('mean-latency',f)

f,ax=plt.subplots(figsize=(8.3,4.1))
for j,c in enumerate(R['conditions']):
    vals=[];lo=[];hi=[]
    for case in cases:
        xs=[r['elapsed_s'] for r in c['rows'] if r['case']==case];v=statistics.mean(xs);vals.append(v);lo.append(v-min(xs));hi.append(max(xs)-v)
    ax.bar([i+(j-1)*.25 for i in range(6)],vals,width=.24,yerr=[lo,hi],capsize=2.5,color=PALETTE[j],label=names[j])
ax.set_xticks(range(6),['手牌费用','敌人','完整牌面','抽牌堆','遮挡生命','展开手牌'])
for l in ax.get_xticklabels():l.set_fontproperties(FP)
ax.set_ylabel('请求墙钟时间 / 秒',fontproperties=FP);ax.spines[['top','right']].set_visible(False);ax.grid(axis='y',alpha=.15);ax.set_axisbelow(True);ax.legend(prop=FP,frameon=False,ncol=3,loc='upper left');ax.set_ylim(0,15)
bycase=savefig('case-latency',f)

f,ax=plt.subplots(figsize=(8.3,3.4))
metrics=['原文可直接解析','去围栏后可解析','规范结果非空']
for j,c in enumerate(cond):ax.bar([i+(j-1)*.23 for i in range(3)],[c['raw_json_valid'],c['json_valid_after_fence_removal'],c['normalized_not_null']],width=.22,color=PALETTE[j],label=names[j])
ax.set_xticks(range(3),metrics)
for l in ax.get_xticklabels():l.set_fontproperties(FP)
ax.set_yticks([0,6,12,18]);ax.set_ylim(0,22);ax.set_ylabel('请求数 / 每条件18次',fontproperties=FP);ax.legend(prop=FP,frameon=False,ncol=3);ax.spines[['top','right']].set_visible(False);ax.grid(axis='y',alpha=.15);ax.set_axisbelow(True)
quality=savefig('output-quality',f)

f,axes=plt.subplots(1,2,figsize=(8.3,3.3))
disk=[m['bytes']/2**30 for m in W['models']]
axes[0].bar(['4B','8B'],disk,color=PALETTE[:2],width=.5);axes[0].set_title('本地权重文件 / GiB',fontproperties=FP)
mem=[c['observed_gpu_mib_max']/1024 for c in cond]
axes[1].bar(['4B','8B','Cloud'],mem,color=PALETTE,width=.55);axes[1].axhline(16303/1024,color='#8B9AA5',ls='--',lw=1);axes[1].set_title('本机总显存最大采样 / GiB',fontproperties=FP)
for ax,vs in zip(axes,[disk,mem]):
    ax.set_ylim(0,18);ax.spines[['top','right']].set_visible(False);ax.grid(axis='y',alpha=.15);ax.set_axisbelow(True)
    for i,v in enumerate(vs):ax.text(i,v+.35,f'{v:.2f}',ha='center',fontsize=10)
f.tight_layout();resources=savefig('weight-memory',f)

f,ax=plt.subplots(figsize=(8.2,1.6))
ax.barh([0],[12035.5/3600],color=PALETTE[0],label='任务日志区间')
ax.barh([0],[16937.75/3600],left=[12035.5/3600],color='#C9D5DF',label='任务段间间隙')
ax.set_xlim(0,8.4);ax.set_yticks([]);ax.set_xlabel('小时；早期49段快照',fontproperties=FP);ax.legend(prop=FP,frameon=False,ncol=2,loc='upper center',bbox_to_anchor=(.5,1.4));ax.spines[['top','right','left']].set_visible(False)
history_plot=savefig('historical-time',f)

class Architecture(Flowable):
    def __init__(self):Flowable.__init__(self);self.width=CW;self.height=275
    def draw(self):
        c=self.canv
        def box(x,y,w,h,title,sub,color=LIGHT):
            c.setFillColor(color);c.setStrokeColor(LINE);c.roundRect(x,y,w,h,6,fill=1,stroke=1)
            c.setFillColor(NAVY);c.setFont('CN-Bold',10);c.drawCentredString(x+w/2,y+h-20,title)
            c.setFillColor(GRAY);c.setFont('CN',8);c.drawCentredString(x+w/2,y+13,sub)
        def arrow(x,y,xx,yy):
            c.setStrokeColor(TEAL);c.setLineWidth(1.4);c.line(x,y,xx,yy)
            ang=math.atan2(yy-y,xx-x);p=c.beginPath();p.moveTo(xx,yy);p.lineTo(xx-6*math.cos(ang-.5),yy-6*math.sin(ang-.5));p.lineTo(xx-6*math.cos(ang+.5),yy-6*math.sin(ang+.5));p.close();c.setFillColor(TEAL);c.drawPath(p,fill=1,stroke=0)
        box(0,210,110,56,'保存的游戏帧','相同像素 / SHA-256')
        box(155,210,150,56,'本地观察条件','5080 · Qwen 4B / 8B NF4')
        box(345,210,150,56,'云端观察条件','官方 DeepSeek Flash')
        arrow(110,238,155,238)
        c.setStrokeColor(TEAL);c.line(55,210,55,195);c.line(55,195,326,195);c.line(326,195,326,238);arrow(326,238,345,238)
        box(155,112,150,60,'OCR / 结构归一化','CPU核对 · 缺失保持未知')
        arrow(230,210,230,172);c.line(420,210,420,142);arrow(420,142,305,142)
        box(0,18,145,57,'观察输出','原文 / 结构 / 核对状态')
        box(175,18,145,57,'规划与原生执行','完整闭环中的后续步骤')
        box(350,18,145,57,'动作后结果确认','输入回执 ≠ 游戏成功')
        c.line(230,112,230,96);c.line(230,96,72,96);arrow(72,96,72,75)
        arrow(145,46,175,46);arrow(320,46,350,46)
        c.setFillColor(ORANGE);c.setFont('CN',8.2);c.drawString(175,0,'本轮只读回放未执行下方规划与键鼠动作')

class Doc(SimpleDocTemplate):
    def afterFlowable(self,flowable):
        if isinstance(flowable,Paragraph) and flowable.style.name=='h1':
            title=flowable.getPlainText();key='p'+str(self.page)
            self.canv.bookmarkPage(key);self.canv.addOutlineEntry(title,key,level=0,closed=False)
def chrome(c,doc):
    c.saveState();c.setFillColor(NAVY);c.rect(0,HEIGHT-10,WIDTH,10,fill=1,stroke=0)
    if doc.page>1:
        c.setFont('CN',8);c.setFillColor(GRAY);c.drawString(M,HEIGHT-32,'AI_vtuber  /  STS2 实验报告');c.drawRightString(WIDTH-M,HEIGHT-32,'RTX 5080 · 模型容量横向对比')
    c.setStrokeColor(LINE);c.line(M,40,WIDTH-M,40);c.setFont('CN',8);c.setFillColor(GRAY);c.drawString(M,26,'shiyanbaogao1  |  v1.0  |  2026-11-01');c.drawRightString(WIDTH-M,26,f'{doc.page:02d}')
    c.restoreState()

# 01 Cover and concise evidence-led abstract.
story.append(Spacer(1,40))
p('EXPERIMENT REPORT  /  01','small')
p('杀戮尖塔 2<br/>多模型视觉智能体实验报告','h1')
p('RTX 5080 本机部署、4B / 8B 权重与云端参照的横向测量','h2')
story.append(Spacer(1,16))
table(['实验范围','已完成规模','数据性质'],[['本地4B、8B；云端Flash','6个困难帧 × 3次 × 3条件','54次正式回放 + 3次预热'],['历史控制链路与任务日志','67个近期任务段审计','段数不等于独立游戏局数']],[.34,.33,.33])
h('摘要')
p('本报告围绕杀戮尖塔2的截图观察、策略决策、原生键鼠执行与结果验证，整理项目阶段证据，并对消费级RTX 5080上的Qwen3-VL 4B、8B模型进行横向测量。官方DeepSeek Flash作为云端观察参照单列，避免把其延迟归为本机GPU性能。')
p('在六个固定困难样本、每条件三轮且关闭缓存的回放中，4B、8B、云端的平均观察接口耗时分别为5.900、5.234和3.124秒。8B两类手牌输出共6次不符合接口要求；其较短处理路径也影响延迟。各条件均存在信息未知或场景分类限制，不能以JSON可解析或接口较快代替视觉准确率与游戏胜率。')
callout('主要发现','本地4B与8B均可在本机NF4配置下完成回放；参数增大没有自动消除接口与信息提取问题。下一步应固定观察、记忆和执行协议，再开展同起点闭环比较。')
p('报告编号：shiyanbaogao1　　版本：v1.0<br/>报告日期：2026-11-01（America/Creston）<br/>实测记录：2026-11-01；历史轨迹截至2026-10-31<br/>状态：探索性阶段实验报告；非通关率基准、非投稿定稿','small')
p('阅读导航：研究与配置 02-05页 · 测量与分析 06-10页<br/>历史与方案 11-12页 · 复现、明细与参考 13-15页','small')

# 02 Research scope.
new(2,'研究问题与比较边界','比较模型之前，先定义模型承担的职责、可见信息和动作接口。')
p('“Codex跑”“DeepSeek跑”“本地模型跑”并非天然等价实验。模型可分别承担观察与决策；CV负责定位或核对，脚本承载流程，原生键鼠负责执行。若同时改变多个环节，结果只能描述系统组合，不能归因于某一个模型。')
table(['问题','目标量','当前能回答到哪里'],[['RQ1：容量如何影响本地观察？','同帧请求延迟、结构兼容、字段状态','已测4B与8B NF4；无独立正确率标签'],['RQ2：云端能否减少观察等待？','同组样本的接口墙钟时间','已测云端Flash；不是等价硬件比较'],['RQ3：整局能力由何决定？','有效动作率、战斗时间、通关/中断','历史证据与方案；未做同种子完整对照']],[.3,.3,.4])
h('已有系统条件')
table(['条件','决策 / 观察 / 执行','证据属性'],[['A Codex监督','对话代理 / 截图+局部Qwen / 原生键鼠','历史48层结算；有监督'],['B DeepSeek结构化','DeepSeek / MCP状态 / 游戏动作接口','历史接管；不是纯视觉'],['C 混合本地视觉','DeepSeek / 本地Qwen+OCR/CV / 原生键鼠','实机闭环推进与失败记录'],['D 混合云视觉','DeepSeek / 云Flash+本地OCR/CV / 原生键鼠','残局败北与新局未完成'],['E 纯本地策略','本地决策 / 固定观察 / 原生键鼠','尚无等价完整策略试验']],[.2,.47,.33])
p('本轮横向测量只替换观察条件，不调用规划模型，不发送游戏输入。历史Codex监督表现和结构化接口表现作为工程背景单列，不纳入54次回放的统计。','small')
callout('研究定位','SpireBench与AgenticSTS研究长程策略[1,2]；Cradle研究截图到键鼠控制[3]，SpireClimb开展视觉尖塔评测[4]。本项目当前切入点是消费级硬件上的混合架构、可追溯测量和分层失败诊断；“模型能玩游戏”本身不构成新颖性声明。')

# 03 Hardware and metadata.
new(3,'硬件、软件与本地权重','环境来自本机读取；权重结构来自config.json与safetensors文件头。')
table(['项目','实测配置'],[['GPU','NVIDIA GeForce RTX 5080；16303 MiB总显存；驱动616.92'],['CPU',W['cpu']+f'；{W["physical_cpu_count"]}核 / {W["logical_cpu_count"]}线程'],['主机内存',f'操作系统可见 {W["ram_bytes"]/2**30:.2f} GiB；不是推理时进程占用'],['系统与Python','Windows 11 build 26200；Python 3.12.14'],['推理软件','PyTorch 2.11.0+cu128；Transformers 5.16.1；Accelerate 1.14.0'],['量化与OCR','bitsandbytes 0.50.2；RapidOCR PP-OCRv6 small CPU']],[.23,.77])
wm=W['models'];w4,w8=wm
table(['权重属性','Qwen3-VL-4B-Instruct','Qwen3-VL-8B-Instruct'],[['名义规模','4B','8B'],['存储张量元素总量',f'{w4["stored_elements"]:,}（约4.438B）',f'{w8["stored_elements"]:,}（约8.767B）'],['其中视觉组件',f'{w4["component_elements"]["vision"]/1e9:.3f}B',f'{w8["component_elements"]["vision"]/1e9:.3f}B'],['权重文件大小',f'{w4["bytes"]/1e9:.3f} GB / {w4["bytes"]/2**30:.3f} GiB',f'{w8["bytes"]/1e9:.3f} GB / {w8["bytes"]/2**30:.3f} GiB'],['分片数 / 张量数',f'{len(w4["shards"])} / {w4["tensor_count"]}',f'{len(w8["shards"])} / {w8["tensor_count"]}'],['磁盘存储精度','BF16','BF16'],['推理量化 / 计算','NF4 / BF16','NF4 / BF16'],['语言层数 / 隐藏宽度','36 / 2560','36 / 4096']],[.3,.35,.35],8.3)
p('Qwen3-VL模型族背景见[5]。B表示十亿级名义规模。存储张量元素由文件头shape乘积求和。<br/>统计包含视觉组件，未对共享权重去重，不能直接等同厂商名义可训练参数量。<br/>磁盘BF16权重加载为NF4，文件大小不等于显存。云端参数量与服务器配置在本次记录中未知。[E2,E3]','small')

# 04 Architecture.
new(4,'硬件与调用链路','图示的是软件/硬件调用关系，不是GPU电气原理图。')
story.extend([Architecture(),Spacer(1,18)])
table(['层级','实际职责','本轮是否测量'],[['采样与输入','读取既有游戏客户区保存图；固定裁剪与文件哈希','固定输入；未重新捕获游戏'],['本地推理','5080加载4B或8B；NF4；不采样生成','测量'],['云端推理','官方DeepSeek Flash图像接口；本地接收输出','测量网络在内的接口时间'],['核对与归一化','本地OCR、字段映射、场景相关拒绝逻辑','测量；分支触发存在差异'],['规划、输入、结果','DeepSeek决策与Win32键鼠；动作后验证','本轮未执行；仅引用历史']],[.21,.54,.25])
p('完整闭环应分开记录观察事实、历史规则、模型动作提案、执行器回执和动作后结果。当前项目要求通过导演API启动任务，Codex监督开发；本轮没有改变该运行约束，也没有读取游戏隐藏状态来补全观测。[E1,E4]','small')

# 05 Protocol.
new(5,'实验协议与样本构成','先固定输入和测量口径，再解释模型差异。')
table(['项目','本轮配置'],[['条件数与重复','3条件；6样本；每样本3次；54次正式请求；每条件另1次预热'],['执行顺序','模型顺序固定4B→8B→Flash；轮内按seed=20261101打乱样本顺序'],['缓存与服务','观察缓存禁用；独立17656端口；只读OCR服务；不修改生产观察代码'],['生成参数','本地do_sample=False；repetition_penalty=1.08；按模式上限800或350 tokens'],['图像预算','本地处理器shortest_edge=262144、longest_edge=1048576（像素面积预算）'],['计时边界','客户端请求发起至完整返回；包含相关推理/核对，云端含网络；加载单列']],[.24,.76],8.7)
table(['样本','接口模式','检验难点'],[[case_cn[0],'hand','相邻牌名、费用徽标归属与遮挡'],[case_cn[1],'battle','敌人生命、目标和结束回合按钮'],[case_cn[2],'card','单张完整牌的名称、类型与规则'],[case_cn[3],'scene','抽牌堆浏览与奖励选牌的混淆'],[case_cn[4],'player','角色生命被展开牌遮挡'],[case_cn[5],'hand','展开牌与邻牌分离、费用核对']],[.27,.15,.58])
callout('统计单位与指标','6个选择性困难样本是内容单位；每样本3次为技术重复，不是18个独立样本。没有独立人工标签，报告接口延迟、JSON解析和字段状态，不报告视觉准确率。均值与P95只描述当前混合模式请求。')
p('停止与清理：回放前导演stop回执releaseComplete=true；回放后自建观察/OCR端口释放，导演stopped=true、busy=false、autonomous.running=false。没有新游戏动作。云端图像处理、提示包装及模型固定顺序仍使三条件不是严格的单变量模型实验。[E1]','small')

# 06 Aggregate latency.
new(6,'总体测量结果','热请求统计排除模型加载和每条件一次预热。')
table(['观察条件','n','均值/s','中位数/s','描述P95/s','合计/s'],[[names[i],c['n'],f'{c["mean_s"]:.3f}',f'{c["median_s"]:.3f}',f'{c["p95_s"]:.3f}',f'{c["total_s"]:.3f}'] for i,c in enumerate(cond)],[.3,.07,.15,.16,.17,.15])
fig(latency,195)
p('图1　六个固定困难样本的观察接口平均请求耗时。每条件18次请求；无独立样本置信区间。云端不是在本机5080上运行。','small')
red_cloud=(1-cond[2]['mean_s']/cond[0]['mean_s'])*100
red_8=(1-cond[1]['mean_s']/cond[0]['mean_s'])*100
callout('本组描述性差异',f'云端平均请求时间比4B低{red_cloud:.1f}%；8B比4B低{red_8:.1f}%。但8B有6次规范化失败，跳过后续手牌OCR，因此其耗时优势含处理路径缩短，不能全归因于推理速度。')
table(['条件','加载就绪/s','预热请求/s','正式输出tokens合计'],[[names[i],f'{c["load_s"]:.3f}',f'{c["warmup_s"]:.3f}',c['generated_tokens']] for i,c in enumerate(cond)],[.34,.21,.22,.23])
p('加载时间受磁盘缓存、依赖初始化和固定运行顺序影响；云端值只是本地代理服务就绪时间。不同tokenizer与不同输出长度下，不能用上表推导跨模型生成速度或每token成本。完整计费token和云端账单未采集。[E1]','small')

# 07 Per-case results.
new(7,'逐场景延迟：差异并不一致','柱为三次均值，误差线为实测最小值至最大值，不是置信区间。')
fig(bycase,245)
rows=[]
for case in cases:
    row=[case_labels[case]]
    for c in R['conditions']:
        xs=[r['elapsed_s'] for r in c['rows'] if r['case']==case]
        row.append(f'{statistics.mean(xs):.3f}\n[{min(xs):.3f}, {max(xs):.3f}]')
    rows.append(row)
table(['样本','4B：均值[范围]/s','8B：均值[范围]/s','云端：均值[范围]/s'],rows,[.25,.25,.25,.25],8.2)
p('抽牌堆样本是本地两模型的主要长请求，均值约12.5秒；输出中枚举了多张卡牌。云端在该例约3.7秒，但仍有一次分类落入menu。遮挡生命例输出很短，本地约1.5秒，反而快于云端约2.5秒。这些差异说明平均延迟会随场景混合比例改变。','body')
p('手牌两例中8B返回顶层数组，规范化失败后没有走相同OCR路径；因此不能把该两例的耗时直接用于隔离模型容量效应。所有技术重复均保留，没有按结果优劣删样本。[E1]','small')

# 08 Output compatibility.
new(8,'输出兼容性与可用性','HTTP完成、文本可解析、规范字段非空、字段正确和游戏成功是不同指标。')
fig(quality,210)
table(['指标（每条件18次）','4B','8B','云端'],[['HTTP返回','18','18','18'],['原始字符串可直接JSON解析','18','6','18'],['去Markdown围栏后可解析','18','18','18'],['规范结果非null','18','12','18'],['缓存命中','0','0','0']],[.49,.17,.17,.17])
h('8B的两类集成问题')
p('12次输出包含Markdown代码围栏，现有解析器去除围栏后仍可处理；这与JSON内容错误不同。另有6次手牌输出采用顶层数组，而接口要求包含cards字段的对象。该结构差异触发规范化错误，parsed与ocr_check均为null；原始错误文本保存在E1。')
callout('计分解释','18/18规范结果非空不代表18/18识别正确。一个非空对象可以只包含未知生命，也可以保留不适用的候选目标。8B的12/18是本轮接口结构接受情况，不是66.7%的视觉准确率。')
p('后续可单列“原样集成”与“仅格式适配”两套指标：适配必须固定规则、不改变牌名/数字/坐标，并重新记录处理路径和耗时。本报告保留当前原样接口结果，不把后处理补救偷偷计作原生成功。[E1]','small')

# 09 Semantic results.
new(9,'六类样本的字段与失败分析','以下依据保存的模型/OCR响应，不声称独立人工像素标注。')
table(['样本','4B / 8B / 云端的关键差异','含义'],[['手牌费用冲突','4B/云端经OCR保留打击1费，其他费用未知；8B数组格式被拒绝。','格式、费用归属与原始读错应分开。'],['高体型敌人','三条件均有69/84与OCR支持；目标ID、描述和空地候选仍不同。','局部生命一致不能证明全部目标可靠。'],['完整牌面','4B和云端防御名称/类型/规则得到OCR支持；8B牌名null、结果不确定。','增大参数量未在该例改善可用牌面。'],['抽牌堆','本地分类selection后由OCR标注抽牌堆并清空目标；云端1次menu保留6个启用卡牌候选，2次selection被纠正。','校验分支依赖模型分类，存在覆盖缺口。'],['遮挡生命','三条件规范生命与格挡均未知。','模型猜测不能替代可见证据。'],['展开手牌','4B/云端保留展开彼岸咆哮3费；8B数组格式被拒绝。','当前接口不能直接使用8B该输出。']],[.19,.56,.25],8.5)
h('失败分类建议')
p('F1 结构不兼容：输出格式未满足接口约束。F2 信息缺失：字段不可见或不确定。F3 语义误读：牌名、费用或场景读错。F4 核对覆盖缺口：错误分类绕过对应校验。F5 闭环执行问题：动作虽提交但未推进。前四类可在回放中发现；第五类必须观察实机动作后的变化。')
callout('本轮发现，不冒充修复','云端抽牌堆menu分支保留候选，是值得后续回归验证的问题；本轮没有发送这些目标对应动作，也没有改线上逻辑。完整牌面的OCR核对字段为名称、类型、完整规则，费用不在此独立核对范围。')
p('没有读取隐藏状态、没有由Codex手工指定新游戏坐标、没有利用过往结论填补未知字段。所有原文与规范结果保存在原始回放JSON。[E1]','small')

# 10 Resource comparison.
new(10,'权重容量与本机资源占用','区分磁盘文件、量化运行状态、全机显存采样及云端资源。')
fig(resources,215)
table(['资源口径','4B','8B','云端Flash'],[['磁盘权重文件/GiB',f'{disk[0]:.3f}',f'{disk[1]:.3f}','本机无相应权重'],['推理时精度','NF4 / BF16计算','NF4 / BF16计算','服务商管理，未知'],['请求后总显存最大采样/MiB','8490','11959','4178（仅本机）'],['样本末尾显存/MiB','8412','11749','4110（仅本机）'],['正式生成tokens总计','2235','2004','1565']],[.4,.2,.2,.2],8.5)
p('4B文件约8.27 GiB，8B约16.33 GiB。加载时采用NF4，因此本轮8B在16GB级GPU上运行，无须将磁盘BF16文件原样全部驻留显存。实际显存还包括未量化组件、激活、KV缓存、CUDA上下文及桌面程序。简单的“参数量×位宽”计算不能替代测量。')
callout('资源结论的边界','图中虚线为16303 MiB总显存。请求后采样可能错过推理峰值；未记录进程独占峰值、持续功率曲线或整局电耗。云端本机约4 GiB占用不是云端模型显存，更不能据此称云端模型比4B更省GPU。')
p('本机探针记录CPU为Ryzen 9 9950X3D、16核32线程，可见内存约47.15 GiB。该硬件信息为本轮只读补充，不用于事后推断当时CPU利用率、热状态或内存峰值。2B、14B、32B等容量未执行，不填入预测性能。[E2,E3]','small')

# 11 Historical context.
new(11,'历史轨迹与闭环耗时','历史阶段提供可行性与失败证据，不与本轮观察请求合并计算胜率。')
table(['阶段','记录支持的结果','不能推出的结论'],[['10月26日：监督原生操作','48层“胜利……？”；3首领、4精英；末段剧情生命归零。','不是后来的DeepSeek自主通关，也不是独立胜率。'],['10月30日起：原生API','两次奖励转场；角色API决策；频繁悬停、停止、失焦及修复。','67任务段不是67局，楼层与战斗数不等价。'],['云视觉继承残局','3/80生命开始，确认两次拖牌与结束回合，之后败北。','不是完整新局策略评测。'],['后续新种子局','最近任务段仍在战斗；16接受决策、14回执、5次实际拖拽。','未见终局；不能判胜或据中断判败。']],[.24,.43,.33],8.5)
fig(history_plot,115)
p('图4　早期49任务段快照：总跨度28,973.25秒（8.048小时）；日志区间12,035.5秒，段间间隙16,937.75秒。间隙含开发、测试、等待和重启，原因无法精确分摊。不是纯模型思考时间。','small')
h('输入耗时与有效推进需分开')
p('同一早期快照中273个输入回执的物理动作合计351.19秒，均值约1.29秒。规划包含199次hover和52次drag，其中15次drag只做起点准备。键鼠动作时间短，不代表整个控制循环高效。串行观察、反复悬停、状态恢复和监督开发均会放大墙钟时间。')
p('最新版本增加了历史规则记忆与动作证据帧复用；因此不同日期表现还混入协议变化。当前统计截止是历史日志时间，而非对现场状态的实时监视。[E4]','small')

# 12 Study limitations and next controlled experiments.
new(12,'有效性限制与下一阶段对照','本报告提供研究雏形；以下实验仍是方案，不是新增结果。')
table(['限制','对结论的影响','后续控制'],[['6个选定困难帧','不能代表正常画面分布或整体准确率','分场景采样；独立标注；开发/冻结测试集分离'],['每帧重复3次','只衡量技术重复，不能扩大内容样本量','以帧/战斗/种子为统计单位'],['模型固定顺序','时间、缓存与温度可能混杂','分块随机化条件顺序，记录负载'],['8B失败分支较短','延迟差异含处理路径改变','统一格式适配，单列原样与适配结果'],['云端处理细节不同','不是同硬件或参数量单变量对照','作为系统级云参照；不推断容量原因'],['无独立像素标签','OCR一致不等于真值','双人或明确流程标注，保留未知与冲突']],[.24,.37,.39],8.4)
h('建议的分层矩阵')
table(['层次','固定项 / 改变项','主要终点'],[['感知','固定截图和提示；比较4B/8B及量化候选','字段正确/未知/错误、定位误差、接口延迟'],['决策','固定同一可见观测与记忆；换DeepSeek/本地规划','动作合法、目标一致、资源约束'],['闭环','固定角色/难度/种子/记忆；换单一模块','战斗完成时间、有效出牌率、HP损失'],['整局','同起点独立尝试；保留失败与中断','通关、败北、剧情未知、中断分别统计']],[.16,.52,.32])
p('先每条件5个配对种子作可行性试运行，再按方差与目标精度制定样本量；5不是功效计算结果。每局重置到同一记忆快照，冻结CV、证据复用和重试协议。代码修复后另立版本，不能把多个修复段拼成一次无干预成功。','small')
callout('阶段判断','现阶段可支持“本机部署可行、所选输入的性能与失败模式可追溯”；不可支持“8B普遍更强”“云端通关更快”或“纯本地策略已自主通关”。')

# 13 Reproducibility and measures.
new(13,'测量定义与复现索引','原始文件位于E:/Github/AI_vtuber；报告保留可核查路径和版本指纹。')
h('统计口径')
p('单次延迟 t 为客户端发起read请求到完整JSON返回的墙钟差。均值为同条件18次正式延迟之和除以18；中位数取中间两项平均。P95采用排序后的线性插值，仅描述这18个混合模式请求，不估计生产尾延迟。加载和预热各自单列。')
p('规范结果非空指parsed不为null，不检查语义正确；原文可解析按JSON直接解析，去围栏后可解析另计。生成token为服务返回的输出计数，不含完整输入账单；不同tokenizer不作等价单位。显存是各请求完成后nvidia-smi全机采样，最大值不是连续监测峰值。')
table(['ID','本机证据（相对项目根）','用途'],[['E1','docs/research/sts2-20261101/replay-20261101T141827Z/results.json','54次请求、预热、模型/核对响应和清理'],['E2','docs/research/sts2-20261101/environment.json','实测GPU与软件版本'],['E3','docs/research/sts2-20261101/weight-metadata.json','CPU/RAM与权重文件头核对'],['E4','docs/research/sts2-20261101/historical-summary.json；history-evidence.md','历史67段、回执和来源哈希'],['E5','docs/literature/sts2-20261101/search-log.md','文献检索式和阅读范围'],['E6','docs/research/sts2-20261101/source-hashes.json','回放观察代码指纹']],[.08,.65,.27],8.0)
table(['文件','SHA-256前24位（完整值保存在原记录）'],[['4B config.json',w4['config_sha256'][:24]],['8B config.json',w8['config_sha256'][:24]],['原始回放JSON',hashlib.sha256((DATA/'replay-20261101T141827Z/results.json').read_bytes()).hexdigest()[:24]]],[.4,.6])
p('复现脚本：run_replay_benchmark.py执行有界回放；analyze_replay.py复算指标与图；inspect_weight_metadata.py只读权重文件头；build_pdf_report.py从保存数据生成本报告。均在docs/research/sts2-20261101目录。原始截图仍在runtime/game-input/runs，未随本PDF分发。上游权重精确下载revision未核定；文件头/配置哈希不能替代完整权重载荷校验。','small')

# 14 Full repeated data.
new(14,'附录：54次正式请求原始耗时','每一行是同一样本、同一轮次的三个模型条件；单位为秒。')
rows=[]
for case in cases:
    for rep in [1,2,3]:
        row=[case_labels[case],rep]
        for c in R['conditions']:
            rr=next(r for r in c['rows'] if r['case']==case and r['repeat']==rep)
            row.append(f'{rr["elapsed_s"]:.3f}')
        rows.append(row)
table(['样本','轮次','4B NF4','8B NF4','云端Flash'],rows,[.38,.1,.17,.17,.18],8.6)
p('同一轮在三个条件内使用相同的样本顺序，但模型条件整体依次执行，非同时请求。这里按样本重排便于查阅；实际顺序可从E1恢复。全部54次HTTP返回、缓存命中0；不删除结构失败请求。','small')
callout('读表提醒','三次重复可能给出相同本地模型原文，但延迟有波动。云端抽牌堆还发生了分类分支变化。技术重复既反映执行时延波动，也可能反映输出变化，不能作为三个独立内容样本。')

# 15 References and provenance.
new(15,'参考文献与报告审核','定向叙述性调研；只借用已核实的接口与方法信息，不转引排行榜替代本项目结果。')
refs=[
 ('[1]','S. C. Lowe and S. W. Keemink, “SpireBench: Evaluating Long-Horizon Strategic Play of Agentic Models with Slay the Spire,” 2026, arXiv:2610.12596v1.','https://arxiv.org/html/2610.12596v1','方法与附录B.1；结构化JSON状态/文本命令。'),
 ('[2]','X. Cheng et al., “AgenticSTS: A Bounded-Memory Testbed for Long-Horizon LLM Agents,” 2026, arXiv:2607.02255v1.','https://arxiv.org/html/2607.02255v1','记忆设计与6.2/限制；小样本效果不能推为显著收益。'),
 ('[3]','W. Tan et al., “Cradle: Empowering Foundation Agents Towards General Computer Control,” 2024, arXiv:2403.03186v3.','https://arxiv.org/html/2403.03186v3','摘要与架构；截图输入、键鼠输出的控制框架。'),
 ('[4]','B. Ou and S. Chen, “AI systems are improving rapidly at Slay the Spire and its sequel,” Epoch AI, Oct. 14, 2026.','https://epoch.ai/publications/ai-systems-are-improving-rapidly-at-slay-the-spire-and-its-sequel','SpireClimb方法；视觉harness、种子、笔记/wiki权限。'),
 ('[5]','Qwen Team, “Qwen3-VL Technical Report,” 2025, arXiv:2511.21631v1.','https://arxiv.org/html/2511.21631v1','OCR、grounding与5.10 GUI代理；不代表本机尖塔准确率。')]
for number,title,url,scope in refs:
    p(f'<b>{number}</b> {html.escape(title)}<br/><link href="{url}" color="#087F8C">原始来源链接</link>　{scope}','small')
h('工具与研究过程披露')
p('使用academic-paper、deep-research、research-design与research-presentations工作流；来源为kinqsradio/academic-research-skills，MIT许可，安装提交37d8d409c0c62adf8fcb81c83935ea19c1e455c3。PDF由ReportLab生成，图表由Matplotlib按原始测量绘制，未用生成图片伪造实验图。')
p('主会话负责实验、分析和报告；两个研究工作会话分别核查历史与文献，并进行有界方法/数值复核。原文JSON可解析口径经复核后区分为“原文”与“去围栏后”。用户尚未逐项人工审阅；这些检查不构成外部同行评审。')
h('完成范围')
p('已完成：本机权重/环境核对、54次只读回放、历史轨迹审计、统计复算、专业排版及渲染检查。未完成：独立像素标注、纯本地策略端到端试验、同种子整局模型对比、云端账单/能耗核算。未做模型权重训练，未对外发布或投稿。')
callout('最终研究结论','本报告建立了可以继续扩展的实验记录与比较框架。实测表明模型容量、接口契约、核对分支和场景输出长度都影响观察性能；闭环能力仍须通过冻结条件的独立游戏试验验证。')

pdf=OUT/'shiyanbaogao1.pdf'
doc=Doc(str(pdf),pagesize=A4,rightMargin=M,leftMargin=M,topMargin=59,bottomMargin=57,title='杀戮尖塔2多模型视觉智能体实验报告',author='AI_vtuber 项目研究记录',subject='RTX 5080、Qwen3-VL 4B/8B与DeepSeek Flash观察层比较')
doc.build(story,onFirstPage=chrome,onLaterPages=chrome)
(DATA/'shiyanbaogao1-source.md').write_text('\n\n'.join(source),encoding='utf-8')
print(json.dumps({'pdf':str(pdf),'bytes':pdf.stat().st_size,'sha256':hashlib.sha256(pdf.read_bytes()).hexdigest(),'source':str(DATA/'shiyanbaogao1-source.md')},ensure_ascii=False))
