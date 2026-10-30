from __future__ import annotations

from pathlib import Path

from pytest import MonkeyPatch

from stirling.contracts.medical_redact import KnownEntity, PolygonPoint, TextSource, TextToken
from stirling.medical_redact import build_document_text, detect_pii, normalize_document_text


def _polygon() -> list[PolygonPoint]:
    return [
        PolygonPoint(x=10, y=10),
        PolygonPoint(x=100, y=10),
        PolygonPoint(x=100, y=30),
        PolygonPoint(x=10, y=30),
    ]


def _token(
    ordinal: int,
    text: str,
    page_id: str = "page-1",
    *,
    line_id: str | None = None,
) -> TextToken:
    return TextToken(
        id=f"token-{ordinal}",
        text=text,
        page_id=page_id,
        polygon=_polygon(),
        source=TextSource.PDF_TEXT,
        line_id=line_id,
    )


def _positioned_token(
    ordinal: int,
    text: str,
    *,
    left: float,
    top: float,
    width: float,
    height: float,
    line_id: str,
) -> TextToken:
    return TextToken(
        id=f"token-{ordinal}",
        text=text,
        page_id="page-1",
        polygon=[
            PolygonPoint(x=left, y=top),
            PolygonPoint(x=left + width, y=top),
            PolygonPoint(x=left + width, y=top + height),
            PolygonPoint(x=left, y=top + height),
        ],
        source=TextSource.PADDLE_OCR,
        line_id=line_id,
        confidence=0.97,
    )


def _checksum_valid_cn_id() -> str:
    base = "".join(("110101", "19900307", "451"))
    weights = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
    checks = "10X98765432"
    total = sum(int(base[index]) * weights[index] for index in range(17))
    return base + checks[total % 11]


def test_document_text_normalization_preserves_source_mapping() -> None:
    tokens = [
        _token(1, "手机号：１３８０００００００１"),
        _token(2, "病历号：MR-2026-001"),
    ]

    document_text = build_document_text("doc-1", tokens)
    normalized = normalize_document_text(document_text)

    assert normalized.normalized_text.startswith("手机号:13800000001")
    phone_start = normalized.normalized_text.index("13800000001")
    source_start = normalized.normalized_to_source_index[phone_start]
    assert document_text.text[source_start : source_start + 11] == "１３８０００００００１"
    assert document_text.index_map[source_start].page_id == "page-1"
    assert document_text.index_map[source_start].token_id == "token-1"
    assert document_text.index_map[source_start].offset_in_token == 4
    assert len(document_text.index_map) == len(document_text.text)
    assert len(normalized.source_to_normalized_index) == len(document_text.text)
    assert document_text.segments[0].token_id == "token-1"
    assert document_text.segments[1].token_id == "token-2"


def test_chinese_medical_presidio_rules_cover_required_tier_one_entities() -> None:
    texts = [
        f"身份证：{_checksum_valid_cn_id()}",
        "手机号：13800000001",
        "固定电话：010-12345678",
        "邮箱：patient@example.com",
        "银行卡：4111111111111111",
        "出生日期：1990-03-07",
        "病历号：MR-2026-001",
        "住院号：ZY-20261024-0007",
        "门诊号：MZ-20261024-0008",
        "医保号：YB-20261024-0009",
        "患者ID：PAT-00001",
        "检查号：EXAM-CT-20261024-09",
        "样本号：SAMPLE-20261024-10",
    ]
    response = detect_pii(
        "doc-1",
        [_token(index, text) for index, text in enumerate(texts, start=1)],
    )

    assert response.available is True
    assert response.warning_code is None
    assert {candidate.entity_type for candidate in response.candidates} == {
        "CN_ID_CARD",
        "PHONE",
        "FIXED_PHONE",
        "EMAIL",
        "BANK_CARD",
        "DATE_OF_BIRTH",
        "MEDICAL_RECORD_NO",
        "INPATIENT_NO",
        "OUTPATIENT_NO",
        "INSURANCE_NO",
        "PATIENT_ID",
        "EXAM_NO",
        "SAMPLE_NO",
    }
    assert all(candidate.detector.startswith("presidio-") for candidate in response.candidates)
    assert all(candidate.token_ids for candidate in response.candidates)
    assert all(candidate.page_ids == ["page-1"] for candidate in response.candidates)


