// 潮生智能 · 姬岁歌人机共播 · 昆山杯路演 PPT（白底、无动画、单一强调色）
// 事实来源：../final/昆山杯-潮生智能-商业计划书-人机共播修订版.docx（2026-10-24）
const pptxgen = require("pptxgenjs");
const path = require("path");

const A = (f) => path.join(__dirname, "assets", f);
const OUT = process.argv[2] || path.join(__dirname, "昆山杯-潮生智能-路演PPT-人机共播版.pptx");

const C = { ink: "1F2329", muted: "5B6270", faint: "8A909C", line: "D5D9E0", soft: "F4F6F9", acc: "2459D6", accSoft: "EAF0FD", white: "FFFFFF" };
const FONT = "Microsoft YaHei";
const W = 13.333, M = 0.6, CW = W - 2 * M, TOTAL = 10;

const SRC = {
  S1: ["YouTube 2025 报告", "https://blog.youtube/culture-and-trends/youtube-culture-trends-report-virtual-creators/"],
  S2: ["B站 2026Q2 公告", "https://www.sec.gov/Archives/edgar/data/1723690/000119312526371261/d434015dex991.htm"],
  S3: ["WWW 2025 VUP 研究", "https://arxiv.org/abs/2502.01553"],
  S4: ["Vedal 官网", "https://vedal.ai/"],
  S5: ["Sync2Cal 样本", "https://www.sync2cal.com/gaming/twitch-streamers/neuro-sama"],
  S5b: ["Vedal 官方 Twitch 排期", "https://www.twitch.tv/vedal987/schedule"],
  S6: ["Lumi_Nox 仓库", "https://github.com/MIO-456/Lumi_Nox"],
  S7: ["B站开放平台直播事件文档", "https://openhome.bilibili.com/doc/4/c7b549c9-d5d6-0331-b510-465ed4107e01"],
  S8: ["抖音开放平台直播 SDK", "https://open.douyin.com/platform/resource/docs/ability/douyin-live-sdk/introduction"],
  R1: ["浙大 2025 抖音主播调研", "https://www.sohu.com/a/976695880_121864818"],
  R2: ["澎湃 3606 名虚拟主播", "https://www.thepaper.cn/newsDetail_forward_18022449"],
  R3: ["界面：许安一 100 天", "https://www.jiemian.com/article/7724509.html"],
  R4: ["新榜：虚拟主播收入中位数", "https://www.woshipm.com/it/5267948.html"],
  R5: ["B站 2025 全年业绩报道", "https://finance.sina.com.cn/tech/roll/2026-03-05/doc-inhpycce3081263.shtml"],
  S9: ["抖音直播行为规范", "https://sf3-cdn-tos.douyinstatic.com/obj/ies-hotsoon-draft/webcast_all_anchor/webcast_ban_protocol.html"],
};

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";
pres.title = "潮生智能 · 姬岁歌人机共同直播";
pres.theme = { headFontFace: FONT, bodyFontFace: FONT };

const T = (s, text, o) => s.addText(text, Object.assign({ isTextBox: true, margin: 0, fontFace: FONT, color: C.ink, valign: "top" }, o));
// box styles: "solid" accent fill, "acc" accent outline, "soft" grey fill, "line" grey outline, "dash" grey dashed (待验证)
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
function dot(s, n, x, y, d = 0.42, filled = true) {
  s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: filled ? C.acc : C.white }, line: { color: C.acc, width: 1.25 } });
  T(s, String(n), { x, y, w: d, h: d, fontSize: 14, bold: true, color: filled ? C.white : C.acc, align: "center", valign: "middle" });
}
function tag(s, text, x, y, { st = "accSoft", color = C.acc, size = 13, h = 0.32, w } = {}) {
  w = w || text.length * size * 0.0165 + 0.36;
  box(s, x, y, w, h, st, h / 2);
  T(s, text, { x, y, w, h, fontSize: size, bold: true, color, align: "center", valign: "middle" });
  return w;
}
function title(s, t, sub) {
  T(s, t, { x: M, y: 0.42, w: CW, h: 0.75, fontSize: 32, bold: true });
  s.addShape(pres.shapes.LINE, { x: M, y: 1.22, w: 0.9, h: 0, line: { color: C.acc, width: 3 } });
  if (sub) T(s, sub, { x: M, y: 1.36, w: CW, h: 0.4, fontSize: 18, color: C.muted });
}
function footer(s, n, srcKeys = [], extra = "") {
  const runs = [];
  if (srcKeys.length) runs.push({ text: "来源：", options: { color: C.faint } });
  srcKeys.forEach((k, i) => {
    runs.push({ text: `[${k}] ${SRC[k][0]}`, options: { color: C.acc, hyperlink: { url: SRC[k][1] } } });
    if (i < srcKeys.length - 1) runs.push({ text: "  ·  ", options: { color: C.faint } });
  });
  if (extra) runs.push({ text: (srcKeys.length ? "    " : "") + extra, options: { color: C.faint } });
  if (runs.length) T(s, runs, { x: M, y: 7.0, w: CW - 1.2, h: 0.3, fontSize: 11, valign: "middle" });
  T(s, `${n} / ${TOTAL}`, { x: W - M - 1.0, y: 7.0, w: 1.0, h: 0.3, fontSize: 11, color: C.faint, align: "right", valign: "middle" });
}
function slide(n, notes) {
  const s = pres.addSlide();
  s.background = { color: C.white };
  s.addNotes(notes);
  return s;
}
const N = (o) => [
  "【本页讲述要点】", ...o.say.map((t) => "· " + t),
  ...(o.more ? ["", "【补充说明】", ...o.more.map((t) => "· " + t)] : []),
  ...(o.bound ? ["", "【预测假设与能力边界】", ...o.bound.map((t) => "· " + t)] : []),
  ...(o.refs ? ["", "【公开数据参照】", ...o.refs.map((t) => "· " + t)] : []),
  ...(o.src ? ["", "【来源】", ...o.src.map((t) => "· " + (SRC[t] ? `[${t}] ${SRC[t][0]}：${SRC[t][1]}` : t))] : []),
  ...(o.todo ? ["", "【待确认事项】", ...o.todo.map((t) => "· " + t)] : []),
].join("\n");

// ===== 封面 =====
{
  const s = slide(1, N({
    say: ["潮生智能团队，项目为“姬岁歌”人机共同直播。", "一句话：真人主动造梗，AI 以稳定角色性格接梗，围绕游戏和弹幕形成真实互动，再用直播、切片和连续剧情吸引观众回访。"],
    bound: ["右侧为角色概念图，版权归团队所有，目前仍在生成定稿；原画与 Live2D 计划 11 月底交付。"],
    src: ["商业计划书封面与项目摘要（2026-10-24 人机共播修订版）"],
    todo: ["无（角色概念图版权归团队所有，正在生成定稿；原画与 Live2D 计划 11 月底交付）。"],
  }));
  s.background = { color: C.white };
  tag(s, "2026 昆山杯清华大学创业大赛 · 种子组 · AI for X 赛道", M, 0.9, { size: 14, h: 0.38, w: 6.2 });
  T(s, "潮生智能", { x: M, y: 1.75, w: 7.5, h: 0.6, fontSize: 24, bold: true, color: C.acc });
  T(s, "姬岁歌\n人机共同直播", { x: M, y: 2.4, w: 7.6, h: 2.2, fontSize: 52, bold: true, lineSpacingMultiple: 1.05 });
  T(s, "真人主动造梗，AI 以角色性格接梗，\n共同经历让观众愿意回来看下一场", { x: M, y: 4.75, w: 7.6, h: 0.95, fontSize: 22, color: C.muted, lineSpacingMultiple: 1.2 });
  T(s, "项目负责人  杨若朝    ·    潮生智能团队", { x: M, y: 6.25, w: 7.6, h: 0.4, fontSize: 16, color: C.ink });
  // concept art 1226x1283
  const ih = 5.9, iw = ih * 1226 / 1283;
  s.addImage({ path: A("jisui-concept.png"), x: W - M - iw, y: 0.75, w: iw, h: ih });
  T(s, "角色概念图 · 定稿中，11 月底交付", { x: W - M - iw, y: 6.7, w: iw, h: 0.3, fontSize: 12, color: C.faint, align: "center" });
}

