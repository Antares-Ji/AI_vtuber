import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Presentation, PresentationFile } from '@oai/artifact-tool';

const root = 'E:/Github/AI_vtuber';
const build = path.join(root, '.codex-ppt-build');
const out = path.join(root, 'output', 'presentations');
const skill = 'C:/Users/Antares.Ji/.codex/plugins/cache/openai-primary-runtime/presentations/26.1011.11113/skills/presentations';
const runtimePython = 'C:/Users/Antares.Ji/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
await fs.mkdir(build, { recursive: true });
await fs.mkdir(out, { recursive: true });

const ppt = Presentation.create({ slideSize: { width: 1280, height: 720 } });
const C = { ink:'#14161A', paper:'#F7F4EC', white:'#FFFFFF', black:'#0E1116', bronze:'#B58D52', red:'#A73E3C', gray:'#5A5D61', pale:'#DFD8C9', mint:'#73CFBF' };
const FONT = 'Noto Sans SC';
const imagePaths = [
 '.codex-ppt-build/jisui-concept.png',
 '.codex-ppt-build/studio-brain.png',
 '.codex-ppt-build/studio-live.png',
 'output/minecraft-demo/integrated-live-final.jpg',
 'output/minecraft-demo/audio-routing-panel.jpg',
 'output/minecraft-demo/qwen-goal-review.jpg',
 '.codex-ppt-build/live-focus.png',
 '.codex-ppt-build/voice-focus.png',
 '.codex-ppt-build/game-focus.png',
 '.codex-ppt-build/brain-focus.png',
 '.codex-ppt-build/director-focus.png',
];
const imageBytes = new Map(await Promise.all(imagePaths.map(async p=>[p,new Uint8Array(await fs.readFile(path.join(root,p)))])));
function box(s,x,y,w,h,fill='none',stroke='none',sw=0){ return s.shapes.add({geometry:'rect',position:{left:x,top:y,width:w,height:h},fill,line:{style:'solid',fill:stroke,width:sw}}); }
function txt(s,t,x,y,w,h,size=24,color=C.ink,bold=false,opts={}){
  const sh=box(s,x,y,w,h);
  sh.text=t;
  sh.text.style={fontSize:size,color,bold,typeface:FONT,alignment:opts.align||'left',verticalAlignment:opts.valign||'top',wrap:'square',autoFit:'shrinkText',insets:0};
  return sh;
}
function img(s,rel,x,y,w,h,fit='cover',crop){
  return s.images.add({blob:imageBytes.get(rel),contentType:rel.endsWith('.png')?'image/png':'image/jpeg',alt:rel,fit,position:{left:x,top:y,width:w,height:h},...(crop?{crop}:{})});
}
function base(bg=C.paper){const s=ppt.slides.add();s.background.fill=bg;return s;}
function head(s,n,title,dark=false){
  const fg=dark?C.paper:C.ink;
  txt(s,String(n).padStart(2,'0'),64,42,70,28,15,dark?C.bronze:C.red,true);
  txt(s,title,64,82,1120,66,36,fg,true);
}
function note(s,t){s.speakerNotes.text=t;}
function cap(s,t,x=64,y=673,w=1150,dark=false){txt(s,t,x,y,w,22,13,dark?C.pale:C.gray,false);}

// 01 Cover: approved name; visual remains an artist-facing concept.
{
 const s=base(C.paper);
 img(s,'.codex-ppt-build/jisui-concept.png',0,25,640,670,'contain');
 txt(s,'AI VTUBER  /  项目答辩',684,88,490,34,17,C.red,true);
 txt(s,'姬岁歌',680,200,530,105,72,C.ink,true);
 txt(s,'让角色记住经历，\n在游戏直播中持续回应',684,323,515,132,31,C.ink,true);
 txt(s,'人格与记忆 · 本地语音 · Live2D · 游戏视觉',684,535,510,60,19,C.gray,false);
 cap(s,'角色图为画师交接概念稿，正式原画与 Live2D 形象待定',684,663,520);
 note(s,'来源：README.md；PROJECT_HANDOFF.md；docs/design/姬岁歌-画师交接稿-2026-10-04.docx。封面概念稿不是已授权的正式角色原画。');
}

// 02 A concrete view of the current prototype.
{
 const s=base(C.black);head(s,2,'现在已经能看到一场游戏直播的雏形',true);
 img(s,'.codex-ppt-build/live-focus.png',64,164,1150,495,'contain');
 cap(s,'本机 Minecraft 联调截图。画面中的 Live2D 是临时模型，姬岁歌正式形象尚未接入',64,666,1150,true);
 note(s,'来源：output/minecraft-demo/integrated-live-final.jpg；README.md；PROJECT_HANDOFF.md。截图只能证明演示界面和局部联调，不代表平台直播正式上线。');
}

