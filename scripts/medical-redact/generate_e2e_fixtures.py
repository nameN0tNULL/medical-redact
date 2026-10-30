#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import random
import shutil
import textwrap
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

import fitz
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "frontend/src/editor/core/tests/test-fixtures/medical-redact"
FONT = ROOT / "frontend/node_modules/@embedpdf/fonts-sc/fonts/NotoSansHans-Regular.otf"
BOLD_FONT = ROOT / "frontend/node_modules/@embedpdf/fonts-sc/fonts/NotoSansHans-Bold.otf"

FAKE = {
    "patient_name": "测试患者甲",
    "doctor_name": "测试医生乙",
    "id_card": "11010119900307451X",
    "phone": "13800000001",
    "email": "patient.e2e@example.invalid",
    "address": "北京市虚构区测试路88号E2E单元",
    "outpatient_no": "MZ-20261024-0001",
    "inpatient_no": "ZY-20261024-0007",
    "medical_record_no": "MR-TEST-20261024-01",
    "insurance_no": "YB-TEST-00000001",
    "exam_no": "EXAM-CT-20261024-09",
    "sample_no": "SAMPLE-20261024-A17",
}

CASES = [
    {
        "file": "01_outpatient_record_text.pdf",
        "format": "pdf",
        "category": "outpatient_record",
        "pages": 2,
        "expected_import": "accepted",
        "variant": "native-text",
    },
    {
        "file": "02_inpatient_record_text.pdf",
        "format": "pdf",
        "category": "inpatient_record",
        "pages": 3,
        "expected_import": "accepted",
        "variant": "native-text-multipage",
    },
    {
        "file": "03_lab_report_text.pdf",
        "format": "pdf",
        "category": "lab_report",
        "pages": 1,
        "expected_import": "accepted",
        "variant": "native-text-table",
    },
    {
        "file": "04_imaging_report_scan.png",
        "format": "png",
        "category": "imaging_report",
        "pages": 1,
        "expected_import": "accepted",
        "variant": "scan-clean",
    },
    {
        "file": "05_ultrasound_report_scan_rotated.png",
        "format": "png",
        "category": "imaging_report",
        "pages": 1,
        "expected_import": "accepted",
        "variant": "scan-rotated",
    },
    {
        "file": "06_lab_slip_low_contrast.png",
        "format": "png",
        "category": "lab_report",
        "pages": 1,
        "expected_import": "accepted",
        "variant": "scan-low-contrast",
    },
    {
        "file": "07_outpatient_record_word.docx",
        "format": "docx",
        "category": "outpatient_record",
        "pages": None,
        "expected_import": "rejected-p0",
        "variant": "word-native",
    },
    {
        "file": "08_imaging_report_word.docx",
        "format": "docx",
        "category": "imaging_report",
        "pages": None,
        "expected_import": "rejected-p0",
        "variant": "word-native",
    },
    {
        "file": "09_lab_report_word.docx",
        "format": "docx",
        "category": "lab_report",
        "pages": None,
        "expected_import": "rejected-p0",
        "variant": "word-table-like",
    },
]


def ensure_fonts() -> None:
    for path in (FONT, BOLD_FONT):
        if not path.is_file():
            raise SystemExit(f"Required repository font is missing: {path}")


def wrap_lines(lines: list[str], width: int = 54) -> list[str]:
    out: list[str] = []
    for line in lines:
        if not line:
            out.append("")
            continue
        if len(line) <= width:
            out.append(line)
            continue
        out.extend(textwrap.wrap(line, width=width, break_long_words=False))
    return out


