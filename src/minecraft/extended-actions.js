'use strict';
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const nativeActions = require('./native-actions');
const str = { type: 'string', minLength: 1, maxLength: 128 };
const int = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const coords = { x: int(-30000000, 30000000), y: int(-2048, 2048), z: int(-30000000, 30000000) };
const variant = (action, fields = {}) => ({ type: 'object', additionalProperties: false, required: ['action', ...Object.keys(fields)], properties: { action: { const: action }, ...fields } });
const schemas = [
  ...nativeActions.schemas,
  variant('look_at', coords),
  variant('move_controls', { control: { enum: ['forward','back','left','right','jump','sprint','sneak'] }, durationMs:int(1,10000) }),
  variant('move_vehicle', { left:int(-1,1), forward:int(-1,1), durationMs:int(1,10000) }),
  variant('elytra_fly'), variant('swing_arm'),
  variant('unequip_item', { destination:{enum:['hand','off-hand','head','torso','legs','feet']} }),
  variant('select_hotbar', { slot:int(0,8) }),
  variant('toss_item', { item:str, count:int(1,2304) }),
  variant('use_on_entity', { entityId:int(0,2147483647), item:str }),
  variant('place_entity', { ...coords,item:str,face:{enum:['up','down','north','south','east','west']} }),
  variant('write_sign', { ...coords,text:{type:'string',maxLength:183},side:{enum:['front','back']} }),
  variant('write_book', { slot:int(9,44),pagesJson:{type:'string',minLength:2,maxLength:1600} }),
  variant('sign_book', { slot:int(9,44),pagesJson:{type:'string',minLength:2,maxLength:1600},author:str,title:{type:'string',minLength:1,maxLength:32} }),
  variant('find_blocks', { name:str,radius:int(1,128),count:int(1,64) }),
  variant('inspect_block',coords), variant('inspect_inventory'), variant('inspect_entities'),
  variant('inspect_recipes',{item:str}),
  variant('furnace_inspect',coords), variant('furnace_take',{...coords,slot:{enum:['input','fuel','output']}}),
  variant('window_click',{...coords,slot:int(0,255),button:int(0,1),mode:{enum:[0,1]}}),
  variant('wait_ticks',{ticks:int(1,1200)}),
  variant('navigate', coords), variant('dig_block', coords), variant('place_block', { ...coords, item: str }),
  variant('attack_entity', { entityId: int(0, 2147483647) }),
  variant('sleep', coords), variant('wake'),
  variant('container_inspect', coords),
  variant('container_transfer', { ...coords, direction: { enum: ['deposit', 'withdraw'] }, item: str, count: int(1, 2304) }),
  variant('inventory_move', { fromSlot: int(9, 44), toSlot: int(9, 44) }),
  variant('equip_item', { item: str, destination: { enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] } }),
  variant('use_item', { item: str, durationMs: int(0, 10000) }),
  variant('activate_block', coords), variant('activate_entity', { entityId: int(0, 2147483647) }),
  variant('fish'), variant('mount', { entityId: int(0, 2147483647) }), variant('dismount'),
  variant('trade_inspect', { entityId: int(0, 2147483647) }),
  variant('trade', { entityId: int(0, 2147483647), index: int(0, 255), count: int(1, 64) }),
  variant('enchant', { ...coords, item: str, choice: int(0, 2) }),
  variant('anvil', { ...coords, item: str, secondItem: { type: 'string', maxLength: 128 }, name: { type: 'string', maxLength: 35 } }),
  variant('smelt_item', { ...coords, item: str, fuel: str, count: int(1, 64), fuelCount: int(1, 64) }),
  variant('consume_item', { item: str })
];
const names = new Set(schemas.map(s => s.properties.action.const));
const compact = item => item ? { name: item.name, count: item.count, slot: item.slot } : null;
async function execute(ctx) {
  const { bot, action: a } = ctx;
  if (nativeActions.names.has(a.action)) return nativeActions.execute(ctx);
  const item = name => { const i = bot.inventory.items().find(i => i.name === name); if (!i) throw new Error(`Missing inventory item ${name}`); return i; };
  const entity = () => { const e = bot.entities[a.entityId]; if (!e?.position || e === bot.entity) throw new Error('Target entity is unavailable'); return e; };
  const point = () => new Vec3(a.x, a.y, a.z);
  const near = async p => { const g = new goals.GoalNear(p.x, p.y, p.z, 2); await ctx.goto(g, 60000); if (!g.isEnd(bot.entity.position.floored())) throw new Error('Navigation did not reach target'); };
  const block = async () => { await near(point()); const b = bot.blockAt(point()); if (!b) throw new Error('Target block is not loaded'); return b; };
  const equip = async name => ctx.step('equip', () => bot.equip(item(name), 'hand'));
  const windowAction = async (open, work) => { const w = await ctx.step('open_window', open); try { return await work(w); } finally { w.close(); } };
  switch (a.action) {
    case 'look_at': await ctx.step('look',()=>bot.lookAt(point(),true)); return { verified:false,lookCompleted:true };
    case 'move_controls': {
      const start=bot.entity.position.clone(); bot.setControlState(a.control,true);
      try { await ctx.sleep(a.durationMs); } finally { bot.clearControlStates(); }
      return { verified:false,control:a.control,distance:bot.entity.position.distanceTo(start) };
    }
    case 'move_vehicle': {
      if(!bot.vehicle)throw new Error('Not mounted');
      const end=Date.now()+a.durationMs;
      try { while(Date.now()<end){ctx.check();bot.moveVehicle(a.left,a.forward);await ctx.sleep(50);} }
      finally { bot.moveVehicle(0,0); }
      return { verified:false,steeringCompleted:true };
    }
    case 'elytra_fly': await ctx.step('elytra',()=>bot.elytraFly()); return { verified:false,flightRequested:true };
    case 'swing_arm': bot.swingArm(); return { verified:false,swingSent:true };
    case 'unequip_item': await ctx.step('unequip',()=>bot.unequip(a.destination)); return { verified:false,operationCompleted:true };
    case 'select_hotbar': bot.setQuickBarSlot(a.slot); return { selectedSlot:bot.quickBarSlot };
    case 'toss_item': { const i=item(a.item),total=()=>bot.inventory.items().filter(x=>x.name===a.item).reduce((n,x)=>n+x.count,0),before=total();await ctx.step('toss',()=>bot.toss(i.type,i.metadata,a.count));await ctx.until('toss_inventory_delta',()=>total()===before-a.count);return { tossed:a.count,item:a.item }; }
    case 'use_on_entity': { const e=entity();await near(e.position);await equip(a.item);await ctx.step('use_on',()=>bot.useOn(e));return { verified:false,interactionSent:true }; }
    case 'place_entity': { const b=await block();await equip(a.item);const face={up:[0,1,0],down:[0,-1,0],north:[0,0,-1],south:[0,0,1],east:[1,0,0],west:[-1,0,0]}[a.face];const e=await ctx.step('place_entity',()=>bot.placeEntity(b,new Vec3(...face)));return { verified:!!e?.id,entityId:e?.id }; }
    case 'write_sign': { const b=await block();if(!/sign/.test(b.name))throw new Error('Not a sign');if(a.text.split('\n').length>4||a.text.split('\n').some(l=>l.length>45))throw new Error('Sign supports four lines of at most 45 characters');bot.updateSign(b,a.text,a.side==='back');return { verified:false,signUpdateSent:true }; }
    case 'write_book': case 'sign_book': { const pages=JSON.parse(a.pagesJson);if(!Array.isArray(pages)||!pages.length||pages.length>100||pages.some(p=>typeof p!=='string'))throw new Error('pagesJson must contain text pages');if(bot.inventory.slots[a.slot]?.name!=='writable_book')throw new Error('Slot must contain a writable book');await ctx.step('book',()=>a.action==='write_book'?bot.writeBook(a.slot,pages):bot.signBook(a.slot,pages,a.author,a.title));return { verified:false,bookOperationCompleted:true }; }
    case 'find_blocks': { const id=bot.registry.blocksByName[a.name]?.id;if(id===undefined)throw new Error('Unknown block');return { blocks:bot.findBlocks({matching:id,maxDistance:a.radius,count:a.count}).map(p=>({x:p.x,y:p.y,z:p.z})) }; }
    case 'inspect_block': { const b=bot.blockAt(point());return { block:b?{name:b.name,position:b.position,diggable:b.diggable,visible:bot.canSeeBlock(b),canDig:bot.canDigBlock(b)}:null }; }
    case 'inspect_inventory': return { slots:bot.inventory.slots.map(compact) };
    case 'inspect_entities': return { entities:Object.values(bot.entities).filter(e=>e.position).map(e=>({id:e.id,name:e.name,type:e.type,position:e.position})).slice(0,256) };
    case 'inspect_recipes': { const id=bot.registry.itemsByName[a.item]?.id;if(id===undefined)throw new Error('Unknown item');return { recipes:bot.recipesAll(id,null,true),craftable:bot.recipesFor(id,null,1,true) }; }
    case 'furnace_inspect': case 'furnace_take': { const b=await block();return windowAction(()=>bot.openFurnace(b),async w=>{if(a.action==='furnace_inspect')return {input:compact(w.inputItem()),fuel:compact(w.fuelItem()),output:compact(w.outputItem())};const result=await ctx.step('take_furnace',()=>w[{input:'takeInput',fuel:'takeFuel',output:'takeOutput'}[a.slot]]());return {verified:false,operationCompleted:true,item:compact(result)};}); }
    case 'window_click': { const b=await block();return windowAction(()=>bot.openBlock(b),async w=>{if(a.slot>=w.slots.length)throw new Error('Slot outside this window');await ctx.step('click',()=>bot.clickWindow(a.slot,a.button,a.mode));return {verified:false,operationCompleted:true,slots:w.slots.map(compact)};}); }
    case 'wait_ticks': await ctx.step('ticks',()=>bot.waitForTicks(a.ticks),Math.max(5000,a.ticks*100));return {ticks:a.ticks};
    case 'navigate': { const g = new goals.GoalBlock(a.x, a.y, a.z); await ctx.goto(g, 120000); if (!g.isEnd(bot.entity.position.floored())) throw new Error('Original navigation goal not reached'); return { arrived: true }; }
    case 'dig_block': { const b = await block(); const tool = bot.pathfinder.bestHarvestTool(b); if (tool) await ctx.step('equip_tool', () => bot.equip(tool, 'hand')); await ctx.step('dig', () => bot.dig(b), 60000); await ctx.until('block_changed', () => bot.blockAt(point())?.type !== b.type); return { removed: b.name }; }
    case 'place_block': {
      await near(point()); const held = item(a.item), before = bot.inventory.items().filter(i=>i.name===a.item).reduce((n,i)=>n+i.count,0);
      await equip(a.item);
      const offsets = [new Vec3(0,-1,0),new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1),new Vec3(0,1,0)];
      const offset = offsets.find(d => bot.blockAt(point().plus(d))?.boundingBox === 'block');
      if (!offset) throw new Error('No placement reference block');
      await ctx.step('place', () => bot.placeBlock(bot.blockAt(point().plus(offset)), offset.scaled(-1)));
      await ctx.until('placement', () => bot.blockAt(point())?.name === held.name && bot.inventory.items().filter(i=>i.name===a.item).reduce((n,i)=>n+i.count,0)<before);
      return { placed: a.item };
    }
    case 'attack_entity': {
      const target = entity(); let killed = false, hits = 0;
      const onDead = e => { if (e.id === target.id) killed = true; }; bot.on('entityDead', onDead);
      try {
        const weapon = bot.inventory.items().find(i=>/_sword$/.test(i.name)) || bot.inventory.items().find(i=>/_axe$/.test(i.name));
        if (weapon) await equip(weapon.name);
        for (let n=0; n<80 && !killed; n++) {
          ctx.check(); if (!bot.entities[target.id]) break;
          if (bot.entity.position.distanceTo(target.position)>2.8) await ctx.goto(new goals.GoalFollow(target,2),15000);
          if (bot.entity.position.distanceTo(target.position)>3) continue;
          const eye=bot.entity.position.offset(0,bot.entity.height||1.62,0), aim=target.position.offset(0,Math.min(target.height||1,1.4),0), ray=aim.minus(eye);
          if (ray.norm() && bot.world.raycast(eye,ray.unit(),ray.norm())) throw new Error('Attack target obstructed');
          await ctx.step('aim',()=>bot.lookAt(aim,true)); bot.attack(target); hits++; await ctx.sleep(700);
        }
        return { verified: killed, completed: killed, killVerified: killed, attacksSent: hits, entityId: target.id };
      } finally { bot.removeListener('entityDead',onDead); }
    }
    case 'sleep': { const b=await block(); await ctx.step('sleep',()=>bot.sleep(b)); await ctx.until('sleeping',()=>bot.isSleeping); return { sleeping:true }; }
    case 'wake': await ctx.step('wake',()=>bot.wake()); await ctx.until('awake',()=>!bot.isSleeping); return { sleeping:false };
    case 'container_inspect': case 'container_transfer': {
      const b=await block(); return windowAction(()=>bot.openContainer(b),async w=>{
        if(a.action==='container_inspect') return { contents:w.containerItems().map(compact) };
        const id=bot.registry.itemsByName[a.item]?.id; if(id===undefined) throw new Error('Unknown item');
        const total=()=>bot.inventory.items().filter(i=>i.name===a.item).reduce((n,i)=>n+i.count,0), before=total();
        await ctx.step(a.direction,()=>w[a.direction](id,null,a.count));
        await ctx.until('container_transfer',()=>total()-before===(a.direction==='withdraw'?a.count:-a.count));
        return { direction:a.direction,item:a.item,transferred:a.count };
      });
    }
    case 'inventory_move': await ctx.step('move_inventory',()=>bot.moveSlotItem(a.fromSlot,a.toSlot)); return { verified:false, operationCompleted:true, slots:[a.fromSlot,a.toSlot].map(slot=>compact(bot.inventory.slots[slot])) };
    case 'equip_item': { const i=item(a.item); await ctx.step('equip',()=>bot.equip(i,a.destination)); const slot={head:5,torso:6,legs:7,feet:8,'off-hand':45}[a.destination]; await ctx.until('equipped',()=> (a.destination==='hand'?bot.heldItem:bot.inventory.slots[slot])?.name===a.item); return { equipped:a.item,destination:a.destination }; }
    case 'consume_item': { const before=bot.food; await equip(a.item); await ctx.step('consume',()=>bot.consume()); return { consumed:a.item,foodBefore:before,foodAfter:bot.food }; }
    case 'use_item': await equip(a.item); bot.activateItem(); try { await ctx.sleep(a.durationMs); } finally { bot.deactivateItem(); } return { verified:false, activationSent:true };
    case 'activate_block': { const b=await block(); await ctx.step('activate',()=>bot.activateBlock(b)); return { verified:false, activationSent:true }; }
    case 'activate_entity': { const e=entity(); await near(e.position); await ctx.step('activate',()=>bot.activateEntity(e)); return { verified:false, activationSent:true }; }
    case 'fish': { await equip('fishing_rod'); const retract=()=>bot.activateItem(); ctx.signal?.addEventListener('abort',retract,{once:true}); try { await ctx.step('fish',()=>bot.fish(),120000); return { verified:false, fishingCycleCompleted:true }; } finally { ctx.signal?.removeEventListener('abort',retract); } }
    case 'mount': { const e=entity(); await near(e.position); bot.mount(e); await ctx.until('mounted',()=>bot.vehicle?.id===e.id); return { mounted:e.id }; }
    case 'dismount': bot.dismount(); await ctx.until('dismounted',()=>!bot.vehicle); return { dismounted:true };
    case 'trade_inspect': case 'trade': { const e=entity(); await near(e.position); return windowAction(()=>bot.openVillager(e),async w=>{
      if(a.action==='trade_inspect') return { trades:w.trades.map((t,index)=>({ index,input:compact(t.inputItem1),second:compact(t.inputItem2),output:compact(t.outputItem),disabled:t.tradeDisabled })) };
      if(!w.trades[a.index]) throw new Error('Trade index unavailable'); await ctx.step('trade',()=>bot.trade(w,a.index,a.count),60000); return { verified:false,operationCompleted:true,index:a.index,count:a.count };
    }); }
    case 'enchant': { const b=await block(); return windowAction(()=>bot.openEnchantmentTable(b),async w=>{
      await ctx.step('put_target',()=>w.putTargetItem(item(a.item))); await ctx.step('put_lapis',()=>w.putLapis(item('lapis_lazuli')));
      const result=await ctx.step('enchant',()=>w.enchant(a.choice)); await ctx.step('take_enchanted',()=>w.takeTargetItem()); return { enchanted:compact(result) };
    }); }
    case 'anvil': { const b=await block(); return windowAction(()=>bot.openAnvil(b),async w=>{ await ctx.step('anvil',()=>a.secondItem?w.combine(item(a.item),item(a.secondItem),a.name):w.rename(item(a.item),a.name),60000); return { verified:false,operationCompleted:true }; }); }
    case 'smelt_item': { const b=await block(); return windowAction(()=>bot.openFurnace(b),async w=>{
      if(w.inputItem()||w.outputItem()) throw new Error('Furnace occupied; inspect or retrieve contents first');
      const input=item(a.item),fuel=item(a.fuel); await ctx.step('input',()=>w.putInput(input.type,input.metadata,a.count)); await ctx.step('fuel',()=>w.putFuel(fuel.type,fuel.metadata,a.fuelCount));
      let received=0; const outputs=[]; const deadline=Date.now()+Math.min(210000,a.count*12000+10000);
      while(received<a.count){ctx.check();if(Date.now()>deadline)throw new Error('Smelting timed out; items remain in furnace');const out=w.outputItem();if(out){outputs.push(compact(out));received+=out.count;await ctx.step('take_output',()=>w.takeOutput());}else await ctx.sleep(500);}
      return { received,outputs };
    }); }
    default: throw new Error('Unknown extended action');
  }
}
module.exports={schemas,names,execute};
