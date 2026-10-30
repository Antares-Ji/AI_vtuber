// 潮生智能 · 姬岁歌人机共播 · 昆山杯路演 PPT 改稿v2
// 版式参考：Slidesgo「Investor Pitch Deck」——左对齐标题、单一主视觉、图表 + 结论栏、白底单色强调
// 事实：../final/昆山杯-潮生智能-商业计划书-人机共播修订版.docx（2026-10-24）+ 用户确认事项；财务：预算测算明细-改稿v2.xlsx
const pptxgen = require("pptxgenjs");
const path = require("path");

const A = (f) => path.join(__dirname, "assets", f);
const OUT = process.argv[2] || path.join(__dirname, "昆山杯-潮生智能-路演PPT-人机共播版-改稿v2.pptx");

const C = { ink: "1F2329", muted: "5B6270", faint: "8A909C", line: "D5D9E0", soft: "F4F6F9", acc: "2459D6", acc2: "7FA0E8", acc3: "B9CCF4", accSoft: "EAF0FD", grey: "9AA1AD", grey2: "C9CED6", white: "FFFFFF" };
const FONT = "Microsoft YaHei";
const W = 13.333, M = 0.6, CW = W - 2 * M, TOTAL = 11;

const SRC = {
  Q1: ["前瞻产业研究院（新浪财经 2024-08-27）", "https://finance.sina.com.cn/roll/2024-08-27/doc-incmaiqi4039892.shtml"],
  R2: ["澎湃：3606 名虚拟主播", "https://www.thepaper.cn/newsDetail_forward_18022449"],
  S1: ["YouTube 2025 报告", "https://blog.youtube/culture-and-trends/youtube-culture-trends-report-virtual-creators/"],
  S2: ["B站 2026Q2 公告", "https://www.sec.gov/Archives/edgar/data/1723690/000119312526371261/d434015dex991.htm"],
  S3: ["WWW 2025 VUP 研究", "https://arxiv.org/abs/2502.01553"],
  S4: ["Vedal 官网", "https://vedal.ai/"],
  S5: ["Sync2Cal 排期样本", "https://www.sync2cal.com/gaming/twitch-streamers/neuro-sama"],
  S5b: ["Vedal 官方 Twitch 排期", "https://www.twitch.tv/vedal987/schedule"],
  S6: ["Lumi_Nox 仓库", "https://github.com/MIO-456/Lumi_Nox"],
  S7: ["B站开放平台直播事件文档", "https://openhome.bilibili.com/doc/4/c7b549c9-d5d6-0331-b510-465ed4107e01"],
  S8: ["抖音开放平台直播 SDK", "https://open.douyin.com/platform/resource/docs/ability/douyin-live-sdk/introduction"],
  S9: ["抖音直播行为规范", "https://sf3-cdn-tos.douyinstatic.com/obj/ies-hotsoon-draft/webcast_all_anchor/webcast_ban_protocol.html"],
  R1: ["浙大 2025 抖音主播调研", "https://www.sohu.com/a/976695880_121864818"],
  R3: ["界面：许安一 100 天", "https://www.jiemian.com/article/7724509.html"],
  R4: ["新榜：虚拟主播收入中位数", "https://www.woshipm.com/it/5267948.html"],
  R5: ["B站 2025 全年业绩报道", "https://finance.sina.com.cn/tech/roll/2026-03-05/doc-inhpycce3081263.shtml"],
};

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";
pres.title = "潮生智能 · 姬岁歌人机共同直播（改稿v2）";
pres.theme = { headFontFace: FONT, bodyFontFace: FONT };

const T = (s, text, o) => s.addText(text, Object.assign({ isTextBox: true, margin: 0, fontFace: FONT, color: C.ink, valign: "top" }, o));
function box(s, x, y, w, h, st = "line", rad = 0.08) {
  const map = {
    solid: { fill: { color: C.acc }, line: { type: "none" } },
    acc: { fill: { color: C.white }, line: { color: C.acc, width: 1.75 } },
    accSoft: { fill: { color: C.accSoft }, line: { type: "none" } },
    soft: { fill: { color: C.soft }, line: { type: "none" } },
    line: { fill: { color: C.white }, line: { color: C.line, width: 1 } },
    dash: { fill: { color: C.white }, line: { color: C.faint, width: 1.25, dashType: "dash" } },
  };
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, Object.assign({ x, y, w, h, rectRadius: rad }, map[st]));
}
function arrow(s, x1, y1, x2, y2, o = {}) {
  s.addShape(pres.shapes.LINE, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    flipH: x2 < x1, flipV: y2 < y1, line: { color: o.color || C.faint, width: o.width || 1.5, endArrowType: o.noHead ? undefined : "triangle", dashType: o.dash ? "dash" : "solid" } });
}
function tag(s, text, x, y, { st = "accSoft", color = C.acc, size = 13, h = 0.34, w } = {}) {
  w = w || text.length * size * 0.0175 + 0.36;
  box(s, x, y, w, h, st, h / 2);
  T(s, text, { x, y, w, h, fontSize: size, bold: true, color, align: "center", valign: "middle" });
  return w;
}
function img(s, file, x, y, w, h, caption) {
  s.addImage({ path: A(file), x, y, w, h });
  s.addShape(pres.shapes.RECTANGLE, { x, y, w, h, fill: { type: "none" }, line: { color: C.line, width: 0.75 } });
  if (caption) T(s, caption, { x, y: y + h + 0.08, w, h: 0.3, fontSize: 12, color: C.faint });
}
// module label + title (+ optional subtitle)
function head(s, mod, t, sub) {
  T(s, mod, { x: M, y: 0.32, w: 6, h: 0.3, fontSize: 13, bold: true, color: C.acc });
  T(s, t, { x: M, y: 0.62, w: CW, h: 0.72, fontSize: 32, bold: true, valign: "middle" });
  if (sub) T(s, sub, { x: M, y: 1.36, w: CW, h: 0.4, fontSize: 18, color: C.muted });
}
function footer(s, n, srcKeys = [], extra = "") {
  s.addShape(pres.shapes.LINE, { x: M, y: 6.98, w: CW, h: 0, line: { color: C.line, width: 0.75 } });
  const runs = [];
  if (srcKeys.length) runs.push({ text: "来源：", options: { color: C.faint } });
  srcKeys.forEach((k, i) => {
    runs.push({ text: `[${k}] ${SRC[k][0]}`, options: { color: C.acc, hyperlink: { url: SRC[k][1] } } });
    if (i < srcKeys.length - 1) runs.push({ text: "  ·  ", options: { color: C.faint } });
  });
  if (extra) runs.push({ text: (srcKeys.length ? "    " : "") + extra, options: { color: C.faint } });
  if (runs.length) T(s, runs, { x: M, y: 7.04, w: CW - 1.3, h: 0.3, fontSize: 11, valign: "middle" });
  T(s, [{ text: String(n).padStart(2, "0"), options: { bold: true, color: C.ink } }, { text: ` / ${TOTAL}`, options: { color: C.faint } }],
    { x: W - M - 1.2, y: 7.04, w: 1.2, h: 0.3, fontSize: 12, align: "right", valign: "middle" });
}
const N = (o) => [
  "【本页讲述要点】", ...o.say.map((t) => "· " + t),
  ...(o.more ? ["", "【补充说明】", ...o.more.map((t) => "· " + t)] : []),
  ...(o.bound ? ["", "【假设与能力边界】", ...o.bound.map((t) => "· " + t)] : []),
  ...(o.src ? ["", "【来源】", ...o.src.map((t) => "· " + (SRC[t] ? `[${t}] ${SRC[t][0]}：${SRC[t][1]}` : t))] : []),
  ...(o.todo ? ["", "【待确认事项】", ...o.todo.map((t) => "· " + t)] : []),
].join("\n");
function slide(notes) {
  const s = pres.addSlide();
  s.background = { color: C.white };
  s.addNotes(notes);
  return s;
}
const chartBase = { catAxisLabelFontFace: FONT, valAxisLabelFontFace: FONT, dataLabelFontFace: FONT, legendFontFace: FONT, titleFontFace: FONT };

