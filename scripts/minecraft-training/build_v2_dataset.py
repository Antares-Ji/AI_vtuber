"""Build a v2-only train/dev corpus; never rewrite v1 files or its holdout."""
from __future__ import annotations
import hashlib
import json
import math
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data/minecraft-training"
CONTRACT = DATA / "contract-v2.json"
GOAL = "在生存模式自主生存并进入下界"

def pos(x=0, y=64, z=0): return {"x": x, "y": y, "z": z}
def block(name, x=5, y=64, z=0): return {"name": name, "position": pos(x,y,z), "distance": round((x*x+(y-64)**2+z*z)**.5)}
def state(inv=None, *, health=20, food=18, y=64, day=True, threats=None, hazards=None,
          resources=None, stations=None, craftable=None, hints=None, fluids=None,
          failures=None, dimension="overworld"):
    r = {k: [] for k in ("stone","coal","iron","diamond","obsidian","gravel","wood")}
    r.update(resources or {})
    return {"connected": True, "mode":"survival", "dimension":dimension, "health":health,"food":food,"oxygen":20,
            "position":pos(0,y,0),"timeOfDay":6000 if day else 18000,"isNight":not day,
            "inventory":[{"name":n,"count":c} for n,c in (inv or {}).items() if c],"tools":[],"heldItem":None,"equipment":[],
            "threats":threats or [],"hazards":hazards or [],"resources":r,"animals":[],"stations":stations or [],
            "fluids":fluids or {"water":[],"lava":[]},"craftable":craftable or [],"recipeHints":hints or [],
            "recentExploration":[],"recentFailures":failures or [],"portalSite":None}

def example(name, action, s, rationale, provenance="synthetic; hand-authored v2 scenario", recent_results=None, user_payload=None):
    return {"scenario":name,"state":s,"action":action,"rationale":rationale,"provenance":provenance,
            "recentResults":recent_results or [],"userPayload":user_payload}

