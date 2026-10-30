import { describe, expect, test } from "vitest";
import {
  MEDICAL_REDACT_ISSUE_CATALOG,
  isMedicalRedactIssueCode,
} from "@app/utils/medicalRedactIssueCatalog";
import {
  medicalRedactIssueCode,
  medicalRedactIssueFromError,
  medicalRedactVerificationIssues,
  resolveMedicalRedactIssue,
} from "@app/utils/medicalRedactIssueResolver";

describe("medicalRedactIssueCatalog", () => {
  test("contains unique global codes and every key resolves", () => {
    const codes = Object.keys(MEDICAL_REDACT_ISSUE_CATALOG);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThan(90);
    for (const code of codes) {
      expect(isMedicalRedactIssueCode(code)).toBe(true);
      const resolved = resolveMedicalRedactIssue(code);
      expect(resolved.code).toBe(code);
      expect(resolved.title.length).toBeGreaterThan(0);
      expect(resolved.description.length).toBeGreaterThan(0);
    }
  });

  test("maps current verification legacy codes to MR-VERIFY codes", () => {
    expect(medicalRedactIssueCode("NO_SELECTED_REDACTION", true)).toBe(
      "MR-VERIFY-7001",
    );
    expect(medicalRedactIssueCode("UNRESOLVED_PII_RISK", true)).toBe(
      "MR-VERIFY-7002",
    );
    expect(medicalRedactIssueCode("KNOWN_VALUE_SURVIVED", true)).toBe(
      "MR-VERIFY-7004",
    );
    expect(medicalRedactIssueCode("OUTPUT_OCR_UNAVAILABLE", true)).toBe(
      "MR-VERIFY-7006",
    );
    expect(medicalRedactIssueCode("TEXT_LAYER_SURVIVED", true)).toBe(
      "MR-VERIFY-7008",
    );
    expect(medicalRedactIssueCode("SOME_NEW_VERIFICATION_FINDING", true)).toBe(
      "MR-VERIFY-7099",
    );
  });

  test("maps OCR, re-OCR, PII and engine legacy warnings without exposing them", () => {
    const pairs: Array<[string, string]> = [
      ["NER_UNAVAILABLE", "MR-PII-4001"],
      ["OCR_NO_TEXT_DETECTED", "MR-OCR-3001"],
      ["PADDLEOCR_RUNTIME_UNAVAILABLE", "MR-OCR-3008"],
      ["LOCAL_REOCR_NO_SAFE_MATCH", "MR-ALIGN-5112"],
      ["TOKEN_REGION_MAPPING_CONFLICT", "MR-ALIGN-5006"],
      ["AI_ENGINE_TIMEOUT", "MR-RUNTIME-9002"],
      ["AI_ENGINE_HTTP_503", "MR-RUNTIME-9005"],
    ];

    for (const [legacy, expected] of pairs) {
      const code = medicalRedactIssueCode(legacy);
      expect(code).toBe(expected);
      const resolved = resolveMedicalRedactIssue(legacy);
      expect(resolved.title).not.toContain(legacy);
      expect(resolved.description).not.toContain(legacy);
      expect(resolved.action).not.toContain(legacy);
    }
  });

  test("normalizes legacy BLOCKED reports and fail-closes unknown findings", () => {
    const issues = medicalRedactVerificationIssues({
      status: "BLOCKED",
      findingCodes: ["OUTPUT_OCR_UNAVAILABLE"],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("MR-VERIFY-7006");
    expect(issues[0].title).toBe("无法完成文字安全复检");

    const unknown = medicalRedactVerificationIssues({
      status: "BLOCKED",
      findingCodes: ["UNKNOWN_FINDING"],
    });
    expect(unknown).toHaveLength(1);
    expect(unknown[0].code).toBe("MR-VERIFY-7099");
  });

  test("keeps same-code verification findings separate when locations differ", () => {
    const issues = medicalRedactVerificationIssues({
      status: "BLOCKED",
      issues: [
        {
          code: "MR-VERIFY-7005",
          severity: "BLOCKING",
          pageId: "page-1",
          candidateId: "candidate-1",
          params: { pageNo: 1, x: 10, y: 20, width: 30, height: 12 },
        },
        {
          code: "MR-VERIFY-7005",
          severity: "BLOCKING",
          pageId: "page-2",
          candidateId: "candidate-2",
          params: { pageNo: 2, x: 40, y: 50, width: 60, height: 18 },
        },
      ],
    });

    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.pageId)).toEqual(["page-1", "page-2"]);
    expect(issues.map((issue) => issue.candidateId)).toEqual([
      "candidate-1",
      "candidate-2",
    ]);
  });

  test("prefers structured API error codes over English messages", () => {
    const issue = medicalRedactIssueFromError({
      response: {
        data: {
          code: "MR-IMPORT-2002",
          traceId: "trace-123",
          message: "Only PDF and common image files are supported",
        },
      },
    });
    expect(issue.code).toBe("MR-IMPORT-2002");
    expect(issue.title).toBe("文件格式不支持");
    expect(issue.title).not.toMatch(/[A-Za-z]{3,}/);
  });

  test("parses structured MR codes from Tauri HTTP string error bodies", () => {
    const issue = medicalRedactIssueFromError({
      response: {
        data: JSON.stringify({
          code: "MR-DELIVERY-8511",
          severity: "ERROR",
          params: {},
          traceId: "delivery-trace",
        }),
      },
    });
    expect(issue.code).toBe("MR-DELIVERY-8511");
    expect(issue.title).toBe("上传交付包失败");
  });

  test("unknown backend text never becomes user-visible text", () => {
    const raw = "secret backend exception in English";
    const issue = medicalRedactIssueFromError(new Error(raw));
    expect(issue.code).toBe("MR-GEN-0001");
    expect(issue.title).toBe("处理失败");
    expect(issue.description).not.toContain(raw);
    expect(issue.action).not.toContain(raw);
  });
});
