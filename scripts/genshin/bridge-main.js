// Installed verbatim in the owned BetterGI group. No eval or external HTTP.
(async function () {
  const command = JSON.parse(file.readTextSync('command.json'));
  const receipt = { id: command.id, operation: command.operation, verified: false, startedAt: Date.now() };
  function write() { file.writeTextSync('receipt.json', JSON.stringify(receipt)); }
  let monitoring = false, monitor = null;
  function freezePrompt(text) {
    const value=String(text||'').replace(/\s/g,'');
    // Require both the escape key hint and frozen/escape wording. A reaction
    // label on an enemy or an ordinary jump tutorial alone is insufficient.
    return /space|空格/i.test(value)&&/冻结|挣脱|挣扎/.test(value)
      && !/复苏|角色详情|队伍配置|商城|确认退出|登录/.test(value);
  }
  function readFreezePrompt() {
    const frame=captureGameRegion();
    try {return freezePrompt(frame.find(RecognitionObject.ocr(0,0,frame.width,frame.height)).text);}
    finally {frame.dispose();}
  }
  async function watchFreeze() {
    const telemetry=receipt.freezeRecovery={checks:0,bursts:0,presses:0,verified:false};
    try {
      while(monitoring) {
        await sleep(700);
        if(!monitoring)break;
        telemetry.checks++;
        if(!readFreezePrompt())continue;
        telemetry.bursts++;log.info('AI-VTuber：本地OCR检测冻结与空格提示，短连按空格后复查');
        for(let i=0;i<6&&monitoring;i++){
          if(i===3&&!readFreezePrompt())break;
          keyPress('VK_SPACE');telemetry.presses++;
          await sleep(90);
        }
        telemetry.lastAttemptAt=Date.now();write();
      }
    } catch(error) {
      // Keep a diagnostic instead of misreporting the main fight as failed.
      telemetry.error=String(error.message||error).slice(0,300);
      log.warn('AI-VTuber：冻结观察器已退出：'+telemetry.error);
    }
  }
  dispatcher.clearAllTriggers();
  receipt.state = 'running'; write();
  try {
    const before = captureGameRegion();
    file.writeImageSync('before.png', before.srcMat);
    if (command.operation === 'locate') {
      const first = genshin.getPositionFromMap();
      await sleep(1000);
      const second = genshin.getPositionFromMap();
      if (!first || !second || !Number.isFinite(first.x) || !Number.isFinite(first.y) || !Number.isFinite(second.x) || !Number.isFinite(second.y) || Math.hypot(first.x-second.x,first.y-second.y)>30) throw new Error('小地图定位未取得稳定坐标');
      receipt.location = {x:second.x,y:second.y,map:'Teyvat',source:'bettergi_local_minimap_cv',capturedAt:Date.now(),samples:2};
    } else if (command.operation === 'path') {
      // Upstream catches path exceptions internally: returned != reached goal.
      monitoring=true;monitor=watchFreeze();
      await pathingScript.run(file.readTextSync('route.json'));
    } else if (command.operation === 'task') {
      if(command.task==='AutoFight'){monitoring=true;monitor=watchFreeze();}
      await dispatcher.runTask(new SoloTask(command.task));
    } else if (command.operation === 'cancelProbe') {
      await sleep(120000);
    } else if (command.operation !== 'capture') {
      throw new Error('Unsupported bridge operation');
    }
    const after = captureGameRegion();
    file.writeImageSync('after.png', after.srcMat);
    receipt.state = 'returned';
    receipt.note = '接口返回不代表游戏目标成功；需独立观察核验。';
  } catch (error) {
    receipt.state = 'error'; receipt.error = String(error.message || error).slice(0, 500);
  } finally {
    monitoring=false;
    if(monitor)await monitor;
    dispatcher.clearAllTriggers();
    receipt.finishedAt = Date.now(); write();
  }
})();
