from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass

from presidio_analyzer import EntityRecognizer, RecognizerRegistry, RecognizerResult
from presidio_analyzer.nlp_engine import NlpArtifacts

from stirling.contracts.medical_redact import (
    AlignmentLevel,
    CandidateAlignment,
    DocumentText,
    DocumentTextIndexEntry,
    DocumentTextSegment,
    KnownEntity,
    NormalizedTextView,
    OCRRequest,
    PIICandidate,
    PIIDetectResponse,
    TextToken,
)
from stirling.medical_redact.candidates import (
    DetectionSource,
    RawDetection,
    align_detection,
    evaluate_policy,
    fuse_detections,
    normalized_span_to_source,
)
from stirling.medical_redact.local_reocr import refine_candidate_alignment
from stirling.medical_redact.ner import NerBackendUnavailableError, load_ner_backend
from stirling.medical_redact.ocr import OcrService

Validator = Callable[[str], bool]

_LOCAL_REOCR_LIMIT_PER_PAGE = 10


@dataclass(frozen=True)
class _RecognizerSpec:
    entity_type: str
    detector: str
    pattern: re.Pattern[str]
    confidence: float
    validator: Validator | None = None


def build_document_text(document_id: str, tokens: list[TextToken]) -> DocumentText:
    parts: list[str] = []
    segments: list[DocumentTextSegment] = []
    index_map: list[DocumentTextIndexEntry] = []
    cursor = 0
    previous_token: TextToken | None = None
    for token in tokens:
        if parts:
            same_visual_line = (
                previous_token is not None
                and previous_token.page_id == token.page_id
                and previous_token.line_id is not None
                and token.line_id is not None
                and previous_token.line_id == token.line_id
            )
            separator = " " if same_visual_line else "\n"
            parts.append(separator)
            index_map.append(DocumentTextIndexEntry())
            cursor += 1
        start = cursor
        parts.append(token.text)
        index_map.extend(
            DocumentTextIndexEntry(
                page_id=token.page_id,
                token_id=token.id,
                offset_in_token=offset,
            )
            for offset in range(len(token.text))
        )
        cursor += len(token.text)
        segments.append(
            DocumentTextSegment(
                source_start=start,
                source_end=cursor,
                page_id=token.page_id,
                token_id=token.id,
            )
        )
        previous_token = token
    return DocumentText(
        document_id=document_id,
        text="".join(parts),
        segments=segments,
        index_map=index_map,
    )


def normalize_document_text(document_text: DocumentText) -> NormalizedTextView:
    normalized: list[str] = []
    normalized_to_source_index: list[int] = []
    source_to_normalized_index: list[int] = []
    for source_index, source_char in enumerate(document_text.text):
        source_to_normalized_index.append(len(normalized))
        piece = unicodedata.normalize("NFKC", source_char)
        for char in piece:
            if char in {"\r", "\n"}:
                normalized.append("\n")
            else:
                normalized.append(" " if char.isspace() else char)
            normalized_to_source_index.append(source_index)
    return NormalizedTextView(
        normalized_text="".join(normalized),
        source_text=document_text.text,
        normalized_to_source_index=normalized_to_source_index,
        source_to_normalized_index=source_to_normalized_index,
    )


def _digits(value: str) -> str:
    return re.sub(r"\D", "", value)


def _valid_luhn(value: str) -> bool:
    digits = _digits(value)
    if len(digits) < 16 or len(digits) > 19:
        return False
    total = 0
    parity = len(digits) % 2
    for index, char in enumerate(digits):
        number = int(char)
        if index % 2 == parity:
            number *= 2
            if number > 9:
                number -= 9
        total += number
    return total % 10 == 0


def _valid_cn_id(value: str) -> bool:
    compact = value.upper()
    if not re.fullmatch(r"[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dX]", compact):
        return False
    weights = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
    checks = "10X98765432"
    total = sum(int(compact[index]) * weights[index] for index in range(17))
    return compact[-1] == checks[total % 11]