def progression_examples():
    e=[]
    # Axe/pick progression, required tool tier, food and exposure constraints.
    e += [
      example("木镐可采暴露石块，升级需要圆石", {"action":"mine","resource":"stone","count":4}, state({"wooden_pickaxe":1,"stick":2},resources={"stone":[block("stone")]}), "木镐能采石；先拿少量圆石制作石镐。"),
      example("已够圆石但缺工作台仍可见原有工作台", {"action":"craft","item":"stone_pickaxe","count":1}, state({"cobblestone":4,"stick":2},stations=[{"name":"crafting_table","position":pos(1,64,0)}],craftable=[{"item":"stone_pickaxe","outputPerCraft":1,"requiresTable":True}]), "材料齐全且工作台已存在，直接升级工具。"),
      example("只有木镐但有圆石和木板、工作台，缺木棍", {"action":"craft","item":"stick","count":2}, state({"wooden_pickaxe":1,"cobblestone":4,"oak_planks":4},stations=[{"name":"crafting_table","position":pos(1,64,0)}],hints=[{"item":"stone_pickaxe","missing":[{"name":"stick","count":2}],"oneRecipeExample":True}]), "先补足配方显示的缺失木棍，不重复采集圆石。"),
      example("石镐面对暴露煤矿", {"action":"mine","resource":"coal","count":5}, state({"stone_pickaxe":1,"torch":4},y=50,resources={"coal":[block("coal_ore",4,50,1)]}), "石镐可采煤；取少量燃料并保留火把。"),
      example("石镐可安全采集暴露铁矿", {"action":"mine","resource":"iron","count":4}, state({"stone_pickaxe":1,"torch":6,"bread":3},y=48,resources={"iron":[block("iron_ore",4,48,0)]}), "铁矿需要石镐或更好，当前工具满足。"),
      example("木镐无法采铁，圆石齐全应先升石镐", {"action":"craft","item":"stone_pickaxe","count":1}, state({"wooden_pickaxe":1,"cobblestone":6,"stick":4},stations=[{"name":"crafting_table","position":pos(2,64,0)}],resources={"iron":[block("iron_ore")]}), "工具等级不够，先制作石镐再挖铁。"),
      example("缺燃料时先采可达煤矿", {"action":"mine","resource":"coal","count":3}, state({"raw_iron":3,"furnace":1,"stone_pickaxe":1},y=45,resources={"coal":[block("coal_ore",3,45,0)]},failures=[{"action":{"action":"smelt","item":"raw_iron","count":3},"error":"Need sufficient fuel"}]), "熔炉缺燃料，先采附近煤炭以避免重试失败熔炼。"),
      example("熔炼后铁锭充足即可制铁镐", {"action":"craft","item":"iron_pickaxe","count":1}, state({"iron_ingot":4,"stick":2},stations=[{"name":"crafting_table","position":pos(1,64,0)}],craftable=[{"item":"iron_pickaxe","outputPerCraft":1,"requiresTable":True}]), "铁锭和木棍满足铁镐配方，制作后再寻找钻石。"),
      example("仅石镐但铁锭燃料原料可熔炼", {"action":"smelt","item":"raw_iron","count":3}, state({"raw_iron":3,"coal":2,"furnace":1,"stone_pickaxe":1}), "已有熔炉、燃料和生铁，先熔炼出制作铁镐所需的铁锭。"),
      example("钻石可见但只有石镐且生铁未熔", {"action":"smelt","item":"raw_iron","count":3}, state({"raw_iron":3,"coal":2,"furnace":1,"stone_pickaxe":1},y=20,resources={"diamond":[block("diamond_ore",4,20,2)]}), "钻石需铁镐；先熔炼现有生铁，后续制作铁镐。"),
      example("钻石可见且铁镐、火把、食物齐备", {"action":"mine","resource":"diamond","count":3}, state({"iron_pickaxe":1,"torch":8,"cooked_beef":3},y=18,resources={"diamond":[block("diamond_ore",4,18,2)]}), "铁镐满足钻石采集等级，当前生命食物及照明充足。"),
      example("钻石已收集并有木棍和工作台", {"action":"craft","item":"diamond_pickaxe","count":1}, state({"diamond":3,"stick":2},stations=[{"name":"crafting_table","position":pos(1,64,0)}],craftable=[{"item":"diamond_pickaxe","outputPerCraft":1,"requiresTable":True}]), "钻石和木棍足够制作钻石镐，之后才能采黑曜石。"),
      example("仅铁镐看到黑曜石不可直接开采", {"action":"explore","direction":"east","distance":16}, state({"iron_pickaxe":1,"torch":6,"bread":2},y=30,resources={"obsidian":[block("obsidian",4,30,1)]}), "黑曜石需要钻石镐；避免无效挖掘，先推进钻石工具路线。"),
      example("钻石镐和安全位置可采黑曜石", {"action":"mine","resource":"obsidian","count":10}, state({"diamond_pickaxe":1,"torch":8,"cooked_beef":4},y=24,resources={"obsidian":[block("obsidian",4,24,1)]}), "钻石镐满足等级，周围无危险且资源可达。"),
      example("铁矿旁有岩浆且生命尚可，不能冒险挖", {"action":"explore","direction":"north","distance":16}, state({"stone_pickaxe":1,"torch":5,"bread":2},y=34,hazards=[{"name":"lava","position":pos(1,34,0)}],resources={"iron":[block("iron_ore",2,34,0)]}), "暴露岩浆构成紧邻危险，改找安全矿脉，不在危险边挖掘。"),
      example("饥饿偏低且有熟食，先补给再下矿", {"action":"eat"}, state({"stone_pickaxe":1,"cooked_beef":2,"torch":4},food=6,y=54,resources={"iron":[block("iron_ore",3,54,0)]}), "饥饿值偏低且背包有安全食物，先吃再下矿。"),
      example("饥饿很低无食物但白天有牛", {"action":"hunt","count":1}, state({"stone_pickaxe":1,"torch":4},food=5,y=64,resources={"iron":[block("iron_ore")]}), "无食物时不继续下矿；白天附近有被动动物可补充食物。"),
      example("夜间低生命且附近敌对生物", {"action":"flee"}, state({"stone_pickaxe":1,"bread":2,"torch":3},health=8,food=12,day=False,threats=[{"id":2,"name":"zombie","distance":5,"position":pos(4,64,2)}],resources={"iron":[block("iron_ore")]}), "夜间敌对威胁优先于采矿，先撤离。"),
      example("暴露矿石上方有悬空沙砾危险", {"action":"explore","direction":"west","distance":16}, state({"stone_pickaxe":1,"torch":5,"bread":2},y=42,hazards=[{"name":"gravel","position":pos(3,43,0)}],resources={"iron":[block("iron_ore",3,42,0)]}), "沙砾落下有危险，不在其下方开采，转向寻找安全路线。"),
      example("安全下降到钻石层且有火把和食物", {"action":"dig_staircase","direction":"south","steps":4}, state({"iron_pickaxe":1,"torch":8,"bread":4},health=18,food=15,y=54), "镐、生命、饥饿和照明满足楼梯条件；按四步小段下降并重新观察。"),
      example("低于y50但火把不足以继续下楼梯", {"action":"craft","item":"torch","count":4}, state({"stone_pickaxe":1,"coal":1,"stick":4},health=16,food=13,y=48,stations=[{"name":"crafting_table","position":pos(1,48,0)}],hints=[{"item":"torch","missing":[],"oneRecipeExample":True}]), "低于y50继续下降需要火把；先补照明再下楼梯。"),
      example("低于挖掘安全生命门槛，不执行楼梯", {"action":"eat"}, state({"stone_pickaxe":1,"bread":2,"torch":8},health=10,food=8,y=52), "楼梯要求生命至少12且饥饿至少10；先恢复状态。"),
      example("正前方未探索，楼梯可按合法步数短段推进", {"action":"dig_staircase","direction":"east","steps":2}, state({"stone_pickaxe":1,"torch":2,"bread":3},health=17,food=13,y=60), "工具和生命食物满足条件，短段推进便于检查环境。"),
      example("前方存在水体，禁止继续挖楼梯", {"action":"explore","direction":"north","distance":16}, state({"stone_pickaxe":1,"torch":6,"bread":3},health=18,food=14,y=50,hazards=[{"name":"water","position":pos(0,49,-1)}]), "前方液体使楼梯挖掘不安全，改找路线。"),
      example("铁桶和安全可达天然水源", {"action":"collect_water"}, state({"bucket":1},fluids={"water":[{"position":pos(4,64,0),"distance":4}],"lava":[]}), "有空桶和可达水源，收集水后用于岩浆冷却。"),
      example("有水桶且能看到岸边岩浆源", {"action":"place_water"}, state({"water_bucket":1},fluids={"water":[],"lava":[{"position":pos(5,64,0),"distance":5}]}), "水桶和可见岩浆源满足冷却条件，放水后验证生成黑曜石并回收。"),
      example("铁镐见黑曜石但不具备钻石镐", {"action":"craft","item":"diamond_pickaxe","count":1}, state({"diamond":3,"stick":2,"iron_pickaxe":1},stations=[{"name":"crafting_table","position":pos(1,64,0)}],craftable=[{"item":"diamond_pickaxe","outputPerCraft":1,"requiresTable":True}]), "黑曜石需要钻石镐，现有材料能制作，先制作正确工具。"),
      example("采矿工具耐久未知，先观察更新状态", {"action":"observe"}, state({"iron_pickaxe":1,"torch":6,"bread":3},y=20,resources={"diamond":[block("diamond_ore",3,20,0)]}), "状态缺少工具耐久和通道信息，下矿前重新观察。"),
      example("连续两次铁矿失败且无可见铁矿", {"action":"explore","direction":"southwest","distance":24}, state({"stone_pickaxe":1,"torch":5},resources={"iron":[]},failures=[{"action":{"action":"mine","resource":"iron","count":4},"error":"No safe exposed iron found"}]), "不重复失败挖掘，换未探索方向寻找铁矿。"),
      example("身处下界且附近有威胁，暂停搜矿", {"action":"flee"}, state({"iron_pickaxe":1,"bread":3,"torch":4},health=14,food=12,dimension="the_nether",threats=[{"id":7,"name":"ghast","distance":12,"position":pos(10,70,5)}]), "进入下界后先处理当前威胁，不能继续冒险采矿。"),
    ]
    return e

