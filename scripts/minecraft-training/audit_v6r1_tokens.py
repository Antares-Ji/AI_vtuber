"""CPU tokenizer audit for frozen v6r1 candidates; never loads CUDA or holdout."""
import json, os, statistics
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
MODEL=os.environ.get('QWEN_MODEL_PATH',r'E:\Qwen3.5-4B')
OUT=ROOT/'output'/'minecraft-training'/'v6r1-candidate-token-audit.json'
def summarize(name,processor):
 rows=[json.loads(x) for x in (ROOT/'data'/'minecraft-training'/name).read_text(encoding='utf-8').splitlines() if x.strip()]
 prompts=[];fulls=[];labels=[];ids=[]
 for r in rows:
  p=processor.apply_chat_template(r['messages'][:-1],tokenize=False,add_generation_prompt=True,enable_thinking=False)
  f=processor.apply_chat_template(r['messages'],tokenize=False,add_generation_prompt=False,enable_thinking=False)
  pi=processor.tokenizer(p,add_special_tokens=False)['input_ids'];fi=processor.tokenizer(f,add_special_tokens=False)['input_ids']
  if fi[:len(pi)]!=pi: raise ValueError(f"assistant label prefix changed: {r['id']}")
  prompts.append(len(pi));fulls.append(len(fi));labels.append(len(fi)-len(pi));ids.append(r['id'])
 return {'rows':len(rows),'promptTokens':{'min':min(prompts),'median':statistics.median(prompts),'max':max(prompts),'mean':round(statistics.mean(prompts),1)},'fullSequenceTokens':{'min':min(fulls),'median':statistics.median(fulls),'max':max(fulls),'mean':round(statistics.mean(fulls),1)},'assistantLabelTokens':{'min':min(labels),'max':max(labels),'mean':round(statistics.mean(labels),1)},'completeAt2560':sum(x<=2560 for x in fulls),'longestIds':[ids[i] for i in sorted(range(len(fulls)),key=lambda i:fulls[i],reverse=True)[:3]]}
def main():
 from transformers import AutoProcessor
 processor=AutoProcessor.from_pretrained(MODEL,trust_remote_code=True)
 report={n:summarize(n,processor) for n in ['train-v6r1-candidates.jsonl','development-v6r1-candidates.jsonl','train-v6r1-weighted-replay-candidates.jsonl']}
 report['status']='CPU tokenizer only; assistant labels kept whole; final holdout not accessed; no GPU inference or training.'
 OUT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(json.dumps(report,ensure_ascii=False,indent=2))
if __name__=='__main__': main()
