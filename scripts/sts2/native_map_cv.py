"""Pixel candidates for local map-reader diagnostics; never choose a game action."""
def map_candidates(image):
    import cv2
    import numpy as np
    rgb=np.asarray(image.convert('RGB'))
    height,width=rgb.shape[:2]
    hsv=cv2.cvtColor(rgb,cv2.COLOR_RGB2HSV)
    gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    roi=np.zeros((height,width),dtype=np.uint8)
    roi[round(height*.12):round(height*.95),round(width*.12):round(width*.82)]=255
    red=(((hsv[:,:,0]<12)|(hsv[:,:,0]>170))&(hsv[:,:,1]>130)&(hsv[:,:,2]>100)).astype('uint8')*255
    dark=((gray<85)&(red==0)).astype('uint8')*255
    def components(mask,prefix):
        mask=cv2.bitwise_and(mask,roi)
        mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((3,3),dtype='uint8'))
        _,_,stats,centroids=cv2.connectedComponentsWithStats(mask)
        candidates=[]
        for (x,y,w,h,area),(cx,cy) in zip(stats[1:],centroids[1:]):
            if area<40 or not .005*width<=w<=.08*width or not .008*height<=h<=.14*height:continue
            candidates.append({'id':prefix+str(len(candidates)+1),'point':[round((x+w/2)/width*1000),round((y+h/2)/height*1000)],'box':[int(x),int(y),int(w),int(h)],'area':int(area)})
        return candidates[:80]
    return {'red':components(red,'R'),'dark':components(dark,'N'),'image_size':[width,height],'verification':'pixel_candidates_only_not_game_targets'}

def local_candidates(candidates):
    if len(candidates['red'])!=1:raise ValueError('Current red marker is ambiguous')
    marker=candidates['red'][0]
    return {**candidates,'dark':[node for node in candidates['dark'] if 15<=marker['point'][1]-node['point'][1]<=350]}

def annotate_candidates(image, candidates, focus=False):
    from PIL import ImageDraw, ImageFont
    annotated=image.copy()
    draw=ImageDraw.Draw(annotated)
    font=ImageFont.load_default(size=18)
    for candidate in candidates['red']+candidates['dark']:
        x,y,w,h=candidate['box']; color='red' if candidate['id'].startswith('R') else '#0075ff'
        draw.rectangle((x-2,y-2,x+w+2,y+h+2),outline=color,width=2)
        label=candidate['id'];box=draw.textbbox((x+w+4,y),label,font=font)
        draw.rectangle(box,fill='white');draw.text((x+w+4,y),label,font=font,fill=color)
    if focus:
        boxes=[item['box'] for item in candidates['red']+candidates['dark']]
        if not boxes:raise ValueError('No map candidates to inspect')
        x0=max(0,min(b[0] for b in boxes)-120);y0=max(0,min(b[1] for b in boxes)-70)
        x1=min(image.width,max(b[0]+b[2] for b in boxes)+140);y1=min(image.height,max(b[1]+b[3] for b in boxes)+100)
        annotated=annotated.crop((x0,y0,x1,y1))
        # Enlarge the small map marks for the local reader; CV coordinates remain
        # tied to the original frame and are never inferred from this preview.
        ratio=min(3,1000/max(annotated.size))
        annotated=annotated.resize((round(annotated.width*ratio),round(annotated.height*ratio)))
    return annotated

def map_observation(selected, candidates):
    """Accept model-selected IDs only; position always comes from pixel geometry."""
    if not isinstance(selected,dict):raise ValueError('Map selection must be an object')
    markers={item['id']:item for item in candidates['red']}
    nodes={item['id']:item for item in candidates['dark']}
    marker=markers.get(selected.get('marker_id'))
    if marker is None or selected.get('marker_confirmed') is not True:
        raise ValueError('Local model did not confirm a detected current marker')
    links=selected.get('next_nodes')
    if not isinstance(links,list) or not 1<=len(links)<=5:raise ValueError('No bounded visible next nodes')
    targets=[];seen=set()
    for link in links:
        if not isinstance(link,dict):raise ValueError('Invalid map link')
        node=nodes.get(link.get('id'))
        if node is None or node['id'] in seen or link.get('directly_connected') is not True:
            raise ValueError('Map node is absent, duplicated or not visibly connected')
        label=link.get('label')
        if not isinstance(label,str) or not label.strip() or len(label)>80:raise ValueError('Missing visible node label')
        # Current/completed nodes below the marker cannot be the next upper row.
        if not 15<=marker['point'][1]-node['point'][1]<=350:raise ValueError('Node is not above the current marker')
        seen.add(node['id'])
        targets.append({'id':node['id'],'label':label,'point':node['point'],'enabled':True,'grounding':'local_cv_qwen','directly_connected':True})
    return {'scene':'map','summary':'本地模型依据标注图报告当前位置标记及直接相连的下一层像素候选；进入结果待后续画面验证。','targets':targets,'map_grounding':{'source':'local_cv_qwen','marker_id':marker['id'],'marker_point':marker['point']}}