// ===== 1 项目背景 =====
{
  const s = slide(2, N({
    say: ["节目由四步构成：真人发起、AI 按角色回应、游戏产生真实结果、观众参与并期待后续。", "观众同时看两样东西：游戏本身，以及人物关系和意外反应。", "真人擅长设题、追问、转场并给出真实反应；AI 以稳定角色回应，并在任务中给出不同于搭档预期的选择。"],
    more: ["首批服务两类观众：愿意持续追看角色与搭档关系的人；先被游戏反转和 AI 意外反应吸引的人。", "人与人联动的吸引力来自默契、分歧和互相理解；本项目保留这些可观察关系：真人会惊讶、着急、认错，AI 通过好奇、坚持、承认偏差和记起约定呈现人格化。"],
    bound: ["“人化”指可识别的性格、表达和连续经历；AI 情绪属于角色表达，不宣称拥有真实情感。", "技术对节目效果的贡献要通过完整片段和观众回访检验，目前尚未完成。"],
    src: ["商业计划书第 3 页“项目背景”、第 4 页“可服务人群”"],
  }));
  title(s, "真人造梗与 AI 回应，共同构成直播内容");
  const steps = [["真人发起话题／挑战", "设局 · 造梗 · 追问"], ["AI 按角色性格回应", "岁追问，歌坚持"], ["游戏或互动产生真实结果", "完成或翻车都真实"], ["观众参与并期待后续", "预测 · 评论 · 回收"]];
  const gap = 0.5, bw = (CW - 3 * gap) / 4, by = 1.6, bh = 2.1;
  steps.forEach(([a, b], i) => {
    const x = M + i * (bw + gap);
    box(s, x, by, bw, bh, i === 0 ? "acc" : "line");
    dot(s, i + 1, x + 0.25, by + 0.25);
    T(s, a, { x: x + 0.25, y: by + 0.75, w: bw - 0.4, h: 0.8, fontSize: 20, bold: true });
    T(s, b, { x: x + 0.25, y: by + 1.6, w: bw - 0.4, h: 0.38, fontSize: 16, color: C.muted });
    if (i < 3) arrow(s, x + bw + 0.06, by + bh / 2, x + bw + gap - 0.06, by + bh / 2, { color: C.acc, width: 2 });
  });
  // loop back
  const ly = by + bh + 0.35, x1 = M + bw / 2, x4 = M + 3 * (bw + gap) + bw / 2;
  arrow(s, x4, by + bh, x4, ly, { noHead: true, color: C.acc, dash: true });
  arrow(s, x4, ly, x1, ly, { noHead: true, color: C.acc, dash: true });
  arrow(s, x1, ly, x1, by + bh + 0.02, { color: C.acc, dash: true });
  T(s, "下一场回收共同经历，场后提炼完整切片", { x: x1 + 2.0, y: ly + 0.06, w: 6, h: 0.35, fontSize: 16, color: C.acc, align: "center" });
  // audience & value
  const y2 = 4.7, h2 = 2.1, lw = 5.4;
  box(s, M, y2, lw, h2, "soft");
  T(s, "目标观众", { x: M + 0.35, y: y2 + 0.25, w: 3, h: 0.4, fontSize: 20, bold: true, color: C.acc });
  T(s, [
    { text: "追看角色与搭档关系的中文观众", options: { bullet: { indent: 16 }, breakLine: true } },
    { text: "被游戏反转与 AI 意外反应吸引的新观众", options: { bullet: { indent: 16 } } },
  ], { x: M + 0.35, y: y2 + 0.8, w: lw - 0.6, h: 1.2, fontSize: 20, paraSpaceAfter: 10 });
  const rx = M + lw + 0.35, rw = CW - lw - 0.35;
  box(s, rx, y2, rw, h2, "line");
  T(s, "观众看的不只是游戏", { x: rx + 0.35, y: y2 + 0.25, w: rw - 0.7, h: 0.4, fontSize: 20, bold: true, color: C.acc });
  const vals = ["游戏过程", "人物关系", "意外反应"];
  const vw = (rw - 0.7 - 0.5) / 3;
  vals.forEach((v, i) => {
    const vx = rx + 0.35 + i * (vw + 0.25);
    box(s, vx, y2 + 0.8, vw, 0.6, i ? "accSoft" : "soft", 0.3);
    T(s, v, { x: vx, y: y2 + 0.8, w: vw, h: 0.6, fontSize: 20, bold: true, align: "center", valign: "middle", color: i ? C.acc : C.ink });
  });
  T(s, "“人化”指性格、表达与连续经历，不宣称 AI 有真实情感", { x: rx + 0.35, y: y2 + 1.55, w: rw - 0.7, h: 0.35, fontSize: 15, color: C.muted });
  footer(s, 2, [], "依据：商业计划书第 3–4 页");
}

