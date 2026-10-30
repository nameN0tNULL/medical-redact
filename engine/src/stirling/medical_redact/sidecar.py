from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import os
import threading
import time
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any

import uvicorn
from fastapi import APIRouter, Depends, FastAPI
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from stirling.contracts.medical_redact import (
    OCRRequest,
    OCRResponse,
    OCRRuntimeCapabilities,
    PIIDetectRequest,
    PIIDetectResponse,
    SelectableRegionRequest,
    SelectableRegionResponse,
)
from stirling.medical_redact import OcrService, build_selectable_regions, detect_pii

_SCHEMA_VERSION = 1
_ALLOWED_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
_AUTH_HEADER = "X-Engine-Auth"


class BundleValidationError(RuntimeError):
    pass


class SidecarSharedSecretMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp, shared_secret: str) -> None:
        super().__init__(app)
        self._shared_secret = shared_secret

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if request.url.path != "/health":
            offered = request.headers.get(_AUTH_HEADER) or ""
            if not hmac.compare_digest(offered, self._shared_secret):
                return JSONResponse({"detail": "Missing or invalid X-Engine-Auth header."}, status_code=401)
        return await call_next(request)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _model_digest(files: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for item in sorted(files, key=lambda value: str(value["path"])):
        digest.update(str(item["path"]).encode())
        digest.update(b"\0")
        digest.update(str(item["sha256"]).encode())
        digest.update(b"\0")
        digest.update(str(item["size"]).encode())
        digest.update(b"\n")
    return digest.hexdigest()


def validate_model_manifest(manifest_path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BundleValidationError(f"model manifest is unreadable: {manifest_path}") from exc

    if payload.get("schemaVersion") != _SCHEMA_VERSION:
        raise BundleValidationError("unsupported model manifest schema")
    if not isinstance(payload.get("bundleVersion"), str) or not payload["bundleVersion"].strip():
        raise BundleValidationError("model manifest bundleVersion is missing")

    models = payload.get("models")
    if not isinstance(models, list) or not models:
        raise BundleValidationError("model manifest has no models")

    root = manifest_path.parent.resolve()
    for model in models:
        if not isinstance(model, dict):
            raise BundleValidationError("model manifest entry must be an object")
        files = model.get("files")
        if not isinstance(files, list) or not files:
            raise BundleValidationError(f"model {model.get('id', '<unknown>')} has no files")

        normalized_files: list[dict[str, Any]] = []
        total_size = 0
        for file_entry in files:
            if not isinstance(file_entry, dict):
                raise BundleValidationError("model file entry must be an object")
            relative = Path(str(file_entry.get("path", "")))
            if relative.is_absolute() or ".." in relative.parts or not relative.parts:
                raise BundleValidationError(f"unsafe model file path: {relative}")

            candidate = (root / relative).resolve()
            try:
                candidate.relative_to(root)
            except ValueError as exc:
                raise BundleValidationError(f"model file escapes bundle root: {relative}") from exc

            if not candidate.is_file():
                raise BundleValidationError(f"model file is missing: {relative}")
            expected_size = file_entry.get("size")
            expected_sha = file_entry.get("sha256")
            actual_size = candidate.stat().st_size
            if expected_size != actual_size:
                raise BundleValidationError(f"model file size mismatch: {relative}")
            if expected_sha != _sha256(candidate):
                raise BundleValidationError(f"model file checksum mismatch: {relative}")

            normalized_files.append(
                {
                    "path": relative.as_posix(),
                    "sha256": expected_sha,
                    "size": actual_size,
                }
            )
            total_size += actual_size

        if model.get("size") != total_size:
            raise BundleValidationError(f"model size mismatch: {model.get('id', '<unknown>')}")
        if model.get("sha256") != _model_digest(normalized_files):
            raise BundleValidationError(f"model checksum mismatch: {model.get('id', '<unknown>')}")

    return payload


def configure_model_environment(manifest_path: Path) -> None:
    model_root = manifest_path.parent.resolve()
    os.environ["MEDICAL_REDACT_OCR_MODEL_ROOT"] = str(model_root / "paddleocr")
    os.environ["MEDICAL_REDACT_NER_MANIFEST"] = str(model_root / "ner" / "model-manifest.json")
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")


@lru_cache(maxsize=1)
def get_ocr_service() -> OcrService:
    return OcrService()


def _medical_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1/medical-redact", tags=["medical-redact"])

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
        return await asyncio.to_thread(service.recognize, request)

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

    return router


def create_sidecar_app(shared_secret: str) -> FastAPI:
    if not shared_secret:
        raise RuntimeError("STIRLING_ENGINE_SHARED_SECRET is required")

    app = FastAPI(title="Medical Redact Engine", version="1")
    app.add_middleware(SidecarSharedSecretMiddleware, shared_secret=shared_secret)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(_medical_router())
    return app


def _loopback_host(value: str) -> str:
    if value not in _ALLOWED_LOOPBACK_HOSTS:
        raise argparse.ArgumentTypeError("medical sidecar must listen on loopback only")
    return value


def _monitor_parent_process(parent_pid: int) -> None:
    if os.name != "posix":
        return
    while os.getppid() == parent_pid:
        time.sleep(0.5)
    os._exit(0)


def _start_parent_monitor(parent_pid: int | None) -> None:
    if parent_pid is None:
        return
    if parent_pid <= 1:
        raise ValueError("parent pid must be greater than 1")
    if os.name != "posix":
        return
    threading.Thread(
        target=_monitor_parent_process,
        args=(parent_pid,),
        name="medical-redact-parent-monitor",
        daemon=True,
    ).start()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the bundled medical-redact AI Engine.")
    parser.add_argument("--host", type=_loopback_host, default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--model-manifest", type=Path, required=True)
    parser.add_argument("--parent-pid", type=int)
    args = parser.parse_args()

    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if args.parent_pid is not None and args.parent_pid <= 1:
        parser.error("--parent-pid must be greater than 1")

    _start_parent_monitor(args.parent_pid)
    manifest_path = args.model_manifest.expanduser().resolve()
    validate_model_manifest(manifest_path)
    configure_model_environment(manifest_path)

    shared_secret = os.getenv("STIRLING_ENGINE_SHARED_SECRET", "")
    app = create_sidecar_app(shared_secret)
    uvicorn.run(app, host=args.host, port=args.port, workers=1, access_log=False)


if __name__ == "__main__":
    main()
