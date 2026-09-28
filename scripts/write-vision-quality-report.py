import json, statistics
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
DIR=ROOT/'runtime/vlm/quality-benchmark'
summary=json.loads((DIR/'summary.json').read_text())
rows=[json.loads(x) for x in (DIR/'results.jsonl').read_text(encoding='utf8').splitlines()]
clicks=[json.loads(x) for x in (DIR/'paired-clicks.jsonl').read_text(encoding='utf8').splitlines()]
names={'vlm':'千问4B','hybrid':'千问+通用YOLO','yolo':'通用YOLO11n'}
lines=['# 明日方舟视觉响应、清晰度与点击对照报告','',
'测试日期：2026-09-11。完整本地 BF16 Qwen3-VL-4B-Instruct，YOLO11n 通用权重，RTX 5080 16GB。', '',
'## 结论与使用边界','',
'本次可比较本地三条路径的请求耗时、目标定位命中和重复稳定性。当前对话模型仅做了少量实际导航对照，没有独立GPT-6 API推理计时，不能宣布云端与本地的速度胜负。', '',
'YOLO最快，但当前通用类别没有游戏按钮；零目标提案属于能力缺口，不是检测器所有CV任务准确率为零。加入这些通用框没有展示稳定的整体优势。', '',
'## 固定截图测试','',
'10张已见过的实机客户区截图 × 3种尺寸 × 3条路径 × 2次重复，共180次测量，另有3次预热不计。随机打乱请求顺序，固定生成参数，不在测试中修改提示或重训。每组20次请求只有10个来源样本，不能当作20个独立场景。', '',
'目标按钮可见矩形由Codex根据此前截图预先记录；目标点落入矩形算命中，未提案算未完成。此项不是游戏真实点击成功率，也不是盲测。重复稳定列表示同一场景两次均命中的数量。', '',
'|输入尺寸|路径|定位命中|两次都命中的场景|场景分类正确|请求中位数|请求P95|',
'|---|---|---:|---:|---:|---:|---:|']
for s in summary:
 w,h=int(1600*s['scale']),int(1024*s['scale'])
 lines.append(f"|{w}×{h}|{names[s['mode']]}|{s['hits']}/20|{s['both_repeats_hit']}/10|{s['scene_correct']}/20|{s['median_ms']:.0f} ms|{s['p95_ms']:.0f} ms|")
lines += ['', '请求时间包含本机HTTP、读图、预处理、推理及返回，不含点击。千问处理器还会内部缩放，所以输入尺寸不是模型实际视觉token尺寸。YOLO不输出本任务的场景分类，表内该列0表示未提供，而非场景分类评测。', '',
'## 清晰度与稳定性解释','',
'只测试了静态截图的1600×1024、800×512、400×256三种输入。未测试视频编码码率、运动模糊、掉帧、连续跟踪或游戏渲染FPS；识别模型也不负责提高视频画质。低分辨率在这组图上若更准，只是本组结果，不能外推为越模糊越好。', '',
'场景分类存在把设置/活动页报为home、复制类别列表等问题。不能只看坐标命中便将模型判为可靠；枚举格式检查也无法修复语义误判。', '',
'## 相同导航目标的实际点击对照','',
'固定“游戏设置→声音设置→游戏设置”，每一侧重复两遍；均使用同一管理员控制器和1600×1024客户区截图。Codex先运行，本地千问后运行；界面和目标相同，光标及动态背景可能变化。各轮结果由Codex看图核对，属于有监督小样本。', '',
 '|坐标来源|执行次数|控制器请求中位数|', '|---|---:|---:|']
for source in ['codex','vlm']:
 group=[r for r in clicks if r['source']==source]
 if group: lines.append(f"|{source}|{len(group)}|{statistics.median(r['controller_request_ms'] for r in group):.0f} ms|")
lines += ['', '逐张点击后截图核对：Codex 4/4、本地千问4/4进入目标页面，均无坐标重试。千问场景字段四次均有格式问题，因此只是点击目标通过，不是所有识别字段正确。两个简单目标不足以判断复杂场景稳定性。', '',
'上表时间从发出点击请求到取得截图，包含固定1200ms等待和控制/截图开销，不包含视觉模型思考；它不能用来评判两个视觉模型谁更快。当前环境配置的是DeepSeek接口，未使用其令牌请求OpenAI，也未将DeepSeek冒充当前模型。', '',
'## 可复现文件','',
'- 原始180条输出、计时及打分：`../runtime/vlm/quality-benchmark/results.jsonl`',
'- 固定标签：`../runtime/vlm/quality-benchmark/labels.json`',
'- 汇总：`../runtime/vlm/quality-benchmark/summary.json`',
'- 点击前后证据及控制器耗时：`../runtime/vlm/quality-benchmark/paired-clicks.jsonl`',
'- 本地点击提案：`../runtime/vlm/quality-benchmark/paired-local-proposals.jsonl`',
'- 测试脚本：`../scripts/benchmark-vision-quality.py`', '',
'本批未新增训练；之前的单图YOLO试训仅有ui_region类别，未纳入这里的通用YOLO路径。对云端、本地、训练后UI检测器的生产级选型仍需独立场景和无人纠错对照。']
(ROOT/'docs/vision-quality-comparison-20260911.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
print('Report written')
