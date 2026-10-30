import { useEffect, useRef } from "react";
import { Group, Stack, Text } from "@mantine/core";
import { useRedaction, useRedactionMode } from "@app/contexts/RedactionContext";
import { useViewer } from "@app/contexts/ViewerContext";
import { useSignature } from "@app/contexts/SignatureContext";
import { MedicalRedactPreviewControls } from "@app/components/tools/redact/MedicalRedactPreviewControls";
import { useMedicalRedactManualHistory } from "@app/hooks/useMedicalRedactManualHistory";
import { useMedicalRedactManualMode } from "@app/hooks/useMedicalRedactManualMode";
import { useMedicalRedactPreviewMode } from "@app/hooks/useMedicalRedactPreviewMode";
import { useMedicalRedactTextHistory } from "@app/hooks/useMedicalRedactTextHistory";
import { useHistoryAvailability } from "@app/hooks/useHistoryAvailability";
import { Button } from "@app/ui/Button";

interface ManualRedactionControlsProps {
  disabled?: boolean;
}

const MEDICAL_REDACTION_COLOR = "#000000";

export default function ManualRedactionControls({
  disabled = false,
}: ManualRedactionControlsProps) {
  const {
    activateManualRedact,
    deactivateRedact,
    setActiveType,
    setManualRedactColor,
  } = useRedaction();
  const { pendingCount, activeType, isBridgeReady, isRedacting } =
    useRedactionMode();
  const { isAnnotationMode, setAnnotationMode, activeFileIndex } = useViewer();
  const { signatureApiRef, historyApiRef, undo, redo } = useSignature();
  const historyAvailability = useHistoryAvailability(historyApiRef);
  const manualHistory = useMedicalRedactManualHistory();
  const textHistory = useMedicalRedactTextHistory();
  const isFinalPreview = useMedicalRedactPreviewMode();
  const [manualMode, setManualMode] = useMedicalRedactManualMode();
  const prevFileIndexRef = useRef(activeFileIndex);

  useEffect(() => {
    setManualRedactColor(MEDICAL_REDACTION_COLOR);
  }, [setManualRedactColor]);

  useEffect(() => {
    if (disabled || isFinalPreview || !manualMode || !isBridgeReady) {
      if (isRedacting) deactivateRedact();
      return;
    }

    if (isAnnotationMode) {
      setAnnotationMode(false);
      try {
        signatureApiRef?.current?.deactivateTools();
      } catch (error) {
        console.log("Unable to deactivate annotation tools:", error);
      }
    }

    if (!isRedacting) {
      const timer = window.setTimeout(() => {
        activateManualRedact();
      }, 50);
      return () => window.clearTimeout(timer);
    }
  }, [
    activateManualRedact,
    deactivateRedact,
    disabled,
    isAnnotationMode,
    isBridgeReady,
    isFinalPreview,
    isRedacting,
    manualMode,
    setAnnotationMode,
    signatureApiRef,
  ]);

  useEffect(() => {
    if (isFinalPreview) setManualMode(false);
  }, [isFinalPreview, setManualMode]);

  useEffect(() => {
    if (prevFileIndexRef.current === activeFileIndex) return;
    prevFileIndexRef.current = activeFileIndex;
    setManualMode(false);
    if (activeType) setActiveType(null);
  }, [activeFileIndex, activeType, setActiveType, setManualMode]);

  return (
    <Stack
      gap="md"
      data-medical-redact-editing-ready={
        manualMode && isRedacting && !isFinalPreview ? "true" : "false"
      }
    >
      <Text size="sm" c="dimmed">
        默认直接点击文字选择或取消脱敏；文字漏识别、定位不准或非文字区域请使用手工补框。
      </Text>

      <Button
        fullWidth
        size="md"
        variant={manualMode ? "primary" : "secondary"}
        disabled={disabled || !isBridgeReady || isFinalPreview}
        aria-pressed={manualMode}
        onClick={() => setManualMode(!manualMode)}
      >
        {manualMode ? "退出手工补框" : "手工补框"}
      </Button>

      {manualMode ? (
        <Text size="xs" c="dimmed">
          当前有 {pendingCount}{" "}
          个手工补框。黑框固定为安全黑色；拖动空白区域新增，选中已有框后可移动、缩放或删除。
        </Text>
      ) : null}

      <Group grow>
        <Button
          variant="secondary"
          disabled={
            disabled ||
            isFinalPreview ||
            !(manualMode
              ? historyAvailability.canUndo || manualHistory.canUndo
              : textHistory.canUndo)
          }
          onClick={
            manualMode
              ? () => {
                  manualHistory.undo();
                  undo();
                }
              : textHistory.undo
          }
        >
          撤销
        </Button>
        <Button
          variant="secondary"
          disabled={
            disabled ||
            isFinalPreview ||
            !(manualMode
              ? historyAvailability.canRedo || manualHistory.canRedo
              : textHistory.canRedo)
          }
          onClick={
            manualMode
              ? () => {
                  manualHistory.redo();
                  redo();
                }
              : textHistory.redo
          }
        >
          重做
        </Button>
      </Group>

      <MedicalRedactPreviewControls disabled={disabled || !isBridgeReady} />
    </Stack>
  );
}
