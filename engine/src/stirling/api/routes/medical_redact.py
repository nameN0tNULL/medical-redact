from __future__ import annotations

import asyncio
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends

from stirling.contracts.medical_redact import (
    OCRRequest,
    OCRResponse,
    OCRRuntimeCapabilities,
    PIIDetectRequest,
    PIIDetectResponse,
    SelectableRegionRequest,
    SelectableRegionResponse,
)
from stirling.contracts.progress import MedicalRedactOcrDone, MedicalRedactOcrStarted
from stirling.medical_redact import OcrService, build_selectable_regions, detect_pii
from stirling.services.progress import emit_progress

router = APIRouter(prefix="/api/v1/medical-redact", tags=["medical-redact"])


@lru_cache(maxsize=1)
def get_ocr_service() -> OcrService:
    return OcrService()


@router.get("/runtime/capabilities", response_model=OCRRuntimeCapabilities)
async def runtime_capabilities(
    service: Annotated[OcrService, Depends(get_ocr_service)],
) -> OCRRuntimeCapabilities:
    return await asyncio.to_thread(service.runtime_capabilities)


@router.post("/ocr", response_model=OCRResponse)
async def recognize_page(
    request: OCRRequest,
    service: Annotated[OcrService, Depends(get_ocr_service)],
) -> OCRResponse:
    await emit_progress(
        MedicalRedactOcrStarted(
            document_id=request.document_id,
            page_id=request.page_id,
            page_no=request.page_no,
        )
    )
    response = await asyncio.to_thread(service.recognize, request)
    await emit_progress(
        MedicalRedactOcrDone(
            document_id=request.document_id,
            page_id=request.page_id,
            page_no=request.page_no,
            available=response.available,
            tokens=len(response.tokens),
            warning_code=response.warning_code,
            elapsed_ms=response.elapsed_ms,
        )
    )
    return response


@router.post("/selectable-regions", response_model=SelectableRegionResponse)
async def selectable_regions(request: SelectableRegionRequest) -> SelectableRegionResponse:
    return SelectableRegionResponse(
        regions=build_selectable_regions(request.document_id, request.page_id, request.tokens)
    )


@router.post("/pii/detect", response_model=PIIDetectResponse)
async def detect_document_pii(
    request: PIIDetectRequest,
    service: Annotated[OcrService, Depends(get_ocr_service)],
) -> PIIDetectResponse:
    return await asyncio.to_thread(
        detect_pii,
        request.document_id,
        request.tokens,
        request.known_entities,
        request.page_images,
        service,
    )
