'use strict';
const g=require('../../scripts/genshin/story-main');
// No model inference, guessed terrain, or reused screenshot. CV and OCR must be
// carried by the exact native request that supplied the archived frame.
function observe(request){
 const texts=request.texts||[],cv=request.nativeVision;
 const cue=g.sceneCue(texts);
 const native=cv?.source==='bettergi_native_cv' ? cv : null;
 let scene=cue||({Main:'world',Talk:'dialogue',BigMap:'map'}[native?.ui])||(native?.closable?'menu':'unknown');
 const instruction=g.questInstruction(texts);
 // Combat requires the current commission combat stage plus an independent
 // in-world enemy level label, not merely a remembered objective.
 if(scene==='world'&&/消灭.*魔物/.test(instruction?.text||'')&&texts.some(t=>/Lv\.?\s*\d+/i.test(t.text)&&t.box?.[0]>300&&t.box[0]<1600&&t.box[1]>150&&t.box[1]<750))scene='combat';
 return {scene,uncertain:scene==='unknown',summary:instruction?.text||'BGI CV/OCR场景：'+scene,
  visible_text:texts.slice(0,12).map(t=>t.text),visionSource:'bettergi_native_cv_ocr',
  navigation:{marker:g.questDistanceLabel(texts)?.direction||'not_visible',terrain:'unknown',
   movement:native?.motion==='Climb'?'climbing':'unknown',evidence:'BGI原生界面模板和OCR；未推断地形是否开阔'},
  nativeVision:native};
}
module.exports={observe};
