'use strict';
const { Vec3 } = require('vec3');
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const text = (maxLength = 256) => ({ type: 'string', minLength: 1, maxLength });
const choice = (...values) => ({ enum: values });
const xyz = { x: integer(-30000000, 30000000), y: integer(-2048, 2048), z: integer(-30000000, 30000000) };
const schema = (action, fields = {}) => ({ type: 'object', additionalProperties: false, required: ['action', ...Object.keys(fields)], properties: { action: { const: action }, ...fields } });
const schemas = [
  schema('chat_message', { text: text() }),
  schema('whisper_message', { username: text(16), text: text() }),
  schema('chat_complete', { text: text() }),
  schema('wait_message', { contains: text(), timeoutMs: integer(1, 30000) }),
  schema('resource_pack_response', { response: choice('accept', 'decline') }),
  schema('client_settings', { locale: text(16), viewDistance: integer(2, 32), chat: choice('enabled', 'commandsOnly', 'disabled'), mainHand: choice('left', 'right'), colorsEnabled: choice(true, false), enableTextFiltering: choice(true, false), enableServerListing: choice(true, false), particleStatus: choice('all', 'decreased', 'minimal'), skinPartsMask: integer(0, 127) }),
  schema('activate_entity_at', { entityId: integer(0, 2147483647), ...xyz }),
  // A whole transaction keeps one window open; individual queued actions close their windows.
  schema('window_transaction', { target: choice('inventory', 'block', 'entity'), ...xyz, entityId: integer(0, 2147483647), operationsJson: text(1600) }),
  schema('respawn'),
  schema('creative_set_slot', { slot: integer(0, 44), item: text(128), count: integer(1, 64) }),
  schema('creative_clear_slot', { slot: integer(0, 44) }),
  schema('creative_clear_inventory'), schema('creative_start_flying'), schema('creative_stop_flying'),
  schema('creative_fly_to', xyz)
];
const names = new Set(schemas.map(s => s.properties.action.const));
const compact = i => i ? { name: i.name, count: i.count, slot: i.slot } : null;
function operations(json, window) {
  const ops = JSON.parse(json);
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > 32) throw Error('Expected 1..32 window operations');
  const slot = (n, end = false) => Number.isInteger(n) && n >= 0 && n < window.slots.length + Number(end);
  for (const op of ops) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) throw Error('Invalid window operation');
    const fields = { click: ['op','slot','button','mode'], move: ['op','from','to'], put_away: ['op','slot'], put_selected: ['op','start','end'], transfer: ['op','item','count','sourceStart','sourceEnd','destStart','destEnd'] }[op.op];
    if (!fields || Object.keys(op).some(k => !fields.includes(k)) || fields.some(k => !(k in op))) throw Error('Invalid window operation fields');
    if (op.op === 'click') {
      const buttons = { 0:[0,1], 1:[0,1], 2:[0,1,2,3,4,5,6,7,8,40], 3:[2], 4:[0,1], 5:[0,1,2,4,5,6,8,9,10], 6:[0] };
      if (!(slot(op.slot) || op.slot === -999) || !buttons[op.mode]?.includes(op.button)) throw Error('Invalid click slot/button/mode');
    } else if (op.op === 'move') { if (!slot(op.from) || !slot(op.to)) throw Error('Invalid move slots'); }
    else if (op.op === 'put_away') { if (!slot(op.slot)) throw Error('Invalid source slot'); }
    else {
      const ranges = op.op === 'transfer' ? [[op.sourceStart,op.sourceEnd],[op.destStart,op.destEnd]] : [[op.start,op.end]];
      if (ranges.some(([a,b]) => !slot(a) || !slot(b,true) || a >= b)) throw Error('Invalid slot range');
      if (op.op === 'transfer' && (typeof op.item !== 'string' || !Number.isInteger(op.count) || op.count < 1 || op.count > 2304)) throw Error('Invalid transfer item/count');
    }
  }
  return ops;
}
async function execute(ctx) {
  const { bot, action: a } = ctx;
  const sent = { verified: false, requestSent: true };
  if (a.action.startsWith('creative_') && bot.game?.gameMode !== 'creative') throw Error('Creative API requires the server to already place this bot in creative mode');
  switch (a.action) {
    case 'chat_message': if (/^\s*\//.test(a.text)) throw Error('chat_message is chat text, not server commands'); bot.chat(a.text); return sent;
    case 'whisper_message': if (!/^[A-Za-z0-9_]{1,16}$/.test(a.username)) throw Error('Invalid player name'); bot.whisper(a.username,a.text); return sent;
    case 'chat_complete': return { matches: await ctx.step('tab_complete', () => bot.tabComplete(a.text,false,true,5000)) };
    case 'wait_message': {
      let handler, timer, aborted;
      try {
        return await ctx.step('wait_message', () => new Promise((resolve,reject) => {
          handler = message => { if (String(message).includes(a.contains)) resolve({ message: String(message).slice(0,1024) }); };
          aborted = () => reject(Error('Message wait cancelled'));
          bot.on('messagestr',handler); ctx.signal?.addEventListener('abort',aborted,{once:true});
          timer = setTimeout(() => resolve({ timedOut:true }),a.timeoutMs);
        }),a.timeoutMs+1000);
      } finally { clearTimeout(timer); if(handler)bot.removeListener('messagestr',handler); if(aborted)ctx.signal?.removeEventListener('abort',aborted); }
    }
    case 'resource_pack_response': bot[a.response === 'accept' ? 'acceptResourcePack' : 'denyResourcePack'](); return { ...sent, response:a.response, texturesDownloaded:false };
    case 'client_settings': {
      const skinParts = Object.fromEntries(['showCape','showJacket','showLeftSleeve','showRightSleeve','showLeftPants','showRightPants','showHat'].map((key,i)=>[key,Boolean(a.skinPartsMask & (1<<i))]));
      const { action, skinPartsMask, ...settings } = a;
      bot.setSettings({...settings,skinParts}); return {...sent,settings:bot.settings};
    }
    case 'activate_entity_at': {
      const e=bot.entities[a.entityId]; if(!e?.position)throw Error('Entity not loaded');
      const {GoalNear}=require('mineflayer-pathfinder').goals;
      await ctx.goto(new GoalNear(e.position.x,e.position.y,e.position.z,2),60000);
      await ctx.step('activate_entity_at',()=>bot.activateEntityAt(e,new Vec3(a.x,a.y,a.z))); return sent;
    }
    case 'window_transaction': {
      let w;
      try {
        if(a.target==='inventory')w=bot.inventory;
        else {
          const {GoalNear}=require('mineflayer-pathfinder').goals;
          const target=a.target==='block'?bot.blockAt(new Vec3(a.x,a.y,a.z)):bot.entities[a.entityId];
          if(!target?.position)throw Error('Window target not loaded');
          await ctx.goto(new GoalNear(target.position.x,target.position.y,target.position.z,2),60000);
          w=await ctx.step('open_window',()=>a.target==='block'?bot.openBlock(target):bot.openEntity(target));
        }
        const ops=operations(a.operationsJson,w);
        for(const op of ops) {
          await ctx.step('window_'+op.op,()=>{
            switch(op.op) {
              case 'click': return bot.clickWindow(op.slot,op.button,op.mode);
              case 'move': return bot.moveSlotItem(op.from,op.to);
              case 'put_away': return bot.putAway(op.slot);
              case 'put_selected': return bot.putSelectedItemRange(op.start,op.end,w);
              case 'transfer': {
                const type=bot.registry.itemsByName[op.item]?.id; if(type===undefined)throw Error('Unknown item');
                return bot.transfer({window:w,itemType:type,count:op.count,sourceStart:op.sourceStart,sourceEnd:op.sourceEnd,destStart:op.destStart,destEnd:op.destEnd});
              }
            }
          });
        }
        return {verified:false,operationsCompleted:ops.length,slots:w.slots.map(compact),cursor:compact(w.selectedItem)};
      } finally { if(w && w!==bot.inventory)bot.closeWindow(w); }
    }
    case 'respawn': bot.respawn(); return sent;
    case 'creative_set_slot': {
      const entry=bot.registry.itemsByName[a.item];if(!entry)throw Error('Unknown item');
      const Item=require('prismarine-item')(bot.registry);
      await ctx.step('creative_slot',()=>bot.creative.setInventorySlot(a.slot,new Item(entry.id,a.count)));return {...sent,slot:compact(bot.inventory.slots[a.slot])};
    }
    case 'creative_clear_slot': await ctx.step('creative_clear',()=>bot.creative.clearSlot(a.slot));return sent;
    case 'creative_clear_inventory': await ctx.step('creative_clear',()=>bot.creative.clearInventory());return sent;
    case 'creative_start_flying': bot.creative.startFlying();return sent;
    case 'creative_stop_flying': bot.creative.stopFlying();return sent;
    case 'creative_fly_to': {
      // Native flyTo has no cancellation hook. Bound each native segment so STOP drains promptly.
      const target=new Vec3(a.x,a.y,a.z);
      try {
        while(bot.entity.position.distanceTo(target)>0.05) {
          ctx.check();const delta=target.minus(bot.entity.position),distance=delta.norm();
          const next=distance>0.5?bot.entity.position.plus(delta.scaled(0.5/distance)):target;
          await ctx.step('creative_fly_segment',()=>bot.creative.flyTo(next),5000);
        }
        return {verified:false,position:bot.entity.position};
      } finally {bot.creative.stopFlying();}
    }
    default: throw Error('Unknown native action');
  }
}
module.exports={schemas,names,execute,operations};