// ===== 2 市场规模与竞品 =====
{
  const s = slide(3, N({
    say: ["两个数据只说明背景：虚拟角色有跨内容形式的观看需求，B站有足够的分发规模。", "它们不是项目的市场规模；项目最初只服务中文游戏、VUP 与 AI 互动兴趣中的一小部分观众，已完成 5 名喜欢 VTuber 的路人观众初步反馈，后续扩大到 30 名成年受试者。", "Neuro 在人格成熟度、长期关系、内容积累和商业化上明显领先，是我们要学习的对象。", "我们的差异化是待验证的：原生中文语境、人机节目设计、国内晚间观看安排。"],
    more: ["S1：YouTube 2024 年 300 个虚拟创作者样本在视频、直播与 Shorts 合计超过 150 亿次观看；样本包括多种虚拟创作者，不等同 AI 主播市场。", "S2：Bilibili 2026 年第二季度月活跃用户约 3.71 亿，仅作平台规模背景，不能计为潜在付费观众。", "S3：WWW 2025 的 B站 VUP 观众研究可作为粉丝社区与付费行为参照，研究对象不是本项目观众。", "S5 时段：2026-10-24 查询的第三方排期样本中，10 月 24 日 18:00 UTC 与 10 月 25 日 19:00 UTC 分别对应北京时间次日 02:00 与 03:00；仅 2 个场次样本，不是固定规律，以官方 Twitch 公告为准。", "S6：Lumi_Nox 已公开双 AI 实时语音、发言仲裁、记忆与游戏桥接，说明这些技术本身不是我们的独有优势。", "普通真人主播表达成熟；AI 独立直播需解决节奏与稳定性；人机共播增加策划、配合和技术维护成本。"],
    bound: ["中文与时段优势可被复制，不构成壁垒；需用实际观看与回访证明。", "全年约 200 条重点切片、15 万主阵地年末关注为进取目标，参照同类创作者公开数据与博主公开营收设定，公开运营后按真实数据复核。"],
    src: ["S1", "S2", "S3", "S4", "S5", "S5b", "S6"],
    todo: ["项目可获得市场规模（中文游戏 + VUP + AI 互动兴趣人群）尚无可引用数据。", "Neuro 时段只有 2 场样本，如需更强结论需补充更多官方排期记录。"],
  }));
  title(s, "中文互动与本地时段是项目切入点");
  // left: data
  const lw = 3.9, y0 = 1.65;
  [["150 亿+", "次观看", "YouTube 2024 年虚拟创作者样本", "行业观看背景 [S1]"], ["3.71 亿", "月活用户", "Bilibili 2026 年第二季度", "平台规模背景 [S2]"]].forEach(([v, u, d, t], i) => {
    const y = y0 + i * 1.72;
    box(s, M, y, lw, 1.52, "soft");
    T(s, [{ text: v, options: { fontSize: 34, bold: true, color: C.acc } }, { text: " " + u, options: { fontSize: 16, color: C.muted } }], { x: M + 0.3, y: y + 0.15, w: lw - 0.5, h: 0.6, valign: "bottom" });
    T(s, d, { x: M + 0.3, y: y + 0.8, w: lw - 0.5, h: 0.45, fontSize: 13, color: C.muted });
    T(s, t, { x: M + 0.3, y: y + 1.18, w: lw - 0.5, h: 0.28, fontSize: 12, bold: true, color: C.ink });
  });
  box(s, M, y0 + 3.44, lw, 1.66, "acc");
  T(s, "项目最初服务", { x: M + 0.3, y: y0 + 3.6, w: lw - 0.5, h: 0.4, fontSize: 18, bold: true, color: C.acc });
  T(s, "喜欢 VTuber、爱看整活与联动的中文观众；已做 5 人路人初步反馈", { x: M + 0.3, y: y0 + 4.02, w: lw - 0.5, h: 0.95, fontSize: 15 });
  // right: 4 comparison cards
  const rx = M + lw + 0.35, rw = CW - lw - 0.35, cw = (rw - 0.3) / 2, ch = 2.45;
  const cards = [
    ["Neuro-sama / Evil Neuro", "line", ["人物关系成熟，内容积累长", "延伸到视频、音乐与商品 [S4]", "2 场样本在北京凌晨 2–3 点 [S5]"], "我们需要追赶的对象"],
    ["姬岁歌（本项目）", "acc", ["原生中文语境接梗", "真人造梗 + 岁/歌双人格节目", "北京时间 20:00–22:00 档"], "差异化待验证"],
    ["普通真人主播", "line", ["表达成熟，现场判断强", "缺少 AI 角色带来的反差"], "比较对象：互动反差"],
    ["AI 独立直播", "line", ["节奏与稳定性仍是难点", "语音、记忆、游戏桥接已有公开项目 [S6]"], "技术本身不是壁垒"],
  ];
  cards.forEach(([h, st, pts, foot], i) => {
    const x = rx + (i % 2) * (cw + 0.3), y = y0 + Math.floor(i / 2) * (ch + 0.25);
    box(s, x, y, cw, ch, st);
    T(s, h, { x: x + 0.3, y: y + 0.2, w: cw - 0.5, h: 0.42, fontSize: 19, bold: true, color: st === "acc" ? C.acc : C.ink });
    T(s, pts.map((t, k) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: k < pts.length - 1 } })), { x: x + 0.3, y: y + 0.72, w: cw - 0.5, h: 1.2, fontSize: 15, paraSpaceAfter: 5 });
    tag(s, foot, x + 0.3, y + ch - 0.48, { size: 12, st: st === "acc" ? "solid" : "soft", color: st === "acc" ? C.white : C.muted });
  });
  footer(s, 3, ["S1", "S2", "S4", "S5", "S6"]);
}

// ===== 3 产品：观众为什么看 =====
{
  const s = slide(4, N({
    say: ["用一个木剑任务说明一场节目怎样发生：主持人设局，AI 结合角色回应，主持人继续接话，游戏给出真实结果，观众预测和回收旧梗。", "岁偏向好奇、观察和理解；歌偏向坚持、选择与守护。同一个挑战，两人表态不同。", "主持人呈现真实的困惑、胜负欲和关心，允许与 AI 意见不同。", "观众记住的是连续经历：开场的约定在结局或下一场被兑现，而不是堆砌网络流行语。"],
    more: ["计划书中的示例：真人提出“先当队长还是先干活”的木剑挑战，AI 回应后在实际游戏中采集和制作；成功后回收开场的玩笑，失败则一起核对缺少的材料。", "页面中的台词为节目设计示例，用于说明节目结构。"],
    bound: ["示例不是实际录屏或测试结果；工程中已有 Minecraft 采木与木剑制作记录，但这段完整人机对话尚未作为节目播出。"],
    src: ["商业计划书第 6 页“一段完整互动怎样发生”、第 9 页“AI 和真人的人性化一面”"],
    todo: ["主持人按场次安排，页面不指定具体人选。"],
  }));
  title(s, "观众观看的是共同经历与人物关系");
  tag(s, "节目设计示例 · 非实际录屏", W - M - 3.05, 0.55, { size: 13, w: 3.05, h: 0.36 });
  const lw = 7.6, y0 = 1.6, rh = 0.74;
  const rows = [
    ["主持人设局", "「今晚谁先做出木剑，谁就当队长。」", "acc"],
    ["岁 · 好奇", "「队长要负责什么？先把规则说清楚。」", "line"],
    ["歌 · 坚持", "「那我先去砍树，队长我当定了。」", "line"],
    ["主持人接话", "「做不出来的话，下一场要叫我队长。」", "acc"],
    ["游戏结果", "采木 → 合成木剑：成功或缺材料都真实发生", "soft"],
    ["观众", "预测谁先完成；下一场回收“队长”约定", "soft"],
  ];
  rows.forEach(([who, line, st], i) => {
    const y = y0 + i * (rh + 0.1);
    box(s, M, y, lw, rh, st);
    T(s, who, { x: M + 0.25, y, w: 1.55, h: rh, fontSize: 17, bold: true, color: st === "acc" ? C.acc : C.ink, valign: "middle" });
    T(s, line, { x: M + 1.85, y, w: lw - 2.05, h: rh, fontSize: 19, valign: "middle" });
  });
  const rx = M + lw + 0.4, rw = CW - lw - 0.4;
  const chars = [["岁", "好奇 · 观察 · 理解", "追问理由，失误时承认偏差"], ["歌", "坚持 · 选择 · 守护", "表明立场，兑现承诺"], ["主持人", "真实反应", "惊讶、着急、认错，也照顾搭档"]];
  chars.forEach(([n, k, d], i) => {
    const y = y0 + i * 1.42;
    box(s, rx, y, rw, 1.27, i < 2 ? "line" : "acc");
    s.addShape(pres.shapes.OVAL, { x: rx + 0.25, y: y + 0.28, w: 0.72, h: 0.72, fill: { color: i < 2 ? C.accSoft : C.acc }, line: { type: "none" } });
    T(s, n, { x: rx + 0.25, y: y + 0.28, w: 0.72, h: 0.72, fontSize: n.length > 1 ? 15 : 22, bold: true, color: i < 2 ? C.acc : C.white, align: "center", valign: "middle" });
    T(s, k, { x: rx + 1.15, y: y + 0.18, w: rw - 1.3, h: 0.42, fontSize: 18, bold: true });
    T(s, d, { x: rx + 1.15, y: y + 0.65, w: rw - 1.3, h: 0.45, fontSize: 15, color: C.muted });
  });
  box(s, rx, y0 + 4.3, rw, 0.66, "soft", 0.33);
  T(s, "连续经历：开场约定 → 下一场兑现", { x: rx, y: y0 + 4.3, w: rw, h: 0.66, fontSize: 17, bold: true, color: C.acc, align: "center", valign: "middle" });
  footer(s, 4, [], "依据：商业计划书第 6、9 页");
}