def live_recovery_examples():
    # Preserve the exact held-out-from-v1 real probe as a training correction,
    # including the rich observe object and failed-action history.
    probe_path=ROOT/"output/minecraft-training/live-probe-1791830746219.json"
    probe=json.loads(probe_path.read_text(encoding="utf-8"))
    source=json.loads(probe["messages"][1]["content"])
    action={"action":"gather_wood","count":12}
    rows=[example("实机纠偏：满饥饿空背包、多次hunt无动物但21格有原木",action,source["state"],
        "最近多次狩猎因附近没有被动动物失败；饥饿20且无需食物，近处有多组可达云杉原木。停止无效hunt，先收集原木推进工具材料。",
        "real; read-only live probe, action independently reviewed from observed inventory/resources/history",
        recent_results=source["recentResults"],user_payload=source)]
    def s(*,wood=True,table=True,failures=3,explored="northwest", food=20, logs=0, planks=0, station=True):
        state0=state({"oak_log":logs,"oak_planks":planks} if logs or planks else {},food=food,day=False,
            resources={"wood":[block("birch_log",12,64,5),block("oak_log",16,64,-3)] if wood else [],"iron":[block("iron_ore",28,39,9)]},
            stations=[{"name":"crafting_table","position":pos(-10,63,2)}] if station else [],
            failures=[{"action":{"action":"hunt","count":3},"error":"No nearby passive animals; explore"} for _ in range(failures)])
        state0["recentExploration"]=[{"direction":explored,"distance":32}]
        return state0
    rows += [
      example("实机近似开发：空背包、夜间满食物、木材近、hunt连续失败",{"action":"gather_wood","count":8},s(),"不需觅食；停止失败hunt，采集可达木材。","synthetic; independent real-probe-like development scenario",recent_results=[{"action":{"action":"hunt","count":3},"status":"failed","error":"No nearby passive animals; explore"}]*3),
      example("实机近似开发：鱼实体不等于可狩猎动物、无木材且空背包",{"action":"explore","direction":"south","distance":24},s(wood=False,explored="northwest"),"没有被动猎物和可见木材，换未探索方向寻找资源，不重复hunt。","synthetic; independent real-probe-like development scenario",recent_results=[{"action":{"action":"hunt","count":3},"status":"failed","error":"No nearby passive animals; explore"}]*2),
      example("资源消耗：原木已转为木板，空木材节点但可制作木棍",{"action":"craft","item":"stick","count":4},s(wood=False,logs=0,planks=8),"原木库存已消耗成木板；不再采集木材或重复工作台，直接制作木棍。","synthetic; material-consumption recovery scenario",recent_results=[{"action":{"action":"craft","item":"planks","count":8},"status":"success","result":{"gained":{"oak_planks":8}}}]),
      example("资源消耗：完成木镐后仅剩一块木板与已放置工作台",{"action":"gather_wood","count":5},s(wood=True,planks=1,station=True),"库存材料已用于工具，仍有附近原木可采集；先补充木材，为后续木棍和火把储备。","synthetic; material-consumption recovery scenario",recent_results=[{"action":{"action":"craft","item":"wooden_pickaxe","count":1},"status":"success","result":{"complete":True}}]),
      example("无动物、无安全食物但饥饿尚满，附近木材充足",{"action":"gather_wood","count":6},s(wood=True,food=20),"满饥饿时无需hunt；采木推进生存路线。","synthetic; independent real-probe-like development scenario"),
      example("饥饿降低且无食物/动物，夜间木材可达",{"action":"gather_wood","count":4},s(wood=True,food=16),"没有被动动物时hunt不可行；当前仍可采集近处木材，同时避免把满食物以外状态硬编码为hunt。","synthetic; independent real-probe-like development scenario"),
    ]
    return rows

