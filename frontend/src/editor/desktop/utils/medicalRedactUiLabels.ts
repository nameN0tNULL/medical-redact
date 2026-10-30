import type {
  MedicalRedactCandidateRiskStatus,
  MedicalRedactVerificationReport,
} from "@app/services/medicalRedactTaskService";
import {
  medicalRedactIssueBody,
  medicalRedactIssueFromError,
  medicalRedactIssueMessage,
  medicalRedactUserErrorMessage as resolveMedicalRedactUserErrorMessage,
  medicalRedactVerificationIssues,
  type ResolvedMedicalRedactIssue,
} from "@app/utils/medicalRedactIssueResolver";

const ENTITY_TYPE_LABELS: Record<string, string> = {
  PATIENT_NAME: "患者姓名",
  DOCTOR_NAME: "医生姓名",
  FAMILY_MEMBER_NAME: "家属姓名",
  CN_ID_CARD: "身份证",
  PHONE: "手机",
  FIXED_PHONE: "固定电话",
  EMAIL: "邮箱",
  BANK_CARD: "银行卡",
  HOME_ADDRESS: "家庭住址",
  ADDRESS: "地址",
  MEDICAL_RECORD_NO: "病历号",
  OUTPATIENT_NO: "门诊号",
  INPATIENT_NO: "住院号",
  INSURANCE_NO: "医保号",
  PATIENT_ID: "患者编号",
  EXAM_NO: "检查号",
  SAMPLE_NO: "样本号",
  DATE_OF_BIRTH: "出生日期",
  HOSPITAL_NAME: "医院名称",
  DEPARTMENT_NAME: "科室名称",
  OTHER: "其他敏感信息",
};

const ENTITY_ROLE_LABELS: Record<string, string> = {
  PATIENT: "患者",
  DOCTOR: "医生",
  FAMILY: "家属",
};

const RISK_STATUS_LABELS: Record<MedicalRedactCandidateRiskStatus, string> = {
  RESOLVED: "已解决",
  REVIEW: "需审核",
  CONFLICT: "冲突",
  HIGH_RISK: "高风险",
  UNRESOLVED: "未定位",
};

const TEXT_SOURCE_LABELS: Record<string, string> = {
  PDF_TEXT: "文档原生文字",
  PADDLE_OCR: "图片文字识别",
  LOCAL_REOCR: "局部重新识别",
  OCR: "图片文字识别",
  OCR_UNAVAILABLE: "图片文字识别不可用",
};

const ALIGNMENT_METHOD_LABELS: Record<string, string> = {
  UNRESOLVED: "未定位",
  PDF_NATIVE_CHAR: "文档原生文字定位",
  TOKEN_FULL: "整段文字定位",
  OCR_CHAR_BOX: "图片文字精确定位",
  TOKEN_PARTIAL: "部分文字定位",
  LOCAL_REOCR: "局部重新识别",
  LOCAL_REOCR_FAILED: "局部重新识别失败",
  LOCAL_REOCR_EXACT: "局部重新识别精确匹配",
  LOCAL_REOCR_FUZZY: "局部重新识别近似匹配",
};

export const MEDICAL_REDACT_ENTITY_TYPE_OPTIONS = Object.entries(
  ENTITY_TYPE_LABELS,
) as ReadonlyArray<readonly [string, string]>;

export const MEDICAL_REDACT_ENTITY_ROLE_OPTIONS = [
  { value: "__NONE__", label: "未指定" },
  { value: "PATIENT", label: "患者" },
  { value: "DOCTOR", label: "医生" },
  { value: "FAMILY", label: "家属" },
] as const;

export const UNKNOWN_MEDICAL_REDACT_CODE_MESSAGE =
  "处理过程中出现未识别的异常。请重试；如持续出现，请记录诊断码并联系维护人员。";

export function medicalRedactEntityTypeLabel(value: string | null | undefined) {
  if (!value) return "其他敏感信息";
  return ENTITY_TYPE_LABELS[value] ?? "其他敏感信息";
}

export function medicalRedactEntityRoleLabel(value: string | null | undefined) {
  if (!value) return "未指定";
  return ENTITY_ROLE_LABELS[value] ?? "其他相关人员";
}

export function medicalRedactRiskStatusLabel(
  value: MedicalRedactCandidateRiskStatus,
) {
  return RISK_STATUS_LABELS[value] ?? "状态待确认";
}

export function medicalRedactTextSourceLabel(value: string | null | undefined) {
  if (!value) return "文字来源待确认";
  return TEXT_SOURCE_LABELS[value] ?? "文字来源待确认";
}

export function medicalRedactAlignmentMethodLabel(
  value: string | null | undefined,
) {
  if (!value) return "定位方式待确认";
  return ALIGNMENT_METHOD_LABELS[value] ?? "定位方式待确认";
}

export function medicalRedactWarningLabel(code: string | null | undefined) {
  return medicalRedactIssueBody(code ?? "MR-GEN-0001");
}

export function medicalRedactVerificationStatusLabel(
  status: "PASS" | "BLOCKED" | "SKIPPED",
) {
  if (status === "PASS") return "安全验证通过";
  if (status === "SKIPPED") return "安全验证已关闭";
  return "安全验证未通过";
}

export function medicalRedactVerificationFindingLabel(
  code: string | null | undefined,
) {
  return medicalRedactIssueMessage(code ?? "MR-VERIFY-7099", true);
}

export function medicalRedactVerificationIssueLocation(
  issue: ResolvedMedicalRedactIssue,
) {
  const parts: string[] = [];
  const pageNo = issue.params.pageNo;
  if (typeof pageNo === "number") {
    parts.push(`第 ${pageNo} 页`);
  }
  const entityType = issue.params.entityType;
  if (typeof entityType === "string" && entityType) {
    parts.push(medicalRedactEntityTypeLabel(entityType));
  }
  const { x, y, width, height } = issue.params;
  if (
    typeof x === "number" &&
    typeof y === "number" &&
    typeof width === "number" &&
    typeof height === "number"
  ) {
    parts.push(
      `区域 (${Math.round(x)}, ${Math.round(y)}, ${Math.round(width)}×${Math.round(height)})`,
    );
  }
  return parts.join(" · ");
}

export function medicalRedactVerificationMessages(
  report: Pick<
    MedicalRedactVerificationReport,
    "status" | "issues" | "findingCodes"
  >,
) {
  if (report.status === "PASS" || report.status === "SKIPPED") {
    return [];
  }
  return medicalRedactVerificationIssues(report).map((issue) => {
    const location = medicalRedactVerificationIssueLocation(issue);
    const message = `${issue.title}：${issue.description}${issue.action}`;
    return location ? `${location} · ${message}` : message;
  });
}

export function medicalRedactUserErrorMessage(
  error: unknown,
  _fallback?: string,
) {
  const issue = medicalRedactIssueFromError(error);
  if (issue.code === "MR-GEN-0001") {
    return UNKNOWN_MEDICAL_REDACT_CODE_MESSAGE;
  }
  return resolveMedicalRedactUserErrorMessage(error);
}