// ===== 4 产品：观众端与后台 =====
{
  const s = slide(5, N({
    say: ["左边是观众看到的节目：游戏或主题画面为主体，配合姬岁歌形象、真人声音或头像、字幕与当晚任务；弹幕、关注、礼物用平台原生入口。", "右边是团队用的后台：主持、人格运营、技术和值班运营围绕同一场节目协作。", "调试参数、错误日志和模型配置不进入观众画面。"],
    more: ["现有页面：首页与 OBS 叠加层承担舞台与字幕；games.html 组织游戏画面、模型方案、聊天与任务停止；studio.html 提供候选记忆审核、大脑诊断、连续经历和直播运行；debug.html 用于开发调试。", "商业开播需补齐：双平台消息标记来源；礼物事件核对去重、撤回和退款；观众建议确认后再影响任务；播前检查画面只含批准内容；播后按时间戳导出高光。"],
    bound: ["左侧为界面方案示意，不是已上线产品截图。", "右侧为现有导演工作台开发版截图（记忆审核页），不是正式观众界面。", "overlay=1 可隐藏控制区用于 OBS 叠加，但隐藏控件不等于已完成后台权限隔离。", "工程中的 Live2D 为临时模型，原创角色成品与真人搭档布局仍待交付。"],
    src: ["商业计划书第 6–7 页", "工程索引 [I4] public/index.html、stream.css、games.html、studio.html"],
    todo: ["真人是否露脸由节目安排决定，尚未确定。", "观众端横屏（B站）与竖屏（抖音）画面方案尚未出图。"],
  }));
  title(s, "观众看节目，后台负责调度与接管");
  const pw = 5.95, y0 = 1.6;
  // viewer scheme
  T(s, "观众端", { x: M, y: y0, w: 2, h: 0.4, fontSize: 20, bold: true, color: C.acc });
  tag(s, "界面方案 · 非上线截图", M + 1.2, y0 + 0.04, { size: 12, st: "soft", color: C.muted });
  const fx = M, fy = y0 + 0.6, fw = pw, fh = fw * 9 / 16;
  box(s, fx, fy, fw, fh, "line", 0.04);
  box(s, fx + 0.15, fy + 0.15, fw * 0.66, fh - 0.95, "soft", 0.04);
  T(s, "游戏或主题画面", { x: fx + 0.15, y: fy + 0.15, w: fw * 0.66, h: fh - 0.95, fontSize: 18, bold: true, color: C.muted, align: "center", valign: "middle" });
  tag(s, "当前任务：做出木剑", fx + 0.3, fy + 0.3, { size: 12, st: "solid", color: C.white });
  const sx = fx + 0.3 + fw * 0.66, sw = fw - fw * 0.66 - 0.45;
  box(s, sx, fy + 0.15, sw, 1.55, "accSoft", 0.04);
  T(s, "AI 角色\n岁 / 歌", { x: sx, y: fy + 0.15, w: sw, h: 1.55, fontSize: 16, bold: true, color: C.acc, align: "center", valign: "middle" });
  box(s, sx, fy + 1.82, sw, fh - 2.62, "soft", 0.04);
  T(s, "真人搭档\n声音或头像", { x: sx, y: fy + 1.82, w: sw, h: fh - 2.62, fontSize: 14, bold: true, color: C.muted, align: "center", valign: "middle" });
  box(s, fx + 0.15, fy + fh - 0.68, fw - 0.3, 0.52, "line", 0.04);
  T(s, "字幕：岁「队长要负责什么？」", { x: fx + 0.35, y: fy + fh - 0.68, w: fw - 0.7, h: 0.52, fontSize: 14, valign: "middle" });
  T(s, "平台原生互动：弹幕 · 关注 · 礼物 · 会员", { x: M, y: fy + fh + 0.15, w: pw, h: 0.4, fontSize: 15, color: C.ink });
  // backend
  const bx = M + pw + 0.25 + 0.0, bw = CW - pw - 0.25;
  s.addShape(pres.shapes.LINE, { x: M + pw + 0.12, y: y0, w: 0, h: 5.1, line: { color: C.line, width: 1 } });
  T(s, "后台", { x: bx + 0.1, y: y0, w: 1.2, h: 0.4, fontSize: 20, bold: true, color: C.acc });
  tag(s, "现有导演工作台 · 开发版截图", bx + 0.85, y0 + 0.04, { size: 12, st: "soft", color: C.muted });
  const iw = bw - 0.1, ih = iw * 900 / 1600;
  s.addImage({ path: A("studio.png"), x: bx + 0.1, y: fy, w: iw, h: ih });
  s.addShape(pres.shapes.RECTANGLE, { x: bx + 0.1, y: fy, w: iw, h: ih, fill: { type: "none" }, line: { color: C.line, width: 1 } });
  const mods = ["模型与语音状态", "弹幕筛选", "人物设定", "记忆审核", "游戏任务", "人工接管", "运行记录"];
  let mx = bx + 0.1, my = fy + ih + 0.15;
  mods.forEach((m) => {
    const w = m.length * 14 * 0.0175 + 0.36;
    if (mx + w > bx + 0.1 + iw + 0.01) { mx = bx + 0.1; my += 0.44; }
    tag(s, m, mx, my, { size: 14, h: 0.34, w, st: "line", color: C.ink });
    mx += w + 0.12;
  });
  T(s, "调试参数与日志不进观众画面；隐藏控制区 ≠ 权限隔离，仍需梳理", { x: bx + 0.1, y: my + 0.46, w: iw, h: 0.35, fontSize: 14, color: C.muted });
  footer(s, 5, [], "依据：商业计划书第 6–7 页；工程索引 [I4]");
}