def dev_examples():
    return [
      example("开发-圆石恰好满足石镐配方",{"action":"craft","item":"stone_pickaxe","count":1},state({"cobblestone":3,"stick":2},stations=[{"name":"crafting_table","position":pos(2,64,1)}],craftable=[{"item":"stone_pickaxe","outputPerCraft":1,"requiresTable":True}]),"配方材料齐全，升级工具。","synthetic; held-out development scenario"),
      example("开发-圆石不足且附近石块安全",{"action":"mine","resource":"stone","count":2},state({"wooden_pickaxe":1,"cobblestone":1,"stick":2},resources={"stone":[block("stone",3,64,0)]}),"先补少量圆石。","synthetic; held-out development scenario"),
      example("开发-铁镐可采远处钻石但食物不足",{"action":"eat"},state({"iron_pickaxe":1,"bread":1,"torch":8},food=7,y=18,resources={"diamond":[block("diamond_ore",8,18,2)]}),"先补充食物。","synthetic; held-out development scenario"),
      example("开发-只有石镐但足够铁锭木棍",{"action":"craft","item":"iron_pickaxe","count":1},state({"iron_ingot":3,"stick":2},stations=[{"name":"crafting_table","position":pos(1,64,0)}]),"制作铁镐推进钻石路线。","synthetic; held-out development scenario"),
      example("开发-楼梯条件满足且下降八步仍合法",{"action":"dig_staircase","direction":"west","steps":8},state({"iron_pickaxe":1,"torch":8,"cooked_porkchop":3},health=20,food=18,y=61),"允许1至8步且准备充分。","synthetic; held-out development scenario"),
      example("开发-敌人近且工具食物充足",{"action":"flee"},state({"stone_pickaxe":1,"bread":4},health=19,food=16,threats=[{"id":9,"name":"skeleton","distance":4,"position":pos(3,64,1)}]),"威胁优先。","synthetic; held-out development scenario"),
      example("开发-附近只有钻石矿但无铁镐也无铁锭",{"action":"explore","direction":"northwest","distance":24},state({"stone_pickaxe":1,"torch":6},y=14,resources={"diamond":[block("diamond_ore",4,14,3)]}),"不使用低级工具挖钻石，探索寻找铁矿或安全补给。","synthetic; held-out development scenario"),
      example("开发-低于y50且火把充足继续小段楼梯",{"action":"dig_staircase","direction":"north","steps":3},state({"stone_pickaxe":1,"torch":4,"bread":2},health=15,food=12,y=47),"火把和生命食物达标，合法短段下降。","synthetic; held-out development scenario"),
      example("开发-危险低血量且无食物",{"action":"flee"},state({"wooden_pickaxe":1},health=6,food=12,threats=[{"id":10,"name":"creeper","distance":9,"position":pos(6,64,5)}]),"低血量并有苦力怕，撤离。","synthetic; held-out development scenario"),
      example("开发-熔炉燃料充足且铁矿待熔",{"action":"smelt","item":"iron_ore","count":2},state({"iron_ore":2,"charcoal":2,"furnace":1}),"现有燃料和熔炉可用。","synthetic; held-out development scenario"),
      example("开发-可见铁矿但处于岩浆边",{"action":"explore","direction":"east","distance":16},state({"stone_pickaxe":1,"torch":4},y=32,hazards=[{"name":"lava","position":pos(0,32,1)}],resources={"iron":[block("iron_ore",0,32,2)]}),"不在岩浆旁挖掘。","synthetic; held-out development scenario"),
      example("开发-只有空桶无水源",{"action":"explore","direction":"south","distance":16},state({"bucket":1},fluids={"water":[],"lava":[]}),"无水源时探索而非执行不可行收水。","synthetic; held-out development scenario"),
      example("开发-地面水源存在但桶已装水",{"action":"place_water"},state({"water_bucket":1},fluids={"water":[],"lava":[{"position":pos(5,63,0),"distance":5}]}),"水桶可用于岩浆源冷却。","synthetic; held-out development scenario"),
      example("开发-工作台已放置无需重复制作",{"action":"craft","item":"wooden_pickaxe","count":1},state({"oak_planks":3,"stick":2},stations=[{"name":"crafting_table","position":pos(1,64,0)}],craftable=[{"item":"wooden_pickaxe","outputPerCraft":1,"requiresTable":True}]),"按现有配方制作木镐。","synthetic; held-out development scenario"),
      example("开发-目前无可见石材但已访问方向",{"action":"explore","direction":"southeast","distance":32},state({"wooden_pickaxe":1},resources={"stone":[]}),"资源不可见时探索并避免已访问路线。","synthetic; held-out development scenario"),
      example("开发-空饥饿条有苹果",{"action":"eat"},state({"apple":2,"iron_pickaxe":1},food=4),"先吃现有安全食物。","synthetic; held-out development scenario"),
      example("开发-钻石镐可采暴露黑曜石",{"action":"mine","resource":"obsidian","count":6},state({"diamond_pickaxe":1,"torch":6,"bread":3},y=25,resources={"obsidian":[block("obsidian",4,25,0)]}),"工具满足黑曜石采集要求。","synthetic; held-out development scenario"),
      example("开发-楼梯步数不必走满",{"action":"dig_staircase","direction":"south","steps":1},state({"stone_pickaxe":1,"torch":1,"bread":2},health=12,food=10,y=52),"最低生命与饥饿边界仍满足楼梯要求，执行一格并复查。","synthetic; held-out development scenario"),
      example("开发-夜间且无敌人但生命充足",{"action":"flee"},state({"stone_pickaxe":1,"torch":3},health=18,food=14,day=False,y=30),"夜间避免无必要深入危险洞穴，返回安全点。","synthetic; held-out development scenario"),
      example("开发-铁镐与火把准备充分且铁矿不可见",{"action":"explore","direction":"northeast","distance":24},state({"iron_pickaxe":1,"torch":10,"bread":4},y=20,resources={"diamond":[]}),"目标矿物不可见时探索新区域。","synthetic; held-out development scenario"),
      example("开发-只有木镐对煤矿可行",{"action":"mine","resource":"coal","count":3},state({"wooden_pickaxe":1,"torch":2},resources={"coal":[block("coal_ore",3,62,1)]}),"木镐可采煤，少量收集燃料。","synthetic; held-out development scenario"),
      example("开发-状态显示采矿失败工具等级不足",{"action":"craft","item":"stone_pickaxe","count":1},state({"wooden_pickaxe":1,"cobblestone":4,"stick":2},stations=[{"name":"crafting_table","position":pos(1,64,0)}],failures=[{"action":{"action":"mine","resource":"iron","count":3},"error":"Missing correct tool for iron_ore"}]),"根据失败原因升级至石镐，不重试铁矿。","synthetic; held-out development scenario"),
      example("开发-夜间低饥饿并有面包",{"action":"eat"},state({"bread":2},food=6,day=False),"有食物先恢复饥饿。","synthetic; held-out development scenario"),
      example("开发-已处于下界且火把不足",{"action":"craft","item":"torch","count":8},state({"coal":2,"stick":4,"iron_pickaxe":1},dimension="the_nether",stations=[{"name":"crafting_table","position":pos(1,64,0)}],craftable=[{"item":"torch","outputPerCraft":4,"requiresTable":False}]),"补充照明后再探索。","synthetic; held-out development scenario"),
    ]

