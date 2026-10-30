from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


class NerBackendUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class NerEntity:
    raw_type: str
    entity_type: str
    start: int
    end: int
    confidence: float
    detector: str
    entity_role: str | None = None


class ChineseNERBackend(Protocol):
    def detect(self, text: str) -> list[NerEntity]: ...


@dataclass(frozen=True)
class _ContextPattern:
    raw_type: str
    entity_type: str
    detector: str
    pattern: re.Pattern[str]
    confidence: float
    entity_role: str | None = None


_HORIZONTAL_SPACE = r"[ \t\u3000]*"


def _label_pattern(
    labels: tuple[str, ...],
    value_pattern: str,
    *,
    require_colon: bool = False,
) -> re.Pattern[str]:
    label_group = "|".join(re.escape(label) for label in labels)
    colon = r"[:：]" if require_colon else r"[:：]?"
    return re.compile(
        rf"(?:{label_group}){_HORIZONTAL_SPACE}{colon}{_HORIZONTAL_SPACE}(?P<value>{value_pattern})",
        re.IGNORECASE,
    )


_CONTEXT_PATTERNS: tuple[_ContextPattern, ...] = (
    _ContextPattern(
        raw_type="PERSON",
        entity_type="PATIENT_NAME",
        entity_role="PATIENT",
        detector="ner-context-patient-name",
        pattern=_label_pattern(
            ("患者姓名", "病人姓名"),
            r"[\u3400-\u9fff·]{2,12}",
        ),
        confidence=0.94,
    ),
    _ContextPattern(
        raw_type="PERSON",
        entity_type="PATIENT_NAME",
        entity_role="PATIENT",
        detector="ner-context-patient-name",
        pattern=_label_pattern(
            ("姓名",),
            r"[\u3400-\u9fff·]{2,12}",
        ),
        confidence=0.94,
    ),
    _ContextPattern(
        raw_type="PERSON",
        entity_type="DOCTOR_NAME",
        entity_role="DOCTOR",
        detector="ner-context-doctor-name",
        pattern=_label_pattern(
            ("主治医师", "经治医师", "主任医师", "医生签名", "医师签名"),
            r"[\u3400-\u9fff·]{2,12}",
        ),
        confidence=0.9,
    ),
    _ContextPattern(
        raw_type="PERSON",
        entity_type="DOCTOR_NAME",
        entity_role="DOCTOR",
        detector="ner-context-doctor-name",
        pattern=_label_pattern(
            ("医生", "医师"),
            r"[\u3400-\u9fff·]{2,12}",
            require_colon=True,
        ),
        confidence=0.9,
    ),
    _ContextPattern(
        raw_type="PERSON",
        entity_type="FAMILY_MEMBER_NAME",
        entity_role="FAMILY",
        detector="ner-context-family-name",
        pattern=_label_pattern(
            ("患者家属", "家属姓名"),
            r"[\u3400-\u9fff·]{2,12}",
        ),
        confidence=0.89,
    ),
    _ContextPattern(
        raw_type="PERSON",
        entity_type="FAMILY_MEMBER_NAME",
        entity_role="FAMILY",
        detector="ner-context-family-name",
        pattern=_label_pattern(
            ("联系人", "监护人"),
            r"[\u3400-\u9fff·]{2,12}",
            require_colon=True,
        ),
        confidence=0.89,
    ),
    _ContextPattern(
        raw_type="LOCATION",
        entity_type="HOME_ADDRESS",
        detector="ner-context-home-address",
        pattern=_label_pattern(
            ("家庭住址", "现住址", "住址"),
            r"[^\n，,；;]{4,80}",
        ),
        confidence=0.9,
    ),
    _ContextPattern(
        raw_type="LOCATION",
        entity_type="HOME_ADDRESS",
        detector="ner-context-home-address",
        pattern=_label_pattern(
            ("地址",),
            r"[^\n，,；;]{4,80}",
            require_colon=True,
        ),
        confidence=0.9,
    ),
    _ContextPattern(
        raw_type="ORGANIZATION",
        entity_type="HOSPITAL_NAME",
        detector="ner-context-hospital-name",
        pattern=re.compile(
            r"(?<![\u3400-\u9fff])(?P<value>[\u3400-\u9fff]{2,30}(?:医院|卫生院|医疗中心|门诊部))(?![\u3400-\u9fff])"
        ),
        confidence=0.88,
    ),
)


class ContextChineseNERBackend:
    def __init__(self, model_id: str, device: str) -> None:
        if device.lower() != "cpu":
            raise NerBackendUnavailableError("P2.1 NER backend currently requires CPU")
        self.model_id = model_id

    def detect(self, text: str) -> list[NerEntity]:
        results: list[NerEntity] = []
        for spec in _CONTEXT_PATTERNS:
            for match in spec.pattern.finditer(text):
                start, end = match.span("value")
                if start >= end:
                    continue
                results.append(
                    NerEntity(
                        raw_type=spec.raw_type,
                        entity_type=spec.entity_type,
                        entity_role=spec.entity_role,
                        start=start,
                        end=end,
                        confidence=spec.confidence,
                        detector=f"{spec.detector}:{self.model_id}",
                    )
                )
        return results


def _manifest_path() -> Path:
    override = os.getenv("MEDICAL_REDACT_NER_MANIFEST")
    if override:
        return Path(override)
    return Path(__file__).with_name("model-manifest.json")


def load_ner_backend() -> ChineseNERBackend:
    try:
        manifest = json.loads(_manifest_path().read_text(encoding="utf-8"))
        active = manifest["activeBackend"]
        config = manifest["backends"][active]
        adapter = config["adapter"]
        model_id = config["modelId"]
        device = config.get("device", "cpu")
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise NerBackendUnavailableError("NER model manifest is unavailable") from exc

    if adapter == "builtin-context":
        return ContextChineseNERBackend(model_id=model_id, device=device)
    raise NerBackendUnavailableError(f"Unsupported NER adapter: {adapter}")