def _always(_: str) -> bool:
    return True


_LABEL_VALUE_SPECS: tuple[tuple[str, str, tuple[str, ...], str, float], ...] = (
    (
        "FIXED_PHONE",
        "presidio-cn-fixed-phone",
        ("固定电话", "座机", "联系电话"),
        r"(?:0\d{2,3}[- ]?)?\d{7,8}",
        0.93,
    ),
    (
        "DATE_OF_BIRTH",
        "presidio-cn-date-of-birth",
        ("出生日期", "出生", "生日"),
        r"(?:19|20)\d{2}(?:[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?|\d{4})",
        0.96,
    ),
    (
        "MEDICAL_RECORD_NO",
        "presidio-cn-medical-record-no",
        ("病历号", "病案号", "病历编号", "病案编号"),
        r"[A-Za-z0-9][A-Za-z0-9._/-]{2,31}",
        0.98,
    ),
    (
        "INPATIENT_NO",
        "presidio-cn-inpatient-no",
        ("住院号", "住院编号"),
        r"[A-Za-z0-9][A-Za-z0-9._/-]{2,31}",
        0.98,
    ),
    (
        "OUTPATIENT_NO",
        "presidio-cn-outpatient-no",
        ("门诊号", "门诊编号"),
        r"[A-Za-z0-9][A-Za-z0-9._/-]{2,31}",
        0.98,
    ),
    (
        "INSURANCE_NO",
        "presidio-cn-insurance-no",
        ("医保号", "医保卡号", "社会保障号"),
        r"[A-Za-z0-9][A-Za-z0-9._/-]{5,31}",
        0.98,
    ),
    (
        "PATIENT_ID",
        "presidio-cn-patient-id",
        ("患者ID", "患者编号", "患者号"),
        r"[A-Za-z0-9][A-Za-z0-9._/-]{2,31}",
        0.98,
    ),
    (
        "EXAM_NO",
        "presidio-cn-exam-no",
        ("检查号", "检查编号", "检验号", "检验编号"),
        r"[A-Za-z0-9][A-Za-z0-9._/-]{2,31}",
        0.97,
    ),
    (
        "SAMPLE_NO",
        "presidio-cn-sample-no",
        ("样本号", "样本编号", "标本号", "标本编号"),
        r"[A-Za-z0-9][A-Za-z0-9._/-]{2,31}",
        0.97,
    ),
)


def _label_pattern(labels: tuple[str, ...], value_pattern: str) -> re.Pattern[str]:
    label_group = "|".join(re.escape(label) for label in labels)
    return re.compile(
        rf"(?:{label_group})\s*[:：]?\s*(?P<value>{value_pattern})",
        re.IGNORECASE,
    )


_SPECS: tuple[_RecognizerSpec, ...] = (
    _RecognizerSpec(
        entity_type="CN_ID_CARD",
        detector="presidio-cn-id-card",
        pattern=re.compile(
            r"(?<!\d)(?P<value>[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])(?!\d)"
        ),
        confidence=1.0,
        validator=_valid_cn_id,
    ),
    _RecognizerSpec(
        entity_type="PHONE",
        detector="presidio-cn-mobile-phone",
        pattern=re.compile(r"(?<!\d)(?P<value>1[3-9]\d{9})(?!\d)"),
        confidence=0.96,
        validator=_always,
    ),
    _RecognizerSpec(
        entity_type="EMAIL",
        detector="presidio-email",
        pattern=re.compile(
            r"(?<![A-Za-z0-9._%+-])(?P<value>[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})(?![A-Za-z0-9._%+-])"
        ),
        confidence=0.98,
        validator=_always,
    ),
    _RecognizerSpec(
        entity_type="BANK_CARD",
        detector="presidio-cn-bank-card",
        pattern=_label_pattern(
            ("银行卡号", "银行卡", "银行账号"),
            r"\d(?:[ -]?\d){15,18}",
        ),
        confidence=0.99,
        validator=_valid_luhn,
    ),
    *tuple(
        _RecognizerSpec(
            entity_type=entity_type,
            detector=detector,
            pattern=_label_pattern(labels, value_pattern),
            confidence=confidence,
            validator=_always,
        )
        for entity_type, detector, labels, value_pattern, confidence in _LABEL_VALUE_SPECS
    ),
)


