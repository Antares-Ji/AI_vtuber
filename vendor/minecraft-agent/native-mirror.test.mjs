import {test} from 'node:test';
import assert from 'node:assert/strict';
import mc from 'minecraft-protocol';
test('native view rotation, paddle and digging packets serialize in Minecraft 1.16.5',()=>{
 const serializer=mc.createSerializer({state:'play',isServer:true,version:'1.16.5'});let count=0;serializer.on('error',e=>{throw e;});serializer.on('data',()=>count++);
 for(let degrees=0;degrees<=360;degrees+=45)serializer.write({name:'entity_teleport',params:{entityId:1,x:0,y:63,z:0,yaw:(Math.round(degrees*256/360)<<24)>>24,pitch:0,onGround:false}});
 serializer.write({name:'entity_metadata',params:{entityId:1,metadata:[{key:11,type:7,value:true},{key:12,type:7,value:false}]}});
 serializer.write({name:'block_break_animation',params:{entityId:1,location:{x:0,y:63,z:0},destroyStage:-1}});assert.equal(count,11);
});
