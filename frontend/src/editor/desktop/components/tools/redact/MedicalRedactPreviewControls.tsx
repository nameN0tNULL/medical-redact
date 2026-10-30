import { Stack, Text } from "@mantine/core";
import { useAnnotation } from "@app/contexts/AnnotationContext";
import { useAllFiles } from "@app/contexts/FileContext";
import { useMedicalRedactReview } from "@app/contexts/MedicalRedactReviewContext";
import { useViewer } from "@app/contexts/ViewerContext";
import { isStirlingFile } from "@app/types/fileContext";
import { Button } from "@app/ui/Button";
import type { MedicalRedactPreviewControlsProps } from "@core/components/tools/redact/MedicalRedactPreviewControls";
import {
  medicalRedactVerificationMessages,
  medicalRedactVerificationStatusLabel,
} from "@app/utils/medicalRedactUiLabels";
import { isMedicalRedactSecurityVerificationEnabled } from "@app/services/medicalRedactPreferences";
export type { MedicalRedactPreviewControlsProps } from "@core/components/tools/redact/MedicalRedactPreviewControls";

export function MedicalRedactPreviewControls({
  disabled = false,
}: MedicalRedactPreviewControlsProps) {
  const { annotationApiRef } = useAnnotation();
  const { activeFileId } = useViewer();
  const { files } = useAllFiles();
  const activeFile = files.find(
    (file) => isStirlingFile(file) && file.fileId === activeFileId,
  );
  const fileKey = activeFileId ?? activeFile?.name ?? null;
  const {
    error,
    isFinalPreview,
    setFinalPreview,
    selectionRevision,
    finalizingFileKey,
    exportingFileKey,
    finalizeDocument,
    exportVerifiedDocument,
    getSelectedCount,
    getVerificationReport,
  } = useMedicalRedactReview();
  const verification = fileKey ? getVerificationReport(fileKey) : null;
  const selectedCount = fileKey ? getSelectedCount(fileKey) : 0;
  const securityVerificationEnabled =
    isMedicalRedactSecurityVerificationEnabled();
  void selectionRevision;
  const isFinalizing = fileKey !== null && finalizingFileKey === fileKey;
  const isExporting = fileKey !== null && exportingFileKey === fileKey;

  return (
    <Stack gap="xs">
      <Button
        fullWidth
        size="md"
        variant={isFinalPreview ? "primary" : "secondary"}
        disabled={disabled || selectedCount === 0}
        aria-pressed={isFinalPreview}
        onClick={() => {
          const next = !isFinalPreview;
          if (next) annotationApiRef.current?.deselectAnnotation();
          setFinalPreview(next);
        }}
      >
        {isFinalPreview ? "退出最终预览" : "最终黑框预览"}
      </Button>
      <Text size="xs" c="dimmed">
        当前已选择 {selectedCount}{" "}
        个脱敏区域。预览只遮挡画面，不会提前修改原文件。
      </Text>

      <Button
        fullWidth
        size="md"
        disabled={!fileKey || disabled || selectedCount === 0 || isFinalizing}
        loading={isFinalizing}
        onClick={() => {
          if (fileKey) void finalizeDocument(fileKey);
        }}
      >
        保存并生成脱敏文件
      </Button>

      {!securityVerificationEnabled ? (
        <Text size="xs" c="dimmed">
          安全验证已关闭，将按当前遮挡结果生成脱敏文件。
        </Text>
      ) : null}

      {verification?.status === "BLOCKED" ? (
        <Stack gap={2} data-medical-redact-verification={verification.status}>
          <Text size="xs" fw={600} c="red">
            {medicalRedactVerificationStatusLabel(verification.status)}
          </Text>
          {medicalRedactVerificationMessages(verification).map((message) => (
            <Text key={message} size="xs" c="red">
              {message}
            </Text>
          ))}
        </Stack>
      ) : null}

      <Button
        fullWidth
        size="md"
        variant="secondary"
        disabled={
          !fileKey ||
          (verification?.status !== "PASS" &&
            verification?.status !== "SKIPPED") ||
          !verification.outputFilename ||
          isExporting
        }
        loading={isExporting}
        onClick={() => {
          if (fileKey) void exportVerifiedDocument(fileKey);
        }}
      >
        {verification?.status === "SKIPPED"
          ? "导出脱敏文件"
          : "导出已验证脱敏文件"}
      </Button>

      {error ? (
        <Text size="xs" c="red">
          {error}
        </Text>
      ) : null}
    </Stack>
  );
}