def serialize(rows, contract, name):
    output=[]
    schema=contract["schema"]
    prepared=[]
    for row in rows:
        s=json.loads(json.dumps(row["state"]))
        # The independent frontend recovery scenarios omit player position;
        # anchor those synthetic examples at spawn so observed block distances
        # can be recomputed consistently instead of trusting stale estimates.
        s.setdefault("position",{"x":0,"y":64,"z":0})
        player=s.get("position") or {}
        def fix_distances(node):
            if isinstance(node,dict):
                p=node.get("position")
                if isinstance(p,dict) and "distance" in node and all(k in p and k in player for k in ("x","y","z")):
                    node["distance"]=round(math.sqrt(sum((float(p[k])-float(player[k]))**2 for k in ("x","y","z"))))
                for value in node.values(): fix_distances(value)
            elif isinstance(node,list):
                for value in node: fix_distances(value)
        fix_distances(s)
        prepared.append(s)
    # Match the runtime's v2 input compaction exactly: drop session/log and
    # reactive entity noise while keeping planning-relevant observed fields.
    compacted=json.loads(subprocess.check_output(["node",str(ROOT/"scripts/minecraft-training/compact_observations.js")],
        input=json.dumps(prepared,ensure_ascii=False,separators=(",",":")).encode("utf-8"),cwd=ROOT))
    for i,(row,s) in enumerate(zip(rows,compacted),1):
        action=row["action"]
        branch=next((x for x in schema["oneOf"] if x["properties"]["action"].get("const")==action.get("action")),None)
        if branch is None or set(action)!=set(branch["properties"]): raise ValueError(f"{name} {i}: invalid action shape {action}")
        for field,rule in branch["properties"].items():
            if "enum" in rule and action[field] not in rule["enum"]: raise ValueError(f"{name} {i}: invalid {field}={action[field]}")
            if rule.get("type")=="integer" and (type(action[field]) is not int or not rule["minimum"]<=action[field]<=rule["maximum"]): raise ValueError(f"{name} {i}: invalid {field} range")
        source_payload=row.get("userPayload") or {"goal":GOAL,"state":s,"recentResults":row.get("recentResults",[])}
        user={**source_payload,"state":s}
        output.append({"id":f"{name}-{i:04d}","scenario":row["scenario"],"provenance":row["provenance"],"rationale":row["rationale"],"action":action,"state":s,"messages":[
            {"role":"system","content":contract["system"]},
            {"role":"user","content":json.dumps(user,ensure_ascii=False,separators=(",",":"))},
            {"role":"assistant","content":json.dumps(action,ensure_ascii=False,separators=(",",":"))}]})
    path=DATA/f"{name}.jsonl"
    path.write_text("".join(json.dumps(x,ensure_ascii=False,separators=(",",":"))+"\n" for x in output),encoding="utf-8",newline="\n")
    print(f"{path.relative_to(ROOT)}: {len(output)} records")
    return output

