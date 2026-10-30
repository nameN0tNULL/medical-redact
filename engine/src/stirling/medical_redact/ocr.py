from __future__ import annotations

import base64
import binascii
import hashlib
import importlib
import importlib.metadata
import logging
import os
import platform
import threading
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from time import monotonic
from typing import Any, cast

import cv2
import numpy as np
from numpy.typing import NDArray

from stirling.contracts.medical_redact import (
    CharacterBox,
    OCRRequest,
    OCRResponse,
    OCRRuntimeCapabilities,
    PolygonPoint,
    TextSource,
    TextToken,
)

_MODEL_DIRS = {
    "orientation": "PP-LCNet_x1_0_doc_ori_infer",
    "textline_orientation": "PP-LCNet_x1_0_textline_ori_infer",
    "detection": "PP-OCRv6_small_det_infer",
    "recognition": "PP-OCRv6_small_rec_infer",
}
_REQUIRED_MODEL_FILES = ("inference.json", "inference.pdiparams", "inference.yml")
_BREAK_AFTER = frozenset("：:，,；;。！？!?、")
_MAX_CJK_TOKEN_CHARS = 6
_DESKEW_MIN_DEGREES = 0.75
_DESKEW_MAX_DEGREES = 12.0
_LOW_CONFIDENCE_THRESHOLD = 0.75
_RUNTIME_COREML = "COREML"
_RUNTIME_ONNX_CUDA = "ONNX_CUDA"
_RUNTIME_ONNX_CPU = "ONNX_CPU"
_RUNTIME_PADDLE_GPU = "PADDLE_GPU"
_RUNTIME_PADDLE_CPU = "PADDLE_CPU"
_RUNTIME_UNAVAILABLE = "UNAVAILABLE"
_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class _PixelCharacter:
    text: str
    polygon: tuple[tuple[float, float], ...]


@dataclass(frozen=True)
class _PixelToken:
    text: str
    polygon: tuple[tuple[float, float], ...]
    confidence: float
    line_index: int
    group_index: int
    char_boxes: tuple[_PixelCharacter, ...]


@dataclass(frozen=True)
class _OcrSnapshot:
    tokens: tuple[_PixelToken, ...]
    warning_code: str | None


class _OcrUnavailableError(RuntimeError):
    def __init__(self, warning_code: str) -> None:
        super().__init__(warning_code)
        self.warning_code = warning_code


