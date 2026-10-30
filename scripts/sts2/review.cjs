'use strict';
const K = require('../../src/sts2/knowledge');
const { jsonCompletion } = require('./learn.cjs');
const slim = c => ({ id: c.id, name: c.name, pool: c.pool, availability: c.availability,
  base: c.base, upgraded: c.upgraded });
async function main() {
  require('../../src/config/env').loadEnv();
  const data = K.read();
  if (!data) throw Error('No catalog');
  const pending = data.cards.filter(c => c.analysis && !c.analysis.review);
  const batches = Array.from({ length: Math.ceil(pending.length/16) }, (_,i) => pending.slice(i*16,i*16+16));
  let next=0;
  const worker=async()=> { while(next<batches.length) {
    const i=next++, batch=batches[i];
    const ids=new Set(batch.flatMap(c=>[c.id,...c.analysis.synergies.map(s=>s.with)]));
    const answer=await jsonCompletion('你现在做事实复核，改正待审核分析的逻辑错误，输出同样的cards结构，每个目标ID恰好一条：{"cards":[{"id":"ID","role":"修正后作用","synergies":[{"with":"ID","reason":"具体前提"}],"cautions":["限制"]}]}。特别检查：固有只保证起手抽到，不会自动打出或生效；复制攻击牌会降低非攻击牌抽到概率；消耗不是弃牌；临时费用与永久费用区分；回合/战斗和开始/结束触发点不能混淆；保留/保留格挡不等于无限积累；不同角色卡池必须说明获取前提。没有字面机制支持的协同删除，宁缺毋滥。所有输出仍只是推断。',
      { version:data.version, targets:batch.map(c=>({id:c.id,analysis:c.analysis})), facts:data.cards.filter(c=>ids.has(c.id)).map(slim) }, `review-${K.hash(batch.map(c=>c.id)).slice(0,12)}`);
    for(const a of K.validateAnalysis(answer.result,batch,data)) data.cards.find(c=>c.id===a.id).analysis={...a,model:answer.model,at:new Date().toISOString(),fingerprint:data.fingerprint,review:{status:'model_review_not_playtest',at:new Date().toISOString()}};
    data.coverage.reviewed=data.cards.filter(c=>c.analysis?.review).length;
    K.write(data);
    console.log(JSON.stringify({event:'reviewed',batch:i+1,batches:batches.length,count:data.coverage.reviewed,usage:answer.usage}));
  }};
  const completed=await Promise.allSettled([worker(),worker()]);
  const failure=completed.find(r=>r.status==='rejected'); if(failure) throw failure.reason;
  // Regenerate guide from reviewed reasoning and actual descriptions of cited cards.
  const answer=await jsonCompletion('返回{"principles":[{"topic":"主题","advice":"最多150字的条件化建议","card_ids":["支持建议的ID"]}]}，10至14条。覆盖五个角色的主要资源、选牌、升级、费用/抽牌、防御、出牌次序和反协同；不要无依据的统一阈值或虚构胜率。',
    { version:data.version,cards:data.cards.filter(c=>c.analysis).map(c=>({id:c.id,name:c.name,pool:c.pool,description:c.base.description,upgraded:c.upgraded?.description,analysis:c.analysis})) }, 'guide-reviewed', 5500);
  const ps=answer.result.principles;
  if(!Array.isArray(ps)||!ps.length||ps.some(p=>typeof p.topic!=='string'||typeof p.advice!=='string'||!Array.isArray(p.card_ids)||p.card_ids.some(id=>!data.cards.some(c=>c.id===id)))) throw Error('Invalid reviewed guide');
  data.guide={principles:ps,model:answer.model,status:'hypothesis_not_playtested',at:new Date().toISOString()};
  if(data.observations.length) {
    const vision=await jsonCompletion('检查本地视觉模型识别文本，只按OCR内容总结。返回{"observations":[{"image_sha256":"输入哈希","reading":"识别到的文本及含义","uncertainties":["不确定项"]}]}。不能看到图片，不能声称视觉核验成功。若只有地图文字就说明没有读到卡牌，禁止推测卡牌。',
      {observations:data.observations.map(o=>({sha256:o.sha256,ocr:o.parsed,matches:o.matches}))}, 'vision-interpretation', 1800);
    data.vision_interpretation={...vision.result,model:vision.model,status:'interpretation_of_local_ocr_not_visual_verification'};
  }
  K.write(data);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
