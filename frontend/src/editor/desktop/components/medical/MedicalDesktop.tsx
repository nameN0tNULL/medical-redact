import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import i18n from "@app/i18n";
import {
  Alert,
  Badge,
  Box,
  Container,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import FileManager from "@app/components/FileManager";
import MedicalReviewWorkspace from "@app/components/medical/MedicalReviewWorkspace";
import MedicalSettingsPage from "@app/components/medical/MedicalSettingsPage";
import { useFileManagement } from "@app/contexts/FileContext";
import { FilesPageProvider } from "@app/contexts/FilesPageContext";
import { useFilesModalContext } from "@app/contexts/FilesModalContext";
import { useToolWorkflowActions } from "@app/contexts/ToolWorkflowContext";
import {
  MedicalRedactReviewProvider,
  useMedicalRedactReview,
} from "@app/contexts/MedicalRedactReviewContext";
import { useBackendHealth } from "@app/hooks/useBackendHealth";
import { useFileHandler } from "@app/hooks/useFileHandler";
import {
  createMedicalRedactBatch,
  importMedicalRedactDocuments,
  listMedicalRedactBatches,
  loadMedicalRedactBatchFiles,
  type MedicalRedactBatch,
} from "@app/services/medicalRedactTaskService";
import {
  deliverMedicalRedactBatch,
  deliveryStatusLabel,
  loadMedicalRedactDeliveryCredentials,
  loadMedicalRedactDeliveryProfile,
  loadMedicalRedactDeliveryRecord,
  type MedicalRedactDeliveryRecord,
} from "@app/services/medicalRedactDelivery";
import { Button } from "@app/ui/Button";
import { medicalRedactUserErrorMessage } from "@app/utils/medicalRedactUiLabels";

const APP_TITLE = "中文医疗资料自动脱敏";
const IMPORT_FORMATS = ["pdf", "png", "jpg", "jpeg", "tif", "tiff", "bmp"];

function defaultTaskName() {
  const now = new Date();
  const date = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const time = now.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `脱敏任务 ${date} ${time}`;
}

function toErrorMessage(error: unknown) {
  return medicalRedactUserErrorMessage(error, "操作失败，请稍后重试。");
}

function batchBusinessState(batch: MedicalRedactBatch) {
  const reports = batch.verificationReports;
  if (
    batch.status === "BLOCKED" ||
    batch.status === "ERROR" ||
    reports.some((report) => report.status === "BLOCKED")
  ) {
    return { label: "需处理", color: "red" as const };
  }

  const generatedReports = reports.filter(
    (report) => report.status === "PASS" || report.status === "SKIPPED",
  );
  const generatedDocuments = new Set(
    generatedReports.map((report) => report.documentId),
  );
  if (
    batch.documents.length > 0 &&
    batch.documents.every((document) => generatedDocuments.has(document.id))
  ) {
    const verificationSkipped = generatedReports.some(
      (report) => report.status === "SKIPPED",
    );
    return verificationSkipped
      ? { label: "已生成", color: "yellow" as const }
      : { label: "已完成", color: "green" as const };
  }

  if (
    [
      "IN_REVIEW",
      "READY_TO_REDACT",
      "REDACTING",
      "VERIFYING",
      "VERIFIED",
    ].includes(batch.status)
  ) {
    return { label: "审核中", color: "blue" as const };
  }

  return { label: "待审核", color: "gray" as const };
}

function TasksPage({
  batches,
  loading,
  busyBatchId,
  deliveryBusyBatchId,
  deliveryRecords,
  error,
  onNewTask,
  onResume,
  onDeliver,
}: {
  batches: MedicalRedactBatch[];
  loading: boolean;
  busyBatchId: string | null;
  deliveryBusyBatchId: string | null;
  deliveryRecords: Record<string, MedicalRedactDeliveryRecord>;
  error: string | null;
  onNewTask: () => void;
  onResume: (batch: MedicalRedactBatch) => void;
  onDeliver: (batch: MedicalRedactBatch) => void;
}) {
  const recentBatches = [...batches].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );

  return (
    <Box h="100%" style={{ overflow: "auto" }} data-medical-task-center>
      <Container size="lg" py="xl">
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start">
            <Stack gap={4}>
              <Title order={2}>任务中心</Title>
              <Text c="dimmed">
                最近任务保存在本机。继续审核时只加载该任务中的医疗资料。
              </Text>
            </Stack>
            <Button onClick={onNewTask}>新建脱敏任务</Button>
          </Group>

          {error ? <Alert title="本地任务操作失败">{error}</Alert> : null}

          {loading ? (
            <Text c="dimmed">正在读取本地任务…</Text>
          ) : recentBatches.length === 0 ? (
            <Paper withBorder p="xl" radius="md">
              <Stack gap="md" align="flex-start">
                <Text fw={700}>还没有脱敏任务</Text>
                <Text c="dimmed">
                  创建任务后，PDF
                  文档或图片会复制到本地受控工作区，不覆盖原文件。
                </Text>
                <Button onClick={onNewTask}>创建第一个任务</Button>
              </Stack>
            </Paper>
          ) : (
            <Stack gap="sm" aria-label="最近任务">
              {recentBatches.map((batch) => {
                const totalPages = batch.documents.reduce(
                  (sum, document) => sum + document.pageCount,
                  0,
                );
                const state = batchBusinessState(batch);
                const generatedReports = batch.verificationReports.filter(
                  (report) =>
                    report.status === "PASS" || report.status === "SKIPPED",
                );
                const outputNames = generatedReports
                  .map((report) => report.outputFilename)
                  .filter((name): name is string => Boolean(name));
                const generatedDocuments = new Set(
                  generatedReports.map((report) => report.documentId),
                );
                const completed =
                  state.label === "已完成" || state.label === "已生成";
                const deliverable =
                  batch.documents.length > 0 &&
                  batch.documents.every((document) =>
                    generatedDocuments.has(document.id),
                  );
                const delivery = deliveryRecords[batch.id];
                const deliveryStatus = delivery?.status ?? "NOT_DELIVERED";

                return (
                  <Paper key={batch.id} withBorder p="lg" radius="md">
                    <Group justify="space-between" align="center" wrap="nowrap">
                      <Stack gap={6} style={{ minWidth: 0 }}>
                        <Group gap="sm">
                          <Text fw={700} truncate>
                            {batch.name}
                          </Text>
                          <Badge variant="light" color={state.color}>
                            {state.label}
                          </Badge>
                        </Group>
                        <Text size="sm" c="dimmed">
                          {new Date(batch.createdAt).toLocaleString("zh-CN")} ·{" "}
                          {batch.documentCount} 个文件 · {totalPages} 页
                        </Text>
                        {generatedReports.length > 0 ? (
                          <Text size="xs" c="dimmed">
                            已生成：{generatedReports.length}/
                            {batch.documentCount}
                            {outputNames.length > 0
                              ? ` · 输出：${outputNames.join("、")}`
                              : ""}
                          </Text>
                        ) : null}
                        {deliverable ? (
                          <Group gap="xs">
                            <Badge
                              variant="light"
                              color={
                                deliveryStatus === "UPLOADED"
                                  ? "green"
                                  : deliveryStatus === "UPLOAD_FAILED"
                                    ? "red"
                                    : deliveryStatus === "UPLOADING"
                                      ? "blue"
                                      : "gray"
                              }
                            >
                              交付：{deliveryStatusLabel(deliveryStatus)}
                            </Badge>
                            {delivery?.remotePath ? (
                              <Text size="xs" c="dimmed">
                                远端：{delivery.remotePath}
                              </Text>
                            ) : null}
                          </Group>
                        ) : null}
                      </Stack>
                      <Group gap="xs" wrap="nowrap">
                        {deliverable ? (
                          <Button
                            disabled={
                              deliveryBusyBatchId !== null ||
                              busyBatchId !== null
                            }
                            onClick={() => onDeliver(batch)}
                          >
                            {deliveryBusyBatchId === batch.id
                              ? "正在交付…"
                              : deliveryStatus === "UPLOAD_FAILED"
                                ? "重试上传"
                                : deliveryStatus === "UPLOADED"
                                  ? "重新上传"
                                  : "打包并上传"}
                          </Button>
                        ) : null}
                        <Button
                          variant="secondary"
                          disabled={
                            batch.documents.length === 0 ||
                            busyBatchId !== null ||
                            deliveryBusyBatchId !== null
                          }
                          onClick={() => onResume(batch)}
                        >
                          {busyBatchId === batch.id
                            ? "正在恢复…"
                            : completed
                              ? "查看结果"
                              : "继续审核"}
                        </Button>
                      </Group>
                    </Group>
                  </Paper>
                );
              })}
            </Stack>
          )}
        </Stack>
      </Container>
    </Box>
  );
}