// ===== 01 封面 =====
{
  const s = slide(N({
    say: ["潮生智能团队，项目是原创角色“姬岁歌”的人机共同直播。", "一句话：主持人主动设局造梗，AI 以岁、歌两种稳定性格接梗，围绕游戏和弹幕形成真实互动，再用直播、切片和连续剧情吸引观众回访。"],
    bound: ["右侧为角色概念图，版权归团队所有，正在生成定稿；原画与 Live2D 计划 11 月底交付。"],
    src: ["商业计划书封面与项目摘要（2026-10-24 人机共播修订版）"],
  }));
  T(s, "2026 昆山杯清华大学创业大赛 · 种子组 · AI for X 赛道", { x: M, y: 0.9, w: 7.3, h: 0.35, fontSize: 15, bold: true, color: C.acc });
  T(s, "潮生智能", { x: M, y: 1.7, w: 7, h: 0.55, fontSize: 24, bold: true, color: C.muted });
  T(s, "姬岁歌\n人机共同直播", { x: M, y: 2.35, w: 7.3, h: 2.2, fontSize: 54, bold: true, lineSpacingMultiple: 1.05 });
  s.addShape(pres.shapes.LINE, { x: M, y: 4.75, w: 1.0, h: 0, line: { color: C.acc, width: 3 } });
  T(s, "主持人设局造梗，AI 以角色性格接梗，\n共同经历让观众回来看下一场", { x: M, y: 4.95, w: 7.3, h: 0.95, fontSize: 21, color: C.muted, lineSpacingMultiple: 1.2 });
  T(s, "项目负责人  杨若朝    ·    潮生智能团队", { x: M, y: 6.35, w: 7.3, h: 0.35, fontSize: 16 });
  const ih = 6.0, iw = ih * 1226 / 1283;
  s.addImage({ path: A("jisui-concept.png"), x: W - M - iw, y: 0.55, w: iw, h: ih });
  T(s, "角色概念图 · 定稿中，原画与 Live2D 11 月底交付", { x: W - M - iw, y: 6.6, w: iw, h: 0.3, fontSize: 12, color: C.faint, align: "center" });
  footer(s, 1);
}

// ===== 02 目录 =====
{
  const s = slide(N({
    say: ["汇报按商业计划书的六个模块展开：项目背景、市场与竞品、产品（4 页）、团队、商业模式、市场战略。", "每个模块右侧是这一部分的结论，读完目录就知道整份提案要说什么。"],
  }));
  T(s, "目录", { x: M, y: 0.62, w: 3.2, h: 0.72, fontSize: 32, bold: true, valign: "middle" });
  s.addShape(pres.shapes.LINE, { x: M, y: 1.45, w: 1.0, h: 0, line: { color: C.acc, width: 3 } });
  T(s, "姬岁歌人机共同直播\n昆山杯路演", { x: M, y: 1.7, w: 3.2, h: 0.9, fontSize: 16, color: C.muted, lineSpacingMultiple: 1.2 });
  const rows = [
    ["01", "项目背景", "AI 会说话之后，难的是做出值得追看的节目", "03"],
    ["02", "市场规模与竞品分析", "虚拟主播供给翻倍，头部仍只占约 1%", "04"],
    ["03", "产品介绍", "共同经历、观众端与后台、技术、证据与验收", "05–08"],
    ["04", "团队介绍", "九人按“一场节目”的生产流程分工", "09"],
    ["05", "商业模式", "首年收入情景覆盖运营与履约支出的 98.6%", "10"],
    ["06", "市场战略规划", "首阶段申请 4.62 万元，先完成形象、试播与验证", "11"],
  ];
  const lx = M + 3.9, lw = CW - 3.9, y0 = 0.75, rh = 0.98;
  rows.forEach(([n, a, b, pg], i) => {
    const y = y0 + i * rh;
    T(s, n, { x: lx, y, w: 0.9, h: rh, fontSize: 28, bold: true, color: i === 2 ? C.acc : C.acc3, valign: "middle" });
    T(s, a, { x: lx + 1.0, y: y + 0.14, w: lw - 2.3, h: 0.42, fontSize: 21, bold: true });
    T(s, b, { x: lx + 1.0, y: y + 0.54, w: lw - 2.3, h: 0.34, fontSize: 15, color: C.muted });
    T(s, pg, { x: lx + lw - 1.2, y, w: 1.2, h: rh, fontSize: 16, bold: true, color: C.faint, align: "right", valign: "middle" });
    if (i < rows.length - 1) s.addShape(pres.shapes.LINE, { x: lx, y: y + rh, w: lw, h: 0, line: { color: C.line, width: 0.75 } });
  });
  footer(s, 2);
}

// ===== 02 项目背景 =====
{
  const s = slide(N({
    say: ["问题：AI 能回答问题之后，难的是持续做出值得看、值得分享、能按期交付的节目。", "我们的回答是人机共播：主持人设局、追问并给出真实反应；AI 以稳定角色回应，并在游戏里做出不同于搭档预期的选择。", "四步构成一场节目，结果留到下一场回收，这是观众回访的理由。", "目标观众：喜欢 VTuber、爱看整活与联动的中文观众；已有 5 名这类路人观众的初步反馈。"],
    more: ["首批服务两类观众：愿意持续追看角色与搭档关系的人；先被游戏反转和 AI 意外反应吸引的人。", "中文接梗需要持续本地化：一个梗同时依赖谐音、弹幕上下文、游戏局势、搭档关系和说话时机；主持人主动造梗为 AI 提供可理解的现场条件。"],
    bound: ["“人化”指可识别的性格、表达和连续经历；AI 情绪属于角色表达，不宣称拥有真实情感。", "5 名路人观众为小样本定性反馈，与熟人前测类似，不是正式验证；正式验证计划扩大到 30 名成年受试者。"],
    src: ["商业计划书第 3–4 页", "5 名路人观众初步反馈：团队记录（用户提供，2026-10）"],
    todo: ["5 名路人反馈的书面记录（时间、渠道、主要反馈）。"],
  }));
  head(s, "01 项目背景", "AI 会说话之后，难的是做出值得追看的节目");
  // left: 3 blocks
  const lw = 5.3, y0 = 1.75;
  const items = [["目标观众", "喜欢 VTuber、爱看整活联动的中文观众"], ["人机分工", "主持人设局与真实反应，AI 稳定角色回应"], ["初步反馈", "5 名路人最想看整活与联动（小样本）"]];
  items.forEach(([k, v], i) => {
    const y = y0 + i * 1.62;
    s.addShape(pres.shapes.LINE, { x: M, y, w: 0, h: 1.3, line: { color: i === 0 ? C.acc : C.line, width: 3 } });
    T(s, k, { x: M + 0.25, y, w: lw - 0.3, h: 0.4, fontSize: 16, bold: true, color: C.acc });
    T(s, v, { x: M + 0.25, y: y + 0.45, w: lw - 0.3, h: 0.85, fontSize: 19 });
  });
  // right: loop
  const rx = M + lw + 0.4, rw = CW - lw - 0.4, nw = 2.85, nh = 1.25;
  const cx = rx + rw / 2, top = 1.85, bot = 4.85;
  const nodes = [
    [cx - nw - 0.35, top, "主持人设局造梗", "挑战 · 玩笑 · 追问", "solid"],
    [cx + 0.35, top, "AI 按角色回应", "岁好奇追问，歌坚持立场", "acc"],
    [cx + 0.35, bot, "游戏产生真实结果", "做成或缺材料都真实", "line"],
    [cx - nw - 0.35, bot, "观众参与并期待", "预测 · 评论 · 回收旧梗", "line"],
  ];
  nodes.forEach(([x, y, a, b, st]) => {
    box(s, x, y, nw, nh, st);
    T(s, a, { x: x + 0.2, y: y + 0.18, w: nw - 0.4, h: 0.45, fontSize: 19, bold: true, color: st === "solid" ? C.white : C.ink });
    T(s, b, { x: x + 0.2, y: y + 0.68, w: nw - 0.4, h: 0.4, fontSize: 15, color: st === "solid" ? "E8EEFC" : C.muted });
  });
  arrow(s, cx - 0.33, top + nh / 2, cx + 0.33, top + nh / 2, { color: C.acc, width: 2 });
  arrow(s, cx + 0.35 + nw / 2, top + nh + 0.05, cx + 0.35 + nw / 2, bot - 0.05, { color: C.acc, width: 2 });
  arrow(s, cx + 0.33, bot + nh / 2, cx - 0.33, bot + nh / 2, { color: C.acc, width: 2 });
  arrow(s, cx - 0.35 - nw / 2, bot - 0.05, cx - 0.35 - nw / 2, top + nh + 0.05, { color: C.acc, width: 2, dash: true });
  T(s, "人机共播", { x: cx - 1.2, y: top + nh + 0.45, w: 2.4, h: 0.5, fontSize: 22, bold: true, color: C.acc, align: "center" });
  T(s, "下一场回收", { x: cx - nw - 0.35 + nw / 2 + 0.1, y: top + nh + 0.75, w: 1.6, h: 0.3, fontSize: 13, color: C.acc });
  T(s, "“人化”指可识别的性格、表达与连续经历，不宣称 AI 有真实情感", { x: rx, y: bot + nh + 0.2, w: rw, h: 0.32, fontSize: 14, color: C.muted, align: "center" });
  footer(s, 3, [], "依据：商业计划书第 3–4 页；5 人初步反馈为团队记录");
}

