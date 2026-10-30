"""在用户手动修改后的《增补修改版》上做定点修改（不重跑整套生成脚本，保留手动修改）。
2026-10-25 用户口述：第 7 页实测字段、第 12 页核心成员、删掉页面上的“待实测 / 待补”、B站与抖音双主阵地、里程碑按第 1–4 月。
用法：py -3 edit_manual_v2.py <输入.pptx> <输出.pptx>"""
import sys
from pptx import Presentation
from pptx.util import Inches as I, Pt
from pptx.dml.color import RGBColor
from pptx.enum.dml import MSO_LINE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from lxml import etree

SRC, OUT = sys.argv[1], sys.argv[2]
ACC = RGBColor(0x24, 0x59, 0xD6); INK = RGBColor(0x1F, 0x23, 0x29); MUTED = RGBColor(0x5B, 0x62, 0x70)
WHITE = RGBColor(0xFF, 0xFF, 0xFF); LIGHT = RGBColor(0xDC, 0xE5, 0xFA); PALE = RGBColor(0xE8, 0xEE, 0xFC)
FONT = "Microsoft YaHei"
prs = Presentation(SRC)
S = lambda n: prs.slides[n - 1]


def font(r, size, bold, color):
    f = r.font; f.size = Pt(size); f.bold = bold; f.color.rgb = color; f.name = FONT
    rPr = r._r.get_or_add_rPr()
    for tag in ("a:ea", "a:cs"):
        el = rPr.find(qn(tag))
        if el is None: el = etree.SubElement(rPr, qn(tag))
        el.set("typeface", FONT)


def write(sh, paras, size=14, bold=False, color=INK, align=None):
    if isinstance(paras, str): paras = [paras]
    tf = sh.text_frame; tf.clear(); tf.word_wrap = True
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        if align: p.alignment = {"c": PP_ALIGN.CENTER, "l": PP_ALIGN.LEFT}[align]
        for text, o in ([(para, {})] if isinstance(para, str) else para):
            r = p.add_run(); r.text = text
            font(r, o.get("size", size), o.get("bold", bold), o.get("color", color))


def tb(s, x, y, w, h, paras, size=13, color=INK):
    t = s.shapes.add_textbox(I(x), I(y), I(w), I(h))
    tf = t.text_frame; tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    write(t, paras, size=size, color=color)
    return t


def find(s, sid):
    return next(sh for sh in s.shapes if sh.shape_id == sid)


def drop(s, *ids):
    for sid in ids:
        try:
            el = find(s, sid)._element; el.getparent().remove(el)
        except StopIteration:
            pass


def move(sh, x=None, y=None, w=None, h=None):
    if x is not None: sh.left = I(x)
    if y is not None: sh.top = I(y)
    if w is not None: sh.width = I(w)
    if h is not None: sh.height = I(h)


def first_text(s, sid):
    """沿用该文本框原有格式，只替换文字（适用于单段落、单一样式）。"""
    return find(s, sid)


def add_note(s, text):
    tf = s.notes_slide.notes_text_frame
    tf.text = text + "\n\n" + tf.text


def retext(sh, old, new):
    """在不改变格式的前提下替换 run 中的文字片段。"""
    hit = False
    for p in sh.text_frame.paragraphs:
        for r in p.runs:
            if old in r.text:
                r.text = r.text.replace(old, new); hit = True
    if not hit:
        raise ValueError(f"{old!r} not in {sh.text_frame.text!r}")


# ---------- 第 2 页：本次申请换来（保留手动修改的内容，只改渠道表述） ----------
s = S(2)
write(find(s, 29), "原创形象交付 · 3 场内部试播 · 30 人观众验证 · B站、抖音双平台试运营 · 宣传投稿作品", size=14)

# ---------- 第 3 页：目录说明 ----------
retext(find(S(3), 41), "B站主阵地与回访", "B站、抖音双主阵地与回访")