// 03 Editable system diagram.
{
 const s=base();head(s,3,'从输入到直播输出的实时闭环');
 const items=[
   ['01','观众与游戏','弹幕、语音、游戏状态'],
   ['02','运行协调','事件排序、取消、调度'],
   ['03','角色大脑','人格、情绪、记忆检索'],
   ['04','模型决策','本地 Qwen 或兼容接口'],
   ['05','直播呈现','语音、字幕、Live2D、OBS']
 ];
 const x0=64,w=214,g=19;
 items.forEach((it,i)=>{
   const x=x0+i*(w+g);
   box(s,x,235,w,260,C.white,C.pale,1);
   txt(s,it[0],x+20,256,100,36,19,C.red,true);
   txt(s,it[1],x+20,315,w-40,64,29,C.ink,true);
   txt(s,it[2],x+20,403,w-40,71,18,C.gray,false);
 });
 txt(s,'旁路控制',64,550,155,35,21,C.red,true);
 txt(s,'导演工作台可查看状态、审核记忆、介入任务；异常时允许取消或降级。',218,550,964,76,21,C.ink);
 note(s,'来源：PROJECT_HANDOFF.md 第 3、4、6 节；README.md 已实现和导演工作台；docs/realtime-ai-vtuber-architecture-v1.md。该图为源码模块关系概括，方框和文字可编辑。');
}

// 04 Persona + memory.
{
 const s=base(C.black);head(s,4,'人格的稳定性来自状态与记忆分层',true);
 txt(s,'34',66,210,245,115,87,C.bronze,true);
 txt(s,'稳定人格维度',69,339,275,40,22,C.paper,true);
 txt(s,'63',360,210,245,115,87,C.bronze,true);
 txt(s,'动态情绪与关系状态',363,339,300,70,21,C.paper,true);
 img(s,'.codex-ppt-build/brain-focus.png',710,186,490,359,'contain');
 txt(s,'长期记忆进入 SQLite 前保留审核；单条弹幕不会直接改写人格。',67,498,610,95,23,C.paper,false);
 cap(s,'工作台实拍：诊断页显示运行状态；维度数量来自项目设计与实现记录',67,662,1120,true);
 note(s,'来源：PROJECT_HANDOFF.md 第 4 节；docs/emotion-and-personality-engine.md；本机 studio.html 大脑诊断页截图，2026-10-14。双人格独立训练仍为目标架构。');
}

// 05 Story and target character system.
{
 const s=base();head(s,5,'姬岁歌的角色设定服务于长期直播');
 txt(s,'姬',70,184,275,170,128,C.red,true);
 txt(s,'岁歌',252,187,455,170,93,C.ink,true);
 txt(s,'从人工智能中醒来，通过游戏和交流认识人类，持续追问“我是谁”。',70,384,840,93,27,C.ink,false);
 txt(s,'听潮记岁',70,543,320,53,29,C.red,true);
 txt(s,'认真观察，珍惜经历',70,594,385,34,19,C.gray);
 txt(s,'守潮成歌',640,543,330,53,29,C.red,true);
 txt(s,'主动选择，守住边界',640,594,390,34,19,C.gray);
 cap(s,'两位虚构人格为创作与未来训练目标，当前系统尚无独立双人格权重',70,664,1100);
 note(s,'来源：README.md；PROJECT_HANDOFF.md；docs/persona/希儿与洛天依融合主播人设-2026-09-29.md；docs/persona/姬岁歌-岁人格设定.md；docs/persona/姬岁歌-歌人格设定.md。不得将故事里的意识设定写为现实系统能力。');
}

// 06 Voice and stage.
{
 const s=base();head(s,6,'语音与舞台已形成可切换的链路');
 txt(s,'SenseVoice 输入     GPT-SoVITS / 浏览器语音输出     字幕与 Live2D 同步',68,167,1140,46,22,C.ink,true);
 img(s,'.codex-ppt-build/voice-focus.png',155,230,970,417,'contain');
 cap(s,'本机联调截图；角色模型与配音素材仍需核实授权',70,666,1120);
 note(s,'来源：README.md 已实现、OBS 使用；PROJECT_HANDOFF.md 第 5、6 节；output/minecraft-demo/audio-routing-panel.jpg。截图使用临时 Live2D 模型。');
}

// 07 Game loop.
{
 const s=base(C.black);head(s,7,'Minecraft：模型选动作，受限技能负责执行',true);
 img(s,'.codex-ppt-build/game-focus.png',65,171,1150,495,'contain');
 cap(s,'局部闭环可运行；尚未通过无人值守生存和进入下界的验收',65,665,1120,true);
 note(s,'来源：docs/minecraft-local-qwen-training-results-20261013.md；docs/minecraft-live-v2-acceptance.md；output/minecraft-demo/qwen-goal-review.jpg。模型决策、执行器技能和安全反射必须分开归因。');
}

// 08 Director interface.
{
 const s=base();head(s,8,'导演工作台让直播过程可观察、可介入');
 img(s,'.codex-ppt-build/director-focus.png',65,186,1150,456,'contain');
 cap(s,'工作台实拍；B 站正式长连接仍依赖开放平台凭据与权限',66,666,1110);
 note(s,'来源：README.md 导演工作台、OBS 使用、B站边界；PROJECT_HANDOFF.md 平台与集成状态；本机 studio.html 直播运行页截图，2026-10-14。');
}

