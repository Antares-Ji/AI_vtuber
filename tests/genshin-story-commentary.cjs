const {test}=require('node:test'),assert=require('node:assert/strict');
const {StoryCommentaryDelivery}=require('../src/genshin/story-commentary-delivery');
test('OBS and console receive the same commentary without consuming each other or duplicating prepared replies',()=>{
 const events=[{id:'one',at:10,text:'第一句'},{id:'two',at:20,text:'第二句'}],delivery=new StoryCommentaryDelivery();let preparations=0;
 const read=after=>events.find(e=>e.at>after),prepare=e=>({text:e.text,replyId:++preparations});
 const consoleFirst=delivery.next(0,read,prepare),obsFirst=delivery.next(0,read,prepare);
 assert.deepEqual(obsFirst,consoleFirst);assert.equal(preparations,1);
 const consoleSecond=delivery.next(consoleFirst.commentaryAt,read,prepare);
 assert.equal(consoleSecond.text,'第二句');assert.equal(delivery.next(obsFirst.commentaryAt,read,prepare).replyId,consoleSecond.replyId);
 assert.equal(preparations,2);assert.equal(delivery.next(20,read,prepare),null);
});
test('legacy client cursor cannot steal an explicit renderer event',()=>{
 const delivery=new StoryCommentaryDelivery(),event={id:'one',at:10};let count=0;
 const read=after=>after<10?event:null,prepare=()=>({replyId:++count});
 assert.equal(delivery.next(undefined,read,prepare).commentaryAt,10);
 assert.equal(delivery.next(undefined,read,prepare),null);
 assert.equal(delivery.next(0,read,prepare).replyId,1);assert.equal(count,1);
});
