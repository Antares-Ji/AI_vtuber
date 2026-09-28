"""Loopback-only image analysis worker. Never sends mouse/keyboard input."""
import importlib.util
import json
import time
import os
from game_visual_memory import retrieve
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location('experiment', Path(__file__).with_name('vlm-experiment.py'))
experiment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(experiment)
import torch
from PIL import Image
from ultralytics import YOLO, settings
settings.update({'sync': False})
BASE = experiment.BASE
CAPTURES = (BASE / 'live-20260911').resolve()
CAPTURES.mkdir(parents=True, exist_ok=True)
processor, model = experiment.load_vlm()
processor.image_processor.size = {'shortest_edge': 65536, 'longest_edge': 786432}
detector = YOLO(str(BASE / 'models/YOLO11/yolo11n.pt'))
stage_weights = os.environ.get('ARKNIGHTS_YOLO_WEIGHTS')
stage_detector = YOLO(stage_weights) if stage_weights else None
detector.predict(Image.new('RGB', (640, 640)), device=0, verbose=False)

def analyze(name, target, mode='hybrid', strategy='baseline'):
    request_start = time.perf_counter()
    fast = strategy == 'stage-fast'
    spatial = strategy in ('deploy-tile', 'deploy-direction')
    if strategy not in ('baseline', 'grounded', 'stage-memory', 'stage-fast', 'objects', 'deploy-tile', 'deploy-direction', 'roster', 'operator-profile', 'tactical'):
        raise ValueError('Unknown strategy')
    if mode not in ('vlm', 'yolo', 'hybrid'):
        raise ValueError('Unknown mode')
    path = (CAPTURES / name).resolve()
    if not path.is_relative_to(CAPTURES) or path.suffix.lower() != '.png':
        raise ValueError('Only experiment PNG captures are accepted')
    image = Image.open(path).convert('RGB')
    original_size = image.size
    if fast or strategy == 'objects':
        image.thumbnail((800, 512))
    start = time.perf_counter()
    active_detector = stage_detector if strategy in ('stage-memory', 'stage-fast') and stage_detector else detector
    result = active_detector.predict(image, verbose=False)[0] if mode != 'vlm' else None
    yolo_ms = (time.perf_counter() - start) * 1000
    boxes = [{'label': result.names[int(b.cls.item())], 'confidence': float(b.conf.item()),
              'xyxy': b.xyxy[0].tolist()} for b in result.boxes] if result is not None else []
    if mode == 'yolo':
        report = {'mode': mode, 'image': name, 'target': target, 'yolo_ms': yolo_ms,
                  'detections': boxes, 'parsed': None,
                  'memory': retrieve(path, limit=2) if strategy == 'stage-memory' else None,
                  'detector_weights': stage_weights if active_detector is stage_detector else 'YOLO11n-COCO',
                  'reason': 'Experimental landmarks only; no validated action policy' if active_detector is stage_detector
                            else 'COCO detector has no game UI target class; abstain from clicking'}
        (CAPTURES / (path.stem + '.yolo.analysis.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        return report
    prompt = ('这是明日方舟窗口截图。只返回JSON：scene（home/settings/notice/other），'
              'selected_tab（当前选中设置或公告分类，看不清为null），'
              'target_visible（布尔），target_point（目标中心[x,y]，坐标归一化到0到1000，找不到为null）。'
              '目标：' + target + '。不要把角色名当按钮。')
    if strategy == 'grounded':
        prompt = ('定位截图中用户指定的可点击目标。先核对目标的文字或图标，再返回该目标的中心。'
                  '高亮只表示当前选中项，不代表用户要点击它。不要返回当前选中项的位置，除非它就是指定目标。'
                  '目标：' + target + '。'
                  '只输出紧凑JSON，字段target_visible为布尔，target_point为[x,y]或null。'
                  '坐标相对于整张图片归一化到0至1000。看不到目标则返回false和null。不要输出场景或当前选项卡。')
    memory = None
    if strategy == 'tactical':
        prompt = ('你是本机明日方舟视觉分析器。只根据当前截图与提供的已核验编队资料推理；'
            '不要把0-1或其他地图坐标套用当前图。红色为敌人入口，蓝色为需要保护的目标。'
            '未知写null，无法确定时明确写不确定。只返回合法JSON对象，禁止Markdown。'
            '任何point坐标均相对于当前整张图归一化0至1000。任务与输出字段：'+target)
    if strategy == 'roster':
        prompt = ('只读当前明日方舟编队或干员列表截图，不凭游戏知识补全。按从左到右、从上到下列出可见卡片。'
            '只输出JSON：{"operators":[{"name":"姓名或null","profession":"先锋/近卫/重装/狙击/术师/医疗/辅助/特种/unknown",'
            '"point":[x,y]}]}。point是卡片中心，整张图归一化0至1000。最多12人。辨认不清写null或unknown。')
    if strategy == 'operator-profile':
        prompt = ('只读取当前选中干员详情，不凭记忆编造，未知字段写null。只输出JSON：'
            '{"name":姓名,"profession":职业,"placement":"ground/high/both/unknown",'
            '"cost":部署费用整数或null,"block":阻挡数整数或null,"skill_name":当前选中技能名称,'
            '"skill_text":当前技能可见描述原文,"dp_recovery":是否明确写获得回复部署费用的布尔或null,'
            '"range_description":当前可见攻击范围格子形状简述或null}。'
            '不要把技能所需技力当部署费用，不要把技能回转或攻击力提高当回复部署费用。')
    if strategy == 'stage-memory':
        memory = retrieve(path, limit=2)
        prompt = ('分析明日方舟当前截图及检索到的历史候选。历史相似图不证明当前关卡，旧坐标不可直接复用。'
            '任务：' + target + '。历史：' + json.dumps(memory, ensure_ascii=False) +
            '只输出JSON：phase（battle/paused/selection/direction/result/unknown），'
            'deployment_confirmed（布尔），next_action（observe/deploy/choose_direction/wait），'
            'target_visible（布尔），target_point（必须是两个数的数组[x,y]，分别是当前截图横纵坐标归一化到0至1000，或null；不能为单个数字），reason（简短原因）。'
            'next_action为observe或wait时target_visible必须为false、target_point必须为null。'
            '未看到绿色可部署格不能提出部署坐标。费用、干员可用性、关卡身份不明时先observe。')
    if fast:
        memory = retrieve(path, limit=2)
        brief = [{k: c[k] for k in ('stage', 'phase', 'layout_distance')} for c in memory['candidates']]
        prompt = ('只依据当前图识别状态。历史候选仅供参考，不能当当前事实：' + json.dumps(brief, ensure_ascii=False) +
            '只输出两个整数的JSON数组[p,d]，无文字。p：0战斗，1暂停，2选中干员显示绿色格，3部署朝向菱形确认，4结算，5不明。'
            '白色巨大菱形和红色取消叉是p=3，不能因画面变暗判暂停；暂停需出现PAUSE或暂停中。'
            'd：0无已部署我方干员，1有，2不明。结算p=4时d=0。方向框里的预览人物不算已部署。'
            '底部卡片、敌人、立绘不算部署；地图上有血条的我方角色才算。')
    if strategy == 'objects':
        prompt = ('识别当前图最确定的至多2个物体。只输出紧凑JSON数组[[k,x1,y1,x2,y2],...]，无文字，无字段名。'
            'k类别：0敌人，1战斗地图上已部署干员，2干员卡片，3战斗红色入口，4战斗蓝色目标点，5按钮，6立绘。'
            '坐标0至1000。非战斗页面不能输出0、1、3、4。大幅角色画像是6不是1。不确定输出[]。')
    reference = None
    if spatial:
        reference = experiment.ROOT / 'data/vision/deployment-references/0-1/vlm-direction-reference.png'
        if strategy == 'deploy-tile':
            prompt = ('第一张是0-1成功拖入后的参考图，白色菱形中心的角色脚下是目标地砖。第二张是当前图。'
                '在第二张找到与参考目标对应的绿色地面砖中心。绿色高亮正是可部署区域，没有文字也可以选。'
                '不要选左侧立绘、底部卡片、浅色高台或红色入口。只输出第二张图上的[x,y]，'
                '横纵坐标均归一化到0至1000；不匹配或没有绿色格则输出null。无需文字和JSON字段名。')
        else:
            prompt = ('第一张是成功出现部署方向选择框的参考图，第二张是当前图。'
                '找第二张白色大菱形内部待部署人物的脚下中心，作为拖动选择朝向的起点。'
                '不是红色取消叉，也不是左侧立绘。只输出第二张图上的[x,y]，'
                '横纵坐标归一化到0至1000；没有白色方向菱形则输出null。无需文字或字段名。')
    if mode == 'hybrid':
        if fast:
            boxes_context = [{'label': b['label'], 'xyxy': [round(v) for v in b['xyxy']]} for b in boxes[:8]]
        else:
            boxes_context = boxes
        prompt += ('实验YOLO地标候选，仅训练过单个关卡，必须用当前图核验：' if active_detector is stage_detector
                   else '通用YOLO检测仅辅助识别人物区域，不是按钮：') + json.dumps(boxes_context, ensure_ascii=False)
    conversation = experiment.messages(image, prompt)
    if reference:
        ref_image = Image.open(reference).convert('RGB')
        conversation[0]['content'].insert(0, {'type':'image', 'image':ref_image})
    inputs = processor.apply_chat_template(conversation, tokenize=True,
        add_generation_prompt=True, return_dict=True, return_tensors='pt').to(model.device)
    torch.cuda.synchronize()
    start = time.perf_counter()
    with torch.inference_mode():
        output = model.generate(**inputs, max_new_tokens=900 if strategy=='roster' else 700 if strategy=='tactical' else 500 if strategy=='operator-profile' else 24 if fast or spatial else 80 if strategy == 'objects' else 140, do_sample=False)
    torch.cuda.synchronize()
    raw = processor.decode(output[0, inputs.input_ids.shape[1]:], skip_special_tokens=True)
    try:
        parsed = json.loads(raw.strip().removeprefix('```json').removesuffix('```').strip())
    except ValueError:
        parsed = None
    validation_errors = []
    if strategy == 'roster':
        entries=parsed.get('operators') if isinstance(parsed,dict) else None
        if not isinstance(entries,list) or len(entries)>12:
            validation_errors.append('invalid_roster')
        else:
            for entry in entries:
                point=entry.get('point') if isinstance(entry,dict) else None
                if not isinstance(point,list) or len(point)!=2 or any(type(v) not in (int,float) or not 0<=v<=1000 for v in point):
                    validation_errors.append('invalid_roster_point')
    if strategy == 'operator-profile' and isinstance(parsed,dict):
        for field in ('cost','block'):
            if parsed.get(field) is not None and (type(parsed[field]) is not int or not 0<=parsed[field]<=99):
                validation_errors.append('invalid_'+field)
        if parsed.get('dp_recovery') is not None and type(parsed['dp_recovery']) is not bool:
            validation_errors.append('invalid_dp_recovery')
    if spatial:
        if parsed is None:
            parsed = {'target_visible':False,'target_point':None}
        elif isinstance(parsed,list) and len(parsed)==2:
            parsed = {'target_visible':True,'target_point':parsed}
        else:
            validation_errors.append('invalid_spatial_point')
    if strategy == 'objects':
        if isinstance(parsed, list) and len(parsed) <= 2 and all(isinstance(o,list) and len(o)==5
                and type(o[0]) is int and o[0] in range(7) for o in parsed):
            kinds = ['enemy','operator','card','entry','base','button','illustration']
            parsed = {'objects':[{'kind':kinds[o[0]],'box':o[1:]} for o in parsed]}
        objects = parsed.get('objects') if isinstance(parsed, dict) else None
        if not isinstance(objects, list) or len(objects) > 5:
            validation_errors.append('invalid_objects')
        else:
            for obj in objects:
                box = obj.get('box') if isinstance(obj, dict) else None
                if (not isinstance(obj, dict) or obj.get('kind') not in ('enemy','operator','card','entry','base','button','illustration')
                    or not isinstance(box, list) or len(box) != 4
                    or any(type(v) not in (int,float) or not 0 <= v <= 1000 for v in box)
                    or box[0] >= box[2] or box[1] >= box[3]):
                    validation_errors.append('invalid_object_box')
    if fast:
        if (isinstance(parsed, list) and len(parsed) == 2 and all(type(v) is int for v in parsed)
            and parsed[0] in range(6) and parsed[1] in range(3)):
            parsed = dict(phase=['battle','paused','selection','direction','result','unknown'][parsed[0]],
                deployment_confirmed=[False, True, None][parsed[1]], next_action='observe',
                target_visible=False, target_point=None)
        else:
            validation_errors.append('invalid_fast_state')
    if not isinstance(parsed, dict):
        validation_errors.append('invalid_json_object')
    else:
        if strategy == 'baseline' and parsed.get('scene') not in ('home', 'settings', 'notice', 'other'):
            validation_errors.append('invalid_scene_enum')
        point = parsed.get('target_point')
        if strategy == 'stage-memory':
            if parsed.get('phase') not in ('battle', 'paused', 'selection', 'direction', 'result', 'unknown'):
                validation_errors.append('invalid_phase')
            if parsed.get('next_action') not in ('observe', 'deploy', 'choose_direction', 'wait'):
                validation_errors.append('invalid_next_action')
        if parsed.get('target_visible') is True and (not isinstance(point, list) or len(point) != 2
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 1000 for v in point)):
            validation_errors.append('invalid_target_point')
    report = {'mode': mode, 'strategy': strategy, 'model': 'Qwen3-VL-4B-Instruct', 'dtype': 'bfloat16', 'image': name, 'target': target, 'yolo_ms': yolo_ms if mode != 'vlm' else None,
              'vlm_ms': (time.perf_counter()-start)*1000, 'detections': boxes,
              'parsed': parsed, 'validation_errors': validation_errors, 'raw': raw, 'image_size': image.size,
              'original_image_size': original_size, 'server_ms': (time.perf_counter()-request_start)*1000,
              'scope': 'state observation only, not planning or clicking' if fast else 'analysis proposal',
              'memory': memory, 'detector_weights': stage_weights if active_detector is stage_detector else 'YOLO11n-COCO',
              'reference_image': str(reference) if reference else None,
              'execution_policy': 'proposal only; agent visually verifies before input'}
    (CAPTURES / (path.stem + '.' + mode + '.' + strategy + '.analysis.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 4096:
                raise ValueError('Invalid request size')
            request = json.loads(self.rfile.read(length))
            result = analyze(request['image'], request['target'], request.get('mode', 'hybrid'), request.get('strategy', 'baseline'))
            code = 200
        except Exception as error:
            result, code = {'error': str(error)}, 400
        payload = json.dumps(result, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

if __name__ == '__main__':
    print('VLM live worker ready on 127.0.0.1:17642', flush=True)
    HTTPServer(('127.0.0.1', 17642), Handler).serve_forever()
