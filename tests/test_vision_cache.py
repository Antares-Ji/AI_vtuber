import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from vision_cache import VisionCache
from PIL import Image

class CacheTests(unittest.TestCase):
    def test_reuse_requires_identical_pixels_prompt_and_provider(self):
        cache=VisionCache();im=Image.new('RGB',(30,30),'white')
        key=cache.key(im,'read','cloud');cache.put(key,{'raw':'{}','record':'source'})
        self.assertEqual(cache.get(cache.key(im.copy(),'read','cloud'))['record'],'source')
        changed=im.copy();changed.putpixel((5,5),(254,255,255))
        for other in [cache.key(changed,'read','cloud'),cache.key(im,'different','cloud'),cache.key(im,'read','local')]:
            self.assertIsNone(cache.get(other))
    def test_ttl_and_lru_are_bounded_without_refresh_on_read(self):
        now=[0];cache=VisionCache(limit=2,ttl=5,clock=lambda:now[0])
        cache.put('a',{'raw':'a'});cache.put('b',{'raw':'b'});cache.get('a');cache.put('c',{'raw':'c'})
        self.assertIsNone(cache.get('b'));now[0]=6;self.assertIsNone(cache.get('a'))
        self.assertIsNone(cache.get('c'))
if __name__=='__main__':unittest.main()