def pdf_page(doc: fitz.Document, title: str, lines: list[str], page_no: int, total: int) -> None:
    page = doc.new_page(width=595, height=842)
    page.draw_rect(fitz.Rect(28, 25, 567, 817), color=(0.45, 0.45, 0.45), width=0.7)
    page.insert_text((45, 58), "E2E 测试数据 / 完全虚构 / 禁止用于真实诊疗", fontname="china-s", fontsize=9, color=(0.65, 0, 0))
    page.insert_text((45, 92), title, fontname="china-s", fontsize=18)
    y = 126
    for line in wrap_lines(lines):
        if line.startswith("## "):
            y += 8
            page.insert_text((45, y), line[3:], fontname="china-s", fontsize=12)
            y += 22
        else:
            page.insert_textbox(
                fitz.Rect(45, y, 545, y + 34),
                line or " ",
                fontname="china-s",
                fontsize=10.5,
                lineheight=1.25,
            )
            y += 23
    page.insert_text((470, 800), f"第 {page_no}/{total} 页", fontname="china-s", fontsize=9, color=(0.4, 0.4, 0.4))


def make_pdfs() -> None:
    outpatient_pages = [
        [
            f"姓名：{FAKE['patient_name']}    性别：男    出生日期：1990-03-07",
            f"身份证号：{FAKE['id_card']}    手机：{FAKE['phone']}",
            f"门诊号：{FAKE['outpatient_no']}    病历号：{FAKE['medical_record_no']}",
            f"家庭住址：{FAKE['address']}",
            "## 主诉",
            "反复咳嗽、咽痒 3 天。以下内容全部为自动化 E2E 测试虚构文本。",
            "## 现病史",
            "三日前受凉后出现咽痒、干咳，夜间稍明显，无真实患者信息。自述未服处方药。",
            "## 既往史",
            "测试用：否认高血压、糖尿病、冠心病；药物过敏史：测试阴性。",
        ],
        [
            "## 四诊摘要",
            "舌淡红，苔薄白；脉浮。测试字段：联系人 测试家属丙，电话 13900000002。",
            "## 初步诊断",
            "中医：咳嗽（风寒袭肺证）；西医：上呼吸道感染（仅用于 E2E 示例）。",
            "## 处理意见",
            "1. 测试处方，不用于真实诊疗。2. 复诊时间：2026-10-31。",
            f"接诊医生：{FAKE['doctor_name']}    邮箱：{FAKE['email']}",
        ],
    ]
    doc = fitz.open()
    for i, lines in enumerate(outpatient_pages, 1):
        pdf_page(doc, "虚构门诊病历", lines, i, len(outpatient_pages))
    doc.save(OUT / "01_outpatient_record_text.pdf")
    doc.close()

    inpatient_pages = [
        [
            f"姓名：{FAKE['patient_name']}    住院号：{FAKE['inpatient_no']}",
            f"病案号：{FAKE['medical_record_no']}    医保号：{FAKE['insurance_no']}",
            f"身份证号：{FAKE['id_card']}    联系电话：{FAKE['phone']}",
            "## 入院记录",
            "因“测试性腹痛 2 天”入院。生命体征、诊疗经过均为虚构自动化测试内容。",
            "床号：E2E-07    科室：测试中医内科    入院日期：2026-10-24",
        ],
        [
            "## 首次病程记录",
            "2026-10-24 09:30 测试患者神清，精神可。查体字段用于测试页面切换和文本层。",
            "辅助检查：虚构血常规、肝肾功能、腹部超声。",
            f"紧急联系人：测试联系人丁    电话：{FAKE['phone']}",
            "地址：上海市虚构新区自动化大道100号。",
        ],
        [
            "## 出院小结（测试）",
            "出院诊断：测试疾病A；中医证型：测试证型B。",
            "住院期间完成虚构检查，无真实医疗行为。",
            "出院日期：2026-10-26    随访日期：2026-11-02",
            f"经治医生：{FAKE['doctor_name']}",
        ],
    ]
    doc = fitz.open()
    for i, lines in enumerate(inpatient_pages, 1):
        pdf_page(doc, "虚构住院病历", lines, i, len(inpatient_pages))
    doc.save(OUT / "02_inpatient_record_text.pdf")
    doc.close()

    lab_lines = [
        f"姓名：{FAKE['patient_name']}    样本号：{FAKE['sample_no']}",
        f"门诊号：{FAKE['outpatient_no']}    检验日期：2026-10-24 08:15",
        "## 血常规（全部为测试数值）",
        "项目                 结果        单位        参考范围",
        "白细胞 WBC          6.20        10^9/L      3.50-9.50",
        "红细胞 RBC          4.62        10^12/L     4.30-5.80",
        "血红蛋白 HGB        138         g/L         130-175",
        "血小板 PLT          226         10^9/L      125-350",
        "C反应蛋白 CRP       2.8         mg/L        0-8",
        f"审核者：{FAKE['doctor_name']}    报告编号：LAB-E2E-20261024-001",
    ]
    doc = fitz.open()
    pdf_page(doc, "虚构检验报告", lab_lines, 1, 1)
    doc.save(OUT / "03_lab_report_text.pdf")
    doc.close()


