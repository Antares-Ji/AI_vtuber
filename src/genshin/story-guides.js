'use strict';
// External walkthroughs are planning references, never current game state.
const guides={
 '神秘岛的传说':{
  source:'https://genshin-impact.fandom.com/wiki/The_Legend_of_the_Mysterious_Island',
  checkedAt:'2026-11-01',
  kind:'external_walkthrough_not_live_evidence',
  notes:'该任务的诱骗子环节需要接近标记区域内的触发位置，随后出现派蒙对话。进入搜索范围不代表已触发对话；没有精确距离时应依据当前地形在区域内探索，不要反复等待距离出现。后续包括跟随导游、靠近阿塔合影、依提示前进及抵达目的地。所有阶段均须用当前截图/OCR确认，攻略不能作为任务已完成或NPC已出现的证据。'
 }
};
module.exports={questGuide:quest=>guides[quest]||null};