// ===== 03 市场规模与竞品 =====
{
  const s = slide(N({
    say: ["图一：据前瞻产业研究院整理，B站虚拟主播从 2021-11-02 的 3,606 名增至 2024-07-22 的 8,689 名，约增长 141%。", "图二：同期 50 万粉以上的虚拟主播从 39 名增至 104 名，占比只从 1.1% 变为 1.2%。供给增加很快，头部仍很集中。", "结论：新账号不能只靠“又一个虚拟主播”，需要可辨识的节目形式；我们的切入点是中文接梗、人机节目和北京时间晚间档，但这些都还需验证。", "Neuro 在人物关系、内容积累和商业化上明显领先，是学习对象。"],
    more: ["补充分布：截至 2021-11-02，约 2/3 的 B站虚拟主播粉丝不足 1 万；月营收前 120 名占行业一半以上 [R2]。", "付费需求背景：B站虚拟主播付费舰长约 15.2 万人、月营收约 350 万美元（VTBS.moe 2024，转引自 [S3]）。", "平台背景：YouTube 2024 年 300 个虚拟创作者样本合计超过 150 亿次观看 [S1]；Bilibili 2026Q2 月活约 3.71 亿 [S2]。两者口径不同，仅作背景，不放进同一张图，也不是项目可获得用户。", "Neuro 时段：2026-10-24 查询的第三方排期样本中，2 场分别在北京时间次日 02:00 与 03:00 [S5]，以官方 Twitch 公告为准 [S5b]；仅为样本，不是固定规律。", "国内已有公开项目实现双 AI 语音、记忆与游戏桥接 [S6]，技术本身不构成壁垒。"],
    bound: ["前瞻产业研究院未公开统计口径（如何界定“虚拟主播”）；两个时间点间隔约 2 年 8 个月，图中只展示两点，不外推趋势。", "中文与时段优势可被复制，不是壁垒。"],
    src: ["Q1", "R2", "S3", "S1", "S2", "S4", "S5", "S5b", "S6"],
    todo: ["项目可获得市场规模（喜欢 VTuber、爱看整活联动的中文观众）暂无可引用的同口径数据。"],
  }));
  head(s, "02 市场规模与竞品分析", "B站虚拟主播增至 8,689 名，50 万粉以上仍只占约 1%");
  const y0 = 1.65, ch = 4.55;
  // chart 1: counts
  T(s, "B站虚拟主播数量（名）", { x: M, y: y0, w: 4.1, h: 0.35, fontSize: 16, bold: true });
  s.addChart(pres.charts.BAR, [{ name: "虚拟主播数量", labels: ["2021-11-02", "2024-07-22"], values: [3606, 8689] }], Object.assign({}, chartBase, {
    x: M, y: y0 + 0.4, w: 4.1, h: ch - 0.4, barDir: "col", barGapWidthPct: 70, chartColors: [C.acc],
    showValue: true, dataLabelPosition: "outEnd", dataLabelFontSize: 16, dataLabelFontBold: true, dataLabelColor: C.ink, dataLabelFormatCode: "#,##0",
    catAxisLabelFontSize: 14, catAxisLabelColor: C.muted, catAxisLineShow: true, valAxisHidden: true, valAxisMinVal: 0, valAxisMaxVal: 10000,
    valGridLine: { style: "none" }, showLegend: false, objectName: "B站虚拟主播数量柱状图",
  }));
  // chart 2: share of 500k+
  const x2 = M + 4.45;
  T(s, "50 万粉以上占比（%）", { x: x2, y: y0, w: 3.6, h: 0.35, fontSize: 16, bold: true });
  s.addChart(pres.charts.BAR, [{ name: "50 万粉以上占比", labels: ["2021-11-02\n39 / 3,606", "2024-07-22\n104 / 8,689"], values: [1.08, 1.20] }], Object.assign({}, chartBase, {
    x: x2, y: y0 + 0.4, w: 3.6, h: ch - 0.4, barDir: "col", barGapWidthPct: 70, chartColors: [C.acc2],
    showValue: true, dataLabelPosition: "outEnd", dataLabelFontSize: 16, dataLabelFontBold: true, dataLabelColor: C.ink, dataLabelFormatCode: '0.0"%"',
    catAxisLabelFontSize: 13, catAxisLabelColor: C.muted, valAxisHidden: true, valAxisMinVal: 0, valAxisMaxVal: 10,
    valGridLine: { style: "none" }, showLegend: false, objectName: "50万粉以上占比柱状图",
  }));
  T(s, "统计口径未公开；两点之间不外推趋势", { x: M, y: y0 + ch + 0.05, w: 8, h: 0.3, fontSize: 12, color: C.faint });
  // right: takeaway & positioning
  const rx = M + 8.45, rw = CW - 8.45;
  box(s, rx, y0, rw, 1.65, "solid");
  T(s, "供给翻倍，头部仍集中", { x: rx + 0.25, y: y0 + 0.18, w: rw - 0.5, h: 0.4, fontSize: 18, bold: true, color: C.white });
  T(s, "新账号需要可辨识的节目形式，而不是又一个虚拟形象", { x: rx + 0.25, y: y0 + 0.65, w: rw - 0.5, h: 0.85, fontSize: 15, color: "E8EEFC" });
  const rows = [["Neuro-sama", "人物关系成熟，内容与商业化领先 [S4]", "line"], ["姬岁歌（待验证）", "中文接梗 · 人机节目 · 北京时间 20–22 点", "acc"]];
  rows.forEach(([a, b, st], i) => {
    const y = y0 + 1.9 + i * 1.32;
    box(s, rx, y, rw, 1.14, st);
    T(s, a, { x: rx + 0.25, y: y + 0.12, w: rw - 0.5, h: 0.38, fontSize: 17, bold: true, color: st === "acc" ? C.acc : C.ink });
    T(s, b, { x: rx + 0.25, y: y + 0.52, w: rw - 0.5, h: 0.55, fontSize: 14, color: C.muted });
  });
  footer(s, 4, ["Q1", "S4", "S5"], "更多背景数据与口径见备注");
}