class _ChineseMedicalRecognizer(EntityRecognizer):
    def __init__(self, spec: _RecognizerSpec) -> None:
        super().__init__(
            supported_entities=[spec.entity_type],
            name=spec.detector,
            supported_language="zh",
            version="1.0.0",
        )
        self.spec = spec

    def analyze(
        self,
        text: str,
        entities: list[str],
        nlp_artifacts: NlpArtifacts | None = None,
    ) -> list[RecognizerResult]:
        del nlp_artifacts
        if self.spec.entity_type not in entities:
            return []

        results: list[RecognizerResult] = []
        for match in self.spec.pattern.finditer(text):
            value_group = match.groupdict().get("value")
            if value_group is None:
                continue
            start, end = match.span("value")
            if start >= end:
                continue
            if self.spec.validator is not None and not self.spec.validator(value_group):
                continue
            results.append(
                RecognizerResult(
                    entity_type=self.spec.entity_type,
                    start=start,
                    end=end,
                    score=self.spec.confidence,
                    recognition_metadata={"recognizer_name": self.name},
                )
            )
        return results


def _build_presidio_registry() -> RecognizerRegistry:
    registry = RecognizerRegistry(supported_languages=["zh"])
    for spec in _SPECS:
        registry.add_recognizer(_ChineseMedicalRecognizer(spec))
    return registry


_PRESIDIO_REGISTRY = _build_presidio_registry()


def _candidate_id(
    document_id: str,
    entity_type: str,
    source_start: int,
    source_end: int,
    detector: str,
) -> str:
    payload = f"{document_id}|{entity_type}|{source_start}|{source_end}|{detector}".encode()
    return "pii-" + hashlib.sha256(payload).hexdigest()[:20]


def _normalized_value(value: str) -> str:
    return "".join(
        " " if char.isspace() else char for source_char in value for char in unicodedata.normalize("NFKC", source_char)
    )


def _known_entity_results(
    normalized_text: str,
    known_entities: list[KnownEntity],
) -> list[RawDetection]:
    results: list[RawDetection] = []
    for known in known_entities:
        needle = _normalized_value(known.value).strip()
        if not needle:
            continue
        start = 0
        while True:
            found = normalized_text.find(needle, start)
            if found < 0:
                break
            results.append(
                RawDetection(
                    entity_type=known.entity_type,
                    entity_role=known.entity_role,
                    normalized_start=found,
                    normalized_end=found + len(needle),
                    confidence=1.0,
                    detector="known-entity",
                    source=DetectionSource.KNOWN,
                )
            )
            start = found + max(1, len(needle))
    return results


_NAME_VALUE_RE = re.compile(r"^[\u3400-\u9fff·]{2,4}$")
_PATIENT_NAME_LABELS = {"姓名", "患者姓名", "病人姓名"}
_DOCTOR_NAME_LABELS = {"主治医师", "经治医师", "主任医师", "医生签名", "医师签名"}


def _token_bounds(token: TextToken) -> tuple[float, float, float, float] | None:
    if not token.polygon:
        return None
    xs = [point.x for point in token.polygon]
    ys = [point.y for point in token.polygon]
    left, right = min(xs), max(xs)
    top, bottom = min(ys), max(ys)
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def _normalized_span_for_source(
    normalized: NormalizedTextView, source_start: int, source_end: int
) -> tuple[int, int] | None:
    if source_start < 0 or source_end <= source_start:
        return None
    source_map = normalized.source_to_normalized_index
    if source_start >= len(source_map):
        return None
    normalized_start = source_map[source_start]
    normalized_end = source_map[source_end] if source_end < len(source_map) else len(normalized.normalized_text)
    if normalized_end <= normalized_start:
        return None
    return normalized_start, normalized_end