def draw_scan(title: str, lines: list[str], *, low_contrast=False, rotate=0.0) -> Image.Image:
    bg = 242 if low_contrast else 255
    fg = 105 if low_contrast else 25
    image = Image.new("RGB", (1500, 2100), (bg, bg, bg))
    draw = ImageDraw.Draw(image)
    body = ImageFont.truetype(str(FONT), 34)
    bold = ImageFont.truetype(str(BOLD_FONT), 48)
    small = ImageFont.truetype(str(FONT), 27)

    draw.rectangle((55, 55, 1445, 2045), outline=(140, 140, 140), width=3)
    draw.text((95, 95), "E2E 测试数据 / 完全虚构", font=small, fill=(155, 20, 20))
    draw.text((95, 175), title, font=bold, fill=(fg, fg, fg))
    y = 280
    for line in lines:
        if line.startswith("## "):
            y += 30
            draw.text((95, y), line[3:], font=bold, fill=(fg, fg, fg))
            y += 75
        else:
            for wrapped in textwrap.wrap(line, width=34, break_long_words=False) or [""]:
                draw.text((95, y), wrapped, font=body, fill=(fg, fg, fg))
                y += 56

    random.seed(20261024)
    for _ in range(180 if low_contrast else 70):
        x = random.randrange(60, 1440)
        y0 = random.randrange(60, 2040)
        shade = random.randrange(180, 235)
        draw.point((x, y0), fill=(shade, shade, shade))
    if low_contrast:
        image = image.filter(ImageFilter.GaussianBlur(radius=0.45))
    if rotate:
        image = image.rotate(rotate, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(bg, bg, bg))
    return image


def make_pngs() -> None:
    image = draw_scan(
        "虚构 CT 检查报告",
        [
            f"姓名：{FAKE['patient_name']}   检查号：{FAKE['exam_no']}",
            f"身份证：{FAKE['id_card']}",
            "检查部位：胸部 CT（测试）",
            "## 检查所见",
            "双肺纹理清晰，测试结节字段 4mm；所有描述均为虚构。",
            "## 检查结论",
            "E2E 测试结论：未见真实异常，仅用于 OCR 与脱敏流程验证。",
            f"报告医生：{FAKE['doctor_name']}",
        ],
    )
    image.save(OUT / "04_imaging_report_scan.png", optimize=True)

    image = draw_scan(
        "虚构超声检查报告",
        [
            f"患者：{FAKE['patient_name']}   电话：{FAKE['phone']}",
            f"住院号：{FAKE['inpatient_no']}",
            "检查项目：腹部超声（测试）",
            "## 超声所见",
            "肝胆胰脾字段均为测试文本。图像整体轻微倾斜，用于 OCR deskew 验证。",
            "## 提示",
            "虚构检查，无诊疗意义。",
        ],
        rotate=1.35,
    )
    image.save(OUT / "05_ultrasound_report_scan_rotated.png", optimize=True)

    image = draw_scan(
        "虚构检验单（低对比度）",
        [
            f"姓名：{FAKE['patient_name']}   样本号：{FAKE['sample_no']}",
            "手机号：１３８０００００００１（全角测试）",
            "项目：ALT 22 U/L；AST 19 U/L；CREA 71 umol/L",
            "地址：广州市虚构区E2E路66号",
            "备注：低对比度 + 全角字符 + 表格式文本，仅供自动化测试。",
        ],
        low_contrast=True,
    )
    image.save(OUT / "06_lab_slip_low_contrast.png", optimize=True)


