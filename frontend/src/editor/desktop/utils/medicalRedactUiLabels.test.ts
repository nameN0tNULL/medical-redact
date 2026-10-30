import { describe, expect, test } from "vitest";
import {
  UNKNOWN_MEDICAL_REDACT_CODE_MESSAGE,
  medicalRedactAlignmentMethodLabel,
  medicalRedactEntityRoleLabel,
  medicalRedactEntityTypeLabel,
  medicalRedactRiskStatusLabel,
  medicalRedactTextSourceLabel,
  medicalRedactUserErrorMessage,
  medicalRedactVerificationFindingLabel,
  medicalRedactVerificationMessages,
  medicalRedactVerificationStatusLabel,
  medicalRedactWarningLabel,
} from "@app/utils/medicalRedactUiLabels";

describe("medicalRedactUiLabels", () => {
  test("maps stable entity, role, risk, source and alignment values to Chinese", () => {
    expect(medicalRedactEntityTypeLabel("PATIENT_NAME")).toBe("患者姓名");
    expect(medicalRedactEntityTypeLabel("DEPARTMENT_NAME")).toBe("科室名称");
    expect(medicalRedactEntityRoleLabel("DOCTOR")).toBe("医生");
    expect(medicalRedactRiskStatusLabel("HIGH_RISK")).toBe("高风险");
    expect(medicalRedactTextSourceLabel("PDF_TEXT")).toBe("文档原生文字");
    expect(medicalRedactTextSourceLabel("PADDLE_OCR")).toBe("图片文字识别");
    expect(medicalRedactTextSourceLabel("LOCAL_REOCR")).toBe("局部重新识别");
    expect(medicalRedactAlignmentMethodLabel("LOCAL_REOCR_FUZZY")).toBe(
      "局部重新识别近似匹配",
    );
  });

  test("covers current local re-OCR, OCR and engine warning families without leaking raw codes", () => {
    const codes = [
      "NER_UNAVAILABLE",
      "NO_SOURCE_TOKEN",
      "INVALID_TOKEN_POLYGON",
      "PARTIAL_TOKEN_NEEDS_REOCR",
      "BBOX_OUT_OF_BOUNDS",
      "MISSING_BBOX",
      "TOKEN_REGION_MAPPING_CONFLICT",
      "LOCAL_REOCR_FAILED",
      "LOCAL_REOCR_FUZZY_MATCH",
      "LOCAL_REOCR_MISSING_BBOX",
      "LOCAL_REOCR_PAGE_MISMATCH",
      "LOCAL_REOCR_INVALID_BBOX",
      "LOCAL_REOCR_IMAGE_DECODE_FAILED",
      "LOCAL_REOCR_IMAGE_DIMENSION_MISMATCH",
      "LOCAL_REOCR_INVALID_CROP",
      "LOCAL_REOCR_IMAGE_ENCODE_FAILED",
      "LOCAL_REOCR_UNAVAILABLE",
      "LOCAL_REOCR_NO_TEXT",
      "LOCAL_REOCR_NO_SAFE_MATCH",
      "LOCAL_REOCR_NO_CHAR_BOX",
      "LOCAL_REOCR_MULTI_PAGE_UNSUPPORTED",
      "LOCAL_REOCR_LIMIT_EXCEEDED",
      "LOCAL_REOCR_IMAGE_UNAVAILABLE",
      "OCR_IMAGE_DECODE_FAILED",
      "OCR_IMAGE_DIMENSION_MISMATCH",
      "OCR_INVALID_REQUEST_IMAGE",
      "OCR_NO_TEXT_DETECTED",
      "OCR_LOW_CONFIDENCE_PRESENT",
      "OCR_TRANSFORM_NON_INVERTIBLE",
      "OCR_UNAVAILABLE",
      "PADDLEOCR_INFERENCE_FAILED",
      "PADDLEOCR_MODEL_MISSING",
      "PADDLEOCR_RUNTIME_UNAVAILABLE",
      "AI_ENGINE_DISABLED",
      "AI_ENGINE_TIMEOUT",
      "AI_ENGINE_UNREACHABLE",
      "AI_ENGINE_INTERRUPTED",
      "AI_ENGINE_HTTP_503",
      "LOCAL_OCR_ENGINE_UNAVAILABLE",
      "LOCAL_PII_ENGINE_UNAVAILABLE",
      "PII_ENGINE_UNAVAILABLE",
    ];

    for (const code of codes) {
      const label = medicalRedactWarningLabel(code);
      expect(label).not.toBe(code);
      expect(label).not.toContain(code);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test("maps every current verification finding to an actionable Chinese message", () => {
    const codes = [
      "NO_SELECTED_REDACTION",
      "UNRESOLVED_PII_RISK",
      "KNOWN_VALUE_SURVIVED",
      "OUTPUT_PII_DETECTED",
      "OUTPUT_OCR_UNAVAILABLE",
      "OUTPUT_PII_SCAN_UNAVAILABLE",
      "TEXT_LAYER_SURVIVED",
      "PDF_STRUCTURE_SURVIVED",
      "METADATA_SURVIVED",
      "ANNOTATION_SURVIVED",
      "PAGE_COUNT_MISMATCH",
      "REDACTION_BOX_NOT_BLACK",
      "SEMANTIC_VERIFICATION_FAILED",
      "VERIFICATION_OUTPUT_READ_FAILED",
    ];

    for (const code of codes) {
      const label = medicalRedactVerificationFindingLabel(code);
      expect(label).not.toBe(code);
      expect(label).not.toContain(code);
      expect(label.length).toBeGreaterThan(0);
    }

    expect(medicalRedactVerificationStatusLabel("PASS")).toBe("安全验证通过");
    expect(medicalRedactVerificationStatusLabel("BLOCKED")).toBe(
      "安全验证未通过",
    );
    expect(medicalRedactVerificationStatusLabel("SKIPPED")).toBe(
      "安全验证已关闭",
    );
    expect(
      medicalRedactVerificationMessages({
        status: "PASS",
        findingCodes: [],
      }),
    ).toEqual([]);
    expect(
      medicalRedactVerificationMessages({
        status: "SKIPPED",
        findingCodes: [],
      }),
    ).toEqual([]);
    expect(
      medicalRedactVerificationMessages({
        status: "BLOCKED",
        findingCodes: ["KNOWN_VALUE_SURVIVED"],
      }),
    ).toEqual([
      "仍检测到已知敏感信息：脱敏后的文件仍包含已知敏感信息。请检查标记区域并补充脱敏后重新生成。",
    ]);
  });

  test("unknown protocol codes and backend messages use Chinese fallbacks instead of raw values", () => {
    expect(medicalRedactWarningLabel("SOME_NEW_INTERNAL_CODE")).toBe(
      UNKNOWN_MEDICAL_REDACT_CODE_MESSAGE,
    );
    expect(medicalRedactVerificationFindingLabel("SOME_NEW_FINDING_CODE")).toBe(
      "安全验证未通过：安全验证检测到未分类的阻断风险。请重新生成；如持续出现，请记录诊断码并联系维护人员。",
    );
    expect(medicalRedactEntityTypeLabel("UNKNOWN_ENTITY")).toBe("其他敏感信息");
    expect(medicalRedactEntityRoleLabel("UNKNOWN_ROLE")).toBe("其他相关人员");
    expect(medicalRedactTextSourceLabel("UNKNOWN_SOURCE")).toBe(
      "文字来源待确认",
    );
    expect(medicalRedactAlignmentMethodLabel("UNKNOWN_ALIGNMENT")).toBe(
      "定位方式待确认",
    );
    expect(
      medicalRedactUserErrorMessage(
        new Error("secret backend exception in English"),
      ),
    ).toBe(UNKNOWN_MEDICAL_REDACT_CODE_MESSAGE);
  });

  test("maps known backend exceptions without exposing the English source message", () => {
    const error = {
      response: {
        data: {
          detail:
            '500 INTERNAL_SERVER_ERROR "Unable to finalize the redacted document"',
        },
      },
    };

    expect(
      medicalRedactUserErrorMessage(error, "生成脱敏文件失败，请稍后重试。"),
    ).toBe("生成脱敏文件失败：永久脱敏文件未能正常生成。请稍后重试。");

    expect(
      medicalRedactUserErrorMessage(
        new Error("At least one PDF or image is required"),
      ),
    ).toBe("尚未选择文件：至少需要选择一个 PDF 文档或图片。请选择文件后继续。");
  });
});
