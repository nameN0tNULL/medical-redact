from __future__ import annotations

import base64
import platform
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

from stirling.contracts.medical_redact import OCRRequest
from stirling.medical_redact.ocr import OcrService

_REPO_ROOT = Path(__file__).resolve().parents[3]
_MODEL_ROOT = _REPO_ROOT / ".cache" / "medical-redact" / "models"
_FIXTURE_ROOT = _REPO_ROOT / "frontend" / "src" / "editor" / "core" / "tests" / "test-fixtures" / "medical-redact"
_REQUIRED_MODEL_DIRS = (
    "PP-LCNet_x1_0_doc_ori_infer",
    "PP-LCNet_x1_0_textline_ori_infer",
    "PP-OCRv6_small_det_infer",
    "PP-OCRv6_small_rec_infer",
)


def _models_ready() -> bool:
    return all((_MODEL_ROOT / directory / "inference.json").is_file() for directory in _REQUIRED_MODEL_DIRS)


def _onnx_models_ready() -> bool:
    return all((_MODEL_ROOT / directory / "inference.onnx").is_file() for directory in _REQUIRED_MODEL_DIRS)


@pytest.fixture(scope="module")
def real_ocr() -> OcrService:
    if not _models_ready():
        pytest.skip("Local PP-OCRv6 models are not downloaded")
    return OcrService(model_root=_MODEL_ROOT, cache_size=8)


def _request(image_bytes: bytes, *, page_id: str = "page-1") -> OCRRequest:
    with Image.open(BytesIO(image_bytes)) as image:
        width, height = image.size
    return OCRRequest(
        document_id="doc-1",
        page_id=page_id,
        page_no=1,
        page_width=width,
        page_height=height,
        render_width=width,
        render_height=height,
        image_base64=base64.b64encode(image_bytes).decode(),
    )


def _assert_in_page(response: object, width: float, height: float) -> None:
    tokens = response.tokens  # type: ignore[attr-defined]
    assert tokens
    for token in tokens:
        assert token.source.value == "PADDLE_OCR"
        assert token.polygon
        for point in token.polygon:
            assert 0 <= point.x <= width
            assert 0 <= point.y <= height


def test_runtime_auto_selects_coreml_only_after_successful_initialization(real_ocr: OcrService) -> None:
    capabilities = real_ocr.runtime_capabilities()

    assert capabilities.available is True
    assert capabilities.available_runtimes == [capabilities.selected_runtime]
    assert capabilities.selected_runtime in {"COREML", "ONNX_CPU", "PADDLE_CPU"}
    if (
        platform.system() == "Darwin"
        and platform.machine().lower() in {"arm64", "aarch64"}
        and _onnx_models_ready()
        and "CoreMLExecutionProvider" in capabilities.onnx_providers
    ):
        assert capabilities.selected_runtime == "COREML"
        assert capabilities.onnxruntime_version is not None


def test_real_ppocrv6_clean_scan_returns_clickable_tokens(real_ocr: OcrService) -> None:
    image_bytes = (_FIXTURE_ROOT / "04_imaging_report_scan.png").read_bytes()

    first = real_ocr.recognize(_request(image_bytes))
    second = real_ocr.recognize(_request(image_bytes))

    assert first.available is True
    assert first.engine_version is not None
    assert "PP-OCRv6-small" in first.engine_version
    assert len(first.tokens) >= 25
    text = "|".join(token.text for token in first.tokens)
    assert "测试患者甲" in text
    assert "身份证：" in text
    assert "检查报告" in text
    assert [token.id for token in first.tokens] == [token.id for token in second.tokens]
    assert any(token.char_boxes for token in first.tokens)
    _assert_in_page(first, 1500, 2100)


def test_real_ppocrv6_existing_rotated_scan_deskews_and_maps_back(real_ocr: OcrService) -> None:
    path = _FIXTURE_ROOT / "05_ultrasound_report_scan_rotated.png"
    image_bytes = path.read_bytes()
    with Image.open(path) as image:
        width, height = image.size

    response = real_ocr.recognize(_request(image_bytes, page_id="rotated-page"))

    assert response.available is True
    text = "|".join(token.text for token in response.tokens)
    assert "测试患者甲" in text
    assert "13800000001" in text
    assert "deskew" in text
    _assert_in_page(response, width, height)

    first = response.tokens[0]
    assert abs(first.polygon[0].y - first.polygon[1].y) > 0.2


