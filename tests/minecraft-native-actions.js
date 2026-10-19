'use strict';
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {execute,operations}=require('../src/minecraft/native-actions');
const {validateAction}=require('../src/minecraft/survival-skills');
async function main(){
  const bot=new EventEmitter(),controller=new AbortController();
  const calls=[];
  Object.assign(bot,{game:{gameMode:'survival'},inventory:{slots:Array(46).fill(null)},chat:s=>calls.push(['chat',s]),whisper:(...a)=>calls.push(['whisper',...a]),acceptResourcePack:()=>calls.push(['accept']),denyResourcePack:()=>calls.push(['decline']),setSettings:s=>{bot.settings=s},clickWindow:async(...a)=>calls.push(['click',...a]),moveSlotItem:async(...a)=>calls.push(['move',...a]),putAway:async(...a)=>calls.push(['putAway',...a]),putSelectedItemRange:async(...a)=>calls.push(['selected',...a]),creative:{clearSlot:async s=>calls.push(['clear',s])},respawn:()=>calls.push(['respawn'])});
  const ctx={bot,signal:controller.signal,step:async(n,fn)=>fn()};
  const run=async a=>{ctx.action=validateAction(a);return execute(ctx)};
  await run({action:'chat_message',text:'hello'});assert.deepEqual(calls.pop(),['chat','hello']);
  await assert.rejects(()=>run({action:'chat_message',text:'/give me dirt'}),/not server commands/);
  await assert.rejects(()=>run({action:'whisper_message',username:'a b',text:'hello'}),/player name/);
  await run({action:'resource_pack_response',response:'decline'});assert.deepEqual(calls.pop(),['decline']);
  await run({action:'client_settings',locale:'zh_CN',viewDistance:12,chat:'enabled',mainHand:'right',colorsEnabled:true,enableTextFiltering:false,enableServerListing:true,particleStatus:'all',skinPartsMask:65});
  assert(bot.settings.skinParts.showCape&&bot.settings.skinParts.showHat);assert.equal(bot.settings.skinParts.showJacket,false);
  const windowAction={action:'window_transaction',target:'inventory',x:0,y:0,z:0,entityId:0,operationsJson:JSON.stringify([{op:'click',slot:9,button:1,mode:0},{op:'move',from:9,to:10}])};
  assert.equal((await run(windowAction)).operationsCompleted,2);assert.deepEqual(calls.slice(-2),[['click',9,1,0],['move',9,10]]);
  for(const op of [{op:'click',slot:99,button:0,mode:0},{op:'click',slot:0,button:9,mode:0},{op:'eval',code:'anything'},{op:'put_selected',start:10,end:9}])assert.throws(()=>operations(JSON.stringify([op]),bot.inventory));
  await assert.rejects(()=>run({action:'creative_clear_slot',slot:9}),/already place/);
  bot.game.gameMode='creative';await run({action:'creative_clear_slot',slot:9});assert.deepEqual(calls.pop(),['clear',9]);
  await run({action:'respawn'});assert.deepEqual(calls.pop(),['respawn']);
  const waiting=run({action:'wait_message',contains:'hello',timeoutMs:1000});bot.emit('messagestr','hello world');assert.equal((await waiting).message,'hello world');assert.equal(bot.listenerCount('messagestr'),0);
  const cancelled=run({action:'wait_message',contains:'x',timeoutMs:30000});controller.abort();await assert.rejects(()=>cancelled,/cancelled/);assert.equal(bot.listenerCount('messagestr'),0);
  console.log('Native actions passed: chat, resource response, settings, window transaction and validation, creative-mode condition, respawn, message matching/cancellation cleanup.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
