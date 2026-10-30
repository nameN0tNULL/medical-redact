import {
  medicalRedactIssueFromError,
  type ResolvedMedicalRedactIssue,
} from "@app/utils/medicalRedactIssueResolver";

export interface MedicalRedactDiagnostic {
  code: string;
  traceId: string | null;
}

export function medicalRedactDiagnosticFromIssue(
  issue: Pick<ResolvedMedicalRedactIssue, "code" | "traceId">,
): MedicalRedactDiagnostic {
  return {
    code: issue.code,
    traceId: issue.traceId,
  };
}

export function medicalRedactDiagnosticFromError(
  error: unknown,
): MedicalRedactDiagnostic {
  return medicalRedactDiagnosticFromIssue(medicalRedactIssueFromError(error));
}
