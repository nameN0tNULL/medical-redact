import {
  MEDICAL_REDACT_ISSUE_CATALOG,
  isMedicalRedactIssueCode,
  type MedicalRedactIssueCode,
  type MedicalRedactIssueDescriptor,
  type MedicalRedactIssueSeverity,
} from "@app/utils/medicalRedactIssueCatalog";

export interface MedicalRedactIssuePayload {
  code: string;
  severity?: MedicalRedactIssueSeverity;
  params?: Record<string, string | number | boolean>;
  documentId?: string | null;
  pageId?: string | null;
  candidateId?: string | null;
  traceId?: string | null;
  legacyCode?: string | null;
}

export interface MedicalRedactVerificationIssueSource {
  status: "PASS" | "BLOCKED" | "SKIPPED";
  issues?: MedicalRedactIssuePayload[] | null;
  findingCodes?: string[] | null;
}

export interface ResolvedMedicalRedactIssue {
  code: MedicalRedactIssueCode;
  severity: MedicalRedactIssueSeverity;
  title: string;
  description: string;
  action: string;
  retryable: boolean;
  params: Record<string, string | number | boolean>;
  documentId: string | null;
  pageId: string | null;
  candidateId: string | null;
  traceId: string | null;
}

const LEGACY_CODE_MAP: Record<string, MedicalRedactIssueCode> = {
  NER_UNAVAILABLE: "MR-PII-4001",
  LOCAL_PII_ENGINE_UNAVAILABLE: "MR-PII-4002",
  PII_ENGINE_UNAVAILABLE: "MR-PII-4002",

  OCR_NO_TEXT_DETECTED: "MR-OCR-3001",
  OCR_LOW_CONFIDENCE_PRESENT: "MR-OCR-3002",
  OCR_INVALID_REQUEST_IMAGE: "MR-OCR-3003",
  OCR_IMAGE_DECODE_FAILED: "MR-OCR-3004",
  OCR_IMAGE_DIMENSION_MISMATCH: "MR-OCR-3005",
  OCR_TRANSFORM_NON_INVERTIBLE: "MR-OCR-3006",
  PADDLEOCR_MODEL_MISSING: "MR-OCR-3007",
  PADDLEOCR_RUNTIME_UNAVAILABLE: "MR-OCR-3008",
  PADDLEOCR_INFERENCE_FAILED: "MR-OCR-3009",
  LOCAL_OCR_ENGINE_UNAVAILABLE: "MR-OCR-3010",

  NO_SOURCE_TOKEN: "MR-ALIGN-5001",
  INVALID_TOKEN_POLYGON: "MR-ALIGN-5002",
  PARTIAL_TOKEN_NEEDS_REOCR: "MR-ALIGN-5003",
  MISSING_BBOX: "MR-ALIGN-5004",
  BBOX_OUT_OF_BOUNDS: "MR-ALIGN-5005",
  TOKEN_REGION_MAPPING_CONFLICT: "MR-ALIGN-5006",
  LOCAL_REOCR_FAILED: "MR-ALIGN-5101",
  LOCAL_REOCR_FUZZY_MATCH: "MR-ALIGN-5102",
  LOCAL_REOCR_MISSING_BBOX: "MR-ALIGN-5103",
  LOCAL_REOCR_PAGE_MISMATCH: "MR-ALIGN-5104",
  LOCAL_REOCR_INVALID_BBOX: "MR-ALIGN-5105",
  LOCAL_REOCR_IMAGE_DECODE_FAILED: "MR-ALIGN-5106",
  LOCAL_REOCR_IMAGE_DIMENSION_MISMATCH: "MR-ALIGN-5107",
  LOCAL_REOCR_INVALID_CROP: "MR-ALIGN-5108",
  LOCAL_REOCR_IMAGE_ENCODE_FAILED: "MR-ALIGN-5109",
  LOCAL_REOCR_UNAVAILABLE: "MR-ALIGN-5110",
  LOCAL_REOCR_NO_TEXT: "MR-ALIGN-5111",
  LOCAL_REOCR_NO_SAFE_MATCH: "MR-ALIGN-5112",
  LOCAL_REOCR_NO_CHAR_BOX: "MR-ALIGN-5113",
  LOCAL_REOCR_MULTI_PAGE_UNSUPPORTED: "MR-ALIGN-5114",
  LOCAL_REOCR_LIMIT_EXCEEDED: "MR-ALIGN-5115",
  LOCAL_REOCR_IMAGE_UNAVAILABLE: "MR-ALIGN-5116",

  NO_SELECTED_REDACTION: "MR-VERIFY-7001",
  UNRESOLVED_PII_RISK: "MR-VERIFY-7002",
  VERIFICATION_OUTPUT_READ_FAILED: "MR-VERIFY-7003",
  KNOWN_VALUE_SURVIVED: "MR-VERIFY-7004",
  OUTPUT_PII_DETECTED: "MR-VERIFY-7005",
  OUTPUT_OCR_UNAVAILABLE: "MR-VERIFY-7006",
  OUTPUT_PII_SCAN_UNAVAILABLE: "MR-VERIFY-7007",
  TEXT_LAYER_SURVIVED: "MR-VERIFY-7008",
  PDF_STRUCTURE_SURVIVED: "MR-VERIFY-7009",
  METADATA_SURVIVED: "MR-VERIFY-7010",
  ANNOTATION_SURVIVED: "MR-VERIFY-7011",
  PAGE_COUNT_MISMATCH: "MR-VERIFY-7012",
  REDACTION_BOX_NOT_BLACK: "MR-VERIFY-7013",
  SEMANTIC_VERIFICATION_FAILED: "MR-VERIFY-7014",

  AI_ENGINE_DISABLED: "MR-RUNTIME-9001",
  AI_ENGINE_TIMEOUT: "MR-RUNTIME-9002",
  AI_ENGINE_UNREACHABLE: "MR-RUNTIME-9003",
  AI_ENGINE_INTERRUPTED: "MR-RUNTIME-9004",
};

