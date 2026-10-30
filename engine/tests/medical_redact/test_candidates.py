from __future__ import annotations

from stirling.contracts.medical_redact import (
    AlignmentLevel,
    CandidatePolicy,
    CandidateRiskStatus,
    CharacterBox,
    PolygonPoint,
    TextSource,
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
from stirling.medical_redact.pii import build_document_text, normalize_document_text


def _rect(left: float, top: float, right: float, bottom: float) -> list[PolygonPoint]:
    return [
        PolygonPoint(x=left, y=top),
        PolygonPoint(x=right, y=top),
        PolygonPoint(x=right, y=bottom),
        PolygonPoint(x=left, y=bottom),
    ]


def _chars(text: str, left: float = 10, top: float = 10) -> list[CharacterBox]:
    return [
        CharacterBox(
            text=char,
            polygon=_rect(left + index * 12, top, left + index * 12 + 10, top + 16),
        )
        for index, char in enumerate(text)
    ]


def _token(
    token_id: str,
    text: str,
    *,
    source: TextSource = TextSource.PDF_TEXT,
    char_boxes: list[CharacterBox] | None = None,
    confidence: float = 1.0,
    line_id: str = "line-1",
    top: float = 10,
) -> TextToken:
    width = max(10, len(text) * 12)
    return TextToken(
        id=token_id,
        text=text,
        page_id="page-1",
        polygon=_rect(10, top, 10 + width, top + 16),
        confidence=confidence,
        line_id=line_id,
        source=source,
        char_boxes=char_boxes,
    )


def _raw(
    entity_type: str,
    start: int,
    end: int,
    *,
    detector: str,
    source: DetectionSource,
    confidence: float,
    entity_role: str | None = None,
) -> RawDetection:
    return RawDetection(
        entity_type=entity_type,
        entity_role=entity_role,
        normalized_start=start,
        normalized_end=end,
        confidence=confidence,
        detector=detector,
        source=source,
    )


def test_fusion_merges_duplicates_nested_spans_and_known_entity_evidence() -> None:
    fused = fuse_detections(
        [
            _raw(
                "PATIENT_NAME",
                5,
                9,
                detector="ner-context-patient-name",
                source=DetectionSource.NER,
                confidence=0.94,
                entity_role="PATIENT",
            ),
            _raw(
                "PATIENT_NAME",
                6,
                9,
                detector="known-entity",
                source=DetectionSource.KNOWN,
                confidence=1.0,
                entity_role="PATIENT",
            ),
            _raw(
                "PATIENT_NAME",
                5,
                9,
                detector="custom-name-rule",
                source=DetectionSource.RULE,
                confidence=0.91,
                entity_role="PATIENT",
            ),
        ]
    )

    assert len(fused) == 1
    candidate = fused[0]
    assert (candidate.normalized_start, candidate.normalized_end) == (5, 9)
    assert candidate.confidence == 1.0
    assert candidate.detector == "known-entity"
    assert set(candidate.detector_evidence) == {
        "ner-context-patient-name",
        "known-entity",
        "custom-name-rule",
    }
    assert candidate.conflict is False


def test_fusion_keeps_overlapping_different_types_and_marks_both_conflict() -> None:
    fused = fuse_detections(
        [
            _raw(
                "PHONE",
                0,
                11,
                detector="phone-rule",
                source=DetectionSource.RULE,
                confidence=0.96,
            ),
            _raw(
                "PATIENT_ID",
                0,
                11,
                detector="id-rule",
                source=DetectionSource.RULE,
                confidence=0.92,
            ),
        ]
    )

    assert len(fused) == 2
    assert all(item.conflict for item in fused)
    assert {item.entity_type for item in fused} == {"PHONE", "PATIENT_ID"}
    assert all(item.conflict_types for item in fused)


def test_pdf_native_partial_span_uses_level_a_character_boxes() -> None:
    token = _token("token-1", "姓名：张三", char_boxes=_chars("姓名：张三"))
    document = build_document_text("doc-1", [token])
    normalized = normalize_document_text(document)
    raw = _raw(
        "PATIENT_NAME",
        3,
        5,
        detector="known-entity",
        source=DetectionSource.KNOWN,
        confidence=1.0,
        entity_role="PATIENT",
    )
    fused = fuse_detections([raw])[0]
    source_span = normalized_span_to_source(fused, normalized)
    assert source_span is not None
    assert source_span == (3, 5)

    alignment, pages, tokens = align_detection(
        fused,
        source_span[0],
        source_span[1],
        document,
        [token],
    )
    policy, risk = evaluate_policy(fused, alignment)

    assert pages == ["page-1"]
    assert tokens == ["token-1"]
    assert alignment.level == AlignmentLevel.A
    assert alignment.method == "PDF_NATIVE_CHAR"
    assert alignment.confidence == 1.0
    assert alignment.needs_local_reocr is False
    assert len(alignment.polygons) == 1
    assert policy == CandidatePolicy.AUTO_SELECT
    assert risk == CandidateRiskStatus.RESOLVED


def test_full_ocr_token_uses_level_b_and_partial_without_chars_is_level_c_review() -> None:
    token = _token(
        "token-1",
        "13800000001",
        source=TextSource.PADDLE_OCR,
        confidence=0.96,
        char_boxes=None,
    )
    document = build_document_text("doc-1", [token])
    normalized = normalize_document_text(document)

    full = fuse_detections(
        [
            _raw(
                "PHONE",
                0,
                len(token.text),
                detector="phone-rule",
                source=DetectionSource.RULE,
                confidence=0.96,
            )
        ]
    )[0]
    full_span = normalized_span_to_source(full, normalized)
    assert full_span is not None
    alignment, _, _ = align_detection(full, full_span[0], full_span[1], document, [token])
    policy, risk = evaluate_policy(full, alignment)
    assert alignment.level == AlignmentLevel.B
    assert alignment.method == "TOKEN_FULL"
    assert alignment.confidence == 0.96
    assert policy == CandidatePolicy.AUTO_SELECT
    assert risk == CandidateRiskStatus.RESOLVED

    mixed_token = _token(
        "token-2",
        "电话13800000001备注",
        source=TextSource.PADDLE_OCR,
        confidence=0.94,
        char_boxes=None,
    )
    mixed_doc = build_document_text("doc-2", [mixed_token])
    mixed_normalized = normalize_document_text(mixed_doc)
    partial = fuse_detections(
        [
            _raw(
                "PHONE",
                2,
                13,
                detector="phone-rule",
                source=DetectionSource.RULE,
                confidence=0.96,
            )
        ]
    )[0]
    partial_span = normalized_span_to_source(partial, mixed_normalized)
    assert partial_span is not None
    alignment, _, _ = align_detection(
        partial,
        partial_span[0],
        partial_span[1],
        mixed_doc,
        [mixed_token],
    )
    policy, risk = evaluate_policy(partial, alignment)
    assert alignment.level == AlignmentLevel.C
    assert alignment.method == "TOKEN_PARTIAL"
    assert alignment.needs_local_reocr is True
    assert policy == CandidatePolicy.REVIEW
    assert risk == CandidateRiskStatus.REVIEW


def test_cross_line_pdf_span_keeps_separate_polygons() -> None:
    first = _token(
        "token-1",
        "测试市测试区",
        char_boxes=_chars("测试市测试区", top=10),
        line_id="line-1",
        top=10,
    )
    second = _token(
        "token-2",
        "测试路88号",
        char_boxes=_chars("测试路88号", top=40),
        line_id="line-2",
        top=40,
    )
    document = build_document_text("doc-1", [first, second])
    normalized = normalize_document_text(document)
    detection = fuse_detections(
        [
            _raw(
                "HOME_ADDRESS",
                0,
                len(normalized.normalized_text),
                detector="address-ner",
                source=DetectionSource.NER,
                confidence=0.92,
            )
        ]
    )[0]
    source_span = normalized_span_to_source(detection, normalized)
    assert source_span is not None

    alignment, _, _ = align_detection(
        detection,
        source_span[0],
        source_span[1],
        document,
        [first, second],
    )
    policy, risk = evaluate_policy(detection, alignment)

    assert alignment.level == AlignmentLevel.A
    assert len(alignment.polygons) == 2
    assert policy == CandidatePolicy.AUTO_SELECT
    assert risk == CandidateRiskStatus.RESOLVED


def test_conflict_and_keep_policy_never_auto_select() -> None:
    token = _token(
        "token-1",
        "测试医院",
        source=TextSource.PADDLE_OCR,
        char_boxes=None,
        confidence=0.95,
    )
    document = build_document_text("doc-1", [token])
    normalized = normalize_document_text(document)
    hospital = fuse_detections(
        [
            _raw(
                "HOSPITAL_NAME",
                0,
                len(token.text),
                detector="hospital-ner",
                source=DetectionSource.NER,
                confidence=0.88,
            )
        ]
    )[0]
    source_span = normalized_span_to_source(hospital, normalized)
    assert source_span is not None
    alignment, _, _ = align_detection(
        hospital,
        source_span[0],
        source_span[1],
        document,
        [token],
    )
    policy, risk = evaluate_policy(hospital, alignment)
    assert policy == CandidatePolicy.KEEP
    assert risk == CandidateRiskStatus.RESOLVED

    conflicted = fuse_detections(
        [
            _raw(
                "PATIENT_NAME",
                0,
                len(token.text),
                detector="known-entity",
                source=DetectionSource.KNOWN,
                confidence=1.0,
            ),
            _raw(
                "HOSPITAL_NAME",
                0,
                len(token.text),
                detector="hospital-ner",
                source=DetectionSource.NER,
                confidence=0.88,
            ),
        ]
    )
    patient = next(item for item in conflicted if item.entity_type == "PATIENT_NAME")
    policy, risk = evaluate_policy(patient, alignment)
    assert patient.conflict is True
    assert policy == CandidatePolicy.REVIEW
    assert risk == CandidateRiskStatus.CONFLICT


def test_invalid_token_polygon_is_level_d_unresolved() -> None:
    token = TextToken(
        id="token-1",
        text="13800000001",
        page_id="page-1",
        polygon=_rect(10, 10, 10, 10),
        confidence=0.95,
        line_id="line-1",
        source=TextSource.PADDLE_OCR,
    )
    document = build_document_text("doc-1", [token])
    normalized = normalize_document_text(document)
    detection = fuse_detections(
        [
            _raw(
                "PHONE",
                0,
                len(token.text),
                detector="phone-rule",
                source=DetectionSource.RULE,
                confidence=0.96,
            )
        ]
    )[0]
    source_span = normalized_span_to_source(detection, normalized)
    assert source_span is not None

    alignment, _, _ = align_detection(
        detection,
        source_span[0],
        source_span[1],
        document,
        [token],
    )
    policy, risk = evaluate_policy(detection, alignment)

    assert alignment.level == AlignmentLevel.D
    assert alignment.unresolved is True
    assert policy == CandidatePolicy.REVIEW
    assert risk == CandidateRiskStatus.UNRESOLVED