// ===== 04 产品 1/4 观看价值 =====
{
  const s = slide(N({
    say: ["左图是开发版运行截图：AI 在 Minecraft 里没做成工作台，主动说明“背包里只有云杉原木，得先把它变成木板”。观众看到的不是完美操作，而是能理解的真实进展。", "右侧是节目设计示例：主持人用“谁先做出木剑谁当队长”设局，岁追问规则、歌抢先砍树，游戏给出真实结果，观众预测并在下一场回收约定。", "岁偏向好奇、观察和理解；歌偏向坚持、选择与守护。主持人呈现真实的惊讶、着急和认错。"],
    more: ["计划书示例：主持人提出“先当队长还是先干活”的木剑挑战，AI 回应后在实际游戏中采集和制作；成功后回收开场玩笑，失败则一起核对缺少的材料。", "工程中已有 Minecraft 规划、动作执行与原木、木剑入库记录 [I1]。"],
    bound: ["截图来自开发版游戏工作台，Live2D 为临时占位模型，不是姬岁歌最终形象，也不是正式直播画面。", "右侧台词为节目设计示例，不是实际录屏或测试结果。"],
    src: ["商业计划书第 6、9 页", "截图：.codex-ppt-build/live-focus.png（开发版游戏工作台）", "工程索引 [I1] docs/minecraft-deepseek.md"],
  }));
  head(s, "03 产品介绍 · 1/4", "观众追看的是主持人与 AI 的共同经历");
  const y0 = 1.65, iw = 7.3, ih = iw * 650 / 1510;
  img(s, "live-focus.png", M, y0, iw, ih, "开发版运行截图 · Live2D 为临时占位模型");
  box(s, M, y0 + ih + 0.5, iw, 1.15, "accSoft");
  T(s, [{ text: "真实片段  ", options: { bold: true, color: C.acc } }, { text: "AI 没做成工作台，主动说明缺什么：\n「背包里只有云杉原木，得先把它变成木板。」", options: { color: C.ink } }],
    { x: M + 0.3, y: y0 + ih + 0.5, w: iw - 0.6, h: 1.15, fontSize: 17, valign: "middle" });
  const rx = M + iw + 0.45, rw = CW - iw - 0.45;
  tag(s, "节目设计示例", rx, y0, { size: 13, w: 1.6 });
  const steps = [["主持人设局", "「谁先做出木剑，谁当队长。」"], ["岁 / 歌回应", "岁追问规则，歌抢先砍树"], ["游戏结果", "做成或缺材料，都在画面里"], ["观众参与", "预测胜负，下一场回收约定"]];
  steps.forEach(([a, b], i) => {
    const y = y0 + 0.55 + i * 1.12;
    s.addShape(pres.shapes.OVAL, { x: rx, y: y + 0.05, w: 0.42, h: 0.42, fill: { color: i === 0 ? C.acc : C.white }, line: { color: C.acc, width: 1.25 } });
    T(s, String(i + 1), { x: rx, y: y + 0.05, w: 0.42, h: 0.42, fontSize: 14, bold: true, color: i === 0 ? C.white : C.acc, align: "center", valign: "middle" });
    if (i < 3) s.addShape(pres.shapes.LINE, { x: rx + 0.21, y: y + 0.5, w: 0, h: 0.62, line: { color: C.acc3, width: 1.5 } });
    T(s, a, { x: rx + 0.62, y, w: rw - 0.62, h: 0.4, fontSize: 18, bold: true });
    T(s, b, { x: rx + 0.62, y: y + 0.42, w: rw - 0.62, h: 0.5, fontSize: 16, color: C.muted });
  });
  footer(s, 5, [], "依据：商业计划书第 6、9 页；工程索引 [I1]");
}

// ===== 05 产品 2/4 观众端与后台 =====
{
  const s = slide(N({
    say: ["左边是观众看到的节目：游戏或主题画面为主体，配合姬岁歌形象、主持人声音或头像、字幕与当晚任务；弹幕、关注、礼物用平台原生入口。", "右边是团队用的后台：主持、人格运营、技术和值班运营围绕同一场节目协作，可以审核记忆、查看运行状态、随时人工接管。", "调试参数、错误日志和模型配置不进入观众画面。"],
    more: ["现有页面：首页与 OBS 叠加层承担舞台与字幕；games.html 组织游戏画面、模型方案、聊天与任务停止；studio.html 提供候选记忆审核、大脑诊断、连续经历和直播运行；debug.html 用于开发调试。", "商业开播需补齐：双平台消息标记来源；礼物事件去重、撤回和退款核对；观众建议确认后再影响任务；播前检查画面只含批准内容；播后按时间戳导出高光。"],
    bound: ["左侧为界面方案示意，不是已上线产品截图。", "右侧为现有导演工作台开发版截图（记忆审核页），不是正式观众界面。", "overlay=1 可隐藏控制区用于 OBS 叠加，但隐藏控件不等于已完成后台权限隔离。"],
    src: ["商业计划书第 6–7 页", "工程索引 [I4] public/index.html、stream.css、games.html、studio.html"],
    todo: ["观众端横屏（B站）与竖屏（抖音）画面方案尚未出图；主持人是否露脸按节目安排。"],
  }));
  head(s, "03 产品介绍 · 2/4", "观众端只放节目，后台负责调度与人工接管");
  const pw = 5.95, y0 = 1.65;
  T(s, "观众端", { x: M, y: y0, w: 1.2, h: 0.4, fontSize: 20, bold: true, color: C.acc });
  tag(s, "界面方案 · 非上线截图", M + 1.2, y0 + 0.03, { size: 12, st: "soft", color: C.muted, w: 2.3 });
  const fx = M, fy = y0 + 0.6, fw = pw, fh = fw * 9 / 16;
  box(s, fx, fy, fw, fh, "line", 0.04);
  box(s, fx + 0.15, fy + 0.15, fw * 0.66, fh - 0.95, "soft", 0.04);
  T(s, "游戏或主题画面", { x: fx + 0.15, y: fy + 0.15, w: fw * 0.66, h: fh - 0.95, fontSize: 18, bold: true, color: C.muted, align: "center", valign: "middle" });
  tag(s, "当前任务：做出木剑", fx + 0.3, fy + 0.3, { size: 12, st: "solid", color: C.white, w: 2.0 });
  const sx = fx + 0.3 + fw * 0.66, sw = fw - fw * 0.66 - 0.45;
  box(s, sx, fy + 0.15, sw, 1.55, "accSoft", 0.04);
  T(s, "AI 角色\n岁 / 歌", { x: sx, y: fy + 0.15, w: sw, h: 1.55, fontSize: 16, bold: true, color: C.acc, align: "center", valign: "middle" });
  box(s, sx, fy + 1.82, sw, fh - 2.62, "soft", 0.04);
  T(s, "主持人\n声音或头像", { x: sx, y: fy + 1.82, w: sw, h: fh - 2.62, fontSize: 14, bold: true, color: C.muted, align: "center", valign: "middle" });
  box(s, fx + 0.15, fy + fh - 0.68, fw - 0.3, 0.52, "line", 0.04);
  T(s, "字幕：岁「队长要负责什么？」", { x: fx + 0.35, y: fy + fh - 0.68, w: fw - 0.7, h: 0.52, fontSize: 14, valign: "middle" });
  T(s, "平台原生互动：弹幕 · 关注 · 礼物 · 会员", { x: M, y: fy + fh + 0.18, w: pw, h: 0.4, fontSize: 18 });
  const bx = M + pw + 0.35, bw = CW - pw - 0.35;
  s.addShape(pres.shapes.LINE, { x: M + pw + 0.17, y: y0, w: 0, h: 5.05, line: { color: C.line, width: 1 } });
  T(s, "后台", { x: bx, y: y0, w: 0.9, h: 0.4, fontSize: 20, bold: true, color: C.acc });
  tag(s, "现有导演工作台 · 开发版截图", bx + 0.85, y0 + 0.03, { size: 12, st: "soft", color: C.muted, w: 2.9 });
  const iw = bw, ih = iw * 900 / 1600;
  img(s, "studio.png", bx, fy, iw, ih);
  const mods = ["记忆审核", "运行状态", "弹幕筛选", "游戏任务", "人工接管"];
  const mw = (iw - 4 * 0.12) / 5;
  mods.forEach((m, i) => tag(s, m, bx + i * (mw + 0.12), fy + ih + 0.18, { size: 15, h: 0.4, w: mw, st: "line", color: C.ink }));
  T(s, "调试参数与日志不进观众画面；隐藏控制区 ≠ 权限隔离，仍需梳理", { x: bx, y: fy + ih + 0.7, w: iw, h: 0.35, fontSize: 14, color: C.muted });
  footer(s, 6, [], "依据：商业计划书第 6–7 页；工程索引 [I4]");
}