def test_known_entities_and_context_ner_map_back_to_existing_tokens() -> None:
    response = detect_pii(
        "doc-1",
        [
            _token(1, "患者姓名：测试患者甲"),
            _token(2, "主治医师：测试医生乙"),
            _token(3, "联系人：测试家属丙"),
            _token(4, "家庭住址：测试市测试区测试路88号"),
            _token(5, "仲思中医院"),
        ],
        [
            KnownEntity(
                entity_type="PATIENT_NAME",
                entity_role="PATIENT",
                value="测试患者甲",
            )
        ],
    )

    by_type = {candidate.entity_type: candidate for candidate in response.candidates}
    assert by_type["PATIENT_NAME"].detector == "known-entity"
    assert by_type["PATIENT_NAME"].entity_role == "PATIENT"
    assert by_type["PATIENT_NAME"].token_ids == ["token-1"]
    assert by_type["DOCTOR_NAME"].entity_role == "DOCTOR"
    assert by_type["FAMILY_MEMBER_NAME"].entity_role == "FAMILY"
    assert by_type["HOME_ADDRESS"].token_ids == ["token-4"]
    assert by_type["HOSPITAL_NAME"].token_ids == ["token-5"]
    assert all(candidate.detector.startswith(("known-entity", "ner-context-")) for candidate in by_type.values())


def test_context_ner_uses_visual_line_boundaries_and_does_not_consume_next_field() -> None:
    response = detect_pii(
        "doc-1",
        [
            _token(1, "姓名：", line_id="line-1"),
            _token(2, "申请单号：", line_id="line-2"),
            _token(3, "医师签名：", line_id="line-3"),
            _token(4, "患者去向：", line_id="line-4"),
        ],
    )

    assert all(candidate.entity_type not in {"PATIENT_NAME", "DOCTOR_NAME"} for candidate in response.candidates)


def test_context_ner_detects_label_and_value_split_across_tokens_on_same_line() -> None:
    response = detect_pii(
        "doc-1",
        [
            _token(1, "姓名：", line_id="line-1"),
            _token(2, "测试患者甲", line_id="line-1"),
            _token(3, "主治医师", line_id="line-2"),
            _token(4, "测试医生乙", line_id="line-2"),
        ],
    )

    by_type = {candidate.entity_type: candidate for candidate in response.candidates}
    assert by_type["PATIENT_NAME"].token_ids == ["token-2"]
    assert by_type["DOCTOR_NAME"].token_ids == ["token-4"]


def test_spatial_context_recovers_name_when_ocr_splits_label_and_value_lines() -> None:
    response = detect_pii(
        "doc-1",
        [
            _positioned_token(
                1,
                "姓名：",
                left=100,
                top=100,
                width=35,
                height=30,
                line_id="line-1",
            ),
            _positioned_token(
                2,
                "测试甲",
                left=138,
                top=116,
                width=45,
                height=20,
                line_id="line-2",
            ),
            _positioned_token(
                3,
                "申请单号",
                left=20,
                top=101,
                width=70,
                height=24,
                line_id="line-3",
            ),
        ],
    )

    patient = [candidate for candidate in response.candidates if candidate.entity_type == "PATIENT_NAME"]
    assert len(patient) == 1
    assert patient[0].token_ids == ["token-2"]
    assert patient[0].detector == "ner-spatial-patient-name"
    assert patient[0].policy.value == "AUTO_SELECT"


def test_ner_failure_does_not_disable_presidio_rules(
    monkeypatch: MonkeyPatch,
    tmp_path: Path,
) -> None:
    manifest = tmp_path / "broken-model-manifest.json"
    manifest.write_text(
        '{"activeBackend":"broken","backends":{"broken":{"adapter":"missing","modelId":"x","device":"cpu"}}}',
        encoding="utf-8",
    )
    monkeypatch.setenv("MEDICAL_REDACT_NER_MANIFEST", str(manifest))

    response = detect_pii("doc-1", [_token(1, "手机号：13800000001")])

    assert response.available is True
    assert response.warning_code == "NER_UNAVAILABLE"
    assert [(item.entity_type, item.detector) for item in response.candidates] == [
        ("PHONE", "presidio-cn-mobile-phone")
    ]


def test_checksum_and_label_context_prevent_broad_false_positives() -> None:
    invalid_id = _checksum_valid_cn_id()[:-1] + ("0" if _checksum_valid_cn_id()[-1] != "0" else "1")
    response = detect_pii(
        "doc-1",
        [
            _token(1, f"身份证：{invalid_id}"),
            _token(2, "普通编号：MR-2026-001"),
            _token(3, "固定电话不是这里的普通数字 12345678"),
        ],
    )

    assert response.candidates == []
