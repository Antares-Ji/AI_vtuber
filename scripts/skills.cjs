'use strict';
const fs = require('node:fs');
const { createSkillHost } = require('../src/skills');
const { localClient } = require('../src/skills/local-client');
async function main() {
  const [command = 'list', value, ...args] = process.argv.slice(2);
  if (command === 'list') { const host = createSkillHost({ directory: null }); console.log(JSON.stringify(host.list(), null, 2)); return; }
  if (command === 'demo') {
    const host = createSkillHost();
    const job = host.start({ skill: 'genshin:demo', args: { goal: '观察当前场景并钓鱼' } });
    console.log(JSON.stringify(await host.wait(job.id), null, 2)); return;
  }
  const request = localClient(`http://127.0.0.1:${process.env.PORT || 3000}`);
  let result;
  if (command === 'run') {
    const index = args.indexOf('--args');
    if (index >= 0 && !args[index + 1]) throw Error('--args requires a JSON file');
    const input = index >= 0 ? JSON.parse(fs.readFileSync(args[index + 1], 'utf8')) : {};
    result = await request('/api/skills/run', { skill: value, args: input, allowLive: args.includes('--live') });
  } else if (command === 'status') result = await request(value ? `/api/skills/runs/${value}` : '/api/skills/runs');
  else if (command === 'stop' && value) result = await request(`/api/skills/runs/${value}/stop`, {});
  else throw Error('Usage: skills.cjs list | demo | run ID [--args file.json] [--live] | status [UUID] | stop UUID');
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