// ===== 06 产品 3/4 技术服务节目 =====
{
  const s = slide(N({
    say: ["四个环节：听懂输入、决定谁何时回应、用角色声音说出来、在画面上呈现。每个技术都对应观众能感知的效果。", "游戏行动单独闭环：模型规划任务，程序执行动作并检查结果，再按准备、尝试、完成分别口播，避免把计划说成成果。", "截图是现有游戏工作台：左侧游戏画面，右侧角色舞台、字幕与语音选择。"],
    more: ["SenseVoice 语音识别把主持人语音送入上下文；Node.js 服务按人格与现场任务路由到语言模型；GPT-SoVITS 或系统 TTS 朗读；Live2D、字幕经 OBS 进入画面。", "Minecraft 以 DeepSeek、千问等规划方案与 Mineflayer 执行衔接，动作经程序检查并读取结果；STS2 有工具动作与口播回执快照。", "SQLite 保存经人工确认的共同事件，供下一场接续。"],
    bound: ["模块存在不等于所有组合都已稳定；试播版本的模型、声线授权与首次可听回应延迟尚未测定。", "截图中的 Live2D 为临时占位模型；完整游戏通关和任意游戏适配不列为已实现成果。"],
    src: ["商业计划书第 8 页", "截图：.codex-ppt-build/game-focus.png（开发版游戏工作台）", "工程索引 [I1] [I2] [I6]"],
    todo: ["试播版本的具体模型、声线授权与首次可听回应延迟。"],
  }));
  head(s, "03 产品介绍 · 3/4", "四个环节把语音、弹幕和游戏变成角色回应");
  const y0 = 1.65, gap = 0.4, bw = (CW - 3 * gap) / 4, bh = 1.45;
  const chain = [["听懂", "语音识别 · 弹幕 · 游戏"], ["调度", "人格 + 任务 → 模型"], ["说出来", "岁 / 歌声线 TTS"], ["呈现", "Live2D · 字幕 · OBS"]];
  chain.forEach(([a, b], i) => {
    const x = M + i * (bw + gap);
    box(s, x, y0, bw, bh, i === 1 ? "acc" : "line");
    T(s, a, { x: x + 0.25, y: y0 + 0.2, w: bw - 0.5, h: 0.5, fontSize: 22, bold: true, color: i === 1 ? C.acc : C.ink });
    T(s, b, { x: x + 0.25, y: y0 + 0.8, w: bw - 0.5, h: 0.5, fontSize: 15, color: C.muted });
    if (i < 3) arrow(s, x + bw + 0.05, y0 + bh / 2, x + bw + gap - 0.05, y0 + bh / 2, { color: C.acc, width: 2 });
  });
  const iy = y0 + bh + 0.4, ih = 3.0, iw = ih * 1510 / 650;
  img(s, "game-focus.png", M, iy, iw, ih, "开发版游戏工作台截图 · Live2D 为临时占位模型");
  const rx = M + iw + 0.4, rw = CW - iw - 0.4;
  T(s, "游戏行动闭环", { x: rx, y: iy, w: rw, h: 0.4, fontSize: 18, bold: true, color: C.acc });
  ["规划任务", "执行动作", "检查结果", "据实口播"].forEach((t, i) => {
    const y = iy + 0.55 + i * 0.58;
    box(s, rx, y, rw, 0.46, i === 3 ? "accSoft" : "soft", 0.23);
    T(s, `${i + 1}  ${t}`, { x: rx + 0.25, y, w: rw - 0.5, h: 0.46, fontSize: 17, bold: true, valign: "middle", color: i === 3 ? C.acc : C.ink });
  });
  T(s, "共同事件经人工确认后存入记忆，下一场接续", { x: rx, y: iy + 2.95, w: rw, h: 0.5, fontSize: 14, color: C.muted });
  footer(s, 7, [], "依据：商业计划书第 8 页；工程索引 [I1][I2][I6]");
}

