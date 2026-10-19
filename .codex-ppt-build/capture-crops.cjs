const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const root='E:/Github/AI_vtuber';
const specs=[
 ['output/minecraft-demo/integrated-live-final.jpg','live-focus.png',{x:20,y:135,width:1510,height:650}],
 ['output/minecraft-demo/audio-routing-panel.jpg','voice-focus.png',{x:20,y:160,width:1510,height:650}],
 ['output/minecraft-demo/qwen-goal-review.jpg','game-focus.png',{x:20,y:140,width:1510,height:650}],
 ['.codex-ppt-build/studio-brain.png','brain-focus.png',{x:100,y:190,width:710,height:520}],
 ['.codex-ppt-build/studio-live.png','director-focus.png',{x:100,y:115,width:1400,height:555}],
];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:1700,height:1200},deviceScaleFactor:1});
 for(const [src,dst,clip] of specs){
  const data=fs.readFileSync(path.join(root,src)).toString('base64');
  const kind=src.endsWith('.png')?'png':'jpeg';
  await page.setContent(`<style>html,body{margin:0;padding:0;background:white}img{display:block;max-width:none}</style><img src="data:image/${kind};base64,${data}">`);
  await page.locator('img').evaluate(img=>img.decode());
  await page.screenshot({path:path.join(root,'.codex-ppt-build',dst),clip});
 }
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