# ---------- 第 7 页：实测字段 ----------
s = S(7)
write(find(s, 3), "MVP 已跑通局部链路，已有部分实测数据", size=30, bold=True)
write(find(s, 21), "已有实测数据（测量区间、样本与日期见备注）", size=15, bold=True, color=ACC)
drop(s, 22, 23, 24, 25)                       # 连续运行时长：无记录，移出页面
fields = [((26, 27, 28, 29), "平均约 120 ms", "团队实测平均值"), ((30, 31, 32, 33), "18 / 18", "STS2 快照成功 / 尝试"),
          ((34, 35, 36, 37), "0 次", "测试期间暂无人工接管"), ((38, 39, 40, 41), "57,826 tokens", "STS2 快照；费用未折算")]
fw = (12.13 - 3 * 0.25) / 4
for i, ((b, lab, val, sub), v, d) in enumerate(fields):
    x = 0.6 + i * (fw + 0.25)
    bx = find(s, b); move(bx, x, 5.5, fw, 1.38)
    bx.line.color.rgb = ACC; bx.line.dash_style = MSO_LINE.SOLID; bx.line.width = Pt(1.25)
    move(find(s, lab), x + 0.18, 5.63, fw - 0.36)
    write(find(s, val), v, size=22, bold=True, color=ACC); move(find(s, val), x + 0.18, 5.93, fw - 0.36)
    write(find(s, sub), d, size=12, color=MUTED); move(find(s, sub), x + 0.18, 6.42, fw - 0.36)
add_note(s, "【2026-10-25 更新（用户口述）】\n· 响应耗时：团队实测平均约 120 ms（团队另说约 100–120 ms）。测量区间（从什么输入到什么输出）、样本数、日期与版本未提供；若测的是完整的“主持人语音结束 → 角色首次可听回应”，该数值明显低于常见 LLM + TTS 链路，答辩前请核对口径。\n· 人工接管：测试期间暂无人工接管（用户提供），对应测试时长未提供。\n· 连续运行时长没有记录，已从页面移除，不作展示。\n· 调用量：STS2 快照 57,826 tokens，费用未折算。")

# ---------- 第 9 页：观众验证（删去待补行） ----------
s = S(9)
drop(s, 10, 11, 12, 13, 16, 17)
move(find(s, 14), y=3.27); write(find(s, 15), "2026-10", size=14); move(find(s, 15), y=3.27)
tb(s, 0.9, 3.74, 1.3, 0.4, [[("反馈性质", {"bold": True, "color": MUTED})]], size=14)
tb(s, 2.2, 3.74, 3.2, 0.4, "口头初步反馈，非正式验证", size=14)

# ---------- 第 11 页：说话时机证据 ----------
s = S(11)
write(find(s, 11), "语音调度代码已有；团队实测平均响应约 120 ms", size=13.5, color=ACC)
write(find(s, 12), "长回复截断，主持人续场；完整链路延迟复核", size=13.5, color=MUTED)

# ---------- 第 12 页：核心成员 ----------
s = S(12)
drop(s, *range(42, 60))
write(find(s, 41), "当前 46,200 元预算不含团队工资：成员暂不领薪，工时单独记录", size=15, color=MUTED)
retext(find(s, 62), "按场次轮值，人选与连续搭档安排待补", "按场次轮值")
cards = [
    (1.90, True, [("身份  ", {"bold": True}), ("清华大学学生", {})], [("相关经历  ", {"bold": True}), ("主修数学与计算机方向", {})]),
    (3.52, False, [("身份  ", {"bold": True}), ("中国传媒大学学生 · 游戏 / 数字媒体相关专业", {})],
                  [("相关经历  ", {"bold": True}), ("AI 方向研究", {}), ("      实际作品  ", {"bold": True}), ("记账软件", {})]),
    (5.14, False, [("身份  ", {"bold": True}), ("中国传媒大学学生 · 游戏 / 数字媒体相关专业", {})],
                  [("投入  ", {"bold": True}), ("每周 5 天，全天投入", {})]),
]
for y, dark, l1, l2 in cards:
    col = WHITE if dark else INK
    ln = s.shapes.add_connector(1, I(0.85), I(y + 0.88), I(7.7), I(y + 0.88))
    ln.line.color.rgb = RGBColor(0x7F, 0xA0, 0xE8) if dark else LIGHT; ln.line.width = Pt(0.75)
    tb(s, 0.85, y + 0.92, 6.85, 0.26, [l1], size=13, color=col)
    tb(s, 0.85, y + 1.17, 6.85, 0.26, [l2], size=13, color=col)
