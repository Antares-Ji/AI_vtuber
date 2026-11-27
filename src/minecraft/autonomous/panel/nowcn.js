'use strict';
// 面板的「现在在干什么 / 卡在哪里」中文摘要。
//
// 为什么要有这一层：面板原本把 bot 的英文机器话直接贴出来（`blaze_rods=0 shots=0 guard=1`、
// `cannot craft stone_pickaxe: need {"c":["cobblestone"...]}`），人要调试就得自己翻。这里把同一份
// 快照翻成中文，并且**只做翻译和归纳，不做推测**：缺什么、卡多久、下一步该干什么，全部从
// 背包 / 最近判决 / 位置变化里读出来，读不出来就写「未知」，不编。
//
// 判定规则沿用项目里那条 15 分钟线：目标量没动 + 位置没动 = 疑似程序问题；
// 位置在动（哪怕里程碑没推进）= 正常流程，别急着重启。

const MS_CN = {
  wood: '砍木头', crafting_table: '做工作台', wooden_pickaxe: '做木镐', stone: '挖石头',
  stone_tools: '做石制工具', food: '找吃的', coal: '挖煤', iron_ore: '挖铁矿', iron_ingots: '烧铁锭',
  iron_gear: '铁装备', armor: '穿护甲', diamond_pick: '钻石镐', diamond_gear: '钻石装备', bow: '弓',
  obsidian: '黑曜石', flint_steel: '打火石', nether: '进下界', blaze_rods: '烈焰棒', pearls: '末影珍珠',
  eyes: '末影之眼', stronghold: '找要塞', enter_end: '进末地', kill_dragon: '打末影龙',
};
const DIM_CN = { overworld: '主世界', the_nether: '下界', the_end: '末地' };
const SKILL_CN = {
  use_portal: '用传送门', build_nether_portal: '建下界门', make_obsidian: '造黑曜石', ensure_tools: '补工具',
  ensure_diamond_pick: '造钻石镐', ensure_bucket: '补水桶', find_diamonds: '找钻石', branch_mine: '分支挖矿',
  mine: '挖矿', roam: '长途寻路', hunt: '打猎', eat: '进食', fish: '钓鱼', search_nether_fortress: '找下界要塞',
  farm_blaze: '打烈焰人', farm_pearl: '刷末影珍珠', craft_eyes_of_ender: '合成末影之眼', locate_stronghold: '三角定位要塞',
  enter_end: '进末地', kill_dragon: '打末影龙', pillar_up: '搭柱上升', tidy: '整理背包', craft: '合成',
  grid_craft: '工作台合成', smelt: '熔炼', equip: '装备', dig_to_y: '向下挖井', deep_shaft: '挖深井',
  resume_shaft: '续挖旧井', recover_surface: '回地表', dry_escape: '脱水脱困', return_overworld: '回主世界',
  status: '查状态', wait: '等待', place: '放方块', climb_out: '爬出坑', obsidian_farm: '黑曜石农场',
};
// 机器话里最常见的短句，翻成中文；命中不了就原样保留（宁可留英文，也不要翻错）。
const PHRASE_CN = [
  [/no lit portal found near ([^ ]+) \(dim=(\w+)\)/g, (m, p, d) => `在 ${p} 附近没找到点燃的传送门（${DIM_CN[d] || d}）`],
  [/no arrival portal remembered for this dimension/g, '这个维度还没记下「来的时候落在哪」'],
  [/the remembered arrival portal at ([^ ]+) did not light up either/g, (m, p) => `记下的到达点 ${p} 也没有点燃的门`],
  [/walking there and looking/g, '正朝推算的门位置走过去，边走边找'],
  [/portal already lit at ([^ ]+) - entered it instead of building/g, (m, p) => `${p} 的门已经点着了，直接进去，不再重建`],
  [/travelled (\w+) -> (\w+)/g, (m, a, b) => `从${DIM_CN[a] || a}到了${DIM_CN[b] || b}`],
  [/arrival remembered/g, '已记下到达点'],
  [/cannot craft (\w+): need (\{.*?\})/g, (m, it, need) => `做不出 ${it}，缺料 ${need}`],
  [/no single item can satisfy "(\w+)" of (\w+)/g, (m, slot, it) => `${it} 的「${slot}」格没有可用材料`],
  [/diamond ore needs an iron pickaxe or better \(stone drops nothing\)/g, '钻石矿要铁镐以上才掉东西（石镐挖了等于白挖）'],
  [/no diamond-tier pickaxe/g, '没有钻石镐'],
  [/mined 0 of/g, '挖到 0 个'],
  [/blaze_rods=(\d+) shots=(\d+) guard=(\d+)/g, (m, r, s, g) => `烈焰棒 ${r} 根 · 射了 ${s} 箭 · 循环计数 ${g}`],
  [/needs arrows \+ bow: arrows=(\d+)/g, (m, a) => `需要弓+箭（现有箭 ${a}）`],
  [/no fortress in sight after (\d+) hops/g, (m, h) => `走了 ${h} 步还没看见要塞`],
  [/the pocket is sealed/g, '这个格子被封死了（四周没有能站的两格高空间）'],
  [/OP LIFT[^:]*:/g, 'OP 传送救援（不是自己走出来的，汇报时要说明）:'],
  [/is flowing \(level (\d+)\) - a bucket cannot take it, skipping/g, (m, l) => `是流动水（level ${l}），桶打不满，跳过`],
  [/bucket still empty/g, '桶还是空的'],
  [/VERDICT REPEATING/g, '判决在重复'],
  [/STAGE LOCK: (\w+) has burned (\d+) attempts \/ (\d+) min of effort \(calendar (\d+) min\)/g,
    (m, st, n, eff, cal) => `${MS_CN[st] || st} 已试 ${n} 次 / 实际耗时 ${eff} 分钟（日历 ${cal} 分钟）`],
  [/milestone (\w+) RE-OPENED/g, (m, st) => `${MS_CN[st] || st} 这一段被重新打开（条件又不成立了）`],
  [/milestone (\w+) not done \(fail (\d+)\)/g, (m, st, n) => `${MS_CN[st] || st} 没完成（第 ${n} 次失败）`],
  [/orphan step: (\w+) refused/g, (m, w) => `上一步已被放弃，它的 ${w} 调用被租约拒绝（正常保护）`],
  [/Path was stopped before it could be completed/g, '寻路被中止（通常是上一步超时后抢占）'],
  [/Took to long to decide path to goal/g, '寻路算不出路线（超时）'],
  [/connection ended mid-step/g, '这一步中途掉线了'],
];

