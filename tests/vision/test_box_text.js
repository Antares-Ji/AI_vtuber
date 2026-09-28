const assert=require('node:assert/strict');
const {labelBoxes}=require('../../src/vision/box-text');
const ocr={width:1000,lines:[{words:[{text:'音 乐 音 量',x:200,y:100,width:120,height:30}]},{words:[{text:'开 启',x:610,y:100,width:70,height:30}]}]};
const result=labelBoxes([{id:1,x:600,y:95,w:150,h:45},{id:2,x:10,y:300,w:80,h:30}],ocr);
assert.equal(result[0].ocrText,'开启');assert.equal(result[0].suggestedLabel,'音乐音量 · 开启');assert.match(result[1].suggestedLabel,/未识别文字/);
assert.equal(labelBoxes([{id:3,x:600,y:300,w:150,h:40}],ocr)[0].contextText,'');
console.log('Box OCR assignment: text inside box, aligned context, Chinese spacing and missing text passed.');