def _spatial_name_results(
    document_text: DocumentText,
    normalized: NormalizedTextView,
    tokens: list[TextToken],
) -> list[RawDetection]:
    segment_by_token = {segment.token_id: segment for segment in document_text.segments}
    results: list[RawDetection] = []

    for label in tokens:
        label_text = label.text.strip().strip(":：").strip()
        if label_text in _PATIENT_NAME_LABELS:
            entity_type = "PATIENT_NAME"
            entity_role = "PATIENT"
            detector = "ner-spatial-patient-name"
            confidence = 0.93
        elif label_text in _DOCTOR_NAME_LABELS:
            entity_type = "DOCTOR_NAME"
            entity_role = "DOCTOR"
            detector = "ner-spatial-doctor-name"
            confidence = 0.88
        else:
            continue

        label_bounds = _token_bounds(label)
        if label_bounds is None:
            continue
        label_left, label_top, label_right, label_bottom = label_bounds
        label_height = label_bottom - label_top
        label_center_y = (label_top + label_bottom) / 2

        nearby: list[tuple[float, TextToken]] = []
        for candidate in tokens:
            if candidate.id == label.id or candidate.page_id != label.page_id:
                continue
            value = candidate.text.strip()
            if not _NAME_VALUE_RE.fullmatch(value):
                continue
            bounds = _token_bounds(candidate)
            if bounds is None:
                continue
            candidate_left, candidate_top, candidate_right, candidate_bottom = bounds
            candidate_height = candidate_bottom - candidate_top
            candidate_center_y = (candidate_top + candidate_bottom) / 2
            horizontal_gap = candidate_left - label_right
            if horizontal_gap < -max(2.0, label_height * 0.15):
                continue
            if horizontal_gap > max(120.0, label_height * 5):
                continue
            vertical_delta = abs(candidate_center_y - label_center_y)
            if vertical_delta > max(label_height, candidate_height) * 0.8:
                continue
            score = max(0.0, horizontal_gap) + vertical_delta * 2
            nearby.append((score, candidate))

        if not nearby:
            continue
        _, candidate = min(nearby, key=lambda item: item[0])
        segment = segment_by_token.get(candidate.id)
        if segment is None:
            continue
        value = candidate.text.strip()
        offset = candidate.text.find(value)
        source_start = segment.source_start + max(0, offset)
        source_end = source_start + len(value)
        normalized_span = _normalized_span_for_source(normalized, source_start, source_end)
        if normalized_span is None:
            continue
        normalized_start, normalized_end = normalized_span
        results.append(
            RawDetection(
                entity_type=entity_type,
                entity_role=entity_role,
                normalized_start=normalized_start,
                normalized_end=normalized_end,
                confidence=confidence,
                detector=detector,
                source=DetectionSource.NER,
            )
        )

    return results


def _local_reocr_unresolved(code: str) -> CandidateAlignment:
    return CandidateAlignment(
        level=AlignmentLevel.D,
        confidence=0.0,
        method="LOCAL_REOCR_FAILED",
        warnings=[code],
        needs_local_reocr=False,
        unresolved=True,
    )


