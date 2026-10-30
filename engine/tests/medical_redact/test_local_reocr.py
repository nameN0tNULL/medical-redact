from __future__ import annotations

import base64

import cv2
import numpy as np
import pytest

from stirling.contracts.medical_redact import (
    CharacterBox,
    OCRRequest,
    OCRResponse,
    PolygonPoint,
    TextSource,
    TextToken,
)
from stirling.medical_redact import detect_pii
from stirling.medical_redact.ocr import OcrService


def _rect(left: float, top: float, right: float, bottom: float) -> list[PolygonPoint]:
    return [
        PolygonPoint(x=left, y=top),
        PolygonPoint(x=right, y=top),
        PolygonPoint(x=right, y=bottom),
        PolygonPoint(x=left, y=bottom),
    ]


def _page_image() -> OCRRequest:
    image = np.full((100, 200, 3), 255, dtype=np.uint8)
    encoded, png = cv2.imencode(".png", image)
    assert encoded
    return OCRRequest(
        document_id="doc-1",
        page_id="page-1",
        page_no=1,
        page_width=200,
        page_height=100,
        render_width=200,
        render_height=100,
        image_base64=base64.b64encode(png.tobytes()).decode("ascii"),
    )


def _partial_token(ordinal: int, text: str = "电话13800000001备注") -> TextToken:
    return TextToken(
        id=f"token-{ordinal}",
        text=text,
        page_id="page-1",
        polygon=_rect(20, 20, 180, 40),
        confidence=0.94,
        line_id=f"line-{ordinal}",
        source=TextSource.PADDLE_OCR,
        char_boxes=None,
    )


class _ExactLocalOcr(OcrService):
    def __init__(self) -> None:
        self.calls = 0

    def recognize(self, request: OCRRequest) -> OCRResponse:
        self.calls += 1
        text = "13800000001"
        left = 4.0
        right = max(left + len(text), request.page_width - 4.0)
        step = (right - left) / len(text)
        char_boxes = [
            CharacterBox(
                text=char,
                polygon=_rect(
                    left + step * index,
                    2,
                    left + step * (index + 1),
                    max(4.0, request.page_height - 2),
                ),
            )
            for index, char in enumerate(text)
        ]
        return OCRResponse(
            available=True,
            engine="paddleocr",
            engine_version="test",
            tokens=[
                TextToken(
                    id=f"local-{self.calls}",
                    text=text,
                    page_id=request.page_id,
                    polygon=_rect(left, 2, right, max(4.0, request.page_height - 2)),
                    confidence=0.93,
                    line_id="local-line",
                    source=TextSource.LOCAL_REOCR,
                    char_boxes=char_boxes,
                )
            ],
        )


class _UnavailableLocalOcr(OcrService):
    def __init__(self) -> None:
        pass

    def recognize(self, request: OCRRequest) -> OCRResponse:
        return OCRResponse(
            available=False,
            engine="paddleocr",
            warning_code="OCR_TRANSFORM_NON_INVERTIBLE",
        )


def test_partial_token_is_refined_to_exact_local_char_boxes() -> None:
    service = _ExactLocalOcr()

    response = detect_pii(
        "doc-1",
        [_partial_token(1)],
        page_images=[_page_image()],
        ocr_service=service,
    )

    candidate = response.candidates[0]
    assert service.calls == 1
    assert candidate.entity_type == "PHONE"
    assert candidate.alignment.level.value == "C"
    assert candidate.alignment.method == "LOCAL_REOCR_EXACT"
    assert candidate.alignment.needs_local_reocr is False
    assert candidate.alignment.unresolved is False
    assert candidate.alignment.polygons
    assert candidate.alignment.confidence == 0.85
    assert candidate.policy.value == "AUTO_SELECT"
    assert candidate.risk_status.value == "RESOLVED"


def test_local_reocr_failure_becomes_unresolved_and_never_auto_selects() -> None:
    response = detect_pii(
        "doc-1",
        [_partial_token(1)],
        page_images=[_page_image()],
        ocr_service=_UnavailableLocalOcr(),
    )

    candidate = response.candidates[0]
    assert candidate.alignment.level.value == "D"
    assert candidate.alignment.unresolved is True
    assert "OCR_TRANSFORM_NON_INVERTIBLE" in candidate.alignment.warnings
    assert candidate.policy.value == "REVIEW"
    assert candidate.risk_status.value == "UNRESOLVED"


def test_local_reocr_is_capped_at_ten_attempts_per_page() -> None:
    service = _ExactLocalOcr()
    tokens = [_partial_token(index) for index in range(1, 12)]

    response = detect_pii(
        "doc-1",
        tokens,
        page_images=[_page_image()],
        ocr_service=service,
    )

    assert service.calls == 10
    high_risk = [candidate for candidate in response.candidates if candidate.risk_status.value == "HIGH_RISK"]
    assert len(response.candidates) == 11
    assert len(high_risk) == 1
    assert high_risk[0].alignment.needs_local_reocr is True
    assert "LOCAL_REOCR_LIMIT_EXCEEDED" in high_risk[0].alignment.warnings


def test_non_invertible_affine_transform_fails_closed() -> None:
    with pytest.raises(RuntimeError, match="OCR_TRANSFORM_NON_INVERTIBLE"):
        OcrService._invert_affine(np.zeros((2, 3), dtype=np.float64))