def test_real_ppocrv6_low_contrast_scan_remains_clickable(real_ocr: OcrService) -> None:
    path = _FIXTURE_ROOT / "06_lab_slip_low_contrast.png"
    image_bytes = path.read_bytes()
    with Image.open(path) as image:
        width, height = image.size

    response = real_ocr.recognize(_request(image_bytes, page_id="low-contrast-page"))

    assert response.available is True
    text = "|".join(token.text for token in response.tokens)
    assert "测试患者甲" in text
    assert "SAMPLE-20261024-A17" in text
    assert "13800000001" in text
    _assert_in_page(response, width, height)


def test_real_ppocrv6_multicolumn_table_and_stamp_nearby_text(
    real_ocr: OcrService,
) -> None:
    font_path = (
        _REPO_ROOT
        / "app"
        / "core"
        / "src"
        / "main"
        / "resources"
        / "static"
        / "fonts"
        / "NotoSansSC-Regular.ttf"
    )
    font = ImageFont.truetype(str(font_path), 38)
    title_font = ImageFont.truetype(str(font_path), 46)
    image = Image.new("RGB", (1600, 1200), "white")
    draw = ImageDraw.Draw(image)
    draw.text((70, 45), "E2E 多栏表格印章 OCR 压力样本", font=title_font, fill="black")

    left_lines = (
        "左栏姓名：测试患者甲",
        "左栏住院号：ZY-20261024-0007",
        "左栏诊断：完全虚构测试",
    )
    right_lines = (
        "右栏电话：13800000001",
        "右栏地址：虚构区测试路88号",
        "右栏检查号：EXAM-CT-20261024-09",
    )
    for index, line in enumerate(left_lines):
        draw.text((70, 150 + index * 70), line, font=font, fill="black")
    for index, line in enumerate(right_lines):
        draw.text((850, 150 + index * 70), line, font=font, fill="black")

    table_left, table_top, table_right, table_bottom = 70, 450, 1530, 760
    for x in (table_left, 450, 850, 1200, table_right):
        draw.line((x, table_top, x, table_bottom), fill="black", width=3)
    for y in (table_top, 520, 590, 660, table_bottom):
        draw.line((table_left, y, table_right, y), fill="black", width=3)
    cells = (
        (90, 466, "项目"),
        (480, 466, "结果"),
        (875, 466, "单位"),
        (1220, 466, "参考"),
        (90, 536, "ALT"),
        (480, 536, "22"),
        (875, 536, "U/L"),
        (1220, 536, "0-40"),
        (90, 606, "CREA"),
        (480, 606, "71"),
        (875, 606, "umol/L"),
        (1220, 606, "40-100"),
    )
    for x, y, value in cells:
        draw.text((x, y), value, font=font, fill="black")

    draw.text((80, 850), "报告医生：测试医生乙", font=font, fill="black")
    draw.ellipse((930, 800, 1240, 1080), outline=(200, 30, 30), width=10)
    draw.text((1005, 910), "测试章", font=font, fill=(200, 30, 30))
    draw.text((1270, 870), "印章附近：审核通过测试", font=font, fill="black")

    buffer = BytesIO()
    image.save(buffer, format="PNG")
    response = real_ocr.recognize(_request(buffer.getvalue(), page_id="layout-stress-page"))

    assert response.available is True
    recognized = "".join(token.text for token in response.tokens)
    for expected in (
        "测试患者甲",
        "13800000001",
        "ZY-20261024-0007",
        "EXAM-CT-20261024-09",
        "ALT",
        "CREA",
        "测试医生乙",
        "印章附近",
    ):
        assert expected in recognized
    assert any(min(point.x for point in token.polygon) < 700 for token in response.tokens)
    assert any(min(point.x for point in token.polygon) > 800 for token in response.tokens)
    _assert_in_page(response, 1600, 1200)


def test_real_ppocrv6_right_angle_orientation_maps_polygons_to_original_input(
    real_ocr: OcrService,
) -> None:
    source = Image.open(_FIXTURE_ROOT / "04_imaging_report_scan.png").convert("RGB")
    rotated = source.transpose(Image.Transpose.ROTATE_90)
    buffer = BytesIO()
    rotated.save(buffer, format="PNG")
    image_bytes = buffer.getvalue()
    width, height = rotated.size

    response = real_ocr.recognize(_request(image_bytes, page_id="right-angle-page"))

    assert response.available is True
    patient = next(token for token in response.tokens if token.text == "测试患者甲")
    xs = [point.x for point in patient.polygon]
    ys = [point.y for point in patient.polygon]
    assert max(xs) < 450
    assert min(ys) > 1000
    _assert_in_page(response, width, height)
