'use strict';
// External walkthroughs are planning references, never current game state.
const guides={
 '两次视线的交汇':{
  source:'https://wiki.biligame.com/ys/两次视线的交汇',checkedAt:'2026-11-03',kind:'external_walkthrough_not_live_evidence',
  relatedReference:'https://wiki.biligame.com/ys/轰鸣与暗涌',
  videoReference:{url:'https://www.youtube.com/watch?v=Z3G7sMayl5U&t=335s',seconds:[335,343],interpretationProvider:'deepseek-flash',source:'external_walkthrough_frames_not_current_game',
   frames:[{file:'linnea-rest-door/335.png',sourceSecond:335,sha256:'87ce7e3868dff80f0939b99c0bd146a6d8c6222eb5a24aa554e4f3aab46ac25d'},{file:'linnea-rest-door/341.png',sourceSecond:341,sha256:'fdf8e3efeb73a53ee737d0bc5b2ba316cf253eca1bb9e275bcbb05db02d6ed59'}],
   landmarks:['335–337秒：酒馆吧台/长椅区（Paavo、Panu附近）通向带盆栽的敞开石门。','338–340秒：穿过石门进入内廊，沿地面金色轨迹经过右侧Pentti，左侧有盆栽及柜体。','341–343秒：廊道通向另一扇敞开石门；门内暖红灯光、木桌和画框，床边出现休息F提示。'],
   limits:'这是DeepSeek对攻略片段的判读，有OCR和方向误差；左右以视频视角为准，不能直接当当前朝向。片段未见升降动作，不能仅凭高处读数认定必须绕到室外找升降机。必须用当前BGI图像找到对应地标并复核唯一F。'},
  notes:'本任务攻略的关键交互是客房床边「休息」，随后HUD转为淘汰赛抽签；长椅「坐下」不是任务休息。优先参考同任务视频展示的酒馆大厅—石门内廊—客房路线。已有BGI商人路线只证明酒馆入口；另一任务酒会期间使用侧门的规则，不应覆盖本任务视频或强制绕到室外。当前地面星光与可见门廊负责实际方向，不从攻略编造当前坐标或直接执行固定按键。休息交互和后续阶段均须当前BGI OCR核验。'
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
