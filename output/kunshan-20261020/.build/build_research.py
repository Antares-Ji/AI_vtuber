from pathlib import Path
import json
import research_sections as add
from research_manual import BODY

root=Path(__file__).resolve().parent
base=(root/'revise_plan.py').read_text(encoding='utf-8')
source=base
def replace_section(src,a,b,new):
    i=src.index(a);j=src.index(b,i+len(a))
    return src[:i]+new+'\n'+src[j:]

source=replace_section(source,'chapter(contents[1])','chapter(contents[2])',add.MARKET)
source=replace_section(source,'chapter(contents[2])','chapter(contents[3])',add.COMPETITION)
source=source.replace('chapter(contents[4])',add.PRODUCT+'\nchapter(contents[4])',1)
source=source.replace('chapter(contents[5])',add.TECH+'\nchapter(contents[5])',1)
source=replace_section(source,'chapter(contents[8])','chapter(contents[9])',add.SURVEY)
source=source.replace('assert chapters==contents',add.REFERENCES+'\nassert chapters==contents',1)
helper="\ndef nextpage(title):\n    doc.add_page_break()\n    doc.add_heading(title,1)\n\n"
source=source.replace('# The revised plan follows',helper+'# The revised plan follows',1)
counts=[1,2,4,2,2,1,1,1,2,1,1,1,1,1,1,1,1,4]
pages=[];n=3
for count in counts:
    pages.append(n);n+=count
source=source.replace("for i,title in enumerate(contents):",f"toc_pages={pages!r}\nfor i,title in enumerate(contents):",1)
source=source.replace("str(i+3)","str(toc_pages[i])",1)
source=source.replace("r = footer.add_run('2026年10月20日    ')","r = footer.add_run('2026年10月21日    ')")
source=source.replace('公开数据检索日期为2026年10月20日。','公开资料检索更新至2026年10月21日。')
source=source.replace("(ROOT/'.build/outline-revised.json')","(ROOT/'.build/outline-research.json')")
(root/'research_generated.py').write_text(source,encoding='utf-8')
exec(compile(source,str(root/'research_generated.py'),'exec'),{'__file__':str(root/'research_generated.py'),'__name__':'__main__'})

prefix=base.split('# The revised plan follows')[0]
prefix=prefix.replace("r = footer.add_run('2026年10月20日    ')","r = footer.add_run('2026年10月21日    ')")
prefix=prefix.replace('潮生智能    姬岁歌AI虚拟主播商业计划书','潮生智能    姬岁歌受众调研与内部试播')
suffix="""
OUT=ROOT/'final'/'姬岁歌-受众调研与内部试播执行手册.docx'
doc.core_properties.title='姬岁歌受众调研与内部试播执行手册'
doc.core_properties.subject='首轮30人研究方案与问卷记录模板'
doc.core_properties.author='潮生智能团队'
doc.save(OUT)
print(OUT)
"""
manual=prefix+BODY+suffix
(root/'manual_generated.py').write_text(manual,encoding='utf-8')
exec(compile(manual,str(root/'manual_generated.py'),'exec'),{'__file__':str(root/'manual_generated.py'),'__name__':'__main__'})
(root/'research-pagination.json').write_text(json.dumps({'chapter_starts':pages,'expected_pages':n-1,'manual_expected_pages':8},ensure_ascii=False,indent=2),encoding='utf-8')