function cn(text) {
  let s = String(text == null ? '' : text);
  for (const [re, rep] of PHRASE_CN) s = s.replace(re, rep);
  // 技能名 / 里程碑名 / 维度名：只替换完整词，避免把 cobblestone 里的 stone 也换掉。
  s = s.replace(/\b([a-z_]{3,})\b/g, (w) => SKILL_CN[w] || MS_CN[w] || DIM_CN[w] || w);
  return s;
}

// 位置多久没动过：面板每 3 秒调一次，这里自己记住上一次的位置。
let lastPos = null, lastMoveAt = 0, lastSeenAt = 0;
function moveIdle(pos) {
  const now = Date.now();
  if (!pos) return { min: null, moved: null };
  const key = `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
  if (key !== lastPos) { lastPos = key; lastMoveAt = now; }
  if (!lastMoveAt) lastMoveAt = now;
  lastSeenAt = now;
  return { min: Math.round((now - lastMoveAt) / 60000), moved: now - lastMoveAt < 90000 };
}

// 从背包里读出「缺什么」。只报能直接支撑下一步的短缺，不报无关物品。
function shortages(inv, cur, dim) {
  const n = (k) => (inv && typeof inv[k] === 'number' ? inv[k] : 0);
  const has = (re) => inv && Object.keys(inv).some(k => re.test(k) && inv[k] > 0);
  const out = [];
  const picks = inv ? Object.keys(inv).filter(k => /_pickaxe$/.test(k)) : [];
  if (!picks.length) out.push('一把镐都没有');
  else if (!has(/diamond_pickaxe/)) out.push(`没有钻石镐（现有镐：${picks.join('、')}）`);
  if (!n('cobblestone') && !n('cobbled_deepslate') && !n('stone')) out.push('没有圆石/石头（石镐做不出来）');
  if (n('iron_ingot') < 3 && !has(/iron_pickaxe/)) out.push(`铁锭只有 ${n('iron_ingot')} 个（铁镐要 3 个）`);
  if (n('diamond') < 3 && !has(/diamond_pickaxe/)) out.push(`钻石 ${n('diamond')}/3（钻石镐要 3 颗）`);
  if (!n('stick')) out.push('没有木棍（所有工具都要）');
  if (!n('crafting_table') && !has(/crafting_table/)) out.push('背包里没有工作台');
  if (dim === 'the_nether' && n('blaze_rod') < 1) out.push('还没有烈焰棒（下界要塞里的烈焰人掉）');
  if (cur === 'blaze_rods' && !n('arrow')) out.push('没有箭（打烈焰人要用弓）');
  if (cur === 'eyes' && n('ender_pearl') < 12) out.push(`末影珍珠 ${n('ender_pearl')}/12（末影之眼要珍珠+烈焰粉）`);
  if (cur === 'obsidian' && n('obsidian') < 10) out.push(`黑曜石 ${n('obsidian')}/10（门框最少 10 块）`);
  if (!n('water_bucket') && (cur === 'obsidian' || cur === 'nether')) out.push('没有水桶（造黑曜石要水+岩浆）');
  return out;
}

// 下一步建议：先看「它现在在做哪一段」，再看缺料。
//
// 这段函数原来是一条从「新手清单」往下第一个命中就 return 的链，末地那两条排在最后面，于是只要
// `iron_ingot < 3 且背包里没铁镐`，不管它在第 22/23 段还是在末地里被末影人追着打，输出永远是
// 「用石镐挖铁矿」（live 02:0x-02:2x 连续一个多小时就是这一句，而包里那两把一直是石镐）。
// 现在：阶段专属建议排最前，新手清单只在「那一段还没完成」时才说话。
const LADDER_DONE = {
  pick: ['wooden_pickaxe', 'stone_tools'],
  cobble: ['stone'],
  iron: ['iron_ore', 'iron_ingots', 'iron_gear', 'armor'],
  diamond: ['diamond_pick', 'diamond_gear'],
};
function already(done, ids) { return !!done && ids.some(id => done.has(id)); }

const STAGE_ADVICE = {
  obsidian: (n) => `门框最少 10 块：水倒在岩浆源上变黑曜石，或直接挖已有的门框/黑曜石田（要钻石镐）。现在 ${n('obsidian')}/10。`,
  nether: () => '门框够 10 块就用打火石点门（对着框内侧右键），然后站进门里等 2~4 秒；已经点着的门直接进，不要重建。',
  blaze_rods: () => '在下界找要塞（nether_bricks/nether_brick_stairs），上到烈焰人刷怪笼附近用弓射；找不到就换方向长距离 roam，别在同一个格子里反复挖。',
  pearls: () => '打末影人拿珍珠（下界/主世界夜晚都有），要 12 颗左右；带水桶防身，别直视末影人。',
  eyes: (n) => `烈焰棒→烈焰粉，粉+珍珠合成末影之眼（要 12 个左右，留几个备用）。现在眼 ${n('ender_eye')}、珍珠 ${n('ender_pearl')}。`,
  stronghold: () => '扔末影之眼三角定位要塞，挖下去找末地传送门框，把眼填进去。',
};

function nextStep(cur, dim, inv, short, food, done, worn) {
  const n = (k) => (inv && typeof inv[k] === 'number' ? inv[k] : 0);
  const hasPick = inv && Object.keys(inv).some(k => /_pickaxe$/.test(k) && inv[k] > 0);
  const wornN = Array.isArray(worn) ? worn.filter(Boolean).length : 0;
  // 看饥饿条，不只看背包：饱食度 19/20 时背包没肉是正常的，不该被劝回主世界打猎。
  if (dim === 'the_nether' && (cur === 'food' || (food != null && food < 10))) {
    return '下界没有被动动物，吃的只能回主世界打猎：先 use_portal 回去（找不到门就朝「主世界门坐标 ÷ 8」走），别在下界继续 hunt。';
  }
  // ---- 阶段专属：这一段真正该做的事，排在任何新手清单前面 ----
  if (dim === 'the_end' || cur === 'enter_end' || cur === 'kill_dragon') {
    const bits = [];
    if (dim === 'the_end') bits.push('先射水晶再打龙：绕着柱子找射线没被挡的格子，一根打不动就换下一根，别朝 50 格外的柱顶抛箭');
    else bits.push('门已开就下去进末地：进门前清点箭/垫路方块/还能用的镐');
    // 护甲看「身上穿的」，不看背包：iron_chestplate 在 6 号槽时 items() 里根本没有它。
    if (wornN === 0) bits.push(`身上零护甲（铁锭 ${n('iron_ingot')}，胸甲要 8）→ 先补甲，末地死一次就是一场`);
    else if (wornN < 2) bits.push(`穿着 ${wornN}/4 件，胸甲+一件是下水线的底线`);
    if (!hasPick) bits.push('背包里没有能用的镐：末地挖不动垫路石，也开不了铁');
    if (!n('arrow')) bits.push('箭打光了：水晶不会自己掉');
    return bits.join('；') + '。';
  }
  if (STAGE_ADVICE[cur]) return STAGE_ADVICE[cur](n) + (short.length && cur === 'blaze_rods' ? `（工具/材料短缺要回主世界补：${short[0]}）` : '');
  // ---- 新手清单：只有对应那一段还没完成才说，否则它在 23 段时还会劝人去挖铁 ----
  if (dim !== 'the_nether' && !hasPick && !already(done, LADDER_DONE.pick)) return '先做任何一把镐：有木棍+木板就做木镐；有圆石就做石镐。没有镐，后面挖矿/钻石/黑曜石全部走不动。';
  if (dim !== 'the_nether' && !n('cobblestone') && !n('cobbled_deepslate') && !already(done, LADDER_DONE.cobble)) return '用手上现有的镐去挖石头拿圆石（木镐就能挖），再合成石镐；不要在没有圆石时反复尝试合成石镐。';
  if (dim !== 'the_nether' && n('iron_ingot') < 3 && !inv.iron_pickaxe && !already(done, LADDER_DONE.iron)) return '用石镐挖铁矿（y≈16 的石头层最快，别在 y<0 的深板岩层磨），烧成铁锭做铁镐——钻石矿必须铁镐以上。';
  if (dim !== 'the_nether' && n('diamond') < 3 && !already(done, LADDER_DONE.diamond)) return '用铁镐在 y<16 找钻石（多为 deepslate_diamond_ore），凑 3 颗做钻石镐；黑曜石只有钻石镐挖得动。';
  return short.length ? `先补：${short[0]}` : '这一段没有明显缺料，看最近动作是否在推进目标量。';
}

function summarize(s) {
  const live = s.live || {};
  const inv = s.inventory || {};
  const cur = s.current;
  const dim = live.dim || null;
  const pos = live.pos || null;
  const mv = moveIdle(pos);
  const k = s.stall || {};
  const short = shortages(inv, cur, dim);
  // The completed-milestone set, from whichever caller has it: the panel hands the whole `ladder`, the
  // POV feed hands the bare `state.json` keys. Without it the beginner ladder cannot know that the run
  // already finished the iron era, which is what made it lecture a dragon fight about mining iron.
  const doneIds = s.ladder ? s.ladder.filter(r => r && r.state === 'done').map(r => r.id) : (s.doneIds || []);
  const doneSet = new Set(doneIds);
  const v = String(k.verdict || '').startsWith('VERDICT REPEATING') ? 'repeat'
    : String(k.verdict || '').startsWith('VERDICT') ? 'other' : 'advancing';
  // 15 分钟线：目标量没动 + 位置也没动 = 疑似程序问题；位置在动 = 正常流程（哪怕里程碑没推进）。
  let judge;
  if (!cur) judge = { level: 'done', text: '23 段全部完成，应该已经在末地阶段了。' };
  else if (v === 'repeat' && (k.segmentMin || 0) >= 15 && mv.min != null && mv.min >= 15) {
    judge = { level: 'bug', text: `疑似程序问题：${MS_CN[cur] || cur} 卡了 ${k.segmentMin} 分钟，目标量 ${k.idle || 0} 次没动，而且位置也 ${mv.min} 分钟没动。` };
  } else if (v === 'repeat' && (k.segmentMin || 0) >= 15) {
    judge = { level: 'slow', text: `里程碑没推进（${k.segmentMin} 分钟），但位置在动（${mv.min == null ? '未知' : mv.min + ' 分钟前还在动'}）——先按正常流程观察，别急着重启。` };
  } else if (v === 'repeat') {
    judge = { level: 'slow', text: `判决在重复：目标量 ${k.idle || 0} 次没动（这一段占了 ${k.segmentMin || 0} 分钟）。位置还在动，所以先按「在尝试但没推进」看，别急着重启。` };
  } else if (mv.min != null && mv.min >= 15) {
    judge = { level: 'bug', text: `位置 ${mv.min} 分钟没动，但判决还没重复到阈值——大概率是空转，值得看最近动作。` };
  } else {
    judge = { level: 'ok', text: `正常推进中（位置 ${mv.min == null ? '未知' : mv.min + ' 分钟前动过'}）。` };
  }
  const act = (s.activity || []).slice(-5).map(cn);
  return {
    headline: cur
      ? `现在在做：${MS_CN[cur] || cur}（第 ${(s.doneCount || 0) + 1}/23 段）`
      : '现在在做：全部里程碑已完成',
    where: pos ? `${DIM_CN[dim] || dim || '未知维度'} (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})` : '位置未知（还没读到 live.json）',
    vitals: `生命 ${live.hp == null ? '?' : live.hp}/20 · 饥饿 ${live.food == null ? '?' : live.food}/20 · ${live.worn && live.worn.length ? '穿着 ' + live.worn.join('+') : '没穿护甲'} · 背包空 ${s.metrics && s.metrics.freeSlots != null ? s.metrics.freeSlots : '?'}`,
    judge: judge.text,
    judgeLevel: judge.level,
    why: k.lastObs ? `最近一次没完成的理由：${cn(k.lastObs)}` : '（还没有失败判决，说明这一段刚开始）',
    tried: k.dossier && k.dossier.alt ? `它自己换过的路线：${SKILL_CN[k.dossier.alt] || k.dossier.alt}（已试 ${k.dossier.attempts || 0} 次）` : '',
    longTerm: (k.dossier && k.dossier.dominant && k.dossier.dominant.length)
      ? `长期卡点（${MS_CN[k.stage] || k.stage || '?'}，跨度 ${k.dossier.spanMin || '?'} 分钟，位置 ${k.dossier.position || '?'}）：`
        + k.dossier.dominant.slice(0, 2).map(d => cn(d)).join('；')
      : '',
    missing: short,
    next: nextStep(cur, dim, inv, short, live.food, doneSet, live.worn),
    recent: act,
    moveIdleMin: mv.min,
  };
}

module.exports = { summarize, cn, MS_CN, DIM_CN, SKILL_CN };