add_note(s, "【2026-10-25 更新（用户口述）】\n· 杨若朝：清华大学学生，主修数学与计算机方向。\n· 徐嘉盛：中国传媒大学学生，游戏 / 数字媒体相关专业；有 AI 方向研究，开发过记账软件。\n· 姬祥：中国传媒大学学生，游戏 / 数字媒体相关专业；每周投入 5 天，全天投入。\n· 页面不再显示“待补”；未提供的经历、作品与投入时长不作展示。\n· 右侧成员暂不改动。用户另说明肖鹏希、刘瑞麒、张涵、吴越、张乐溪为中国传媒大学游戏设计、数字媒体技术、游戏科学与技术方向，李岱松来自另一所高校（口述为“北京科”，全称待确认），本页暂未写入。")

# ---------- 第 13 页：商业模式 ----------
s = S(13)
retext(find(s, 134), "主阵地公开试运营起", "双平台公开试运营起")
write(find(s, 141), "单场经营模型（开播后按场记录）", size=15, bold=True, color=ACC)

# ---------- 第 14 页：获客与回访 ----------
s = S(14)
write(find(s, 3), "获客与回访：B站、抖音双主阵地，投入各半", size=30, bold=True)
write(find(s, 12), "主阵地", size=11, bold=True, color=WHITE, align="c")
pill = find(s, 11); pill.fill.solid(); pill.fill.fore_color.rgb = ACC; pill.line.fill.background()
write(find(s, 8), "横屏直播 + 连载，承接追更与社群", size=15)
write(find(s, 13), "竖屏直播 + 切片，吸引新观众", size=15)
write(find(s, 24), "切片到回访的漏斗（计划指标）", size=15, bold=True, color=ACC)
for sid in (26, 28, 30, 32, 34):
    sh = find(s, sid)
    for p in sh.text_frame.paragraphs:
        for r in list(p.runs):
            if "待实测" in r.text:
                r._r.getparent().remove(r._r)
            else:
                r.text = r.text.rstrip()
write(find(s, 36), [[("已有结果  ", {"bold": True, "color": ACC}), ("尚无公开运营数据。", {}),
                     ("B站与抖音按各半精力经营，每周 4–5 条切片为计划；同期同口径统计单条曝光、有效播放、关注与可追踪的直播到访，不用总播放替代回访。", {"color": MUTED})]], size=14)
add_note(s, "【2026-10-25 更新（用户口述）】渠道改为 B站、抖音双主阵地，投入各半：B站以横屏直播与连载承接追更和社群，抖音以竖屏直播与切片吸引新观众。漏斗中的指标均为计划，页面去掉了“待实测”字样，标题已注明“计划指标”；尚无公开运营数据。此前“B站主阵地、抖音轻量测试”的写法作废。")

# ---------- 第 15 页：市场战略与资金 ----------
s = S(15)
write(find(s, 14), "主阵地 · 竖屏", size=12, color=MUTED, align="c")
write(find(s, 25), "形象交付 → 内部试播与接梗测试 → 观众验证 → B站、抖音双平台开播", size=13)
retext(find(s, 38), "团队测算及报价依据（原画、Live2D 报价单待附）", "团队测算及报价依据")
add_note(s, "【2026-10-25 更新】渠道图改为 B站、抖音双主阵地（各半精力）；首阶段末开播改为双平台开播。预算金额不变。")

# ---------- 第 16 页：里程碑 ----------
s = S(16)
write(find(s, 25), "第 4 月起", size=14, bold=True, color=ACC)
write(find(s, 27), "双平台试运营", size=19, bold=True)
write(find(s, 28), [[("验收物  ", {"bold": True, "color": MUTED}), ("B站与抖音开播记录、回访与净到账收入台账", {})]], size=13.5)
retext(find(s, 35), "延后周边、新游戏接入与抖音直播加量", "延后周边、新游戏接入与追加推广")
retext(find(s, 35), "主阵地开播", "双平台开播")
retext(find(s, 37), "B站主阵地试运营", "B站、抖音双平台试运营")
add_note(s, "【2026-10-25 更新（用户口述）】里程碑按资金到账后第 1 月形象交付、第 2 月内部试播、第 3 月观众验证、第 4 月起双平台（B站、抖音）试运营。")

prs.save(OUT)
print("saved", OUT)