def paragraph_xml(text: str, bold: bool = False) -> str:
    runs = []
    for part in text.split("\n"):
        rpr = "<w:rPr><w:b/></w:rPr>" if bold else ""
        runs.append(f"<w:p><w:r>{rpr}<w:t xml:space=\"preserve\">{escape(part)}</w:t></w:r></w:p>")
    return "".join(runs)


def make_docx(path: Path, title: str, lines: list[str]) -> None:
    body = paragraph_xml("E2E 测试数据 / 完全虚构 / 禁止用于真实诊疗", True)
    body += paragraph_xml(title, True)
    for line in lines:
        body += paragraph_xml(line[3:] if line.startswith("## ") else line, line.startswith("## "))
    document_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>'''
    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''
    rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document_xml)


def make_docxs() -> None:
    make_docx(
        OUT / "07_outpatient_record_word.docx",
        "虚构门诊病历（Word）",
        [
            f"姓名：{FAKE['patient_name']}",
            f"身份证号：{FAKE['id_card']}",
            f"手机：{FAKE['phone']}",
            f"地址：{FAKE['address']}",
            "主诉：测试性头痛 1 天。",
            f"接诊医生：{FAKE['doctor_name']}",
        ],
    )
    make_docx(
        OUT / "08_imaging_report_word.docx",
        "虚构影像报告（Word）",
        [
            f"姓名：{FAKE['patient_name']}",
            f"检查号：{FAKE['exam_no']}",
            "检查项目：测试 MRI。",
            "检查所见：虚构文本，用于 Word 输入兼容性边界测试。",
            "影像结论：E2E TEST ONLY。",
        ],
    )
    make_docx(
        OUT / "09_lab_report_word.docx",
        "虚构检验报告（Word）",
        [
            f"姓名：{FAKE['patient_name']}    样本号：{FAKE['sample_no']}",
            "WBC 6.20 10^9/L",
            "HGB 138 g/L",
            "PLT 226 10^9/L",
            f"审核者：{FAKE['doctor_name']}",
        ],
    )


def verify_outputs() -> None:
    for case in CASES:
        path = OUT / case["file"]
        if not path.is_file() or path.stat().st_size == 0:
            raise SystemExit(f"Fixture was not generated correctly: {path}")
        if case["format"] == "pdf":
            doc = fitz.open(path)
            if doc.page_count != case["pages"]:
                raise SystemExit(f"Unexpected page count for {path}: {doc.page_count}")
            text = "".join(page.get_text() for page in doc)
            if "E2E" not in text or FAKE["patient_name"] not in text:
                raise SystemExit(f"PDF text layer verification failed for {path}")
            doc.close()
        elif case["format"] == "png":
            with Image.open(path) as image:
                if min(image.size) < 1200:
                    raise SystemExit(f"PNG fixture is unexpectedly small: {path}")
        elif case["format"] == "docx":
            with zipfile.ZipFile(path) as z:
                xml = z.read("word/document.xml").decode("utf-8")
                if FAKE["patient_name"] not in xml:
                    raise SystemExit(f"DOCX content verification failed for {path}")


def main() -> None:
    ensure_fonts()
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    make_pdfs()
    make_pngs()
    make_docxs()
    manifest = {
        "generated": "2026-10-24",
        "purpose": "Synthetic fixtures for medical-redaction E2E tests. No real patient data.",
        "fake_fields": FAKE,
        "cases": CASES,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    verify_outputs()
    print(f"Generated {len(CASES)} synthetic medical fixtures in {OUT}")
    for case in CASES:
        p = OUT / case["file"]
        print(f"- {p.name}: {p.stat().st_size} bytes ({case['variant']})")


if __name__ == "__main__":
    main()
