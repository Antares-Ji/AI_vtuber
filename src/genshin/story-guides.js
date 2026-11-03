'use strict';
// External walkthroughs are planning references, never current game state.
const guides={
 '两次视线的交汇':{
  source:'https://wiki.biligame.com/ys/两次视线的交汇',checkedAt:'2026-11-03',kind:'external_walkthrough_not_live_evidence',
  notes:'返回旗舰休息需要先进入旗舰，再依据当前提示选择休息。已接入BGI脚本仓库的旗舰入口路线，只保留路径和传送坐标，不执行原脚本购物或盲按F。入口到达不等于休息完成。之后为淘汰赛抽签、参赛、观看比赛、休息和调查等剧情阶段；必须每步依据当前BGI OCR，不能把攻略当当前状态。'
 },
 '紧急修理':{
  source:'https://wiki.biligame.com/ys/紧急修理',
  checkedAt:'2026-11-02',kind:'external_walkthrough_not_live_evidence',
  notes:'收集木材阶段需要任务物品「结实的木板」，不是家园砍树木材。树林内调查/拾取点需以当前BGI唯一F提示确认并交互，不能把「调查」「木板」当作无关目标离开。取得后以HUD是否变成「将结实的木板交给法拉」核验，随后交付、战斗和对话；若要求绳索则按新HUD继续。攻略不提供当前坐标或完成证据。'
 },
 '神秘岛的传说':{
  source:'https://genshin-impact.fandom.com/wiki/The_Legend_of_the_Mysterious_Island',
  checkedAt:'2026-11-01',
  kind:'external_walkthrough_not_live_evidence',
  notes:'该任务的诱骗子环节需要接近标记区域内的触发位置，随后出现派蒙对话。进入搜索范围不代表已触发对话；没有精确距离时应依据当前地形在区域内探索，不要反复等待距离出现。后续包括跟随导游、靠近阿塔合影、依提示前进及抵达目的地。所有阶段均须用当前截图/OCR确认，攻略不能作为任务已完成或NPC已出现的证据。'
 }
};
module.exports={questGuide:quest=>guides[quest]||null};
