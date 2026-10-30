import { useMemo, useState } from "react";
import {
  Badge,
  Divider,
  Group,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import ManualRedactionControls from "@app/components/tools/redact/ManualRedactionControls";
import { useAllFiles } from "@app/contexts/FileContext";
import { useMedicalRedactReview } from "@app/contexts/MedicalRedactReviewContext";
import { useViewer } from "@app/contexts/ViewerContext";
import type {
  MedicalRedactCandidateRiskStatus,
  MedicalRedactPiiCandidate,
} from "@app/services/medicalRedactTaskService";
import { isStirlingFile } from "@app/types/fileContext";
import { Button } from "@app/ui/Button";
import {
  MEDICAL_REDACT_ENTITY_ROLE_OPTIONS,
  medicalRedactEntityRoleLabel,
  medicalRedactEntityTypeLabel,
  medicalRedactRiskStatusLabel,
  medicalRedactVerificationIssueLocation,
  medicalRedactVerificationStatusLabel,
  medicalRedactWarningLabel,
} from "@app/utils/medicalRedactUiLabels";
import { medicalRedactVerificationIssues } from "@app/utils/medicalRedactIssueResolver";

type RiskFilter = "ALL" | Exclude<MedicalRedactCandidateRiskStatus, "RESOLVED">;

const RISK_FILTERS: Array<{ value: RiskFilter; label: string }> = [
  { value: "ALL", label: "全部待审核风险" },
  { value: "UNRESOLVED", label: medicalRedactRiskStatusLabel("UNRESOLVED") },
  { value: "HIGH_RISK", label: medicalRedactRiskStatusLabel("HIGH_RISK") },
  { value: "CONFLICT", label: medicalRedactRiskStatusLabel("CONFLICT") },
  { value: "REVIEW", label: medicalRedactRiskStatusLabel("REVIEW") },
];

function riskColor(status: MedicalRedactCandidateRiskStatus) {
  switch (status) {
    case "UNRESOLVED":
    case "HIGH_RISK":
      return "red";
    case "CONFLICT":
      return "orange";
    case "REVIEW":
      return "yellow";
    default:
      return "green";
  }
}

export default function MedicalReviewPanel() {
  const { files } = useAllFiles();
  const { activeFileId, scrollActions } = useViewer();
  const {
    batch,
    autoRedactingFileKey,
    autoRedactDocument,
    entityTypes,
    getDocument,
    getPiiCandidates,
    getCandidateReviewState,
    getCandidateDecision,
    reviewCandidate,
    changeCandidateType,
    changeCandidateRole,
    getSelectionSummary,
    getVerificationReport,
    selectionRevision,
    setVerificationFocusBox,
    textRegionRevision,
  } = useMedicalRedactReview();
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("ALL");
  const [riskCursor, setRiskCursor] = useState(0);

  const activeFile = files.find(
    (file) => isStirlingFile(file) && file.fileId === activeFileId,
  );
  const fileKey = activeFileId ?? activeFile?.name ?? null;
  const document = fileKey ? getDocument(fileKey) : undefined;
  const verification = fileKey ? getVerificationReport(fileKey) : null;
  const summary = fileKey
    ? getSelectionSummary(fileKey)
    : { total: 0, auto: 0, user: 0, manual: 0 };
  const candidates = fileKey ? getPiiCandidates(fileKey) : [];
  const verificationIssues = useMemo(
    () =>
      verification?.status === "BLOCKED"
        ? medicalRedactVerificationIssues(verification)
        : [],
    [verification],
  );
  void selectionRevision;
  void textRegionRevision;
  void batch;

  const riskCandidates = useMemo(
    () =>
      candidates.filter(
        (candidate) =>
          candidate.riskStatus !== "RESOLVED" &&
          (riskFilter === "ALL" || candidate.riskStatus === riskFilter),
      ),
    [candidates, riskFilter],
  );

  const locateCandidate = (candidate: MedicalRedactPiiCandidate) => {
    const pageId = candidate.pageIds[0];
    const page = document?.pages.find((item) => item.id === pageId);
    if (page) {
      scrollActions.scrollToPage(page.pageNo, "smooth");
    }
  };

  const goToNextRisk = () => {
    if (riskCandidates.length === 0) return;
    const nextIndex = riskCursor % riskCandidates.length;
    const candidate = riskCandidates[nextIndex];
    locateCandidate(candidate);
    setRiskCursor((nextIndex + 1) % riskCandidates.length);
  };

  const locateVerificationIssue = (
    issue: ReturnType<typeof medicalRedactVerificationIssues>[number],
  ) => {
    const pageNo = issue.params.pageNo;
    const { x, y, width, height } = issue.params;
    if (
      issue.pageId &&
      typeof x === "number" &&
      typeof y === "number" &&
      typeof width === "number" &&
      typeof height === "number"
    ) {
      setVerificationFocusBox({
        pageId: issue.pageId,
        x,
        y,
        width,
        height,
      });
    } else {
      setVerificationFocusBox(null);
    }
    if (typeof pageNo === "number") {
      scrollActions.scrollToPage(pageNo, "smooth");
    }
  };

  const entityTypeOptions = entityTypes.map(([value, label]) => ({
    value,
    label,
  }));

  return (
    <Stack gap="md" p="md" data-medical-review-panel>
      <Stack gap={4}>
        <Title order={4}>脱敏审核</Title>
        {activeFile ? (
          <>
            <Text size="sm" fw={600} truncate>
              {document?.originalFilename ?? activeFile.name}
            </Text>
            <Group gap="xs">
              <Badge variant="light">{document?.pageCount ?? "—"} 页</Badge>
              <Badge variant="light">已选择 {summary.total}</Badge>
              {verification?.status === "BLOCKED" ? (
                <Badge variant="light" color="red">
                  {medicalRedactVerificationStatusLabel(verification.status)}
                </Badge>
              ) : null}
            </Group>
            <Group gap="xs">
              <Badge variant="outline">自动 {summary.auto}</Badge>
              <Badge variant="outline">人工文字 {summary.user}</Badge>
              <Badge variant="outline">手工框 {summary.manual}</Badge>
            </Group>
            <Button
              size="sm"
              data-medical-auto-redact
              disabled={!fileKey || autoRedactingFileKey !== null}
              onClick={() => {
                if (fileKey) void autoRedactDocument(fileKey);
              }}
            >
              {autoRedactingFileKey === fileKey ? "正在自动脱敏…" : "自动脱敏"}
            </Button>
            <Text size="xs" c="dimmed">
              按当前敏感信息规则自动涂黑可可靠定位的内容；完成后仍可点击文字框取消或补选，也可继续手工框选。
            </Text>
            {verification?.status === "BLOCKED" ? (
              <Stack gap="xs" data-verification-findings>
                {verificationIssues.map((issue, index) => {
                  const location =
                    medicalRedactVerificationIssueLocation(issue);
                  const canLocate =
                    typeof issue.params.pageNo === "number" ||
                    Boolean(issue.pageId);
                  return (
                    <Paper
                      key={`${issue.code}-${issue.pageId ?? "none"}-${issue.candidateId ?? index}`}
                      withBorder
                      p="xs"
                      radius="sm"
                      data-verification-issue={issue.code}
                    >
                      <Stack gap={4}>
                        <Text size="xs" fw={600}>
                          {issue.title}
                        </Text>
                        {location ? (
                          <Text size="xs" c="red">
                            {location}
                          </Text>
                        ) : null}
                        <Text size="xs" c="dimmed">
                          {issue.description}
                          {issue.action}
                        </Text>
                        {canLocate ? (
                          <Button
                            size="sm"
                            variant="quiet"
                            onClick={() => locateVerificationIssue(issue)}
                          >
                            定位该区域
                          </Button>
                        ) : null}
                      </Stack>
                    </Paper>
                  );
                })}
              </Stack>
            ) : null}
          </>
        ) : (
          <Text size="sm" c="dimmed">
            未选择任务文件
          </Text>
        )}
      </Stack>

      <Divider />

      <Stack gap="xs" data-medical-risk-list>
        <Group justify="space-between" align="center">
          <Text size="sm" fw={600}>
            敏感信息风险
          </Text>
          <Badge
            variant="light"
            color={riskCandidates.length > 0 ? "red" : "green"}
          >
            {riskCandidates.length}
          </Badge>
        </Group>
        <Select
          size="xs"
          aria-label="风险筛选"
          value={riskFilter}
          data={RISK_FILTERS}
          onChange={(value) => {
            setRiskFilter((value as RiskFilter | null) ?? "ALL");
            setRiskCursor(0);
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={riskCandidates.length === 0}
          onClick={goToNextRisk}
        >
          下一风险
        </Button>

        {riskCandidates.length === 0 ? (
          <Text size="xs" c="dimmed">
            当前筛选下没有待审核风险。
          </Text>
        ) : (
          <ScrollArea.Autosize mah={360}>
            <Stack gap="xs">
              {riskCandidates.map((candidate) => {
                const reviewState = fileKey
                  ? getCandidateReviewState(fileKey, candidate.id)
                  : null;
                const decision = fileKey
                  ? getCandidateDecision(fileKey, candidate.id)
                  : null;
                return (
                  <Paper
                    key={candidate.id}
                    withBorder
                    p="xs"
                    radius="sm"
                    data-risk-candidate={candidate.id}
                    data-risk-status={candidate.riskStatus}
                  >
                    <Stack gap={6}>
                      <Group justify="space-between" gap="xs">
                        <Badge
                          size="sm"
                          variant="light"
                          color={riskColor(candidate.riskStatus)}
                        >
                          {medicalRedactRiskStatusLabel(candidate.riskStatus)}
                        </Badge>
                        {decision ? (
                          <Badge
                            size="sm"
                            variant="outline"
                            color={decision === "APPROVE" ? "green" : "gray"}
                          >
                            {decision === "APPROVE" ? "已批准" : "已拒绝"}
                          </Badge>
                        ) : null}
                      </Group>

                      <Text size="xs">
                        {medicalRedactEntityTypeLabel(
                          reviewState?.entityType ?? candidate.entityType,
                        )}
                        {reviewState?.entityRole || candidate.entityRole
                          ? " · " +
                            medicalRedactEntityRoleLabel(
                              reviewState?.entityRole ?? candidate.entityRole,
                            )
                          : ""}
                      </Text>
                      <Text size="xs" c="dimmed">
                        识别置信度 {Math.round(candidate.confidence * 100)}% ·
                        定位置信度{" "}
                        {Math.round(candidate.alignment.confidence * 100)}%
                      </Text>
                      {candidate.alignment.warnings.length > 0 ? (
                        <Stack gap={2}>
                          {Array.from(
                            new Set(
                              candidate.alignment.warnings.map(
                                medicalRedactWarningLabel,
                              ),
                            ),
                          ).map((message) => (
                            <Text key={message} size="xs" c="dimmed">
                              {message}
                            </Text>
                          ))}
                        </Stack>
                      ) : null}

                      <Select
                        size="xs"
                        aria-label="候选类型"
                        value={reviewState?.entityType ?? candidate.entityType}
                        data={entityTypeOptions}
                        onChange={(value) => {
                          if (fileKey && value) {
                            changeCandidateType(fileKey, candidate.id, value);
                          }
                        }}
                      />
                      <Select
                        size="xs"
                        aria-label="候选角色"
                        value={reviewState?.entityRole ?? "__NONE__"}
                        data={MEDICAL_REDACT_ENTITY_ROLE_OPTIONS}
                        onChange={(value) => {
                          if (fileKey) {
                            changeCandidateRole(
                              fileKey,
                              candidate.id,
                              !value || value === "__NONE__" ? null : value,
                            );
                          }
                        }}
                      />

                      <Group gap="xs">
                        <Button
                          size="sm"
                          variant="quiet"
                          onClick={() => locateCandidate(candidate)}
                        >
                          定位
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            if (fileKey) {
                              reviewCandidate(fileKey, candidate.id, "APPROVE");
                            }
                          }}
                        >
                          批准
                        </Button>
                        <Button
                          size="sm"
                          variant="quiet"
                          onClick={() => {
                            if (fileKey) {
                              reviewCandidate(fileKey, candidate.id, "REJECT");
                            }
                          }}
                        >
                          拒绝
                        </Button>
                      </Group>
                      {candidate.riskStatus === "UNRESOLVED" ||
                      candidate.riskStatus === "HIGH_RISK" ? (
                        <Text size="xs" c="dimmed">
                          先点击页面上的正确文字框，或使用下方手工补框；仅批准候选不会绕过
                          安全验证阻断。
                        </Text>
                      ) : null}
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>
          </ScrollArea.Autosize>
        )}
      </Stack>

      <Divider />

      <ManualRedactionControls disabled={!activeFile} />
    </Stack>
  );
}
