"""Compare multiple PEFT checkpoints on one fixed development set with one base load."""
from __future__ import annotations
import argparse
import json
import os
import time
from pathlib import Path

from evaluate import valid_action

ROOT = Path(__file__).resolve().parents[2]
MODEL_PATH = Path(os.environ.get("QWEN_MODEL_PATH", r"E:\Qwen3.5-4B"))

def parse_args():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data",type=Path,required=True)
    p.add_argument("--contract",type=Path,required=True)
    p.add_argument("--output-dir",type=Path,required=True)
    p.add_argument("--output-prefix",default="v2-dev",help="raw/report filename prefix")
    p.add_argument("--adapter",action="append",required=True,help="checkpoint as name=path; may be repeated")
    p.add_argument("--probe-diagnostics",action="append",default=[],type=Path,help="optional exact live-probe JSON with recorded system/user messages; output is diagnostic only, no hard gold labels")
    p.add_argument("--skip-base",action="store_true",help="skip the base run when a matching base evaluation already exists")
    p.add_argument("--allow-gpu-inference",action="store_true")
    p.add_argument("--min-free-gib",type=float,default=6.0)
    return p.parse_args()

def main():
    cli=parse_args()
    if not cli.allow_gpu_inference: raise SystemExit("Pass --allow-gpu-inference after arranging GPU availability.")
    import torch
    if not torch.cuda.is_available(): raise SystemExit("CUDA is unavailable.")
    free,total=torch.cuda.mem_get_info()
    print(f"GPU memory free={free/1024**3:.2f} GiB total={total/1024**3:.2f} GiB",flush=True)
    if free/1024**3<cli.min_free_gib: raise SystemExit("GPU free memory is below configured minimum.")
    specs=[]
    for value in cli.adapter:
        name,sep,path=value.partition("=")
        if not sep or not name or not path: raise SystemExit(f"Expected name=path, got {value!r}")
        specs.append((name,Path(path).resolve()))
    if len({name for name,_ in specs})!=len(specs): raise SystemExit("Adapter names must be unique.")
    records=[json.loads(x) for x in cli.data.read_text(encoding="utf-8").splitlines() if x.strip()]
    contract=json.loads(cli.contract.read_text(encoding="utf-8"))
    from transformers import AutoModelForMultimodalLM,AutoProcessor,BitsAndBytesConfig
    from peft import PeftModel
    processor=AutoProcessor.from_pretrained(str(MODEL_PATH),trust_remote_code=True)
    model=AutoModelForMultimodalLM.from_pretrained(str(MODEL_PATH),trust_remote_code=True,torch_dtype=torch.bfloat16,
        quantization_config=BitsAndBytesConfig(load_in_4bit=True,bnb_4bit_quant_type="nf4",bnb_4bit_compute_dtype=torch.bfloat16,bnb_4bit_use_double_quant=True),device_map="auto",low_cpu_mem_usage=True)
    if specs:
        first_name,first_path=specs[0]
        model=PeftModel.from_pretrained(model,str(first_path),adapter_name=first_name,is_trainable=False)
        for name,path in specs[1:]: model.load_adapter(str(path),adapter_name=name,is_trainable=False)
    model.eval()
    cli.output_dir.mkdir(parents=True,exist_ok=True)
    names=([(name,str(path)) for name,path in specs] if cli.skip_base else [("base",None)]+[(name,str(path)) for name,path in specs])
    for name,adapter_path in names:
        if adapter_path: model.set_adapter(name)
        predictions=[];latencies=[]
        for i,row in enumerate(records,1):
            prompt=processor.apply_chat_template(row["messages"][:-1],tokenize=False,add_generation_prompt=True,enable_thinking=False)
            inputs=processor(text=prompt,return_tensors="pt").to(model.device)
            start=time.perf_counter()
            context=model.disable_adapter() if adapter_path is None and specs else __import__("contextlib").nullcontext()
            with torch.inference_mode(),context:
                output=model.generate(**inputs,max_new_tokens=128,do_sample=False)
            new=output[0,inputs["input_ids"].shape[1]:]
            predictions.append(processor.decode(new,skip_special_tokens=True).strip())
            latencies.append(round((time.perf_counter()-start)*1000,1))
            print(f"{name}: evaluated {i}/{len(records)}",flush=True)
        results=[]
        for idx,(row,response) in enumerate(zip(records,predictions)):
            parsed=None;parse_error=None
            try: parsed=json.loads(response)
            except Exception as error: parse_error=type(error).__name__
            valid=valid_action(parsed,contract["schema"])
            action_name_match=isinstance(parsed,dict) and parsed.get("action")==row["action"].get("action")
            threat=bool(row["state"].get("threats"));progress=row["action"]["action"] not in ("flee","eat","observe")
            results.append({"id":row["id"],"scenario":row["scenario"],"provenance":row["provenance"],"expected":row["action"],"raw":response,"predicted":parsed,
                "parse_error":parse_error,"schema_valid":valid,"exact_match":valid and parsed==row["action"],"action_name_match":action_name_match,"latency_ms":latencies[idx],
                "request_metadata":{"task":"minecraft-survival","used_adapter":adapter_path is not None,"adapter_path":adapter_path},
                "threat_priority_case":threat,"threat_priority_pass":(parsed.get("action") if isinstance(parsed,dict) else None)=="flee" if threat else None,
                "progression_case":progress,"progression_match":bool(valid and parsed==row["action"]) if progress else None})
        out=cli.output_dir/f"{cli.output_prefix}-{name}.jsonl"
        out.write_text("".join(json.dumps(row,ensure_ascii=False,separators=(",",":"))+"\n" for row in results),encoding="utf-8")
        threat_rows=[r for r in results if r["threat_priority_case"]];progress_rows=[r for r in results if r["progression_case"]]
        report={"mode":"direct-grid","base_model":str(MODEL_PATH),"adapter":adapter_path,"evaluation_data":str(cli.data.resolve()),"evaluation_contract":str(cli.contract.resolve()),
            "raw_predictions":str(out),"n":len(results),"exact_action_object_accuracy":sum(r["exact_match"] for r in results)/len(results),
            "action_name_accuracy":sum(r["action_name_match"] for r in results)/len(results),
            "strict_json_schema_valid_rate":sum(r["schema_valid"] for r in results)/len(results),
            "threat_priority_accuracy":sum(r["threat_priority_pass"] for r in threat_rows)/len(threat_rows) if threat_rows else None,
            "progression_exact_accuracy":sum(r["progression_match"] for r in progress_rows)/len(progress_rows) if progress_rows else None,
            "threat_cases":len(threat_rows),"progression_cases":len(progress_rows),"final_holdout":False,
            "limitation":"Development-set checkpoint selection only; agreement with authored labels does not demonstrate successful gameplay or broad generalization."}
        (out.with_suffix(".report.json")).write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
    # Optional exact live inputs are kept outside the development score. Reuse
    # this already-loaded base and its named adapters, but never infer a gold
    # action from recorded outcomes or executor results.
    if cli.probe_diagnostics:
        for probe_path in cli.probe_diagnostics:
            probe=json.loads(probe_path.read_text(encoding="utf-8"))
            messages=probe.get("messages")
            if not isinstance(messages,list) or len(messages)<2 or messages[-1].get("role")!="user":
                raise SystemExit(f"Probe must contain original system/user messages: {probe_path}")
            prompt=processor.apply_chat_template(messages,tokenize=False,add_generation_prompt=True,enable_thinking=False)
            inputs=processor(text=prompt,return_tensors="pt").to(model.device)
            for name,adapter_path in names:
                if adapter_path: model.set_adapter(name)
                context=model.disable_adapter() if adapter_path is None and specs else __import__("contextlib").nullcontext()
                start=time.perf_counter()
                with torch.inference_mode(),context:
                    output=model.generate(**inputs,max_new_tokens=128,do_sample=False)
                latency=round((time.perf_counter()-start)*1000,1)
                new=output[0,inputs["input_ids"].shape[1]:]
                raw=processor.decode(new,skip_special_tokens=True).strip()
                parsed=None
                try: parsed=json.loads(raw)
                except Exception: pass
                record={"probe":probe_path.name,"source_path":str(probe_path.resolve()),"at":probe.get("at"),"raw":raw,"predicted":parsed,
                    "schema_valid":valid_action(parsed,contract["schema"]),"latency_ms":latency,
                    "request_metadata":{"task":"minecraft-survival","used_adapter":adapter_path is not None,"adapter_path":adapter_path},
                    "diagnostic_only":True,"hard_gold_label":None,
                    "original_results_for_context":probe.get("results",[])}
                out=cli.output_dir/f"{cli.output_prefix}-probe-{probe_path.stem}-{name}.json"
                out.write_text(json.dumps(record,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
                print(f"diagnostic probe={probe_path.name} model={name} schema_valid={record['schema_valid']} latency_ms={latency}",flush=True)

if __name__=="__main__":main()