// ===== 07 产品 4/4 证据与验证 =====
{
  const s = slide(N({
    say: ["左边是已有证据：不同模块和局部任务能运行，另有 5 名路人观众的初步反馈。", "右边是整场节目上线前的四项验收：连续节目稳定性、中文接梗、双平台真实接入、观众回访。", "中文接梗的难点在语境、双关、反讽、角色一致、回应时机和旧事回收；测试按“主持人铺垫 → AI 理解 → 角色回应 → 观众反馈”记录。"],
    more: ["场景设计：谐音、认真误解、反向挑战、角色分歧和旧事回收，同时放入普通对话作对照；每种人格分别生成并由内容人员复核，保留未见过的场景检验迁移。", "正式观众验收：30 名成年观众按观看习惯分层，随机平衡两段各 6 分钟样片顺序；一次只比较一项变化。团队预设门槛：自由观看中位数 3 分钟；至少 15 人记住角色或事件；至少 6 人七天内主动回看满 60 秒。", "失败预案：接梗生硬回到具体场景；语音延迟时缩短回复并由主持人续场；游戏卡住时停止任务、切备用栏目。"],
    bound: ["尚无测评数据，页面不展示成功率。", "5 名路人观众为小样本定性反馈，不是正式验证。", "已有证据不证明能任意游戏长期自主直播。"],
    src: ["商业计划书第 9、19 页", "[I1] docs/minecraft-deepseek.md、logs/minecraft-deepseek-live-run.json", "[I2] output/sts2/streamer-acceptance.json（2026-10-20）", "[I3] docs/demo-summary-20261018.md", "[I4]–[I6] 界面源文件、B站事件归一化、记忆候选机制"],
    todo: ["中文接梗场景清单：后续安排。", "30 名成年受试者验证：后续安排。"],
  }));
  head(s, "03 产品介绍 · 4/4", "模块已经跑通，整场节目还要过四项验收");
  const y0 = 1.65, cw = (CW - 0.4) / 2, ch = 3.25;
  box(s, M, y0, cw, ch, "line");
  T(s, "已有证据", { x: M + 0.3, y: y0 + 0.2, w: 3, h: 0.42, fontSize: 20, bold: true, color: C.acc });
  [["Minecraft", "规划→执行，原木与木剑入库"], ["STS2", "18 次成功动作 + 口播回执"], ["Flappy Bird", "约定条件下独立策略验收"], ["工作台", "舞台、导演台与记忆审核"], ["观众", "5 名路人初步反馈（小样本）"]].forEach(([a, b], i) => {
    const y = y0 + 0.78 + i * 0.48;
    s.addShape(pres.shapes.OVAL, { x: M + 0.32, y: y + 0.13, w: 0.16, h: 0.16, fill: { color: C.acc }, line: { type: "none" } });
    T(s, [{ text: a + "  ", options: { bold: true } }, { text: b, options: { color: C.muted } }], { x: M + 0.62, y, w: cw - 0.85, h: 0.42, fontSize: 17, valign: "middle" });
  });
  const rx = M + cw + 0.4;
  box(s, rx, y0, cw, ch, "dash");
  T(s, "上线前验收", { x: rx + 0.3, y: y0 + 0.2, w: 3, h: 0.42, fontSize: 20, bold: true });
  [["连续节目稳定性", "整场播完，卡住能切备用栏目"], ["中文接梗", "按场景测试，岁 / 歌分别复核"], ["双平台真实接入", "B站、抖音真实事件"], ["观众回访", "扩大到 30 人，看七天回访"]].forEach(([a, b], i) => {
    const y = y0 + 0.8 + i * 0.6;
    s.addShape(pres.shapes.OVAL, { x: rx + 0.32, y: y + 0.13, w: 0.16, h: 0.16, fill: { color: C.white }, line: { color: C.faint, width: 1.25 } });
    T(s, [{ text: a + "  ", options: { bold: true } }, { text: b, options: { color: C.muted } }], { x: rx + 0.62, y, w: cw - 0.85, h: 0.42, fontSize: 17, valign: "middle" });
  });
  const fy = y0 + ch + 0.4;
  T(s, [{ text: "中文接梗难在  ", options: { bold: true, color: C.acc } }, { text: "语境 · 双关 · 反讽 · 角色一致 · 回应时机 · 旧事回收", options: { color: C.ink } }], { x: M, y: fy, w: CW, h: 0.42, fontSize: 18 });
  const fl = ["主持人铺垫", "AI 理解", "角色回应", "观众反馈"], fg = 0.45, fw = (CW - 3 * fg) / 4;
  fl.forEach((f, i) => {
    const x = M + i * (fw + fg), y = fy + 0.62;
    box(s, x, y, fw, 0.7, i === 3 ? "acc" : "soft");
    T(s, f, { x, y, w: fw, h: 0.7, fontSize: 19, bold: true, align: "center", valign: "middle", color: i === 3 ? C.acc : C.ink });
    if (i < 3) arrow(s, x + fw + 0.05, y + 0.35, x + fw + fg - 0.05, y + 0.35, { color: C.acc, width: 2 });
  });
  footer(s, 8, [], "依据：商业计划书第 9、19 页；工程索引 [I1]–[I6]    仅为测试设计，尚无测评结果");
}

// ===== 08 团队 =====
{
  const s = slide(N({
    say: ["九人按一场节目的生产流程组织：CEO 统筹，技术总监负责系统实现与验收，运营总监负责节目排期与跨工作线交付。", "播前运营总监组织任务、主持与抛梗审阅，技术总监确认依赖服务和接管流程；播后视频负责人筛选高光，市场商务负责人汇总数据，CEO 决定下一轮投入。"],
    more: ["主持人按场次轮值安排；团队成员目前不领薪，工时单独记录。"],
    bound: ["以上为计划中的岗位安排，公司设立后的正式任职另行确认；页面不包含履历与过往成绩。"],
    src: ["商业计划书第 10 页“团队介绍”"],
  }));
  head(s, "04 团队介绍", "九人按“一场节目”的生产流程分工");
  const person = (x, y, w, h, name, role, dl, st = "line") => {
    box(s, x, y, w, h, st);
    T(s, [{ text: name + "  ", options: { bold: true, fontSize: 19, color: st === "solid" ? C.white : C.ink } }, { text: role, options: { fontSize: 14, color: st === "solid" ? C.white : C.acc, bold: true } }], { x: x + 0.25, y: y + 0.12, w: w - 0.4, h: 0.42, valign: "middle" });
    T(s, dl, { x: x + 0.25, y: y + 0.55, w: w - 0.4, h: 0.38, fontSize: 16, color: st === "solid" ? "E8EEFC" : C.muted });
  };
  const ceoW = 4.4, ceoX = (W - ceoW) / 2, y1 = 1.6, h = 1.0;
  person(ceoX, y1, ceoW, h, "杨若朝", "首席执行官", "项目统筹与资源决策", "solid");
  const tx = M, tw = 4.3, ox = M + tw + 0.5, ow = CW - tw - 0.5, y2 = 3.0;
  person(tx, y2, tw, h, "徐嘉盛", "技术总监", "模型、游戏与系统验收", "acc");
  person(ox + (ow - 4.3) / 2, y2, 4.3, h, "姬祥", "运营总监", "节目排期与团队协作", "acc");
  const cx = W / 2, my = y1 + h + 0.2;
  arrow(s, cx, y1 + h, cx, my, { noHead: true });
  arrow(s, tx + tw / 2, my, ox + ow / 2, my, { noHead: true });
  arrow(s, tx + tw / 2, my, tx + tw / 2, y2, { noHead: true });
  arrow(s, ox + ow / 2, my, ox + ow / 2, y2, { noHead: true });
  const y3 = 4.4, y4 = 5.6;
  person(tx, y3, tw, h, "李岱松", "系统工程师", "部署与工作台");
  person(tx, y4, tw, h, "肖鹏希", "音频工程师", "语音与声音效果");
  arrow(s, tx + tw / 2, y2 + h, tx + tw / 2, y3, { noHead: true });
  const gw = (ow - 0.3) / 2;
  [["刘瑞麒", "AI 人格与内容负责人", "角色表达与接梗企划"], ["张涵", "市场与商务负责人", "增长与品牌合作"], ["吴越", "视觉美术负责人", "原画与 Live2D 协作"], ["张乐溪", "视频制作负责人", "高光切片与系列包装"]]
    .forEach(([n, r, d], i) => person(ox + (i % 2) * (gw + 0.3), i < 2 ? y3 : y4, gw, h, n, r, d));
  arrow(s, ox + ow / 2, y2 + h, ox + ow / 2, y3 - 0.02, { noHead: true });
  footer(s, 9, [], "依据：商业计划书第 10 页（计划岗位，正式任职另行确认）；主持人按场次轮值");
}

