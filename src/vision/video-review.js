const fs = require('node:fs/promises');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../../runtime/vision/video-runs');
async function handleVideoReview(req,res,url,{send}) {
  if(!url.pathname.startsWith('/api/vision/video-runs/')) return false;
  const match=url.pathname.match(/^\/api\/vision\/video-runs\/(settings-\d{8}-\d{6})\/(bundle\.json|timeline\.json|analysis\.json|frames\.json|images\/frame-\d{6}\.png|derived\/[a-z0-9-]+\.png)$/);
  if(req.method!=='GET'||!match){send(res,404,{error:'Not found'});return true;}
  try {
    const bytes=await fs.readFile(path.join(ROOT,match[1],match[2]));
    res.writeHead(200,{'Content-Type':match[2].endsWith('.png')?'image/png':'application/json; charset=utf-8','Cache-Control':'no-cache'});res.end(bytes);
  }catch(e){send(res,e.code==='ENOENT'?404:500,{error:'Unable to read video artifact'});}
  return true;
}
module.exports={handleVideoReview};