// ===== 5 产品：技术落地 =====
{
  const s = slide(6, N({
    say: ["实时交流链路：真人语音、弹幕和游戏状态进入，经过理解与调度，生成角色回复和语音，最后以 Live2D 和字幕出现在观众画面。", "每个模块都对应观众能感知的行为：听懂铺垫、决定谁回应、用稳定声音接话、看到角色表情。", "游戏行动是单独的闭环：任务规划、动作执行、结果反馈、继续互动；场上讲话依据真实游戏状态。", "经人工确认的共同事件存入记忆，下一场接续。"],
    more: ["Node.js 服务与网页舞台连接输入、调度和展示。", "SenseVoice 语音识别把真人语音送入上下文；模型路由结合人格与现场任务生成回应；GPT-SoVITS 或系统 TTS 负责朗读。", "Minecraft 以 DeepSeek 等规划方案与 Mineflayer 执行衔接，动作经程序检查并读取结果；STS2 有工具动作与口播回执快照。", "准备、尝试和完成采用不同表达，避免模型把计划说成成果。"],
    bound: ["模块存在不等于所有组合都已稳定；实际使用的声线、模型及延迟按试播版本说明。", "完整游戏通关、任意游戏适配不列为已实现成果。"],
    src: ["商业计划书第 8 页", "工程索引 [I1] [I2] [I6]"],
    todo: ["试播版本使用的具体模型、声线授权与首次可听回应延迟尚未测定。"],
  }));
  title(s, "技术链路支撑实时交流与游戏行动");
  const y0 = 1.6, gap = 0.42, bw = (CW - 3 * gap) / 4, bh = 2.1;
  const chain = [
    ["输入", "真人语音 · 弹幕 · 游戏\nSenseVoice 识别", "听懂铺垫与观众反应"],
    ["理解与调度", "Node.js · 模型路由 · 人格", "决定谁回应、何时回应"],
    ["角色回复与语音", "GPT-SoVITS 或系统 TTS", "岁、歌用各自语气接话"],
    ["人物表现与画面", "Live2D · 字幕 · OBS", "看到表情、字幕与任务"],
  ];
  chain.forEach(([a, t, r], i) => {
    const x = M + i * (bw + gap);
    box(s, x, y0, bw, bh, i === 1 ? "acc" : "line");
    T(s, a, { x: x + 0.22, y: y0 + 0.2, w: bw - 0.4, h: 0.45, fontSize: 19, bold: true });
    T(s, t, { x: x + 0.22, y: y0 + 0.75, w: bw - 0.4, h: 0.6, fontSize: 14, color: C.muted });
    s.addShape(pres.shapes.LINE, { x: x + 0.22, y: y0 + 1.45, w: bw - 0.44, h: 0, line: { color: C.line, width: 0.75 } });
    T(s, r, { x: x + 0.22, y: y0 + 1.55, w: bw - 0.4, h: 0.45, fontSize: 15, bold: true, color: C.acc });
    if (i < 3) arrow(s, x + bw + 0.05, y0 + bh / 2, x + bw + gap - 0.05, y0 + bh / 2, { color: C.acc, width: 2 });
  });
  // game loop
  const gy = 4.6, gh = 1.15, lw = 8.7;
  T(s, "游戏行动闭环", { x: M, y: gy - 0.48, w: 4, h: 0.4, fontSize: 18, bold: true, color: C.acc });
  const g = [["任务规划", "DeepSeek 等"], ["动作执行", "Mineflayer · 工具动作"], ["结果反馈", "程序检查，读取状态"], ["继续互动", "按准备、尝试、完成口播"]];
  const gg = 0.32, gw = (lw - 3 * gg) / 4;
  g.forEach(([a, b], i) => {
    const x = M + i * (gw + gg);
    box(s, x, gy, gw, gh, "soft");
    T(s, a, { x: x + 0.15, y: gy + 0.15, w: gw - 0.3, h: 0.42, fontSize: 18, bold: true, align: "center" });
    T(s, b, { x: x + 0.1, y: gy + 0.6, w: gw - 0.2, h: 0.45, fontSize: 13, color: C.muted, align: "center" });
    if (i < 3) arrow(s, x + gw + 0.03, gy + gh / 2, x + gw + gg - 0.03, gy + gh / 2, { color: C.faint });
  });
  const ly = gy + gh + 0.28, xa = M + gw / 2, xb = M + 3 * (gw + gg) + gw / 2;
  arrow(s, xb, gy + gh, xb, ly, { noHead: true, dash: true });
  arrow(s, xb, ly, xa, ly, { noHead: true, dash: true });
  arrow(s, xa, ly, xa, gy + gh + 0.02, { dash: true });
  T(s, "下一步任务", { x: M + 2.5, y: ly + 0.04, w: 3.7, h: 0.3, fontSize: 13, color: C.muted, align: "center" });
  // memory
  const mx = M + lw + 0.35, mw = CW - lw - 0.35;
  box(s, mx, gy - 0.48, mw, gh + 1.0, "acc");
  T(s, "记忆模块", { x: mx + 0.25, y: gy - 0.3, w: mw - 0.5, h: 0.42, fontSize: 18, bold: true, color: C.acc });
  T(s, "SQLite 保存经人工确认的共同事件", { x: mx + 0.25, y: gy + 0.2, w: mw - 0.5, h: 0.65, fontSize: 15 });
  T(s, "→ 下一场回收约定与旧事", { x: mx + 0.25, y: gy + 0.95, w: mw - 0.5, h: 0.5, fontSize: 15, bold: true, color: C.acc });
  footer(s, 6, [], "依据：商业计划书第 8 页；工程索引 [I1][I2][I6]    能力边界：模块存在 ≠ 所有组合已稳定");
}

// ===== 6 可行性与中文接梗 =====
{
  const s = slide(7, N({
    say: ["左边是已有证据：不同模块和局部任务可运行；右边是下一步验收：整场节目、中文接梗、双平台接入和观众回访。", "中文接梗难在六点：共享语境、谐音双关、反话与调侃、岁与歌的角色一致性、回应时机、旧事回收。大模型能生成中文，不能证明会自然接梗。", "测试方法：真人铺垫，AI 理解，角色回应，观众反馈；记录解释笑话、答非所问、过度顺从、重复老梗或错过接话时机。"],
    more: ["场景设计：谐音、认真误解、反向挑战、角色分歧和旧事回收，同时放入普通对话作为对照；不少于 30 个中文场景，每种人格分别生成并由内容人员复核，保留未见过的场景检验迁移。", "观众验收：首轮 30 名成年观众按观看习惯分层，随机平衡两段各 6 分钟样片顺序；一次只比较一项变化（如有无主动造梗、有无共同记忆）。", "团队预设迭代门槛：自由观看中位数 3 分钟；至少 15 人记住角色特点或事件；至少 6 人七天内主动回看满 60 秒。", "失败预案：接梗生硬回到具体场景与样本；语音延迟时缩短回复并由真人续场；游戏卡住时停止任务、切到备用栏目。"],
    bound: ["尚无测评数据，页面不展示任何成功率。", "已完成 5 名喜欢 VTuber 的路人观众初步反馈（与熟人前测 P001 类似），反馈偏好整活与联动内容；属于小样本定性反馈，正式验证扩大到 30 名成年受试者。", "已有证据不证明能任意游戏长期自主直播。"],
    src: ["商业计划书第 9 页与第 19 页", "工程索引 [I1] docs/minecraft-deepseek.md、logs/minecraft-deepseek-live-run.json", "[I2] output/sts2/streamer-acceptance.json（2026-10-20）", "[I3] docs/demo-summary-20261018.md", "[I4]–[I6] 界面源文件、B站事件归一化、记忆候选机制", "[I7] output/kunshan-20261020/research/P001-pretest.json"],
    todo: ["中文接梗场景清单：后续安排。", "30 名成年受试者验证：后续安排。"],
  }));
  title(s, "已有模块基础，整场节目仍需验证");
  const y0 = 1.55, cw = (CW - 0.35) / 2, ch = 3.3;
  // evidence
  box(s, M, y0, cw, ch, "line");
  T(s, "已有证据", { x: M + 0.3, y: y0 + 0.18, w: 3, h: 0.42, fontSize: 20, bold: true, color: C.acc });
  const ev = [["局部验证", "Minecraft：原木与木剑入库 [I1]"], ["局部验证", "STS2：18 次成功动作 + 口播回执 [I2]"], ["局部验证", "Flappy Bird：独立策略验收 [I3]"], ["已有模块", "工作台与记忆审核基础 [I4–I6]"], ["初步反馈", "5 名路人观众：偏好整活与联动"]];
  ev.forEach(([t, d], i) => {
    const y = y0 + 0.68 + i * 0.5;
    tag(s, t, M + 0.3, y + 0.05, { size: 12, w: 1.1, h: 0.32, st: t === "已有模块" ? "solid" : "acc", color: t === "已有模块" ? C.white : C.acc });
    T(s, d, { x: M + 1.55, y: y - 0.03, w: cw - 1.75, h: 0.48, fontSize: 15, valign: "middle" });
  });
  // acceptance
  const rx = M + cw + 0.35;
  box(s, rx, y0, cw, ch, "dash");
  T(s, "下一步验收", { x: rx + 0.3, y: y0 + 0.18, w: 3, h: 0.42, fontSize: 20, bold: true });
  const ac = [["连续节目稳定性", "整场播出，卡住切备用栏目"], ["中文接梗", "≥30 个场景，岁/歌分别复核"], ["双平台真实接入", "B站、抖音真实事件"], ["观众回访", "扩大到 30 人，看七天回访"]];
  ac.forEach(([a, d], i) => {
    const y = y0 + 0.68 + i * 0.6;
    tag(s, "待验证", rx + 0.3, y + 0.05, { size: 12, w: 0.95, h: 0.32, st: "dash", color: C.muted });
    T(s, [{ text: a + "  ", options: { bold: true } }, { text: d, options: { color: C.muted } }], { x: rx + 1.4, y, w: cw - 1.6, h: 0.45, fontSize: 15, valign: "middle" });
  });
  // difficulty + method
  const by = y0 + ch + 0.25;
  T(s, "中文接梗难在", { x: M, y: by, w: 2.2, h: 0.45, fontSize: 18, bold: true, color: C.acc, valign: "middle" });
  const diffs = ["语境", "双关", "反讽", "角色一致", "回应时机", "旧事回收"];
  const dw = (CW - 2.2 - 5 * 0.18) / 6;
  diffs.forEach((d, i) => {
    const x = M + 2.2 + i * (dw + 0.18);
    box(s, x, by, dw, 0.5, "soft", 0.25);
    T(s, d, { x, y: by, w: dw, h: 0.5, fontSize: 18, bold: true, align: "center", valign: "middle" });
  });
  const fy = by + 0.72;
  T(s, "测试方法", { x: M, y: fy, w: 2.2, h: 0.75, fontSize: 18, bold: true, color: C.acc, valign: "middle" });
  const fl = ["真人铺垫", "AI 理解", "角色回应", "观众反馈"];
  const fg = 0.45, fw = (CW - 2.2 - 3 * fg) / 4;
  fl.forEach((f, i) => {
    const x = M + 2.2 + i * (fw + fg);
    box(s, x, fy, fw, 0.75, i === 3 ? "acc" : "line");
    T(s, f, { x, y: fy, w: fw, h: 0.75, fontSize: 20, bold: true, align: "center", valign: "middle", color: i === 3 ? C.acc : C.ink });
    if (i < 3) arrow(s, x + fw + 0.05, fy + 0.375, x + fw + fg - 0.05, fy + 0.375, { color: C.acc, width: 2 });
  });
  footer(s, 7, [], "依据：商业计划书第 9、19 页；工程索引 [I1]–[I7]    仅为测试设计与验收目标，尚无测评结果");
}