// ===== 09 商业模式 =====
{
  const s = slide(N({
    say: ["商业逻辑：人机节目经 B站与抖音直播和切片传播，形成观看、回访与社群关系，再转为礼物、会员、周边、品牌及游戏合作，收入再投入内容与制作。", "首个完整运营年度收入情景 61,650 元：会员 19,250、打赏与付费留言 17,400、周边 15,000、商业合作 10,000。", "运营与履约支出 62,500 元：日常运营 52,000 加周边制作履约 10,500。收入覆盖其中 98.6%，运营现金差额为负 850 元，尚未盈利。", "加上 25,000 元启动投入，年末现金缺口 25,850 元；按季度推算，第 9 个月累计垫付最高，约 47,750 元。年末缺口不等于中途需要的最高垫付。"],
    more: [
      "收入依据：会员 = 385 个会员月 × 每会员月净到账 50 元（情景假设，Q3 105、Q4 280）；合作 = 2 次 × 5,000 元（Q4，以签约结算为准）；周边 = 目标销售额 15,000 元，款式与销量未定；打赏 = 计划书季度目标 1,200 / 3,000 / 5,300 / 7,900 元，计划书给出方法“有效观众 × 实际付费比例 × 人均净收入”但未给参数。",
      "口径：打赏与会员为扣除平台分成后的净到账；税费未单列；周边履约按销售额 70%；团队成员不领薪，工时另记。",
      "季度现金：Q1 收入 1,200、支出 13,000，净 −11,800；Q2 净 −10,000；Q3 收入 15,550、支出 16,500，净 −950；Q4 收入 41,900、支出 20,000，净 +21,900。",
      "日常运营明细：模型语音云服务 18,000、剪辑社群补贴 12,000、推广 18,000、活动杂费 4,000。",
      "保守情景（计划书）：会员与合作延后，打赏 8,000、日常支出 40,000、启动 25,000，缺口约 57,000 元，相应推迟预售与可变推广。",
      "打赏进入节目：平台事件核对去重后进入感谢队列，连续小额合并，在任务间隙致谢；免费观众同样参与公开任务；不把打赏绑定角色的爱意、痛苦或输赢 [S9]。",
      "游戏选择看五点：需求潜力、节目效果、AI 可执行程度、观众参与、维护成本。例如 Minecraft 木剑短任务材料与时限明确，失败也能讲清缺什么；游戏热度待公开运营前采样验证。",
      "公开数据背景（不证明本项目收入预测成立）：B站虚拟主播付费舰长约 15.2 万人、月营收约 350 万美元 [S3]；浙大 2025 抖音主播调研中超 66% 月收入 2,000–10,000 元 [R1]；虚拟主播收入高度集中，约 2/3 粉丝不足 1 万 [R2]。",
    ],
    bound: ["以上为预测情景，不是实际经营成绩；项目尚未盈利，也未形成商业闭环。", "全部公式与季度、月度现金流见《预算测算明细-改稿v2.xlsx》。"],
    src: ["商业计划书第 11–16 页", "预算测算明细-改稿v2.xlsx", "S3", "R1", "R2", "S7", "S8", "S9"],
    todo: ["平台收入分成：后续确定。"],
  }));
  head(s, "05 商业模式", "首年收入情景 6.17 万元，覆盖运营与履约支出的 98.6%");
  // thin logic chain
  const chain = ["人机节目", "直播 + 切片", "观看与回访", "四类收入", "再投入内容"];
  let cx = M;
  chain.forEach((t, i) => {
    const w = t.length * 15 * 0.0175 + 0.6;
    box(s, cx, 1.5, w, 0.42, i === 2 ? "solid" : "soft", 0.21);
    T(s, t, { x: cx, y: 1.5, w, h: 0.42, fontSize: 15, bold: true, align: "center", valign: "middle", color: i === 2 ? C.white : C.ink });
    cx += w;
    if (i < chain.length - 1) { arrow(s, cx + 0.05, 1.71, cx + 0.3, 1.71, { color: C.acc, width: 1.5 }); cx += 0.35; }
  });
  // main chart: stacked horizontal bars
  const y0 = 2.25, chW = 8.0, chH = 3.75;
  T(s, "首个完整运营年度 · 测算情景（元）", { x: M, y: y0, w: chW, h: 0.35, fontSize: 16, bold: true });
  const cats = ["运营与履约支出", "年度收入"];
  const series = [
    ["会员", [0, 19250], C.acc], ["打赏与付费留言", [0, 17400], C.acc2], ["周边销售", [0, 15000], C.acc3], ["商业合作", [0, 10000], "DCE5FA"],
    ["日常运营", [52000, 0], C.grey], ["周边履约", [10500, 0], C.grey2],
  ];
  s.addChart(pres.charts.BAR, series.map(([n, v]) => ({ name: n, labels: cats, values: v })), Object.assign({}, chartBase, {
    x: M, y: y0 + 0.35, w: chW, h: chH, barDir: "bar", barGrouping: "stacked", barGapWidthPct: 45, chartColors: series.map((x) => x[2]),
    showValue: true, dataLabelFontSize: 13, dataLabelColor: C.ink, dataLabelFormatCode: "#,##0;;;", dataLabelPosition: "ctr",
    catAxisLabelFontSize: 16, catAxisLabelColor: C.ink, valAxisLabelFontSize: 12, valAxisLabelColor: C.faint, valAxisMinVal: 0, valAxisMaxVal: 70000, valAxisMajorUnit: 10000, valAxisLabelFormatCode: "#,##0",
    valGridLine: { color: "ECEEF2", size: 0.5 }, catGridLine: { style: "none" }, showLegend: true, legendPos: "b", legendFontSize: 13, objectName: "收入构成与支出对比堆积条形图",
  }));
  T(s, "会员 385 会员月 × 50 元 · 合作 2 次 × 5,000 元 · 周边履约按销售额 70%", { x: M, y: y0 + chH + 0.4, w: chW, h: 0.3, fontSize: 13, color: C.muted });
  // KPI column
  const rx = M + chW + 0.4, rw = CW - chW - 0.4;
  const kpi = [["98.6%", "运营履约覆盖率", "61,650 ÷ 62,500", "solid"], ["−850 元", "运营现金差额", "收入 − 运营与履约支出", "line"], ["−25,850 元", "含启动的年末缺口", "再减启动投入 25,000", "line"], ["47,750 元", "累计最高垫付", "第 9 个月末，按季度推算", "acc"]];
  kpi.forEach(([v, k, d, st], i) => {
    const y = y0 + i * 1.08;
    box(s, rx, y, rw, 0.96, st);
    T(s, v, { x: rx + 0.22, y: y + 0.08, w: rw - 0.4, h: 0.5, fontSize: 24, bold: true, color: st === "solid" ? C.white : st === "acc" ? C.acc : C.ink });
    T(s, [{ text: k, options: { bold: true } }, { text: "  " + d, options: {} }], { x: rx + 0.22, y: y + 0.56, w: rw - 0.4, h: 0.32, fontSize: 12, color: st === "solid" ? "E8EEFC" : C.muted });
  });
  T(s, "测算情景，非经营成绩；团队成员不领薪", { x: rx, y: y0 + 4.36, w: rw, h: 0.3, fontSize: 12, color: C.faint });
  footer(s, 10, ["S9"], "依据：计划书第 11–16 页；公式见《预算测算明细-改稿v2.xlsx》");
}

