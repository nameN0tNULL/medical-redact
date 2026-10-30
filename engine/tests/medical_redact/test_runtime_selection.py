from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from stirling.medical_redact.ocr import OcrService

_MODEL_DIRS = (
    "PP-LCNet_x1_0_doc_ori_infer",
    "PP-LCNet_x1_0_textline_ori_infer",
    "PP-OCRv6_small_det_infer",
    "PP-OCRv6_small_rec_infer",
)


class _RuntimeStub:
    def close(self) -> None:
        return None


def _fake_models(root: Path, *, onnx: bool = True) -> None:
    for directory in _MODEL_DIRS:
        model_dir = root / directory
        model_dir.mkdir(parents=True)
        for filename in ("inference.json", "inference.pdiparams", "inference.yml"):
            (model_dir / filename).write_text("test", encoding="utf-8")
        if onnx:
            (model_dir / "inference.onnx").write_bytes(b"onnx")


def test_coreml_initialization_failure_falls_back_to_onnx_cpu(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_models(tmp_path)
    service = OcrService(model_root=tmp_path, runtime="auto")
    attempts: list[str] = []

    monkeypatch.setattr("stirling.medical_redact.ocr.platform.system", lambda: "Darwin")
    monkeypatch.setattr("stirling.medical_redact.ocr.platform.machine", lambda: "arm64")
    monkeypatch.setattr(
        service,
        "_detect_onnx_providers",
        lambda: ["CoreMLExecutionProvider", "CPUExecutionProvider"],
    )
    monkeypatch.setattr(service, "_probe_onnx_provider", lambda provider: None)

    def build_runtime(runtime_name: str, *, orientation_cls: Any, pipeline_cls: Any) -> tuple[Any, Any]:
        del orientation_cls, pipeline_cls
        attempts.append(runtime_name)
        if runtime_name == "COREML":
            raise RuntimeError("simulated CoreML initialization failure")
        return _RuntimeStub(), _RuntimeStub()

    monkeypatch.setattr(service, "_build_runtime", build_runtime)

    capabilities = service.runtime_capabilities()

    assert attempts == ["COREML", "ONNX_CPU"]
    assert capabilities.available is True
    assert capabilities.selected_runtime == "ONNX_CPU"
    assert capabilities.available_runtimes == ["ONNX_CPU"]
    assert capabilities.fallback_chain == ["COREML", "ONNX_CPU", "PADDLE_CPU"]


def test_coreml_inference_failure_blacklists_runtime_and_falls_back_to_onnx_cpu(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_models(tmp_path)
    service = OcrService(model_root=tmp_path, runtime="auto")
    service._orientation_model = _RuntimeStub()
    service._ocr_pipeline = _RuntimeStub()
    service._selected_runtime = "COREML"
    attempts: list[str | None] = []

    monkeypatch.setattr(
        service,
        "_runtime_candidates",
        lambda: ["COREML", "ONNX_CPU", "PADDLE_CPU"],
    )

    def ensure_runtime() -> None:
        if service._orientation_model is not None and service._ocr_pipeline is not None:
            return
        service._orientation_model = _RuntimeStub()
        service._ocr_pipeline = _RuntimeStub()
        service._selected_runtime = "ONNX_CPU"

    def infer_pixels(image: Any) -> str:
        del image
        attempts.append(service._selected_runtime)
        if service._selected_runtime == "COREML":
            raise RuntimeError("simulated CoreML execution failure")
        return "fallback-result"

    monkeypatch.setattr(service, "_ensure_runtime", ensure_runtime)
    monkeypatch.setattr(service, "_infer_pixels", infer_pixels)

    result = service._infer_with_runtime_fallback(np.zeros((16, 16, 3), dtype=np.uint8))

    assert result == "fallback-result"
    assert attempts == ["COREML", "ONNX_CPU"]
    assert service._selected_runtime == "ONNX_CPU"
    assert service._failed_runtimes == {"COREML"}


def test_missing_onnx_models_keep_paddle_cpu_as_safe_baseline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_models(tmp_path, onnx=False)
    service = OcrService(model_root=tmp_path, runtime="auto")
    attempts: list[str] = []

    monkeypatch.setattr("stirling.medical_redact.ocr.platform.system", lambda: "Darwin")
    monkeypatch.setattr("stirling.medical_redact.ocr.platform.machine", lambda: "arm64")
    monkeypatch.setattr(
        service,
        "_detect_onnx_providers",
        lambda: ["CoreMLExecutionProvider", "CPUExecutionProvider"],
    )

    def build_runtime(runtime_name: str, *, orientation_cls: Any, pipeline_cls: Any) -> tuple[Any, Any]:
        del orientation_cls, pipeline_cls
        attempts.append(runtime_name)
        return _RuntimeStub(), _RuntimeStub()

    monkeypatch.setattr(service, "_build_runtime", build_runtime)

    capabilities = service.runtime_capabilities()

    assert attempts == ["PADDLE_CPU"]
    assert capabilities.available is True
    assert capabilities.selected_runtime == "PADDLE_CPU"
    assert capabilities.model_formats == ["PADDLE"]


def test_windows_x64_prefers_onnx_cuda_when_provider_initializes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_models(tmp_path)
    service = OcrService(model_root=tmp_path, runtime="auto")
    attempts: list[str] = []

    monkeypatch.setattr("stirling.medical_redact.ocr.platform.system", lambda: "Windows")
    monkeypatch.setattr("stirling.medical_redact.ocr.platform.machine", lambda: "AMD64")
    monkeypatch.setattr(
        service,
        "_detect_onnx_providers",
        lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"],
    )
    monkeypatch.setattr(service, "_onnx_cuda_available", lambda: True)
    monkeypatch.setattr(service, "_paddle_cuda_available", lambda: False)

    def build_runtime(runtime_name: str, *, orientation_cls: Any, pipeline_cls: Any) -> tuple[Any, Any]:
        del orientation_cls, pipeline_cls
        attempts.append(runtime_name)
        return _RuntimeStub(), _RuntimeStub()

    monkeypatch.setattr(service, "_build_runtime", build_runtime)

    capabilities = service.runtime_capabilities()

    assert attempts == ["ONNX_CUDA"]
    assert capabilities.selected_runtime == "ONNX_CUDA"
    assert capabilities.available_runtimes == ["ONNX_CUDA"]
    assert capabilities.fallback_chain == ["ONNX_CUDA", "ONNX_CPU", "PADDLE_CPU"]


def test_windows_cuda_initialization_failure_falls_back_to_onnx_cpu(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_models(tmp_path)
    service = OcrService(model_root=tmp_path, runtime="auto")
    attempts: list[str] = []

    monkeypatch.setattr("stirling.medical_redact.ocr.platform.system", lambda: "Windows")
    monkeypatch.setattr("stirling.medical_redact.ocr.platform.machine", lambda: "AMD64")
    monkeypatch.setattr(
        service,
        "_detect_onnx_providers",
        lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"],
    )
    monkeypatch.setattr(service, "_onnx_cuda_available", lambda: True)
    monkeypatch.setattr(service, "_paddle_cuda_available", lambda: False)

    def build_runtime(runtime_name: str, *, orientation_cls: Any, pipeline_cls: Any) -> tuple[Any, Any]:
        del orientation_cls, pipeline_cls
        attempts.append(runtime_name)
        if runtime_name == "ONNX_CUDA":
            raise RuntimeError("simulated CUDA initialization failure")
        return _RuntimeStub(), _RuntimeStub()

    monkeypatch.setattr(service, "_build_runtime", build_runtime)

    capabilities = service.runtime_capabilities()

    assert attempts == ["ONNX_CUDA", "ONNX_CPU"]
    assert capabilities.selected_runtime == "ONNX_CPU"
    assert capabilities.fallback_chain == ["ONNX_CUDA", "ONNX_CPU", "PADDLE_CPU"]


def test_windows_can_use_paddle_gpu_when_custom_runtime_is_really_cuda_capable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_models(tmp_path)
    service = OcrService(model_root=tmp_path, runtime="auto")
    attempts: list[str] = []

    monkeypatch.setattr("stirling.medical_redact.ocr.platform.system", lambda: "Windows")
    monkeypatch.setattr("stirling.medical_redact.ocr.platform.machine", lambda: "AMD64")
    monkeypatch.setattr(
        service,
        "_detect_onnx_providers",
        lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"],
    )
    monkeypatch.setattr(service, "_onnx_cuda_available", lambda: True)
    monkeypatch.setattr(service, "_paddle_cuda_available", lambda: True)

    def build_runtime(runtime_name: str, *, orientation_cls: Any, pipeline_cls: Any) -> tuple[Any, Any]:
        del orientation_cls, pipeline_cls
        attempts.append(runtime_name)
        if runtime_name == "ONNX_CUDA":
            raise RuntimeError("simulated ONNX CUDA initialization failure")
        return _RuntimeStub(), _RuntimeStub()

    monkeypatch.setattr(service, "_build_runtime", build_runtime)

    capabilities = service.runtime_capabilities()

    assert attempts == ["ONNX_CUDA", "PADDLE_GPU"]
    assert capabilities.selected_runtime == "PADDLE_GPU"
    assert capabilities.fallback_chain == [
        "ONNX_CUDA",
        "PADDLE_GPU",
        "ONNX_CPU",
        "PADDLE_CPU",
    ]


def test_windows_cuda_provider_without_working_cuda_session_keeps_cpu_runtime_chain(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_models(tmp_path)
    service = OcrService(model_root=tmp_path, runtime="auto")
    attempts: list[str] = []

    monkeypatch.setattr("stirling.medical_redact.ocr.platform.system", lambda: "Windows")
    monkeypatch.setattr("stirling.medical_redact.ocr.platform.machine", lambda: "AMD64")
    monkeypatch.setattr(
        service,
        "_detect_onnx_providers",
        lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"],
    )
    monkeypatch.setattr(service, "_onnx_cuda_available", lambda: False)
    monkeypatch.setattr(service, "_paddle_cuda_available", lambda: False)

    def build_runtime(runtime_name: str, *, orientation_cls: Any, pipeline_cls: Any) -> tuple[Any, Any]:
        del orientation_cls, pipeline_cls
        attempts.append(runtime_name)
        return _RuntimeStub(), _RuntimeStub()

    monkeypatch.setattr(service, "_build_runtime", build_runtime)

    capabilities = service.runtime_capabilities()

    assert attempts == ["ONNX_CPU"]
    assert capabilities.selected_runtime == "ONNX_CPU"
    assert capabilities.fallback_chain == ["ONNX_CPU", "PADDLE_CPU"]


def test_windows_without_cuda_provider_keeps_cpu_runtime_chain(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_models(tmp_path)
    service = OcrService(model_root=tmp_path, runtime="auto")
    attempts: list[str] = []

    monkeypatch.setattr("stirling.medical_redact.ocr.platform.system", lambda: "Windows")
    monkeypatch.setattr("stirling.medical_redact.ocr.platform.machine", lambda: "AMD64")
    monkeypatch.setattr(
        service,
        "_detect_onnx_providers",
        lambda: ["CPUExecutionProvider"],
    )
    monkeypatch.setattr(service, "_onnx_cuda_available", lambda: False)
    monkeypatch.setattr(service, "_paddle_cuda_available", lambda: False)

    def build_runtime(runtime_name: str, *, orientation_cls: Any, pipeline_cls: Any) -> tuple[Any, Any]:
        del orientation_cls, pipeline_cls
        attempts.append(runtime_name)
        return _RuntimeStub(), _RuntimeStub()

    monkeypatch.setattr(service, "_build_runtime", build_runtime)

    capabilities = service.runtime_capabilities()

    assert attempts == ["ONNX_CPU"]
    assert capabilities.selected_runtime == "ONNX_CPU"
    assert capabilities.fallback_chain == ["ONNX_CPU", "PADDLE_CPU"]


def test_onnx_provider_probe_rejects_silent_cpu_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_models(tmp_path)
    service = OcrService(model_root=tmp_path, runtime="auto")

    class CpuOnlySession:
        def get_providers(self) -> list[str]:
            return ["CPUExecutionProvider"]

    def create_session(model_path: str, providers: list[str]) -> CpuOnlySession:
        del model_path, providers
        return CpuOnlySession()

    fake_onnxruntime = SimpleNamespace(InferenceSession=create_session)
    original_import_module = __import__("importlib").import_module

    def import_module(name: str) -> Any:
        if name == "onnxruntime":
            return fake_onnxruntime
        return original_import_module(name)

    monkeypatch.setattr("stirling.medical_redact.ocr.importlib.import_module", import_module)

    with pytest.raises(RuntimeError, match="was not activated"):
        service._probe_onnx_provider("CUDAExecutionProvider")


def test_cuda_runtime_build_requests_cuda_provider_with_cpu_provider_fallback(
    tmp_path: Path,
) -> None:
    _fake_models(tmp_path)
    service = OcrService(model_root=tmp_path, runtime="onnx-cuda")
    calls: list[dict[str, Any]] = []

    def runtime_factory(**kwargs: Any) -> _RuntimeStub:
        calls.append(kwargs)
        return _RuntimeStub()

    service._build_runtime(
        "ONNX_CUDA",
        orientation_cls=runtime_factory,
        pipeline_cls=runtime_factory,
    )

    assert len(calls) == 2
    for call in calls:
        assert call["device"] == "gpu:0"
        assert call["engine"] == "onnxruntime"
        assert call["engine_config"] == {"providers": ["CUDAExecutionProvider", "CPUExecutionProvider"]}


def test_paddle_gpu_runtime_build_uses_gpu_device(tmp_path: Path) -> None:
    _fake_models(tmp_path)
    service = OcrService(model_root=tmp_path, runtime="paddle-gpu")
    calls: list[dict[str, Any]] = []

    def runtime_factory(**kwargs: Any) -> _RuntimeStub:
        calls.append(kwargs)
        return _RuntimeStub()

    service._build_runtime(
        "PADDLE_GPU",
        orientation_cls=runtime_factory,
        pipeline_cls=runtime_factory,
    )

    assert len(calls) == 2
    for call in calls:
        assert call["device"] == "gpu:0"
        assert call["engine"] == "paddle"
        assert "engine_config" not in call