// ===== 7 团队 =====
{
  const s = slide(8, N({
    say: ["九人团队按一场节目的生产流程组织：CEO 统筹，技术总监负责系统实现与验收，运营总监负责节目排期与跨工作线交付。", "每场节目怎样协作：播前运营总监组织任务、主持、抛梗与交付审阅，技术总监确认依赖服务和接管流程；人格内容负责人检查角色回应，视觉与音频负责人核对舞台。", "播后视频负责人筛选高光，市场商务负责人汇总观看与合作数据，CEO 决定下一轮投入。"],
    more: ["主持和导演按场次轮值；成员投入工时单独记录。"],
    bound: ["以上为计划中的岗位安排，公司设立后的正式任职另行确认。页面不包含履历与过往成绩。"],
    src: ["商业计划书第 10 页“团队介绍”"],
    todo: ["主持人按场次轮值，页面不单列。"],
  }));
  title(s, "团队围绕一场节目组织协作");
  const person = (x, y, w, h, name, role, dl, st = "line") => {
    box(s, x, y, w, h, st);
    T(s, [{ text: name + "  ", options: { bold: true, fontSize: 19, color: st === "solid" ? C.white : C.ink } }, { text: role, options: { fontSize: 14, color: st === "solid" ? C.white : C.acc, bold: true } }], { x: x + 0.25, y: y + 0.12, w: w - 0.4, h: 0.42, valign: "middle" });
    T(s, dl, { x: x + 0.25, y: y + 0.55, w: w - 0.4, h: 0.38, fontSize: 15, color: st === "solid" ? "E8EEFC" : C.muted });
  };
  const ceoW = 4.4, ceoX = (W - ceoW) / 2, y1 = 1.5, h = 1.0;
  person(ceoX, y1, ceoW, h, "杨若朝", "首席执行官", "项目统筹与资源决策", "solid");
  const tx = M, tw = 4.3, ox = M + tw + 0.5, ow = CW - tw - 0.5, y2 = 2.95;
  person(tx, y2, tw, h, "徐嘉盛", "技术总监", "模型、游戏与系统验收", "acc");
  person(ox + (ow - 4.3) / 2, y2, 4.3, h, "姬祥", "运营总监", "节目排期与团队协作", "acc");
  // connectors
  const cx = W / 2, my = y1 + h + 0.22;
  arrow(s, cx, y1 + h, cx, my, { noHead: true });
  arrow(s, tx + tw / 2, my, ox + ow / 2, my, { noHead: true });
  arrow(s, tx + tw / 2, my, tx + tw / 2, y2, { noHead: true });
  arrow(s, ox + ow / 2, my, ox + ow / 2, y2, { noHead: true });
  const y3 = 4.4, y4 = 5.6;
  person(tx, y3, tw, h, "李岱松", "系统工程师", "部署与工作台");
  person(tx, y4, tw, h, "肖鹏希", "音频工程师", "语音与声音效果");
  arrow(s, tx + tw / 2, y2 + h, tx + tw / 2, y3, { noHead: true });
  const gw = (ow - 0.3) / 2;
  const ops = [["刘瑞麒", "AI 人格与内容负责人", "角色表达与接梗企划"], ["张涵", "市场与商务负责人", "增长与品牌合作"], ["吴越", "视觉美术负责人", "原画与 Live2D 协作"], ["张乐溪", "视频制作负责人", "高光切片与系列包装"]];
  ops.forEach(([n, r, d], i) => person(ox + (i % 2) * (gw + 0.3), i < 2 ? y3 : y4, gw, h, n, r, d));
  arrow(s, ox + ow / 2, y2 + h, ox + ow / 2, y3 - 0.02, { noHead: true });
  footer(s, 8, [], "依据：商业计划书第 10 页（计划岗位，正式任职另行确认）");
}

