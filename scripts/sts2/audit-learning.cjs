const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const K=require('../../src/sts2/knowledge');
const db=new DatabaseSync('data/memory.db',{readOnly:true});
const data=K.read();
const report={coverage:data.coverage,version:data.version,
  memory:db.prepare("SELECT kind,COUNT(*) AS count FROM memories WHERE source LIKE 'sts2-learning:%' AND status='active' GROUP BY kind").all(),
  recentCommentary:db.prepare("SELECT at,text,reply FROM session_messages WHERE at > ? AND (text LIKE '%读牌%' OR text LIKE '%痛击%' OR text LIKE '%愤怒%') ORDER BY id DESC LIMIT 4").all('2026-10-21T09:05:00'),
  example:K.retrieve('痛击与愤怒的协同')};
db.close();
fs.writeFileSync('runtime/sts2/learning/final-audit.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({coverage:report.coverage,memoryRows:report.memory.reduce((s,r)=>s+r.count,0),recentCommentary:report.recentCommentary}));
