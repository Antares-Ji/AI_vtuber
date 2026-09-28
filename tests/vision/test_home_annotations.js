const assert = require('node:assert/strict');
const original = require('../../public/annotations/home-boxes.json');
const reviewed = require('../../public/annotations/home-reviewed.json');
assert.equal(original.boxes.length, 30, 'original candidates must stay intact');
assert.equal(reviewed.boxes.length, 25);
assert.equal(reviewed.image, original.image);
assert.equal(new Set(reviewed.boxes.map(b => b.id)).size, 25);
for (const b of reviewed.boxes) {
  for (const k of ['id','x','y','w','h']) assert.ok(Number.isInteger(b[k]));
  assert.ok(b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0);
  assert.ok(b.x+b.w <= reviewed.width && b.y+b.h <= reviewed.height);
  assert.ok(b.label.trim());
}
for (const id of [7,10,14,15,17,19]) assert.ok(!reviewed.boxes.some(b => b.id === id));
assert.equal(reviewed.boxes.find(b => b.id === 31).label, '增加理智');
assert.deepEqual(reviewed.boxes.find(b => b.id === 30), {id:30,label:'助理角色点击区域',x:416,y:168,w:363,h:375,uncertain:false});
console.log('Reviewed home annotations passed: 25 valid regions; original baseline preserved.');