// ===== 8 商业模式 =====
{
  const s = slide(9, N({
    say: ["商业逻辑是一个循环：人机节目，经 B站与抖音直播和切片传播，形成观看、回访与社群关系，再转为礼物、会员、周边、品牌及游戏合作，收入再投入内容与制作。", "真人与 AI 分工让商业段落也好看：真人介绍产品事实与规则、主动设挑战，AI 以角色视角回应和选择，观众投票或预测。", "打赏自然进入节目：平台事件先核对来源与重复，进入感谢队列，连续小额合并，在任务间隙致谢；关键游戏动作受保护。", "免费互动仍然成立：公开任务与基本互动面向未付费观众；不承诺私下关系，不把打赏绑定角色的爱意、痛苦或输赢。", "游戏按五点选择；例如 Minecraft 木剑短任务材料和时限明确，失败也能讲清缺什么，观众容易预测。"],
    more: ["收入结构（首年目标情景）：普通打赏 17,400 元、会员 19,250 元、周边 15,000 元、商业合作 10,000 元，合计 61,650 元。", "季度收入情景：Q1 1,200；Q2 3,000；Q3 15,550；Q4 41,900 元。", "支出：日常运营 52,000 元（模型语音云服务 18,000、剪辑社群补贴 12,000、推广 18,000、活动杂费 4,000）+ 周边制作履约 10,500 元 = 62,500 元；运营现金余额 -850 元。", "启动投入另计 25,000 元（原画、Live2D 与表情、开发工具），首年现金缺口 25,850 元；按季度并将启动投入置于期初，累计缺口峰值约 47,750 元。", "保守情景：若会员与合作延后，按 8,000 元打赏、40,000 元日常支出及 25,000 元启动投入，缺口约 57,000 元，相应推迟预售与可变推广。", "会员按 385 个会员月、每月净到账 50 元测算（情景假设）；品牌合作按首年两次、每次 5,000 元目标测算。", "约 250 场、500 小时排期对应日常现金约 208 元每场、104 元每小时；团队成员不领薪，开发、美术、音效等投入已计入运营与启动预算。", "平台价格、分成与提现以账号当期规则和合同为准；收入以平台结算单确认，感谢队列显示值只用于节目。"],
    bound: ["以上为预测情景，不是实际经营成绩；团队成员不计薪酬；项目尚未盈利，也未形成商业闭环。", "10 万元申请支持不等于首年现金缺口。", "游戏热度尚未验证；公开运营前将在两平台相同观察窗口采集候选游戏的直播与短片表现。", "B站事件适配层目前基于模拟事件，真实直播间接通、金额与退款对账、抖音事件接入均待交付。"],
    src: ["商业计划书第 11–16 页", "S3", "R1", "R2", "R4", "R5", "S7", "S8", "S9"],
    todo: ["平台收入分成：后续确定。"],
    refs: [
      "B站虚拟主播付费舰长约 15.2 万人、月营收约 350 万美元（VTBS.moe 2024，转引自 [S3] WWW 2025 论文）：说明 VTuber 会员付费需求真实存在。",
      "浙江大学国际传播研究中心《2025 抖音主播职业调研报告》（2025-11，1001 份问卷）：超 66% 主播月收入 2000–1 万元，仅 3.4% 超 3 万元 [R1]。本项目首年收入情景约合每月 5,100 元，落在多数主播区间内。",
      "B站虚拟主播收入高度集中：月营收前 120 名占行业一半以上；约 2/3 虚拟主播粉丝不足 1 万（截至 2021-11-02）[R2]。2021 年 8 月统计的 3,472 名虚拟主播中 1,827 人当月营收为 0 [R4]。因此收入情景按小规模设定，并随观看与回访复核。",
      "新榜 2021 年访谈：虚拟主播收入中位数 5–10 万（周期与样本未说明）[R4]。",
      "B站 2025 年近 300 万创作者通过广告、直播、充电获得收入，月均付费用户 3,566 万 [R5]。",
    ],
  }));
  title(s, "先验证观看与回访，再扩大商业收入", "真人负责设局与产品事实，AI 负责角色化接梗：商业段落同样有可看的互动");
  const y0 = 1.95, gap = 0.36, bw = (CW - 4 * gap) / 5, bh = 1.2;
  const flow = [["人机节目", "真人设局 · AI 接梗"], ["直播 + 切片", "B站 · 抖音双平台"], ["观看与回访", "社群关系 · 先验证"], ["收入", "礼物 · 会员 · 周边 · 品牌及游戏合作"], ["再投入", "内容与制作"]];
  flow.forEach(([a, b], i) => {
    const x = M + i * (bw + gap);
    box(s, x, y0, bw, bh, i === 2 ? "solid" : "line");
    T(s, a, { x: x + 0.12, y: y0 + 0.12, w: bw - 0.24, h: 0.45, fontSize: 18, bold: true, align: "center", color: i === 2 ? C.white : C.ink });
    T(s, b, { x: x + 0.12, y: y0 + 0.58, w: bw - 0.24, h: 0.55, fontSize: 13, align: "center", color: i === 2 ? "E8EEFC" : C.muted });
    if (i < 4) arrow(s, x + bw + 0.04, y0 + bh / 2, x + bw + gap - 0.04, y0 + bh / 2, { color: C.acc, width: 2 });
  });
  const ly = y0 + bh + 0.22, xa = M + bw / 2, xb = M + 4 * (bw + gap) + bw / 2;
  arrow(s, xb, y0 + bh, xb, ly, { noHead: true, dash: true, color: C.acc });
  arrow(s, xb, ly, xa, ly, { noHead: true, dash: true, color: C.acc });
  arrow(s, xa, ly, xa, y0 + bh + 0.02, { dash: true, color: C.acc });
  // three cards
  const cy = 3.75, chh = 3.05, cg = 0.3, cw = (CW - 2 * cg) / 3;
  // A tipping
  box(s, M, cy, cw, chh, "line");
  T(s, "打赏自然进入节目", { x: M + 0.25, y: cy + 0.18, w: cw - 0.5, h: 0.42, fontSize: 18, bold: true, color: C.acc });
  ["事件核对", "排队合并", "间隙致谢"].forEach((t, i) => {
    const x = M + 0.25 + i * ((cw - 0.5 - 0.4) / 3 + 0.2), w = (cw - 0.5 - 0.4) / 3;
    box(s, x, cy + 0.75, w, 0.6, "soft");
    T(s, t, { x, y: cy + 0.75, w, h: 0.6, fontSize: 14, bold: true, align: "center", valign: "middle" });
  });
  T(s, [
    { text: "免费观众同样参与公开任务", options: { bullet: { indent: 14 }, breakLine: true } },
    { text: "不绑定角色的爱意、痛苦或输赢 [S9]", options: { bullet: { indent: 14 }, breakLine: true } },
    { text: "关键游戏动作不被打断", options: { bullet: { indent: 14 } } },
  ], { x: M + 0.25, y: cy + 1.55, w: cw - 0.5, h: 1.4, fontSize: 15, paraSpaceAfter: 5 });
  // B games
  const bx = M + cw + cg;
  box(s, bx, cy, cw, chh, "line");
  T(s, "游戏选择看五点", { x: bx + 0.25, y: cy + 0.18, w: cw - 0.5, h: 0.42, fontSize: 18, bold: true, color: C.acc });
  const crit = ["需求潜力", "节目效果", "AI 可执行", "观众参与", "维护成本"];
  let tx = bx + 0.25, ty = cy + 0.75;
  crit.forEach((c) => { const w = c.length * 14 * 0.0175 + 0.3; if (tx + w > bx + cw - 0.25) { tx = bx + 0.25; ty += 0.46; } tag(s, c, tx, ty, { size: 14, h: 0.36, w, st: "soft", color: C.ink }); tx += w + 0.1; });
  T(s, [{ text: "例：Minecraft 木剑短任务", options: { bold: true, breakLine: true } }, { text: "材料与时限明确，失败能讲清缺什么，观众容易预测；热度待公开前采样", options: { color: C.muted } }],
    { x: bx + 0.25, y: ty + 0.5, w: cw - 0.5, h: 1.0, fontSize: 14 });
  // C finance
  const fx = bx + cw + cg;
  box(s, fx, cy, cw, chh, "acc");
  T(s, "首个完整运营年度 · 测算情景", { x: fx + 0.25, y: cy + 0.18, w: cw - 0.5, h: 0.42, fontSize: 17, bold: true, color: C.acc });
  const fin = [["收入情景", "61,650"], ["运营与履约支出", "62,500"], ["启动投入（另计）", "25,000"], ["首年现金缺口", "25,850"]];
  fin.forEach(([k, v], i) => {
    const y = cy + 0.72 + i * 0.5;
    T(s, k, { x: fx + 0.25, y, w: cw - 2.0, h: 0.45, fontSize: 15, valign: "middle", bold: i === 3 });
    T(s, v + " 元", { x: fx + cw - 2.0, y, w: 1.75, h: 0.45, fontSize: i === 3 ? 20 : 17, bold: true, align: "right", valign: "middle", color: i === 3 ? C.acc : C.ink });
    if (i === 2) s.addShape(pres.shapes.LINE, { x: fx + 0.25, y: y + 0.48, w: cw - 0.5, h: 0, line: { color: C.line, width: 1 } });
  });
  T(s, "测算情景；开发、美术、音效已计入", { x: fx + 0.25, y: cy + chh - 0.42, w: cw - 0.5, h: 0.3, fontSize: 12, color: C.muted });
  footer(s, 9, ["S3", "R1", "R2", "S9"], "计划书第 11–16 页");
}