class OcrService:
    """Local PP-OCRv6 adapter with PAGE_SPACE-safe geometry.

    Paddle's document unwarping pipeline changes the image coordinate system without exposing a
    stable inverse transform, so this adapter intentionally does not enable UVDoc. Right-angle
    orientation is classified separately, and small-angle deskew uses our own affine transform.
    Both transforms are inverted before any token leaves the engine, keeping the public contract in
    the original rendered-image coordinate system for the Spring layer to map into PAGE_SPACE.
    """

    def __init__(
        self,
        model_root: Path | None = None,
        *,
        device: str | None = None,
        runtime: str | None = None,
        cache_size: int = 32,
    ) -> None:
        self._model_root = model_root or self._default_model_root()
        configured_device = device or os.getenv("MEDICAL_REDACT_OCR_DEVICE", "cpu")
        configured_gpu_device = os.getenv("MEDICAL_REDACT_OCR_GPU_DEVICE", "gpu:0")
        self._gpu_device = configured_device if configured_device.lower().startswith("gpu") else configured_gpu_device
        self._runtime_preference = (runtime or os.getenv("MEDICAL_REDACT_OCR_RUNTIME", "auto")).strip()
        self._cache_size = max(1, cache_size)
        self._cache: OrderedDict[str, _OcrSnapshot] = OrderedDict()
        self._cache_lock = threading.Lock()
        self._inference_lock = threading.Lock()
        self._orientation_model: Any | None = None
        self._ocr_pipeline: Any | None = None
        self._engine_version: str | None = None
        self._selected_runtime: str | None = None
        self._runtime_fallback_chain: list[str] = []
        self._onnx_providers: list[str] = []
        self._failed_runtimes: set[str] = set()

    @staticmethod
    def _default_model_root() -> Path:
        configured = os.getenv("MEDICAL_REDACT_OCR_MODEL_ROOT")
        if configured:
            return Path(configured).expanduser().resolve()
        repo_root = Path(__file__).resolve().parents[4]
        return repo_root / ".cache" / "medical-redact" / "models"

    def recognize(self, request: OCRRequest) -> OCRResponse:
        started = monotonic()
        try:
            image_bytes = base64.b64decode(request.image_base64, validate=True)
            decoded = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
            if decoded is None:
                raise _OcrUnavailableError("OCR_IMAGE_DECODE_FAILED")
            image = cast(NDArray[np.uint8], decoded)
            height, width = image.shape[:2]
            if width != request.render_width or height != request.render_height:
                raise _OcrUnavailableError("OCR_IMAGE_DIMENSION_MISMATCH")

            cache_key = hashlib.sha256(image_bytes).hexdigest()
            snapshot = self._get_cached(cache_key)
            if snapshot is None:
                with self._inference_lock:
                    snapshot = self._get_cached(cache_key)
                    if snapshot is None:
                        snapshot = self._infer_with_runtime_fallback(image)
                        self._put_cached(cache_key, snapshot)

            tokens = self._to_page_tokens(request, snapshot.tokens)
            warning_code = snapshot.warning_code
            if not tokens and warning_code is None:
                warning_code = "OCR_NO_TEXT_DETECTED"
            return OCRResponse(
                available=True,
                engine="paddleocr",
                engine_version=self._engine_version,
                tokens=tokens,
                warning_code=warning_code,
                elapsed_ms=max(0, round((monotonic() - started) * 1000)),
            )
        except _OcrUnavailableError as exc:
            return self._unavailable(exc.warning_code, started)
        except (binascii.Error, ValueError):
            return self._unavailable("OCR_INVALID_REQUEST_IMAGE", started)
        except Exception:  # noqa: BLE001 - third-party inference errors must fail closed.
            return self._unavailable("PADDLEOCR_INFERENCE_FAILED", started)

    def runtime_capabilities(self) -> OCRRuntimeCapabilities:
        try:
            with self._inference_lock:
                self._ensure_runtime()
        except _OcrUnavailableError as exc:
            return OCRRuntimeCapabilities(
                available=False,
                selected_runtime=_RUNTIME_UNAVAILABLE,
                available_runtimes=[],
                fallback_chain=self._runtime_candidates(),
                onnx_providers=self._detect_onnx_providers(),
                onnxruntime_version=self._onnxruntime_version(),
                model_formats=self._model_formats(),
                warning_code=exc.warning_code,
            )
        return OCRRuntimeCapabilities(
            available=True,
            selected_runtime=self._selected_runtime or _RUNTIME_UNAVAILABLE,
            available_runtimes=[self._selected_runtime] if self._selected_runtime else [],
            fallback_chain=list(self._runtime_fallback_chain),
            onnx_providers=list(self._onnx_providers),
            onnxruntime_version=self._onnxruntime_version(),
            model_formats=self._model_formats(),
        )

    def _ensure_runtime(self) -> None:
        missing = self._missing_model_files()
        if missing:
            raise _OcrUnavailableError("PADDLEOCR_MODEL_MISSING")

        if self._orientation_model is not None and self._ocr_pipeline is not None:
            return

        os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
        paddleocr = importlib.import_module("paddleocr")
        orientation_cls = getattr(paddleocr, "DocImgOrientationClassification")
        pipeline_cls = getattr(paddleocr, "PaddleOCR")
        candidates = self._runtime_candidates()
        self._runtime_fallback_chain = list(candidates)
        self._onnx_providers = self._detect_onnx_providers()

        for runtime_name in candidates:
            if runtime_name in self._failed_runtimes:
                continue
            try:
                self._verify_runtime_provider(runtime_name)
                orientation, pipeline = self._build_runtime(
                    runtime_name,
                    orientation_cls=orientation_cls,
                    pipeline_cls=pipeline_cls,
                )
            except Exception as exc:  # noqa: BLE001 - runtime probing must fall back safely.
                _LOGGER.warning(
                    "Medical redact OCR runtime initialization failed runtime=%s error=%s detail=%s",
                    runtime_name,
                    type(exc).__name__,
                    exc,
                )
                continue

            self._orientation_model = orientation
            self._ocr_pipeline = pipeline
            self._selected_runtime = runtime_name
            self._engine_version = self._runtime_engine_version(runtime_name)
            return

        raise _OcrUnavailableError("PADDLEOCR_RUNTIME_UNAVAILABLE")

    def _infer_with_runtime_fallback(self, image: NDArray[np.uint8]) -> _OcrSnapshot:
        while True:
            self._ensure_runtime()
            runtime_name = self._selected_runtime
            try:
                return self._infer_pixels(image)
            except _OcrUnavailableError:
                raise
            except Exception as exc:
                if runtime_name is None:
                    raise

                self._failed_runtimes.add(runtime_name)
                _LOGGER.warning(
                    "Medical redact OCR inference failed runtime=%s; falling back to next runtime error=%s detail=%s",
                    runtime_name,
                    type(exc).__name__,
                    exc,
                )
                self._reset_runtime()

                remaining = [
                    candidate for candidate in self._runtime_candidates() if candidate not in self._failed_runtimes
                ]
                if not remaining:
                    raise

    def _reset_runtime(self) -> None:
        orientation = self._orientation_model
        pipeline = self._ocr_pipeline
        self._orientation_model = None
        self._ocr_pipeline = None
        self._selected_runtime = None
        self._engine_version = None
        if pipeline is not None:
            self._close_runtime_object(pipeline)
        if orientation is not None and orientation is not pipeline:
            self._close_runtime_object(orientation)

    def _verify_runtime_provider(self, runtime_name: str) -> None:
        provider = {
            _RUNTIME_COREML: "CoreMLExecutionProvider",
        }.get(runtime_name)
        if provider is None:
            return
        self._probe_onnx_provider(provider)

    def _probe_onnx_provider(self, provider: str) -> None:
        onnxruntime = importlib.import_module("onnxruntime")
        inference_session = getattr(onnxruntime, "InferenceSession")
        model_path = self._model_root / _MODEL_DIRS["orientation"] / "inference.onnx"
        session = inference_session(
            str(model_path),
            providers=[provider, "CPUExecutionProvider"],
        )
        active_providers = [str(value) for value in session.get_providers()]
        if provider not in active_providers:
            raise RuntimeError(
                f"Requested ONNX provider {provider} was not activated; active providers: {active_providers!r}"
            )

    def _build_runtime(
        self,
        runtime_name: str,
        *,
        orientation_cls: Any,
        pipeline_cls: Any,
    ) -> tuple[Any, Any]:
        common: dict[str, Any]
        if runtime_name == _RUNTIME_COREML:
            common = {
                "device": "cpu",
                "engine": "onnxruntime",
                "engine_config": {
                    "providers": ["CoreMLExecutionProvider", "CPUExecutionProvider"],
                },
            }
        elif runtime_name == _RUNTIME_ONNX_CUDA:
            common = {
                "device": self._gpu_device,
                "engine": "onnxruntime",
                "engine_config": {
                    "providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
                },
            }
        elif runtime_name == _RUNTIME_ONNX_CPU:
            common = {
                "device": "cpu",
                "engine": "onnxruntime",
                "engine_config": {"providers": ["CPUExecutionProvider"]},
            }
        elif runtime_name == _RUNTIME_PADDLE_GPU:
            common = {
                "device": self._gpu_device,
                "engine": "paddle",
            }
        elif runtime_name == _RUNTIME_PADDLE_CPU:
            common = {
                "device": "cpu",
                "engine": "paddle",
            }
        else:
            raise ValueError(f"Unsupported medical-redact OCR runtime: {runtime_name}")

        orientation = orientation_cls(
            model_name="PP-LCNet_x1_0_doc_ori",
            model_dir=str(self._model_root / _MODEL_DIRS["orientation"]),
            **common,
        )
        try:
            pipeline = pipeline_cls(
                text_detection_model_name="PP-OCRv6_small_det",
                text_detection_model_dir=str(self._model_root / _MODEL_DIRS["detection"]),
                textline_orientation_model_name="PP-LCNet_x1_0_textline_ori",
                textline_orientation_model_dir=str(self._model_root / _MODEL_DIRS["textline_orientation"]),
                text_recognition_model_name="PP-OCRv6_small_rec",
                text_recognition_model_dir=str(self._model_root / _MODEL_DIRS["recognition"]),
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=True,
                return_word_box=True,
                text_rec_score_thresh=0.0,
                **common,
            )
        except Exception:
            self._close_runtime_object(orientation)
            raise
        return orientation, pipeline

    def _runtime_candidates(self) -> list[str]:
        preference = self._runtime_preference.lower().replace("_", "-")
        onnx_ready = self._onnx_models_ready()
        providers = set(self._detect_onnx_providers())
        system = platform.system()
        machine = platform.machine().lower()
        apple_silicon = system == "Darwin" and machine in {"arm64", "aarch64"}
        windows_x64 = system == "Windows" and machine in {"amd64", "x86_64", "x64"}
        onnx_cuda = windows_x64 and self._onnx_cuda_available()
        paddle_cuda = windows_x64 and self._paddle_cuda_available()

        candidates: list[str] = []

        def add_coreml() -> None:
            if onnx_ready and apple_silicon and "CoreMLExecutionProvider" in providers:
                candidates.append(_RUNTIME_COREML)

        def add_onnx_cuda() -> None:
            if onnx_ready and windows_x64 and "CUDAExecutionProvider" in providers and onnx_cuda:
                candidates.append(_RUNTIME_ONNX_CUDA)

        def add_paddle_gpu() -> None:
            if paddle_cuda:
                candidates.append(_RUNTIME_PADDLE_GPU)

        def add_onnx_cpu() -> None:
            if onnx_ready and "CPUExecutionProvider" in providers:
                candidates.append(_RUNTIME_ONNX_CPU)

        def add_cpu_fallbacks() -> None:
            add_onnx_cpu()
            candidates.append(_RUNTIME_PADDLE_CPU)

        if preference == "auto":
            if apple_silicon:
                add_coreml()
            elif windows_x64:
                add_onnx_cuda()
                add_paddle_gpu()
            add_cpu_fallbacks()
        elif preference == "coreml":
            add_coreml()
            add_cpu_fallbacks()
        elif preference in {"cuda", "onnx-cuda", "onnx-gpu"}:
            add_onnx_cuda()
            add_cpu_fallbacks()
        elif preference in {"gpu", "windows-gpu"}:
            add_onnx_cuda()
            add_paddle_gpu()
            add_cpu_fallbacks()
        elif preference == "paddle-gpu":
            add_paddle_gpu()
            add_cpu_fallbacks()
        elif preference in {"onnx", "onnx-cpu"}:
            add_cpu_fallbacks()
        elif preference in {"paddle", "paddle-cpu"}:
            candidates.append(_RUNTIME_PADDLE_CPU)
        else:
            _LOGGER.warning(
                "Unknown MEDICAL_REDACT_OCR_RUNTIME=%s; using automatic selection",
                self._runtime_preference,
            )
            if apple_silicon:
                add_coreml()
            elif windows_x64:
                add_onnx_cuda()
                add_paddle_gpu()
            add_cpu_fallbacks()
        return list(dict.fromkeys(candidates))

    def _onnx_models_ready(self) -> bool:
        return all((self._model_root / directory / "inference.onnx").is_file() for directory in _MODEL_DIRS.values())

    def _model_formats(self) -> list[str]:
        formats = ["PADDLE"] if not self._missing_model_files() else []
        if self._onnx_models_ready():
            formats.append("ONNX")
        return formats

    @staticmethod
    def _detect_onnx_providers() -> list[str]:
        try:
            onnxruntime = importlib.import_module("onnxruntime")
            providers = getattr(onnxruntime, "get_available_providers")()
            return [str(provider) for provider in providers]
        except Exception:  # noqa: BLE001 - optional ONNX runtime must fail closed to Paddle CPU.
            return []

    def _onnx_cuda_available(self) -> bool:
        if not self._onnx_models_ready():
            return False
        try:
            if "CUDAExecutionProvider" not in set(self._detect_onnx_providers()):
                return False
            self._probe_onnx_provider("CUDAExecutionProvider")
            return True
        except Exception:  # noqa: BLE001 - optional CUDA probing must never block CPU fallback.
            return False

    @staticmethod
    def _paddle_cuda_available() -> bool:
        try:
            paddle = importlib.import_module("paddle")
            is_compiled_with_cuda = getattr(paddle.device, "is_compiled_with_cuda")
            cuda = getattr(paddle.device, "cuda")
            return bool(is_compiled_with_cuda()) and int(cuda.device_count()) > 0
        except Exception:  # noqa: BLE001 - optional Paddle CUDA probing must never block CPU fallback.
            return False

    @staticmethod
    def _package_version(package: str) -> str | None:
        try:
            return importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            return None

    def _onnxruntime_version(self) -> str | None:
        return self._package_version("onnxruntime") or self._package_version("onnxruntime-gpu")

    def _paddle_version(self) -> str | None:
        return self._package_version("paddlepaddle") or self._package_version("paddlepaddle-gpu")

    @staticmethod
    def _close_runtime_object(runtime: Any) -> None:
        close = getattr(runtime, "close", None)
        if callable(close):
            close()

    def _runtime_engine_version(self, runtime_name: str) -> str:
        paddleocr_version = self._package_version("paddleocr") or "unknown"
        if runtime_name in {_RUNTIME_COREML, _RUNTIME_ONNX_CUDA, _RUNTIME_ONNX_CPU}:
            onnxruntime_version = self._onnxruntime_version() or "unknown"
            return (
                f"paddleocr/{paddleocr_version}+onnxruntime/{onnxruntime_version}+{runtime_name.lower()}+PP-OCRv6-small"
            )
        paddle_version = self._paddle_version() or "unknown"
        return f"paddleocr/{paddleocr_version}+paddle/{paddle_version}+PP-OCRv6-small"

    def _missing_model_files(self) -> list[Path]:
        missing: list[Path] = []
        for directory in _MODEL_DIRS.values():
            model_dir = self._model_root / directory
            for filename in _REQUIRED_MODEL_FILES:
                path = model_dir / filename
                if not path.is_file():
                    missing.append(path)
        return missing

    def _infer_pixels(self, image: NDArray[np.uint8]) -> _OcrSnapshot:
        if self._orientation_model is None or self._ocr_pipeline is None:
            raise _OcrUnavailableError("PADDLEOCR_RUNTIME_UNAVAILABLE")

        original_height, original_width = image.shape[:2]
        orientation_angle = self._classify_orientation(image)
        oriented = self._rotate_right_angle(image, orientation_angle)

        skew_angle = self._estimate_skew_angle(oriented)
        deskew_matrix: NDArray[np.float64] | None = None
        processed = oriented
        if skew_angle is not None:
            oriented_height, oriented_width = oriented.shape[:2]
            center = (oriented_width / 2.0, oriented_height / 2.0)
            deskew_matrix = np.asarray(cv2.getRotationMatrix2D(center, skew_angle, 1.0), dtype=np.float64)
            processed = cast(
                NDArray[np.uint8],
                cv2.warpAffine(
                    oriented,
                    deskew_matrix,
                    (oriented_width, oriented_height),
                    flags=cv2.INTER_LINEAR,
                    borderMode=cv2.BORDER_CONSTANT,
                    borderValue=(255, 255, 255),
                ),
            )

        results = list(self._ocr_pipeline.predict(processed))
        if not results:
            return _OcrSnapshot(tokens=(), warning_code="OCR_NO_TEXT_DETECTED")

        data = self._result_payload(results[0])
        pixel_tokens = self._build_pixel_tokens(
            data,
            original_width=original_width,
            original_height=original_height,
            orientation_angle=orientation_angle,
            deskew_matrix=deskew_matrix,
        )
        warning_code = None
        if any(token.confidence < _LOW_CONFIDENCE_THRESHOLD for token in pixel_tokens):
            warning_code = "OCR_LOW_CONFIDENCE_PRESENT"
        return _OcrSnapshot(tokens=tuple(pixel_tokens), warning_code=warning_code)

    def _classify_orientation(self, image: NDArray[np.uint8]) -> int:
        if self._orientation_model is None:
            return 0
        results = list(self._orientation_model.predict(image, batch_size=1))
        if not results:
            return 0
        data = self._result_payload(results[0])
        labels = data.get("label_names") or []
        scores = data.get("scores") or []
        if not labels:
            return 0
        try:
            angle = int(str(labels[0]))
        except ValueError:
            return 0
        if angle not in {0, 90, 180, 270}:
            return 0
        if scores and float(scores[0]) < 0.5:
            return 0
        return angle

    @staticmethod
    def _rotate_right_angle(image: NDArray[np.uint8], angle: int) -> NDArray[np.uint8]:
        if angle == 90:
            return cast(NDArray[np.uint8], cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE))
        if angle == 180:
            return cast(NDArray[np.uint8], cv2.rotate(image, cv2.ROTATE_180))
        if angle == 270:
            return cast(NDArray[np.uint8], cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE))
        return image

    @staticmethod
    def _estimate_skew_angle(image: NDArray[np.uint8]) -> float | None:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 50, 150, apertureSize=3)
        height, width = gray.shape[:2]
        lines = cv2.HoughLinesP(
            edges,
            1,
            np.pi / 180,
            threshold=80,
            minLineLength=max(80, width // 8),
            maxLineGap=max(12, width // 100),
        )
        if lines is None:
            return None

        angles: list[float] = []
        for x1, y1, x2, y2 in lines[:, 0]:
            angle = float(np.degrees(np.arctan2(float(y2 - y1), float(x2 - x1))))
            if -20.0 <= angle <= 20.0:
                angles.append(angle)
        if len(angles) < 5:
            return None

        median = float(np.median(np.asarray(angles, dtype=np.float64)))
        if abs(median) < _DESKEW_MIN_DEGREES or abs(median) > _DESKEW_MAX_DEGREES:
            return None
        return median

    def _build_pixel_tokens(
        self,
        data: dict[str, Any],
        *,
        original_width: int,
        original_height: int,
        orientation_angle: int,
        deskew_matrix: NDArray[np.float64] | None,
    ) -> list[_PixelToken]:
        texts = list(data.get("rec_texts") or [])
        scores = list(data.get("rec_scores") or [])
        polygons = list(data.get("rec_polys") or [])
        word_lines = list(data.get("text_word") or [])
        word_box_lines = list(data.get("text_word_boxes") or [])

        inverse_deskew = self._invert_affine(deskew_matrix) if deskew_matrix is not None else None
        tokens: list[_PixelToken] = []

        for line_index, text_value in enumerate(texts, start=1):
            text = str(text_value).strip()
            if not text:
                continue
            score = float(scores[line_index - 1]) if line_index - 1 < len(scores) else 0.0
            groups: list[
                tuple[
                    str,
                    tuple[float, float, float, float],
                    list[tuple[str, tuple[float, float, float, float]]],
                ]
            ]
            if line_index - 1 < len(word_lines) and line_index - 1 < len(word_box_lines):
                groups = self._group_word_boxes(
                    list(word_lines[line_index - 1]),
                    list(word_box_lines[line_index - 1]),
                )
            else:
                groups = []

            if not groups and line_index - 1 < len(polygons):
                polygon = self._normalize_polygon(polygons[line_index - 1])
                if polygon is not None:
                    left = min(point[0] for point in polygon)
                    top = min(point[1] for point in polygon)
                    right = max(point[0] for point in polygon)
                    bottom = max(point[1] for point in polygon)
                    groups = [(text, (left, top, right, bottom), [(text, (left, top, right, bottom))])]

            for group_index, (group_text, box, units) in enumerate(groups, start=1):
                mapped_polygon = self._map_rect_to_original(
                    box,
                    inverse_deskew=inverse_deskew,
                    orientation_angle=orientation_angle,
                    original_width=original_width,
                    original_height=original_height,
                )
                char_boxes: list[_PixelCharacter] = []
                for unit_text, unit_box in units:
                    char_boxes.extend(
                        self._character_boxes(
                            unit_text,
                            unit_box,
                            inverse_deskew=inverse_deskew,
                            orientation_angle=orientation_angle,
                            original_width=original_width,
                            original_height=original_height,
                        )
                    )
                tokens.append(
                    _PixelToken(
                        text=group_text,
                        polygon=mapped_polygon,
                        confidence=max(0.0, min(1.0, score)),
                        line_index=line_index,
                        group_index=group_index,
                        char_boxes=tuple(char_boxes),
                    )
                )
        return tokens

    @staticmethod
    def _group_word_boxes(
        words: list[Any], boxes: list[Any]
    ) -> list[
        tuple[
            str,
            tuple[float, float, float, float],
            list[tuple[str, tuple[float, float, float, float]]],
        ]
    ]:
        units: list[tuple[str, tuple[float, float, float, float]]] = []
        for word, raw_box in zip(words, boxes, strict=False):
            text = str(word)
            if not text or not isinstance(raw_box, (list, tuple)) or len(raw_box) < 4:
                continue
            values = [float(value) for value in raw_box[:4]]
            box = (values[0], values[1], values[2], values[3])
            if box[2] <= box[0] or box[3] <= box[1]:
                continue
            units.append((text, box))

        groups: list[
            tuple[
                str,
                tuple[float, float, float, float],
                list[tuple[str, tuple[float, float, float, float]]],
            ]
        ] = []
        current: list[tuple[str, tuple[float, float, float, float]]] = []

        def flush() -> None:
            if not current:
                return
            visible = [(text, box) for text, box in current if not text.isspace()]
            current.clear()
            if not visible:
                return
            text = "".join(item[0] for item in visible)
            left = min(item[1][0] for item in visible)
            top = min(item[1][1] for item in visible)
            right = max(item[1][2] for item in visible)
            bottom = max(item[1][3] for item in visible)
            groups.append((text, (left, top, right, bottom), visible))

        previous_box: tuple[float, float, float, float] | None = None
        previous_ascii: bool | None = None
        character_count = 0
        for text, box in units:
            if text.isspace():
                flush()
                previous_box = None
                previous_ascii = None
                character_count = 0
                continue

            ascii_word = OcrService._is_ascii_word(text)
            if current and previous_box is not None:
                line_height = max(1.0, previous_box[3] - previous_box[1])
                gap = box[0] - previous_box[2]
                category_change = (
                    previous_ascii is not None and ascii_word != previous_ascii and text not in _BREAK_AFTER
                )
                if gap > line_height * 0.55 or category_change:
                    flush()
                    character_count = 0

            current.append((text, box))
            character_count += len(text)
            previous_box = box
            previous_ascii = ascii_word
            if any(char in _BREAK_AFTER for char in text) or (
                not ascii_word and character_count >= _MAX_CJK_TOKEN_CHARS
            ):
                flush()
                previous_box = None
                previous_ascii = None
                character_count = 0
        flush()
        return groups

    @staticmethod
    def _is_ascii_word(text: str) -> bool:
        return bool(text) and all(ord(char) < 128 and not char.isspace() for char in text)

    def _character_boxes(
        self,
        text: str,
        box: tuple[float, float, float, float],
        *,
        inverse_deskew: NDArray[np.float64] | None,
        orientation_angle: int,
        original_width: int,
        original_height: int,
    ) -> list[_PixelCharacter]:
        characters = [char for char in text if not char.isspace()]
        if not characters:
            return []
        left, top, right, bottom = box
        step = (right - left) / len(characters)
        result: list[_PixelCharacter] = []
        for index, character in enumerate(characters):
            char_box = (
                left + step * index,
                top,
                left + step * (index + 1),
                bottom,
            )
            result.append(
                _PixelCharacter(
                    text=character,
                    polygon=self._map_rect_to_original(
                        char_box,
                        inverse_deskew=inverse_deskew,
                        orientation_angle=orientation_angle,
                        original_width=original_width,
                        original_height=original_height,
                    ),
                )
            )
        return result

    @staticmethod
    def _invert_affine(matrix: NDArray[np.float64]) -> NDArray[np.float64]:
        determinant = float(matrix[0, 0] * matrix[1, 1] - matrix[0, 1] * matrix[1, 0])
        if not np.isfinite(determinant) or abs(determinant) < 1e-9:
            raise _OcrUnavailableError("OCR_TRANSFORM_NON_INVERTIBLE")
        inverse = np.asarray(cv2.invertAffineTransform(matrix), dtype=np.float64)
        if inverse.shape != (2, 3) or not np.isfinite(inverse).all():
            raise _OcrUnavailableError("OCR_TRANSFORM_NON_INVERTIBLE")
        return inverse

    @staticmethod
    def _normalize_polygon(raw_polygon: Any) -> tuple[tuple[float, float], ...] | None:
        if not isinstance(raw_polygon, (list, tuple)) or len(raw_polygon) < 4:
            return None
        points: list[tuple[float, float]] = []
        for raw_point in raw_polygon[:4]:
            if not isinstance(raw_point, (list, tuple)) or len(raw_point) < 2:
                return None
            points.append((float(raw_point[0]), float(raw_point[1])))
        return tuple(points)

    def _map_rect_to_original(
        self,
        box: tuple[float, float, float, float],
        *,
        inverse_deskew: NDArray[np.float64] | None,
        orientation_angle: int,
        original_width: int,
        original_height: int,
    ) -> tuple[tuple[float, float], ...]:
        left, top, right, bottom = box
        points = (
            (left, top),
            (right, top),
            (right, bottom),
            (left, bottom),
        )
        return tuple(
            self._map_to_original(
                point,
                inverse_deskew=inverse_deskew,
                orientation_angle=orientation_angle,
                original_width=original_width,
                original_height=original_height,
            )
            for point in points
        )

    @staticmethod
    def _map_to_original(
        point: tuple[float, float],
        *,
        inverse_deskew: NDArray[np.float64] | None,
        orientation_angle: int,
        original_width: int,
        original_height: int,
    ) -> tuple[float, float]:
        x, y = point
        if inverse_deskew is not None:
            x, y = (
                float(inverse_deskew[0, 0] * x + inverse_deskew[0, 1] * y + inverse_deskew[0, 2]),
                float(inverse_deskew[1, 0] * x + inverse_deskew[1, 1] * y + inverse_deskew[1, 2]),
            )

        if orientation_angle == 90:
            original_x, original_y = original_width - y, x
        elif orientation_angle == 180:
            original_x, original_y = original_width - x, original_height - y
        elif orientation_angle == 270:
            original_x, original_y = y, original_height - x
        else:
            original_x, original_y = x, y

        return (
            max(0.0, min(float(original_width), original_x)),
            max(0.0, min(float(original_height), original_y)),
        )

    def _to_page_tokens(self, request: OCRRequest, pixel_tokens: tuple[_PixelToken, ...]) -> list[TextToken]:
        scale_x = request.page_width / request.render_width
        scale_y = request.page_height / request.render_height
        result: list[TextToken] = []
        for token in pixel_tokens:
            page_polygon = self._scale_polygon(token.polygon, scale_x, scale_y)
            token_id = self._stable_token_id(request.page_id, token, page_polygon)
            char_boxes = [
                CharacterBox(
                    text=character.text,
                    polygon=self._scale_polygon(character.polygon, scale_x, scale_y),
                )
                for character in token.char_boxes
            ]
            result.append(
                TextToken(
                    id=token_id,
                    text=token.text,
                    page_id=request.page_id,
                    polygon=page_polygon,
                    confidence=token.confidence,
                    line_id=f"{request.page_id}-L{token.line_index:04d}",
                    block_id=f"{request.page_id}-B0001",
                    source=TextSource.PADDLE_OCR,
                    char_boxes=char_boxes or None,
                )
            )
        return result

    @staticmethod
    def _scale_polygon(polygon: tuple[tuple[float, float], ...], scale_x: float, scale_y: float) -> list[PolygonPoint]:
        return [PolygonPoint(x=x * scale_x, y=y * scale_y) for x, y in polygon]

    @staticmethod
    def _stable_token_id(page_id: str, token: _PixelToken, polygon: list[PolygonPoint]) -> str:
        geometry = "|".join(f"{round(point.x * 10)}:{round(point.y * 10)}" for point in polygon)
        payload = f"{page_id}|{token.line_index}|{token.group_index}|{geometry}".encode()
        return "token-" + hashlib.sha256(payload).hexdigest()[:20]

    @staticmethod
    def _result_payload(result: Any) -> dict[str, Any]:
        raw = getattr(result, "json", None)
        if callable(raw):
            raw = raw()
        if not isinstance(raw, dict):
            return {}
        payload = raw.get("res", raw)
        return payload if isinstance(payload, dict) else {}

    def _get_cached(self, cache_key: str) -> _OcrSnapshot | None:
        with self._cache_lock:
            snapshot = self._cache.get(cache_key)
            if snapshot is None:
                return None
            self._cache.move_to_end(cache_key)
            return snapshot

    def _put_cached(self, cache_key: str, snapshot: _OcrSnapshot) -> None:
        with self._cache_lock:
            self._cache[cache_key] = snapshot
            self._cache.move_to_end(cache_key)
            while len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)

    def _unavailable(self, warning_code: str, started: float) -> OCRResponse:
        return OCRResponse(
            available=False,
            engine="paddleocr",
            engine_version=self._engine_version,
            tokens=[],
            warning_code=warning_code,
            elapsed_ms=max(0, round((monotonic() - started) * 1000)),
        )
