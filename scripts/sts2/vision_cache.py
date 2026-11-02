"""Bounded raw perception reuse for identical displayed pixels and instructions."""
from collections import OrderedDict
import hashlib,time

def cacheable(parsed,mode=None,target=False):
    if not isinstance(parsed,dict):return False
    if target:return parsed.get('target_visible') is True and isinstance(parsed.get('target_center'),list)
    if mode=='energy':return type(parsed.get('energy')) is int
    if mode in ('player','player-hud'):
        return all(type(parsed.get('player',{}).get(k)) is int for k in ('hp','max_hp'))
    if mode in (None,'card'):return parsed.get('uncertain') is False and len(parsed.get('cards',[]))==1
    if mode=='scene':return parsed.get('scene') not in (None,'unknown') and isinstance(parsed.get('targets'),list)
    return parsed.get('scene') in ('battle','map') and bool(parsed.get('targets'))

class VisionCache:
    def __init__(self,limit=64,ttl=60,clock=time.monotonic):
        self.limit,self.ttl,self.clock=limit,ttl,clock
        self.items=OrderedDict()
    def key(self,image,prompt,provider):
        digest=hashlib.sha256()
        digest.update(repr((image.mode,image.size,provider,prompt)).encode('utf-8'))
        digest.update(image.tobytes())
        return digest.hexdigest()
    def get(self,key):
        item=self.items.get(key)
        if item is None:return None
        at,value=item
        if self.clock()-at>self.ttl:
            del self.items[key];return None
        self.items.move_to_end(key)
        return dict(value)
    def put(self,key,value):
        self.items[key]=(self.clock(),dict(value));self.items.move_to_end(key)
        while len(self.items)>self.limit:self.items.popitem(last=False)