const LEGACY_MESSAGE_MAP: Record<string, MedicalRedactIssueCode> = {
  "Batch not found": "MR-TASK-1001",
  "Invalid batch id": "MR-TASK-1002",
  "Batch id is required": "MR-TASK-1002",
  "Batch name must be 120 characters or fewer": "MR-TASK-1003",
  "Unable to create the local task": "MR-TASK-1004",
  "Unable to read local tasks": "MR-TASK-1005",
  "Unable to read the local task": "MR-TASK-1005",
  "Document not found": "MR-TASK-1006",
  "Document id is required": "MR-TASK-1007",

  "At least one PDF or image is required": "MR-IMPORT-2001",
  "Only PDF and common image files are supported": "MR-IMPORT-2002",
  "Empty files are not supported": "MR-IMPORT-2003",
  "A valid filename is required": "MR-IMPORT-2004",
  "Unable to import documents": "MR-IMPORT-2005",
  "Document source is unavailable": "MR-IMPORT-2006",
  "Unable to read the document source": "MR-IMPORT-2007",
  "The image file could not be decoded": "MR-IMPORT-2008",
  "Unable to create the review PDF": "MR-IMPORT-2009",

  "Known entity context is limited to 100 entries": "MR-PII-4010",
  "Known entity type and value are required": "MR-PII-4011",
  "Unsupported known entity type": "MR-PII-4012",
  "Known entity values must contain 1 to 256 characters": "MR-PII-4013",
  "Known entity role is too long": "MR-PII-4014",

  "Review action is required": "MR-REVIEW-6001",
  "Review target type is required": "MR-REVIEW-6002",
  "Review target id is required": "MR-REVIEW-6003",
  "Review target id must be 200 characters or fewer": "MR-REVIEW-6004",
  "Review action type is required": "MR-REVIEW-6005",
  "Text selection actions require a text region target": "MR-REVIEW-6006",
  "Manual rectangle action has an invalid target type": "MR-REVIEW-6007",
  "Review action must include before or after state": "MR-REVIEW-6008",
  "Selection state is required": "MR-REVIEW-6009",
  "Selection source is required": "MR-REVIEW-6010",
  "Review action page does not belong to document": "MR-REVIEW-6011",
  "Review action box is invalid": "MR-REVIEW-6012",
  "Unable to save the review action": "MR-REVIEW-6013",
  "Unable to extract document text regions": "MR-REVIEW-6014",
  "Entity type must be 80 characters or fewer": "MR-REVIEW-6015",
  "Entity role must be 80 characters or fewer": "MR-REVIEW-6016",

  "At least one selected redaction region is required": "MR-VERIFY-7001",
  "Unresolved PII risks require review before Verification": "MR-VERIFY-7002",
  "Unable to finalize the redacted document": "MR-VERIFY-7015",
  "Secure-raster verification found unresolved output risks": "MR-VERIFY-7099",

  "Verified output is not available": "MR-EXPORT-8002",
  "Verified output is unavailable": "MR-EXPORT-8002",
  "Unable to read the verified output": "MR-EXPORT-8003",

  "PNG encoder is unavailable": "MR-RUNTIME-9006",
  "SHA-256 is unavailable": "MR-RUNTIME-9007",
  "Unable to clean temporary workspace files": "MR-STORAGE-9501",
  "Unable to mark source file as read-only": "MR-STORAGE-9502",
};

function mappedLegacyMessage(value: string): MedicalRedactIssueCode | null {
  const exact = LEGACY_MESSAGE_MAP[value];
  if (exact) return exact;
  for (const [message, code] of Object.entries(LEGACY_MESSAGE_MAP)) {
    if (value.includes(message)) return code;
  }
  return null;
}

