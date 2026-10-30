'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createSkillHost } = require('../src/skills');
const root = path.resolve(__dirname, '..');
const skills = createSkillHost({ directory: null, env: {} }).list();
const outputs = new Map();
outputs.set('skills/catalog.json', JSON.stringify({ schema_version: 1, trustedCodeOnly: true, skills }, null, 2) + '\n');
outputs.set('docs/integration/SKILLS.md', '# 已注册 Skill\n\n由 `node scripts/skill-catalog.cjs` 从实际注册表生成；`--check` 可检查文档是否过期。每个 Skill 都有独立说明，执行器按环境分文件实现。\n\n| Skill | 模式 | 用途 |\n| --- | --- | --- |\n' +
  skills.map(s => `| [${s.id}](../../skills/${s.id.replace(':', '/')}/README.md) | ${s.mode} | ${s.description} |`).join('\n') + '\n');
for (const skill of skills) {
  const [group, name] = skill.id.split(':');
  const provider = group === 'mcplayer' ? 'minecraft' : group;
  outputs.set(`skills/${group}/${name}/README.md`, `# ${skill.id}\n\n${skill.description}\n\n版本：${skill.version}。模式：${skill.mode}。资源占用：${skill.resources.join(', ') || '无'}。\n\n实现：[${provider} provider](../../../src/skills/providers/${provider}.js)。\n\n参数元数据（实际参数由 provider.validate 严格检查）：\n\n\`\`\`json\n${JSON.stringify(skill.arguments, null, 2)}\n\`\`\`\n\n通过 \`npm run skills -- run ${skill.id}\` 调用；有参数时加 \`--args FILE.json\`${skill.mode === 'live' ? '，实机必须显式加 `--live`' : ''}。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。\n`);
}
for (const [relative, content] of outputs) {
  const file = path.join(root, relative);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== content) throw Error(`Stale skill catalog: ${relative}`);
  } else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
}
console.log(`${skills.length} registered skills; catalog ${process.argv.includes('--check') ? 'verified' : 'written'}`);