// ===== 9 市场战略规划 =====
{
  const s = slide(10, N({
    say: ["B站与抖音都直播：B站用较完整的游戏过程、角色关系和社群讨论承接追更；抖音用快速说明情境、明确反应和阶段结果降低陌生观众理解成本，短片用于直播前后触达。", "推进按验收结果，而不是按日历：内部试播与中文接梗测试，观众验证，双平台正式直播，切片回流与固定栏目，小规模付费及合作验证。", "每个阶段先看四件事：节目能否稳定完成、观众是否记住角色与事件、是否主动回访、收入是否覆盖相应直接成本。", "申请 10 万元支持：原画 8,000、Live2D 及表情 14,000、开发工具 3,000、年度日常运营 52,000、周边周转 10,500、机动 12,500 元；帮助完成原创形象首版、内部试播与接梗测试、一年双平台运营与各阶段验收。"],
    more: ["初期拟每周二至周六北京时间 20:00–22:00 开播，周一研发企划，周日复盘与素材整理；每周发布 4–5 条重点切片，保留真人抛梗、AI 回应和结局。", "首月：原创形象与授权声线首版，一类短游戏任务和两个人机栏目，3 场内部试播及至少 10 个切片候选。", "前三个月按已落实人力稳定开播；第四至六个月形成游戏主线、挑战、弹幕预测和旧事回收的固定结构，并与同量级真人主播联动；第七至十二个月测试会员与小批量预售周边，推出有实际受众样例的品牌主题直播。", "全年推广预算 18,000 元分批使用，先比较自然流量下的完播、评论与关注。", "海外传播放在国内双平台稳定之后。"],
    bound: ["B站与抖音开播权限可落实；双平台正式运营以推流、音视频与事件联调和节目验收为前提；当前 OBS 与 B站适配是基础，未验收双路持续直播。", "进取目标：前三个月 2.5 万、约六个月 10 万、年末 15 万主阵地关注；参照同类创作者公开数据设定，若落后则调整商业收入起点和支出。", "约 10 万关注为团队原设的会员与商品升级节点，不是平台统一门槛。"],
    src: ["商业计划书第 16–19 页", "R2", "R3", "R5", "S8"],
    todo: ["30 名成年受试者验证：后续安排。"],
    refs: [
      "增长上限参照：抖音虚拟主播许安一 2022-03-25 首播，一个月内直播涨粉 13 万，100 天粉丝 42.7 万（飞瓜数据，转引自界面新闻/新播场 2022-07-11）[R3]。属头部个案。",
      "行业分布参照：截至 2021-11-02，B站 3,606 名虚拟主播中约 2/3 粉丝不足 1 万，50 万粉以上约 1% [R2]。",
      "因此半年 10 万、年末 15 万关注是介于头部个案与行业多数之间的进取目标，不是预测；落后时按回访与收入数据调整节奏。",
      "B站 2025 年第四季度千粉以上 UP 主数量同比增长 30% [R5]。",
    ],
  }));
  title(s, "按验收结果推进双平台运营");
  // left channel diagram
  const lx = M, lw = 4.5, y0 = 1.55;
  box(s, lx + 0.9, y0, lw - 1.8, 0.6, "solid");
  T(s, "人机节目", { x: lx + 0.9, y: y0, w: lw - 1.8, h: 0.6, fontSize: 18, bold: true, color: C.white, align: "center", valign: "middle" });
  const pw = (lw - 0.25) / 2, py = y0 + 0.95;
  [["B站直播", "横屏 · 完整过程与连载"], ["抖音直播", "竖屏 · 快速情境入口"]].forEach(([a, b], i) => {
    const x = lx + i * (pw + 0.25);
    box(s, x, py, pw, 1.1, "acc");
    T(s, a, { x, y: py + 0.1, w: pw, h: 0.42, fontSize: 18, bold: true, color: C.acc, align: "center" });
    T(s, b, { x: x + 0.1, y: py + 0.56, w: pw - 0.2, h: 0.42, fontSize: 13, color: C.muted, align: "center" });
    arrow(s, lx + lw / 2, y0 + 0.6, x + pw / 2, py - 0.02, { color: C.acc });
    arrow(s, x + pw / 2, py + 1.1, lx + lw / 2 + (i ? 0.3 : -0.3), py + 1.5 - 0.02, { color: C.faint });
  });
  const ky = py + 1.5;
  box(s, lx, ky, lw, 0.85, "soft");
  T(s, [{ text: "高光切片  ", options: { bold: true } }, { text: "每周 4–5 条", options: { color: C.muted, breakLine: true } }, { text: "保留抛梗、回应与结局", options: { color: C.muted } }], { x: lx + 0.25, y: ky, w: lw - 1.0, h: 0.85, fontSize: 14, valign: "middle" });
  arrow(s, lx + lw - 0.2, ky, lx + lw - 0.2, py + 1.12, { dash: true, color: C.acc });
  T(s, "回流直播", { x: lx + lw - 1.25, y: ky + 0.27, w: 0.95, h: 0.3, fontSize: 12, color: C.acc, align: "right" });
  // right timeline
  const rx = M + lw + 0.45, rw = CW - lw - 0.45, rh = 0.6, rg = 0.1;
  const stages = [
    ["首月", "内部试播与中文接梗测试", "形象 11 月底交付；3 场试播"],
    ["验证", "观众验证", "5 人初步反馈 → 30 人七天回访"],
    ["前 3 月", "B站、抖音双平台正式直播", "前提：真实接入、人员、验收"],
    ["4–6 月", "切片回流与固定栏目", "主线 · 挑战 · 预测 · 旧事"],
    ["7–12 月", "小规模付费及合作验证", "会员、小批量周边、品牌样例"],
  ];
  s.addShape(pres.shapes.LINE, { x: rx + 0.21, y: y0 + 0.3, w: 0, h: 4 * (rh + rg), line: { color: C.line, width: 2 } });
  stages.forEach(([t, a, b], i) => {
    const y = y0 + i * (rh + rg);
    dot(s, i + 1, rx, y + 0.09, 0.42, i < 2);
    T(s, t, { x: rx + 0.55, y, w: 0.95, h: rh, fontSize: 14, bold: true, color: C.acc, valign: "middle" });
    box(s, rx + 1.5, y, rw - 1.5, rh, i < 2 ? "line" : "dash");
    T(s, a, { x: rx + 1.7, y, w: 3.15, h: rh, fontSize: 17, bold: true, valign: "middle" });
    T(s, b, { x: rx + 4.85, y, w: rw - 5.0, h: rh, fontSize: 13, color: C.muted, valign: "middle" });
  });
  // gates (full width)
  const gy = 5.1;
  T(s, "每阶段先看", { x: M, y: gy, w: 1.5, h: 0.4, fontSize: 15, bold: true, color: C.acc, valign: "middle" });
  const gates = ["节目能否稳定完成", "观众是否记住角色与事件", "是否主动回访", "收入是否覆盖直接成本"];
  const gw = (CW - 1.5 - 3 * 0.15) / 4;
  gates.forEach((g, i) => tag(s, g, M + 1.5 + i * (gw + 0.15), gy, { size: 14, h: 0.4, w: gw, st: "accSoft" }));
  // budget bar
  const by = 6.05, bh = 0.45;
  T(s, "申请 10 万元支持", { x: M, y: by - 0.4, w: 3, h: 0.34, fontSize: 15, bold: true, color: C.acc });
  T(s, "支持完成：原创形象首版 → 内部试播与接梗测试 → 一年双平台运营与阶段验收", { x: M + 2.6, y: by - 0.4, w: CW - 2.6, h: 0.34, fontSize: 13, color: C.muted, align: "right" });
  const parts = [["原画", 8000], ["Live2D", 14000], ["工具", 3000], ["年度日常运营", 52000], ["周边周转", 10500], ["机动", 12500]];
  let bx = M;
  parts.forEach(([k, v], i) => {
    const w = CW * v / 100000;
    const sw = i === parts.length - 1 ? M + CW - bx : w - 0.03;
    s.addShape(pres.shapes.RECTANGLE, { x: bx, y: by, w: sw, h: bh, fill: { color: i === 3 ? C.acc : i % 2 ? "C9D6F5" : "A9BEEF" }, line: { type: "none" } });
    const lbl = `${k} ${String(v / 10000)} 万`;
    if (w > 1.6) T(s, lbl, { x: bx, y: by, w: sw, h: bh, fontSize: 12, bold: true, color: i === 3 ? C.white : C.ink, align: "center", valign: "middle" });
    else T(s, lbl, { x: Math.max(M, bx - 0.35), y: by + bh + 0.04, w: w + 0.7, h: 0.28, fontSize: 11, color: C.muted, align: "center" });
    bx += w;
  });
  footer(s, 10, ["R3", "R2", "S8"], "依据：计划书第 16–19 页");
}

pres.writeFile({ fileName: OUT }).then((f) => console.log("wrote", f));