// 09 Evidence-minded model training.
{
 const s=base(C.black);head(s,9,'模型训练完成了，但候选权重按实机问题回退',true);
 txt(s,'57 / 57',69,224,455,115,78,C.bronze,true);
 txt(s,'v4r1 与 v6r1 在同一开发集上均输出有效格式',72,354,540,70,23,C.paper);
 txt(s,'20 / 57',690,223,475,96,64,C.paper,true);
 txt(s,'v4r1 可接受动作',693,323,440,35,20,C.pale);
 txt(s,'24 / 57',690,385,475,96,64,C.paper,true);
 txt(s,'v6r1 可接受动作',693,484,440,35,20,C.pale);
 txt(s,'仍保留 v4r1：v6r1 出现材料不足却请求制作等关键回退。',72,565,1110,68,24,C.paper,true);
 cap(s,'同一冻结开发输入的直接推理；不是直播成功率',71,664,1120,true);
 note(s,'来源：docs/minecraft-local-qwen-training-results-20261013.md。57 个开发输入上两版 schema 有效率均 57/57，动作可接受为 v4r1 20/57、v6r1 24/57；但 v6r1 因关键材料与阶段回退被拒绝部署。开发集分数不能代表完整自主游戏表现。');
}

// 10 Deployment diagram.
{
 const s=base();head(s,10,'运行依赖围绕一台 Windows 主机');
 const y=210;
 box(s,64,y,526,315,C.white,C.pale,1);
 txt(s,'RTX 5080 台式机',92,y+30,450,58,34,C.ink,true);
 txt(s,'Node 服务、导演工作台、直播画面',92,y+108,450,68,22,C.gray);
 txt(s,'本地 Qwen 3.5 4B、语音与视觉服务\n按显存和任务负载分别调度',92,y+198,450,96,21,C.ink);
 box(s,622,y,591,145,C.white,C.pale,1);
 txt(s,'可选：RTX 5070 笔记本',650,y+26,530,49,27,C.ink,true);
 txt(s,'离线时主机应能降级运行',650,y+83,510,40,20,C.gray);
 box(s,622,y+171,591,144,C.white,C.pale,1);
 txt(s,'外部：双 RTX 6000',650,y+197,530,49,27,C.ink,true);
 txt(s,'用于训练与评测，不是直播必需节点',650,y+254,510,40,20,C.gray);
 txt(s,'模型权重、GPT-SoVITS 服务和密钥在仓库外配置。',67,582,1080,56,23,C.red,true);
 note(s,'来源：PROJECT_HANDOFF.md 第 6、7 节；.env.example。硬件为项目文档记录，目标机器需核实当前服务与权重路径。该部署结构为可编辑原生图。');
}

// 11 Close with truthful status and next milestone.
{
 const s=base(C.black);head(s,11,'下一步：把可运行原型变成可验收的主播',true);
 txt(s,'现在',70,212,205,61,36,C.bronze,true);
 txt(s,'对话、情绪记忆、语音、Live2D 舞台、\n导演工作台与部分游戏闭环已接入。',70,278,525,115,24,C.paper);
 txt(s,'接下来',680,212,340,61,36,C.bronze,true);
 txt(s,'完成姬岁歌正式美术和授权；验证双人格\n运行方案；用真实直播场景检查稳定性。',680,278,520,115,24,C.paper);
 txt(s,'当前边界',70,474,280,52,29,C.paper,true);
 txt(s,'歌唱模块未开发。B 站正式长连接和长期无人值守游戏仍待验证。',70,529,1120,95,26,C.paper);
 cap(s,'项目资料截止 2026-10-14；答辩时应以现场可复现结果为准',70,665,1110,true);
 note(s,'来源：README.md；PROJECT_HANDOFF.md；docs/minecraft-local-qwen-training-results-20261013.md；docs/minecraft-live-v2-acceptance.md。正式原画、授权、双人格独立训练和歌唱仍待补齐。');
}

// Render for private visual review.
for (const [i,s] of ppt.slides.items.entries()) {
 const blob=await ppt.export({slide:s,format:'png',scale:1});
 await fs.writeFile(path.join(build,`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await blob.arrayBuffer()));
}
const draft=path.join(build,'candidate.pptx');
await (await PresentationFile.exportPptx(ppt)).save(draft);

const { finalizePresentation } = await import(pathToFileURL(path.join(skill,'container_tools/artifact_tool_utils.mjs')).href);
const final=path.join(out,'AI-VTuber-姬岁歌-项目答辩-2026-10-14-v3.pptx');
const result=await finalizePresentation({
 workspaceDir:root,candidatePath:draft,finalPath:final,pythonExecutable:runtimePython,
 integrityValidatorPath:path.join(skill,'container_tools/inspect_presentation_package_integrity.py'),
 layoutValidatorPath:path.join(skill,'container_tools/inspect_presentation_layout_geometry.py'),
 layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-heading-fit'],
 requiredNativeTableOwnerSlides:[],fontPolicy:{basis:'design',families:[FONT]},
 verifyArtifactToolImport:true,receiptPath:path.join(build,'validation-v3.json')
});
console.log(JSON.stringify({final,result}));