def main():
    if not CONTRACT.exists(): subprocess.check_call(["python",str(ROOT/"scripts/minecraft-training/freeze_v2_contract.py")],cwd=ROOT)
    c=json.loads(CONTRACT.read_text(encoding="utf-8"))
    original=[json.loads(line) for line in (DATA/"train.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    v1_hash=hashlib.sha256((DATA/"train.jsonl").read_bytes()).hexdigest()
    base=[]
    for r in original:
        action=r["action"]
        base.append(example(f"v1 synthetic seed: {r['scenario']}",action,r["state"],"将v1场景迁移至冻结v2决策契约；标签保持原子动作，不把旧holdout纳入训练。","synthetic; migrated v1 training example"))
    recovery=json.loads((DATA/"recovery-v2-scenarios.json").read_text(encoding="utf-8"))["records"]
    rec=[example(r["scenario"],r["action"],r["state"],r["rationale"],r["provenance"]) for r in recovery]
    progression=progression_examples()
    live=live_recovery_examples()
    # Keep the exact real probe as a development regression test. Train only
    # on independent, similar synthetic states so it remains a meaningful check.
    train=base+rec+progression+live[1:5]
    dev=dev_examples()+[live[0],live[5]]
    serialize(train,c,"train-v2")
    serialize(dev,c,"development-v2")
    manifest={"name":"minecraft-survival-policy-lora-v2","contract":"data/minecraft-training/contract-v2.json","contract_sha256":hashlib.sha256(CONTRACT.read_bytes()).hexdigest(),
      "train_examples":len(train),"development_examples":len(dev),"holdout_examples":20,"synthetic_only":True,
      "training_composition":{"migrated_v1_training":len(base),"recovery_v2_hand_authored":len(rec),"tool_tier_and_safe_mining":len(progression),"rich_state_live_probe_analogs":len(live[1:5])},
      "development_policy":"Fresh hand-authored development set for checkpoint selection, including the exact read-only live probe and a separate similar scenario; neither is used in training. Keep final independent holdout evaluation separate and do not tune on it.",
      "v1_holdout_in_training":False,"v1_train_jsonl_sha256_before":v1_hash,
      "sources":{"v1_training":"data/minecraft-training/train.jsonl","recovery_v2":"data/minecraft-training/recovery-v2-scenarios.json","real_live_probe_dev":"output/minecraft-training/live-probe-1791830746219.json"},
      "all_training_examples_synthetic":True,"development_includes_real_case":True,
      "v1_examples_derived":True,"normalization":"All generated train/dev states receive an explicit synthetic origin position when absent, distances are recomputed from state.position, then states are compacted with survival-planner.compactObservation; this removes runtime-only and reactive entity noise.",
      "limits":"Synthetic action-label agreement plus one real read-only regression prompt; neither measures Mineflayer execution success or broad generalization. Keep v1 train.jsonl and holdout.jsonl unchanged."}
    (DATA/"manifest-v2.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(f"manifest-v2.json: {json.dumps(manifest['training_composition'],ensure_ascii=False)}")

if __name__=="__main__": main()