function MedicalDesktopContent() {
  const location = useLocation();
  const navigate = useNavigate();
  const { openFilesModal } = useFilesModalContext();
  const { addFiles } = useFileHandler();
  const { clearAllFiles } = useFileManagement();
  const { handleToolSelectForced } = useToolWorkflowActions();
  const backendHealth = useBackendHealth();
  const { batch: activeBatch, startSession } = useMedicalRedactReview();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [taskName, setTaskName] = useState(defaultTaskName);
  const [batches, setBatches] = useState<MedicalRedactBatch[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [busyBatchId, setBusyBatchId] = useState<string | null>(null);
  const [deliveryBusyBatchId, setDeliveryBusyBatchId] = useState<string | null>(
    null,
  );
  const [deliveryRecords, setDeliveryRecords] = useState<
    Record<string, MedicalRedactDeliveryRecord>
  >({});
  const [taskError, setTaskError] = useState<string | null>(null);
  const lastOwnedRouteRef = useRef("/");

  useEffect(() => {
    const enforceMedicalChinese = (language: string) => {
      if (language !== "zh-CN") {
        void i18n.changeLanguage("zh-CN");
      }
    };

    document.title = APP_TITLE;
    void i18n.changeLanguage("zh-CN");
    i18n.on("languageChanged", enforceMedicalChinese);
    return () => {
      i18n.off("languageChanged", enforceMedicalChinese);
    };
  }, []);

  const refreshBatches = useCallback(async () => {
    try {
      const nextBatches = await listMedicalRedactBatches();
      setBatches(nextBatches);
      const records = await Promise.all(
        nextBatches.map(async (batch) => {
          try {
            return [
              batch.id,
              await loadMedicalRedactDeliveryRecord(batch.id),
            ] as const;
          } catch {
            return null;
          }
        }),
      );
      setDeliveryRecords(
        Object.fromEntries(
          records.filter(
            (item): item is readonly [string, MedicalRedactDeliveryRecord] =>
              item !== null,
          ),
        ),
      );
      return null;
    } catch (error) {
      return toErrorMessage(error);
    }
  }, []);

  useEffect(() => {
    const onTaskRoute =
      location.pathname === "/" || location.pathname === "/tasks";
    if (!onTaskRoute) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const maxAttempts = 12;

    setTasksLoading(true);
    setTaskError(null);

    const attemptRefresh = async (attempt: number) => {
      const error = await refreshBatches();
      if (cancelled) return;
      if (!error) {
        setTasksLoading(false);
        setTaskError(null);
        return;
      }

      if (attempt >= maxAttempts - 1) {
        setTasksLoading(false);
        setTaskError(error);
        return;
      }

      const delay = Math.min(500 * 2 ** Math.min(attempt, 3), 4000);
      retryTimer = setTimeout(() => {
        void attemptRefresh(attempt + 1);
      }, delay);
    };

    void attemptRefresh(0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [backendHealth.isOnline, location.pathname, refreshBatches]);

  useEffect(() => {
    if (location.pathname === "/redact" && !activeBatch) {
      navigate("/tasks", { replace: true });
    }
  }, [activeBatch, location.pathname, navigate]);

  const enterReviewWithFiles = useCallback(
    async (batch: MedicalRedactBatch, files: File[]) => {
      await clearAllFiles();
      const addedFiles = await addFiles(files);
      startSession(batch, addedFiles);
      handleToolSelectForced("redact");
      navigate("/redact");
    },
    [addFiles, clearAllFiles, handleToolSelectForced, navigate, startSession],
  );

  const openNewTask = useCallback(() => {
    setTaskError(null);
    setTaskName(defaultTaskName());
    setNewTaskOpen(true);
  }, []);

  const chooseNewTaskFiles = useCallback(() => {
    const name = taskName.trim();
    setNewTaskOpen(false);
    openFilesModal({
      supportedFormats: IMPORT_FORMATS,
      customHandler: async (files: File[]) => {
        if (files.length === 0) return;
        try {
          const created = await createMedicalRedactBatch(name);
          const imported = await importMedicalRedactDocuments(
            created.id,
            files,
          );
          setBatches((current) => [
            imported,
            ...current.filter((item) => item.id !== imported.id),
          ]);
          const reviewFiles = await loadMedicalRedactBatchFiles(imported);
          await enterReviewWithFiles(imported, reviewFiles);
        } catch (error) {
          setTaskError(toErrorMessage(error));
          navigate("/tasks");
        }
      },
    });
  }, [enterReviewWithFiles, navigate, openFilesModal, taskName]);

  const deliverBatch = useCallback(async (batch: MedicalRedactBatch) => {
    setDeliveryBusyBatchId(batch.id);
    setTaskError(null);
    try {
      const profile = loadMedicalRedactDeliveryProfile();
      const credentials = await loadMedicalRedactDeliveryCredentials(
        profile.profileId,
      );
      if (!credentials) {
        setTaskError(medicalRedactUserErrorMessage("MR-DELIVERY-8502"));
        return;
      }
      const record = await deliverMedicalRedactBatch(
        batch.id,
        profile,
        credentials,
      );
      setDeliveryRecords((current) => ({
        ...current,
        [batch.id]: record,
      }));
    } catch (error) {
      setTaskError(toErrorMessage(error));
      try {
        const record = await loadMedicalRedactDeliveryRecord(batch.id);
        setDeliveryRecords((current) => ({
          ...current,
          [batch.id]: record,
        }));
      } catch {
        // Keep the last known delivery state when the backend is unavailable.
      }
    } finally {
      setDeliveryBusyBatchId(null);
    }
  }, []);

  const resumeBatch = useCallback(
    async (batch: MedicalRedactBatch) => {
      setBusyBatchId(batch.id);
      setTaskError(null);
      try {
        const files = await loadMedicalRedactBatchFiles(batch);
        await enterReviewWithFiles(batch, files);
      } catch (error) {
        setTaskError(toErrorMessage(error));
      } finally {
        setBusyBatchId(null);
      }
    },
    [enterReviewWithFiles],
  );

  const route = location.pathname;
  const routeIsOwned =
    route === "/" ||
    route === "/tasks" ||
    route === "/redact" ||
    route.startsWith("/settings");

  useEffect(() => {
    if (routeIsOwned) {
      lastOwnedRouteRef.current = route;
    }
  }, [route, routeIsOwned]);

  const fallbackRoute =
    activeBatch && lastOwnedRouteRef.current === "/redact"
      ? "/redact"
      : "/tasks";
  const medicalOwnsFileManager =
    route === "/" || route === "/tasks" || route.startsWith("/settings");
  const modalCanContinue = useMemo(
    () => taskName.trim().length > 0 && taskName.trim().length <= 120,
    [taskName],
  );

  return (
    <Box h="100%" style={{ display: "flex", flexDirection: "column" }}>
      {medicalOwnsFileManager ? (
        <FilesPageProvider>
          <FileManager />
        </FilesPageProvider>
      ) : null}

      <Modal
        opened={newTaskOpen}
        onClose={() => setNewTaskOpen(false)}
        title="新建脱敏任务"
        centered
      >
        <Stack gap="md">
          <TextInput
            label="任务名称"
            value={taskName}
            maxLength={120}
            onChange={(event) => setTaskName(event.currentTarget.value)}
            placeholder="例如：10 月住院病历脱敏"
          />
          <Text size="sm" c="dimmed">
            下一步选择 PDF
            文档或图片。源文件将复制到本地受控工作区，原文件不会被修改。
          </Text>
          <Group justify="flex-end">
            <Button variant="quiet" onClick={() => setNewTaskOpen(false)}>
              取消
            </Button>
            <Button disabled={!modalCanContinue} onClick={chooseNewTaskFiles}>
              选择文件
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Paper withBorder radius={0} px="md" py="xs">
        <Group justify="space-between" wrap="nowrap" gap="md">
          <Button
            variant="quiet"
            onClick={() => navigate("/tasks")}
            aria-label="返回医疗任务中心"
          >
            <Text fw={700}>{APP_TITLE}</Text>
          </Button>
          <Group gap="xs" wrap="nowrap">
            <Button variant="primary" onClick={openNewTask}>
              新建任务
            </Button>
            <Button
              variant={route.startsWith("/settings") ? "secondary" : "quiet"}
              onClick={() => navigate("/settings")}
            >
              设置
            </Button>
          </Group>
        </Group>
      </Paper>

      <Box style={{ flex: 1, minHeight: 0 }}>
        {route === "/" || route === "/tasks" ? (
          <TasksPage
            batches={batches}
            loading={tasksLoading}
            busyBatchId={busyBatchId}
            deliveryBusyBatchId={deliveryBusyBatchId}
            deliveryRecords={deliveryRecords}
            error={taskError}
            onNewTask={openNewTask}
            onResume={(batch) => void resumeBatch(batch)}
            onDeliver={(batch) => void deliverBatch(batch)}
          />
        ) : route === "/redact" ? (
          <MedicalReviewWorkspace />
        ) : route.startsWith("/settings") ? (
          <MedicalSettingsPage />
        ) : (
          <Navigate to={fallbackRoute} replace />
        )}
      </Box>
    </Box>
  );
}

export default function MedicalDesktop() {
  return (
    <MedicalRedactReviewProvider>
      <MedicalDesktopContent />
    </MedicalRedactReviewProvider>
  );
}
