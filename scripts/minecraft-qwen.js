require('../src/config/env').loadEnv();
const { run } = require('../src/minecraft/qwen-bridge');
run(process.argv.slice(2).join(' ')).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
