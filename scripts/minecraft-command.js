const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../logs/minecraft-control.json'), 'utf8'));
  const command = process.argv.slice(2).join(' ') || 'status';
  const status = ['status', '状态', '查看状态'].includes(command);
  const response = await fetch(`http://127.0.0.1:${config.port}/${status ? 'status' : 'command'}`, {
    method: status ? 'GET' : 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    ...(status ? {} : { body: JSON.stringify({ command }) }), signal: AbortSignal.timeout(5000)
  });
  console.log(await response.text());
  if (!response.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