// ===== 10 市场战略规划 =====
{
  const s = slide(N({
    say: ["B站与抖音都直播：B站承接完整游戏过程与连载，抖音用快速情境吸引陌生观众；切片每周 4–5 条，回流到两端直播。", "首阶段 6 个月：原画与 Live2D 11 月底交付，完成内部试播与中文接梗测试、观众验证，并开始双平台直播。下半年进入固定栏目和小规模付费，资金依靠到账收入。", "每个阶段先看四件事：节目能否稳定完成、观众是否记住角色与事件、是否主动回访、收入是否覆盖直接成本。", "首阶段申请支持重算为 46,200 元，比原方案 10 万元少 53.8%：必要启动 25,000、6 个月精简运营 17,000、预备金 4,200。"],
    more: [
      "重算方法（自下而上，首阶段 1–6 月）：原画 8,000、Live2D 及表情 14,000、开发工具 3,000（必要）；模型语音云服务 9,000（1,500 元/月 × 6）；剪辑补贴 3,000（半额，成员自剪为主）；推广 3,000（只做小额切片测试）；活动杂费 2,000；支出小计 42,000；预备金按 10% 计 4,200；合计 46,200 元。",
      "相比原 10 万方案延后或削减：周边周转 10,500 改为下半年预售回款后生产；推广 15,000 待回访达标后用到账收入追加；剪辑补贴削减 9,000（全年口径，下半年视收入恢复）；预备金由 12,500 降为 4,200；下半年日常运营不由本次申请覆盖。",
      "资金来源：首阶段预测收入 4,200 元（Q1+Q2 打赏目标）不计入资金来源，若按期到账作为额外缓冲。基准情景下半年收入 57,450、支出 36,500，净现金约 +20,950 元，可自行覆盖；若首阶段验收未通过，不进入下半年扩张。",
      "对照：全年基准情景累计最高垫付约 47,750 元（第 9 月末），本方案不依赖预测收入，首阶段需要 46,200 元。",
      "原画与 Live2D 尚未付款（用户确认），全额计入申请额。",
      "进取增长目标：前三个月 2.5 万、约六个月 10 万、年末 15 万主阵地关注；参照头部个案（抖音虚拟主播许安一首月直播涨粉 13 万）[R3] 与行业分布（约 2/3 虚拟主播不足 1 万粉）[R2] 设定，不是预测。",
      "初期每周二至周六北京时间 20:00–22:00 开播；全年推广预算分批使用，先比较自然流量下的完播、评论与关注。",
    ],
    bound: ["B站与抖音开播权限可落实；双平台正式运营仍以推流、音视频与事件联调和节目验收为前提。", "申请额为团队测算方案，不代表已获批准或任何融资条款。"],
    src: ["商业计划书第 16–19 页", "预算测算明细-改稿v2.xlsx（第 5 表）", "R2", "R3", "S8"],
    todo: ["30 名成年受试者验证：后续安排。"],
  }));
  head(s, "06 市场战略规划", "首阶段申请 4.62 万元，先完成形象、试播与观众验证");
  // row 1 left: channel diagram
  const y0 = 1.6, lw = 5.0;
  box(s, M, y0 + 0.55, 1.35, 0.85, "solid");
  T(s, "人机节目", { x: M, y: y0 + 0.55, w: 1.35, h: 0.85, fontSize: 16, bold: true, color: C.white, align: "center", valign: "middle" });
  const px = M + 1.75, pw = 1.6;
  [["B站直播", "横屏 · 连载"], ["抖音直播", "竖屏 · 快速情境"]].forEach(([a, b], i) => {
    const y = y0 + i * 1.0;
    box(s, px, y, pw, 0.88, "acc");
    T(s, a, { x: px, y: y + 0.08, w: pw, h: 0.38, fontSize: 16, bold: true, color: C.acc, align: "center" });
    T(s, b, { x: px, y: y + 0.48, w: pw, h: 0.3, fontSize: 12, color: C.muted, align: "center" });
    arrow(s, M + 1.37, y0 + 0.97, px - 0.03, y + 0.44, { color: C.acc });
    arrow(s, px + pw + 0.03, y + 0.44, px + pw + 0.37, y0 + 0.97, { color: C.faint });
  });
  const kx = px + pw + 0.4, kw = M + lw - kx;
  box(s, kx, y0 + 0.4, kw, 1.15, "soft");
  T(s, [{ text: "切片与社群", options: { bold: true, breakLine: true } }, { text: "每周 4–5 条，回流直播", options: { color: C.muted } }], { x: kx + 0.1, y: y0 + 0.4, w: kw - 0.2, h: 1.15, fontSize: 13, align: "center", valign: "middle" });
  arrow(s, kx + kw / 2, y0 + 0.4, kx + kw / 2, y0 + 0.05, { dash: true, color: C.acc, noHead: true });
  arrow(s, kx + kw / 2, y0 + 0.05, px + pw + 0.05, y0 + 0.2, { dash: true, color: C.acc });
  // row 1 right: two-phase roadmap
  const rx = M + lw + 0.45, rw = CW - lw - 0.45, phw = (rw - 0.3) / 2;
  [["首阶段 · 1–6 月", "本次申请覆盖", "形象交付 → 内部试播与接梗测试 → 观众验证 → 双平台开播", "solid"], ["下半年 · 7–12 月", "依靠到账收入", "固定栏目 → 会员测试 → 小批量周边 → 品牌样例", "dash"]].forEach(([a, b, c, st], i) => {
    const x = rx + i * (phw + 0.3);
    box(s, x, y0, phw, 1.95, st === "solid" ? "acc" : "dash");
    T(s, a, { x: x + 0.22, y: y0 + 0.15, w: phw - 0.4, h: 0.4, fontSize: 17, bold: true, color: st === "solid" ? C.acc : C.ink });
    tag(s, b, x + 0.22, y0 + 0.6, { size: 12, st: st === "solid" ? "solid" : "soft", color: st === "solid" ? C.white : C.muted, w: 1.5, h: 0.32 });
    T(s, c, { x: x + 0.22, y: y0 + 1.02, w: phw - 0.4, h: 0.85, fontSize: 14, color: C.ink });
  });
  T(s, "进入下一阶段先看：稳定完成 · 记住角色与事件 · 主动回访 · 收入覆盖直接成本", { x: rx, y: y0 + 2.05, w: rw, h: 0.32, fontSize: 13, color: C.acc, bold: true });
  // row 2 left: big number
  const y2 = 4.15;
  T(s, "首阶段申请支持", { x: M, y: y2, w: lw, h: 0.35, fontSize: 16, bold: true, color: C.muted });
  T(s, [{ text: "46,200", options: { fontSize: 54, bold: true, color: C.acc } }, { text: " 元", options: { fontSize: 20, color: C.ink } }], { x: M, y: y2 + 0.35, w: lw, h: 0.95, valign: "bottom" });
  T(s, [
    { text: "原方案 100,000 元，减少 53.8%", options: { bullet: { indent: 14 }, breakLine: true } },
    { text: "预测收入不计入资金来源", options: { bullet: { indent: 14 }, breakLine: true } },
    { text: "周边改预售，推广待回访达标后追加", options: { bullet: { indent: 14 } } },
  ], { x: M, y: y2 + 1.45, w: lw, h: 1.25, fontSize: 15, color: C.ink, paraSpaceAfter: 4 });
  // row 2 right: native bar chart of uses
  const uses = [["Live2D", 14000], ["语音云服务", 9000], ["原画", 8000], ["预备金", 4200], ["开发工具", 3000], ["剪辑补贴", 3000], ["推广测试", 3000], ["活动杂费", 2000]];
  T(s, [{ text: "资金用途（元）", options: { bold: true } }, { text: "  语音云 6 个月 · 剪辑补贴半额 · 预备金 10%", options: { fontSize: 12, color: C.muted } }], { x: rx, y: y2, w: rw, h: 0.35, fontSize: 16 });
  s.addChart(pres.charts.BAR, [{ name: "金额", labels: uses.map((u) => u[0]).reverse(), values: uses.map((u) => u[1]).reverse() }], Object.assign({}, chartBase, {
    x: rx, y: y2 + 0.3, w: rw, h: 2.55, barDir: "bar", barGapWidthPct: 35, chartColors: [C.acc],
    showValue: true, dataLabelPosition: "outEnd", dataLabelFontSize: 12, dataLabelColor: C.ink, dataLabelFormatCode: "#,##0",
    catAxisLabelFontSize: 12, catAxisLabelColor: C.ink, catAxisLabelFrequency: 1, valAxisHidden: true, valAxisMinVal: 0, valAxisMaxVal: 17000,
    valGridLine: { style: "none" }, showLegend: false, objectName: "首阶段资金用途条形图",
  }));
  footer(s, 11, ["S8"], "依据：计划书第 16–19 页；重算见《预算测算明细-改稿v2.xlsx》第 5 表");
}

pres.writeFile({ fileName: OUT }).then((f) => console.log("wrote", f));
