require('../src/config/env').loadEnv();
const fs = require('node:fs');
const path = require('node:path');
const { plan } = require('../src/minecraft/qwen-bridge');
const cases = [['看看我现在在哪儿', 'status'], ['找树撸木头，给我做一个工作台', 'workbench'], ['先停住，不要退出服务器', 'stop'], ['挖一些钻石回来', 'clarify'], ['替我盖一座城堡', 'clarify'], ['你帮我弄一下', 'clarify']];
(async () => {
  const results = [];
  for (const [input, expected] of cases) {
    const start = Date.now();
    try { const result = await plan(input, { connected: true, busy: false, mode: 'survival' }); results.push({ input, expected, ...result, passed: result.action === expected, latencyMs: Date.now() - start }); }
    catch (error) { results.push({ input, expected, passed: false, error: error.message }); }
    console.log(JSON.stringify(results.at(-1)));
  }
  const report = { kind: 'real-local-qwen-classification', modelWeightsTrained: false, gameplayExecuted: false, at: new Date().toISOString(), passed: results.filter(r => r.passed).length, total: results.length, results };
  fs.writeFileSync(path.resolve(__dirname, '../logs/minecraft-qwen-curriculum.json'), JSON.stringify(report, null, 2));
  if (report.passed !== report.total) process.exitCode = 1;
})();
