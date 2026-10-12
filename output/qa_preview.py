from pathlib import Path
from html import escape
from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph

root=Path(r'E:\Github\AI_vtuber\output\qa')
root.mkdir(exist_ok=True,parents=True)
for f in Path(r'E:\Github\AI_vtuber\output').glob('AI主播*.docx'):
    d=Document(f)
    pieces=[]
    for item in d.iter_inner_content():
        if isinstance(item,Paragraph):
            t=escape(item.text)
            if not t.strip(): continue
            if item.style.name=='Title': tag='h1'
            elif item.style.name=='Heading 1': tag='h2'
            elif item.style.name=='Heading 2': tag='h3'
            else: tag='p'
            if item.style.name=='List Bullet': t='• '+t
            if item.style.name=='List Number': t='1. '+t
            pieces.append(f'<{tag}>{t}</{tag}>')
        elif isinstance(item,Table):
            rows=[]
            for i,row in enumerate(item.rows):
                tag='th' if i==0 else 'td'
                rows.append('<tr>'+''.join(f'<{tag}>{escape(c.text)}</{tag}>' for c in row.cells)+'</tr>')
            pieces.append('<table>'+''.join(rows)+'</table>')
    if '原创角色' in f.stem:
        img=Path(r'E:\Github\AI_vtuber\docs\design\汐音原创角色视觉概念图-2026-09-29.png')
        pieces.append('<img style="display:block;max-width:5.9in;max-height:7in;margin:auto;break-inside:avoid" src="'+img.as_uri()+'">')
    css='''@page{size:letter;margin:.75in .78in .7in}body{font-family:"Microsoft YaHei",sans-serif;font-size:10.5pt;line-height:1.2;color:#000}h1{font-size:19pt;margin:0 0 13pt}h2{font-size:14pt;margin:14pt 0 5pt;break-after:avoid}h3{font-size:11.5pt;margin:8pt 0 5pt;break-after:avoid}p{margin:0 0 5pt}table{width:100%;border-collapse:collapse;margin:5pt 0 9pt;font-size:9pt;line-height:1.12}th,td{border:1px solid #d9d9d9;padding:5px;vertical-align:middle;text-align:left}th{background:#dceaf4}tr:nth-child(odd):not(:first-child){background:#f8fafc}tr{break-inside:avoid}thead{display:table-header-group}'''
    out=root/(f.stem+'.html')
    out.write_text('<!doctype html><html lang="zh"><meta charset="utf-8"><style>'+css+'</style><body>'+''.join(pieces)+'</body></html>',encoding='utf-8')
    print(out)
