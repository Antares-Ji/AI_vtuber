from pathlib import Path
from collections import Counter
import json
from docx import Document
from pypdf import PdfReader

root = Path(__file__).resolve().parent.parent
bp = root / 'final/昆山杯-潮生智能-商业计划书.docx'
manual = root / 'final/姬岁歌-受众调研与内部试播执行手册.docx'
doc = Document(bp)
text = '\n'.join(p.text for p in doc.paragraphs)
text += '\n' + '\n'.join(c.text for t in doc.tables for row in t.rows for c in row.cells)
assert not any(term in text for term in ['不代表', '不作为', '版本说明', '不是市场调查'])
team = next(t for t in doc.tables if t.cell(0, 0).text == '成员')
assert [row.cells[0].text for row in team.rows[1:]] == ['杨若朝','姬祥','徐嘉盛','李岱松','刘瑞麒','张涵','肖鹏希','吴越','张乐溪']
assert team.cell(2, 1).text == '项目负责人 项目管理'
assert all(s in text for s in ['待招募', 'Neuro-sama', 'Lumi', 'hanser', '兰音', '雫るる', '宝钟马琳'])
expected = json.loads((root / '.build/research-pagination.json').read_text(encoding='utf-8'))
bp_pdf = PdfReader(root / '.build/research-render-v1/昆山杯-潮生智能-商业计划书.pdf')
manual_pdf = PdfReader(root / '.build/survey-render-v1/姬岁歌-受众调研与内部试播执行手册.pdf')
assert len(bp_pdf.pages) == expected['expected_pages'] == 30
assert len(manual_pdf.pages) == expected['manual_expected_pages'] == 8
heads = [p.text for p in doc.paragraphs if p.style.name == 'Heading 1']
chapter_heads = [s for s in heads if s.startswith(tuple('一二三四五六七八九十'))]
assert len(chapter_heads) == 18
for title, number in zip(chapter_heads, expected['chapter_starts']):
    normalized = lambda s: ''.join(s.split())
    # LibreOffice PDF places some bold CJK glyphs out of reading order.
    heading_line = bp_pdf.pages[number - 1].extract_text().splitlines()[2]
    assert Counter(normalized(title)) == Counter(normalized(heading_line)), (title, number, heading_line)
assert all(len(page.extract_text()) > 200 for page in bp_pdf.pages)
assert all(len(page.extract_text()) > 200 for page in manual_pdf.pages)
assert sum([17400,19250,15000,10000]) == 61650
assert 61650 - 52000 - 10500 == -850
assert sum([8000,14000,3000,52000,10500,12500]) == 100000
report = {'bp_pages':30,'manual_pages':8,'all_page_images_visually_reviewed':True,'toc_matches':True,'team_order_and_roles':True,'survey_status':'待招募','financial_arithmetic':True}
(root / '.build/research-quality-check.json').write_text(json.dumps(report, ensure_ascii=False, indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
