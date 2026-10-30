from __future__ import annotations

import asyncio
import base64
from io import BytesIO
from pathlib import Path

from PIL import Image

from stirling.api.routes.medical_redact import recognize_page, runtime_capabilities
from stirling.contracts import MedicalRedactOcrDone, MedicalRedactOcrStarted
from stirling.contracts.medical_redact import (
    OCRRequest,
    PolygonPoint,
    SelectableRegionRequest,
    SelectionSource,
    SelectionState,
    TextSource,
    TextToken,
)
from stirling.medical_redact import OcrService, build_selectable_regions
from stirling.services import reset_progress_emitter, set_progress_emitter


def _polygon() -> list[PolygonPoint]:
    return [
        PolygonPoint(x=10, y=20),
        PolygonPoint(x=30, y=20),
        PolygonPoint(x=30, y=40),
        PolygonPoint(x=10, y=40),
    ]


def test_contracts_serialize_using_camel_case() -> None:
    request = OCRRequest(
        document_id="doc-1",
        page_id="page-1",
        page_no=1,
        page_width=595,
        page_height=842,
        render_width=1653,
        render_height=2339,
        image_base64="AA==",
    )

    payload = request.model_dump()

    assert payload["documentId"] == "doc-1"
    assert payload["pageId"] == "page-1"
    assert payload["pageNo"] == 1
    assert payload["renderWidth"] == 1653


def test_selectable_regions_start_unselected_and_are_stable() -> None:
    token = TextToken(
        id="token-1",
        text="患者",
        page_id="page-1",
        polygon=_polygon(),
        confidence=1.0,
        line_id="line-1",
        block_id="block-1",
        source=TextSource.PDF_TEXT,
    )
    first = build_selectable_regions("doc-1", "page-1", [token])
    second = build_selectable_regions("doc-1", "page-1", [token])

    assert first == second
    assert first[0].selection_state is SelectionState.UNSELECTED
    assert first[0].selection_source is SelectionSource.NONE
    assert first[0].token_ids == ["token-1"]


def test_selectable_region_request_rejects_tokens_from_other_pages_at_conversion() -> None:
    token = TextToken(
        id="token-1",
        text="患者",
        page_id="page-2",
        polygon=_polygon(),
        source=TextSource.PDF_TEXT,
    )
    request = SelectableRegionRequest(document_id="doc-1", page_id="page-1", tokens=[token])

    assert build_selectable_regions(request.document_id, request.page_id, request.tokens) == []


def test_runtime_capabilities_fail_closed_when_models_are_missing(tmp_path: Path) -> None:
    capabilities = asyncio.run(runtime_capabilities(OcrService(model_root=tmp_path)))

    assert capabilities.available is False
    assert capabilities.selected_runtime == "UNAVAILABLE"
    assert capabilities.available_runtimes == []
    assert capabilities.model_formats == []
    assert capabilities.warning_code == "PADDLEOCR_MODEL_MISSING"


def test_ocr_service_fails_closed_when_models_are_missing(tmp_path: Path) -> None:
    image = Image.new("RGB", (32, 24), "white")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    response = OcrService(model_root=tmp_path).recognize(
        OCRRequest(
            document_id="doc-1",
            page_id="page-1",
            page_no=1,
            page_width=32,
            page_height=24,
            render_width=32,
            render_height=24,
            image_base64=base64.b64encode(buffer.getvalue()).decode(),
        )
    )

    assert response.available is False
    assert response.tokens == []
    assert response.warning_code == "PADDLEOCR_MODEL_MISSING"


def test_ocr_route_emits_typed_progress_without_sensitive_text(tmp_path: Path) -> None:
    image = Image.new("RGB", (32, 24), "white")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    request = OCRRequest(
        document_id="doc-1",
        page_id="page-1",
        page_no=1,
        page_width=32,
        page_height=24,
        render_width=32,
        render_height=24,
        image_base64=base64.b64encode(buffer.getvalue()).decode(),
    )
    events: list[MedicalRedactOcrStarted | MedicalRedactOcrDone] = []

    async def capture(event: object) -> None:
        assert isinstance(event, (MedicalRedactOcrStarted, MedicalRedactOcrDone))
        events.append(event)

    token = set_progress_emitter(capture)
    try:
        response = asyncio.run(recognize_page(request, OcrService(model_root=tmp_path)))
    finally:
        reset_progress_emitter(token)

    assert response.available is False
    assert [event.phase for event in events] == [
        "medical_redact_ocr_started",
        "medical_redact_ocr_done",
    ]
    assert events[0].model_dump() == {
        "phase": "medical_redact_ocr_started",
        "documentId": "doc-1",
        "pageId": "page-1",
        "pageNo": 1,
    }
    done = events[1]
    assert isinstance(done, MedicalRedactOcrDone)
    assert done.available is False
    assert done.tokens == 0
    assert done.warning_code == "PADDLEOCR_MODEL_MISSING"
    assert "imageBase64" not in str([event.model_dump() for event in events])
