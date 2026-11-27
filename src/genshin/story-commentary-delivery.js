'use strict';
// Each renderer owns its read cursor. Preparing a reply still happens once,
// avoiding duplicated brain/history entries when OBS and the console coexist.
class StoryCommentaryDelivery {
 constructor(){this.legacyAfter=0;this.prepared=new Map();}
 next(after,read,prepare){
  const explicit=Number.isFinite(after)&&after>=0;
  const event=read(explicit?after:this.legacyAfter);if(!event)return null;
  if(!explicit)this.legacyAfter=event.at;
  if(!this.prepared.has(event.id))this.prepared.set(event.id,prepare(event));
  while(this.prepared.size>30)this.prepared.delete(this.prepared.keys().next().value);
  return {...this.prepared.get(event.id),commentaryAt:event.at};
 }
}
module.exports={StoryCommentaryDelivery};