export function medicalRedactIssueCode(
  value: string | null | undefined,
  verification = false,
): MedicalRedactIssueCode {
  if (!value) {
    return verification ? "MR-VERIFY-7099" : "MR-GEN-0001";
  }
  if (isMedicalRedactIssueCode(value)) return value;
  if (value.startsWith("AI_ENGINE_HTTP_")) return "MR-RUNTIME-9005";
  const legacyCode = LEGACY_CODE_MAP[value];
  if (legacyCode) return legacyCode;
  const legacyMessage = mappedLegacyMessage(value);
  if (legacyMessage) return legacyMessage;
  return verification ? "MR-VERIFY-7099" : "MR-GEN-0001";
}

export function resolveMedicalRedactIssue(
  issue: MedicalRedactIssuePayload | string,
  verification = false,
): ResolvedMedicalRedactIssue {
  const payload = typeof issue === "string" ? { code: issue } : issue;
  const code = medicalRedactIssueCode(payload.code, verification);
  const descriptor: MedicalRedactIssueDescriptor =
    MEDICAL_REDACT_ISSUE_CATALOG[code];
  return {
    code,
    severity: descriptor.severity,
    title: descriptor.title,
    description: descriptor.description,
    action: descriptor.action,
    retryable: descriptor.retryable,
    params: payload.params ?? {},
    documentId: payload.documentId ?? null,
    pageId: payload.pageId ?? null,
    candidateId: payload.candidateId ?? null,
    traceId: payload.traceId ?? null,
  };
}

export function medicalRedactVerificationIssues(
  report: MedicalRedactVerificationIssueSource,
): ResolvedMedicalRedactIssue[] {
  if (report.status === "PASS" || report.status === "SKIPPED") return [];

  const sources =
    report.issues && report.issues.length > 0
      ? report.issues
      : (report.findingCodes ?? []).map((code) => ({
          code,
          legacyCode: code,
        }));

  if (sources.length === 0) {
    return [resolveMedicalRedactIssue("MR-VERIFY-7099", true)];
  }

  const resolved = sources.map((issue) =>
    resolveMedicalRedactIssue(issue, true),
  );
  return Array.from(
    new Map(
      resolved.map((issue) => [
        [
          issue.code,
          issue.pageId ?? "",
          issue.candidateId ?? "",
          JSON.stringify(issue.params),
        ].join("|"),
        issue,
      ]),
    ).values(),
  );
}

export function medicalRedactIssueBody(
  issue: MedicalRedactIssuePayload | string,
  verification = false,
): string {
  const resolved = resolveMedicalRedactIssue(issue, verification);
  return resolved.action
    ? `${resolved.description}${resolved.action}`
    : resolved.description;
}

export function medicalRedactIssueMessage(
  issue: MedicalRedactIssuePayload | string,
  verification = false,
): string {
  const resolved = resolveMedicalRedactIssue(issue, verification);
  return `${resolved.title}：${medicalRedactIssueBody(issue, verification)}`;
}

function collectErrorCandidates(error: unknown): string[] {
  if (typeof error === "string") return [error];
  if (typeof error !== "object" || error === null) return [];

  const record = error as Record<string, unknown>;
  const candidates: string[] = [];

  if (error instanceof Error && error.message) candidates.push(error.message);
  if (typeof record.code === "string") candidates.push(record.code);

  const response =
    typeof record.response === "object" && record.response !== null
      ? (record.response as Record<string, unknown>)
      : null;
  const data = response?.data;
  if (typeof data === "string") {
    candidates.push(data);
    try {
      const parsed = JSON.parse(data) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        const parsedRecord = parsed as Record<string, unknown>;
        for (const key of [
          "code",
          "warningCode",
          "findingCode",
          "detail",
          "message",
          "error",
        ]) {
          const value = parsedRecord[key];
          if (typeof value === "string") candidates.push(value);
        }
      }
    } catch {
      // Plain-text legacy responses are already included above.
    }
  } else if (typeof data === "object" && data !== null) {
    const dataRecord = data as Record<string, unknown>;
    for (const key of [
      "code",
      "warningCode",
      "findingCode",
      "detail",
      "message",
      "error",
    ]) {
      const value = dataRecord[key];
      if (typeof value === "string") candidates.push(value);
    }
  }

  return candidates;
}

export function medicalRedactIssueFromError(
  error: unknown,
): ResolvedMedicalRedactIssue {
  for (const candidate of collectErrorCandidates(error)) {
    const code = medicalRedactIssueCode(candidate);
    if (code !== "MR-GEN-0001") {
      return resolveMedicalRedactIssue(code);
    }
  }
  return resolveMedicalRedactIssue("MR-GEN-0001");
}

export function medicalRedactUserErrorMessage(error: unknown): string {
  const issue = medicalRedactIssueFromError(error);
  return `${issue.title}：${issue.description}${issue.action}`;
}