def detect_pii(
    document_id: str,
    tokens: list[TextToken],
    known_entities: list[KnownEntity] | None = None,
    page_images: list[OCRRequest] | None = None,
    ocr_service: OcrService | None = None,
) -> PIIDetectResponse:
    document_text = build_document_text(document_id, tokens)
    normalized = normalize_document_text(document_text)
    candidates: list[PIICandidate] = []
    detections: list[RawDetection] = []
    page_image_by_id = {image.page_id: image for image in page_images or []}
    local_reocr_counts: dict[str, int] = {}

    detections.extend(
        _known_entity_results(
            normalized.normalized_text,
            known_entities or [],
        )
    )
    detections.extend(_spatial_name_results(document_text, normalized, tokens))

    recognizers = _PRESIDIO_REGISTRY.get_recognizers(language="zh", all_fields=True)
    for recognizer in recognizers:
        if not isinstance(recognizer, _ChineseMedicalRecognizer):
            continue
        detector = recognizer.name or recognizer.__class__.__name__
        for result in recognizer.analyze(
            normalized.normalized_text,
            recognizer.supported_entities,
            None,
        ):
            detections.append(
                RawDetection(
                    entity_type=result.entity_type,
                    entity_role=None,
                    normalized_start=result.start,
                    normalized_end=result.end,
                    confidence=result.score,
                    detector=detector,
                    source=DetectionSource.RULE,
                )
            )

    warning_code: str | None = None
    try:
        ner_backend = load_ner_backend()
        for entity in ner_backend.detect(normalized.normalized_text):
            detections.append(
                RawDetection(
                    entity_type=entity.entity_type,
                    entity_role=entity.entity_role,
                    normalized_start=entity.start,
                    normalized_end=entity.end,
                    confidence=entity.confidence,
                    detector=entity.detector,
                    source=DetectionSource.NER,
                )
            )
    except NerBackendUnavailableError:
        warning_code = "NER_UNAVAILABLE"

    for fused in fuse_detections(detections):
        source_span = normalized_span_to_source(fused, normalized)
        if source_span is None:
            continue
        source_start, source_end = source_span
        alignment, page_ids, token_ids = align_detection(
            fused,
            source_start,
            source_end,
            document_text,
            tokens,
        )
        if not page_ids or not token_ids:
            continue

        if alignment.needs_local_reocr:
            if len(page_ids) != 1:
                alignment = _local_reocr_unresolved("LOCAL_REOCR_MULTI_PAGE_UNSUPPORTED")
            else:
                page_id = page_ids[0]
                used = local_reocr_counts.get(page_id, 0)
                if used >= _LOCAL_REOCR_LIMIT_PER_PAGE:
                    alignment = CandidateAlignment(
                        level=alignment.level,
                        confidence=alignment.confidence,
                        method=alignment.method,
                        polygons=alignment.polygons,
                        warnings=[*alignment.warnings, "LOCAL_REOCR_LIMIT_EXCEEDED"],
                        needs_local_reocr=True,
                        unresolved=False,
                    )
                else:
                    local_reocr_counts[page_id] = used + 1
                    page_image = page_image_by_id.get(page_id)
                    if ocr_service is None or page_image is None:
                        alignment = _local_reocr_unresolved("LOCAL_REOCR_IMAGE_UNAVAILABLE")
                    else:
                        alignment = refine_candidate_alignment(
                            target_text=document_text.text[source_start:source_end],
                            alignment=alignment,
                            page_image=page_image,
                            ocr_service=ocr_service,
                        )

        policy, risk_status = evaluate_policy(fused, alignment)
        candidates.append(
            PIICandidate(
                id=_candidate_id(
                    document_id,
                    fused.entity_type,
                    source_start,
                    source_end,
                    fused.detector,
                ),
                entity_type=fused.entity_type,
                entity_role=fused.entity_role,
                normalized_start=fused.normalized_start,
                normalized_end=fused.normalized_end,
                source_start=source_start,
                source_end=source_end,
                confidence=fused.confidence,
                overall_confidence=min(fused.confidence, alignment.confidence),
                detector=fused.detector,
                detector_evidence=list(fused.detector_evidence),
                page_ids=page_ids,
                token_ids=token_ids,
                alignment=alignment,
                policy=policy,
                risk_status=risk_status,
                conflict=fused.conflict,
            )
        )

    candidates.sort(key=lambda item: (item.source_start, item.source_end, item.entity_type))
    return PIIDetectResponse(
        available=True,
        candidates=candidates,
        warning_code=warning_code,
    )
