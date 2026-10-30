import { useEffect } from "react";
import { Badge, Box, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "react-router-dom";
import MedicalReviewPanel from "@app/components/medical/MedicalReviewPanel";
import Viewer from "@app/components/viewer/Viewer";
import { useAllFiles } from "@app/contexts/FileContext";
import { useMedicalRedactReview } from "@app/contexts/MedicalRedactReviewContext";
import { useNavigationActions } from "@app/contexts/NavigationContext";
import { useViewer } from "@app/contexts/ViewerContext";
import { Button } from "@app/ui/Button";
import {
  medicalRedactTextSourceLabel,
  medicalRedactVerificationStatusLabel,
} from "@app/utils/medicalRedactUiLabels";

function documentState(
  isActive: boolean,
  verification: "PASS" | "BLOCKED" | "SKIPPED" | null,
) {
  if (verification === "PASS") return "已验证";
  if (verification === "SKIPPED") return "已生成";
  if (verification === "BLOCKED") return "需处理";
  return isActive ? "审核中" : "待审核";
}

export default function MedicalReviewWorkspace() {
  const navigate = useNavigate();
  const { files } = useAllFiles();
  const { actions: navigationActions } = useNavigationActions();
  const {
    activeFileIndex,
    setActiveFileIndex,
    isThumbnailSidebarVisible,
    toggleThumbnailSidebar,
  } = useViewer();
  const { batch, getDocument, getVerificationReport } =
    useMedicalRedactReview();

  useEffect(() => {
    navigationActions.setWorkbench("viewer");
  }, [navigationActions]);

  useEffect(() => {
    if (files.length > 0 && activeFileIndex < 0) {
      setActiveFileIndex(0);
    }
  }, [activeFileIndex, files.length, setActiveFileIndex]);

  const previousEnabled = activeFileIndex > 0;
  const nextEnabled =
    activeFileIndex >= 0 && activeFileIndex < files.length - 1;

  return (
    <Box
      h="100%"
      data-medical-review-workspace
      style={{
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        minHeight: 0,
        background: "var(--c-bg)",
      }}
    >
      <Paper radius={0} withBorder px="md" py="xs">
        <Group justify="space-between" wrap="nowrap">
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="xs" c="dimmed">
              当前脱敏任务
            </Text>
            <Text fw={700} truncate>
              {batch?.name ?? "医疗资料脱敏"}
            </Text>
          </Stack>
          <Group gap="xs" wrap="nowrap">
            <Button
              variant={isThumbnailSidebarVisible ? "secondary" : "quiet"}
              aria-pressed={isThumbnailSidebarVisible}
              onClick={toggleThumbnailSidebar}
            >
              页面缩略图
            </Button>
            <Button variant="quiet" onClick={() => navigate("/tasks")}>
              返回任务中心
            </Button>
          </Group>
        </Group>
      </Paper>

      <Box
        style={{
          display: "grid",
          gridTemplateColumns: "16rem minmax(0, 1fr) 21rem",
          minHeight: 0,
        }}
      >
        <Paper
          radius={0}
          withBorder
          p="md"
          style={{ overflow: "auto", minHeight: 0 }}
          data-medical-document-list
        >
          <Stack gap="md">
            <Stack gap={4}>
              <Text size="xs" c="dimmed">
                当前任务
              </Text>
              <Title order={4}>任务文件</Title>
            </Stack>

            {files.length === 0 ? (
              <Stack gap="sm">
                <Text size="sm" c="dimmed">
                  当前没有已加载的任务文件，请从任务中心继续审核。
                </Text>
                <Button variant="secondary" onClick={() => navigate("/tasks")}>
                  返回任务中心
                </Button>
              </Stack>
            ) : (
              <>
                <Stack gap="xs">
                  {files.map((file, index) => {
                    const document =
                      getDocument(file.fileId) ?? getDocument(file.name);
                    const verification = getVerificationReport(file.fileId);
                    const source = medicalRedactTextSourceLabel(
                      document?.pages.some(
                        (page) => page.sourceKind === "IMAGE",
                      )
                        ? "PADDLE_OCR"
                        : "PDF_TEXT",
                    );
                    const state = documentState(
                      activeFileIndex === index,
                      verification?.status ?? null,
                    );
                    return (
                      <Button
                        key={file.fileId}
                        variant={
                          activeFileIndex === index ? "secondary" : "quiet"
                        }
                        onClick={() => setActiveFileIndex(index)}
                        aria-label={`打开任务文件 ${file.name}`}
                        style={{ justifyContent: "flex-start", height: "auto" }}
                      >
                        <Stack
                          gap={2}
                          align="flex-start"
                          style={{ minWidth: 0 }}
                        >
                          <Text size="sm" fw={600} truncate>
                            {document?.originalFilename ?? file.name}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {document?.pageCount ?? "—"} 页 · {source} · {state}
                          </Text>
                          {verification?.status === "BLOCKED" ? (
                            <Badge size="xs" variant="light" color="red">
                              {medicalRedactVerificationStatusLabel(
                                verification.status,
                              )}
                            </Badge>
                          ) : null}
                        </Stack>
                      </Button>
                    );
                  })}
                </Stack>

                <Group grow>
                  <Button
                    variant="secondary"
                    disabled={!previousEnabled}
                    onClick={() => setActiveFileIndex(activeFileIndex - 1)}
                  >
                    上一文件
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!nextEnabled}
                    onClick={() => setActiveFileIndex(activeFileIndex + 1)}
                  >
                    下一文件
                  </Button>
                </Group>
              </>
            )}
          </Stack>
        </Paper>

        <Box
          data-medical-viewer-host
          style={{ minWidth: 0, minHeight: 0, overflow: "hidden" }}
          onContextMenuCapture={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {files.length > 0 ? (
            <Viewer />
          ) : (
            <Group h="100%" justify="center" align="center">
              <Text c="dimmed">请先从任务中心加载需要审核的文件。</Text>
            </Group>
          )}
        </Box>

        <Paper
          radius={0}
          withBorder
          p={0}
          style={{ overflow: "auto", minHeight: 0 }}
        >
          <MedicalReviewPanel />
        </Paper>
      </Box>
    </Box>
  );
}
