from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

_MODEL_DIRS = (
    "PP-LCNet_x1_0_doc_ori_infer",
    "PP-LCNet_x1_0_textline_ori_infer",
    "PP-OCRv6_small_det_infer",
    "PP-OCRv6_small_rec_infer",
)


def default_model_root() -> Path:
    return Path(__file__).resolve().parents[2] / ".cache" / "medical-redact" / "models"


def converter_command() -> list[str]:
    return [
        "uvx",
        "--python",
        "3.12",
        "--with",
        "packaging",
        "--with",
        "paddlepaddle==3.3.1",
        "paddle2onnx==2.1.0",
    ]


def convert_model(model_dir: Path, opset_version: int, force: bool) -> None:
    model_file = model_dir / "inference.json"
    params_file = model_dir / "inference.pdiparams"
    output_file = model_dir / "inference.onnx"
    if output_file.is_file() and not force:
        print(f"{model_dir.name}: ONNX model already present")
        return
    if not model_file.is_file() or not params_file.is_file():
        raise RuntimeError(f"Missing Paddle inference files in {model_dir}")

    command = [
        *converter_command(),
        "--model_dir",
        str(model_dir),
        "--model_filename",
        model_file.name,
        "--params_filename",
        params_file.name,
        "--save_file",
        str(output_file),
        "--opset_version",
        str(opset_version),
        "--enable_onnx_checker",
        "True",
        "--optimize_tool",
        "None",
    ]
    print(f"{model_dir.name}: converting to ONNX")
    subprocess.run(command, check=True)
    if not output_file.is_file() or output_file.stat().st_size <= 0:
        raise RuntimeError(f"ONNX conversion did not produce {output_file}")
    print(f"{model_dir.name}: {output_file.stat().st_size} bytes")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Pre-convert medical-redact Paddle OCR models to ONNX for local runtime fallback."
    )
    parser.add_argument("--model-root", type=Path, default=default_model_root())
    parser.add_argument("--opset-version", type=int, default=11)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    root = args.model_root.expanduser().resolve()
    for directory_name in _MODEL_DIRS:
        convert_model(root / directory_name, args.opset_version, args.force)

    print(f"Medical-redact ONNX models ready: {root}")


if __name__ == "__main__":
    main()
