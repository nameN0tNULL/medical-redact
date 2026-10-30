import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Container,
  Group,
  NumberInput,
  Paper,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useBackendHealth } from "@app/hooks/useBackendHealth";
import {
  cleanupMedicalRedactTemp,
  loadMedicalRedactRuntimeCapabilities,
  type MedicalRedactRuntimeCapabilities,
} from "@app/services/medicalRedactTaskService";
import {
  isMedicalRedactSecurityVerificationEnabled,
  setMedicalRedactSecurityVerificationEnabled,
} from "@app/services/medicalRedactPreferences";
import {
  defaultMedicalRedactDeliveryProfile,
  loadMedicalRedactDeliveryCredentials,
  loadMedicalRedactDeliveryProfile,
  saveMedicalRedactDeliveryCredentials,
  saveMedicalRedactDeliveryProfile,
  testMedicalRedactDeliveryConnection,
  type MedicalRedactDeliveryCredentials,
} from "@app/services/medicalRedactDelivery";
import { Button } from "@app/ui/Button";
import { medicalRedactUserErrorMessage } from "@app/utils/medicalRedactUiLabels";

function SettingsRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "warning";
}) {
  return (
    <Group justify="space-between" align="flex-start" wrap="nowrap">
      <Text size="sm">{label}</Text>
      {tone ? (
        <Badge color={tone === "success" ? "green" : "yellow"} variant="light">
          {value}
        </Badge>
      ) : (
        <Text size="sm" c="dimmed" ta="right">
          {value}
        </Text>
      )}
    </Group>
  );
}

function formatMemory(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "未知";
  const gib = bytes / 1024 / 1024 / 1024;
  return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GB`;
}

function formatMemoryTier(
  tier: MedicalRedactRuntimeCapabilities["workerSchedule"]["memoryTier"],
) {
  if (tier === "LOW") return "低内存";
  if (tier === "CONSTRAINED") return "受限内存";
  if (tier === "STANDARD") return "标准";
  if (tier === "HIGH") return "高内存";
  return "安全默认";
}

export function formatRuntimeCapabilities(
  capabilities: MedicalRedactRuntimeCapabilities,
) {
  const runtimes =
    capabilities.availableRuntimes.length > 0
      ? capabilities.availableRuntimes
          .map((runtime) => {
            if (runtime === "CPU") return "CPU";
            if (runtime === "COREML") return "CoreML（Apple Silicon 加速）";
            if (runtime === "ONNX_CUDA") return "ONNX Runtime（NVIDIA CUDA）";
            if (runtime === "ONNX_CPU") return "ONNX Runtime（CPU）";
            if (runtime === "PADDLE_GPU") return "Paddle（NVIDIA GPU）";
            if (runtime === "PADDLE_CPU") return "Paddle（CPU）";
            return "本机计算运行时";
          })
          .join("、")
      : "未检测到";
  const accelerators =
    capabilities.detectedAccelerators.length > 0
      ? capabilities.detectedAccelerators
          .map((accelerator) => {
            if (accelerator === "APPLE_SILICON") return "Apple Silicon";
            if (accelerator === "NVIDIA") return "NVIDIA GPU";
            return accelerator;
          })
          .join("、")
      : "未检测到";
  return { runtimes, accelerators };
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Paper withBorder p="lg" radius="md">
      <Stack gap="md">
        <Stack gap={2}>
          <Title order={3}>{title}</Title>
          {description ? (
            <Text size="sm" c="dimmed">
              {description}
            </Text>
          ) : null}
        </Stack>
        {children}
      </Stack>
    </Paper>
  );
}

export default function MedicalSettingsPage() {
  const health = useBackendHealth();
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [runtimeCapabilities, setRuntimeCapabilities] =
    useState<MedicalRedactRuntimeCapabilities | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [securityVerificationEnabled, setSecurityVerificationEnabled] =
    useState(isMedicalRedactSecurityVerificationEnabled);
  const [deliveryProfile, setDeliveryProfile] = useState(
    loadMedicalRedactDeliveryProfile,
  );
  const [deliveryCredentials, setDeliveryCredentials] =
    useState<MedicalRedactDeliveryCredentials>({
      password: "",
      privateKey: "",
      privateKeyPassphrase: "",
      archivePassword: "",
    });
  const [deliveryMessage, setDeliveryMessage] = useState<string | null>(null);
  const [deliveryBusy, setDeliveryBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void loadMedicalRedactDeliveryCredentials(deliveryProfile.profileId)
      .then((credentials) => {
        if (active && credentials) {
          setDeliveryCredentials(credentials);
        }
      })
      .catch((error) => {
        if (active) {
          setDeliveryMessage(medicalRedactUserErrorMessage(error));
        }
      });
    return () => {
      active = false;
    };
  }, [deliveryProfile.profileId]);

  useEffect(() => {
    let active = true;
    void loadMedicalRedactRuntimeCapabilities()
      .then((capabilities) => {
        if (!active) return;
        setRuntimeCapabilities(capabilities);
        setRuntimeError(null);
      })
      .catch((error) => {
        if (!active) return;
        setRuntimeCapabilities(null);
        setRuntimeError(medicalRedactUserErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, []);

  const runtimeDisplay = runtimeCapabilities
    ? formatRuntimeCapabilities(runtimeCapabilities)
    : null;
  const runtimePlaceholder = runtimeError ? "暂时无法读取" : "正在检测";

  const saveDeliverySettings = async () => {
    setDeliveryBusy(true);
    setDeliveryMessage(null);
    try {
      saveMedicalRedactDeliveryProfile(deliveryProfile);
      await saveMedicalRedactDeliveryCredentials(
        deliveryProfile.profileId,
        deliveryCredentials,
      );
      setDeliveryMessage("交付服务器配置已安全保存。");
    } catch (error) {
      setDeliveryMessage(medicalRedactUserErrorMessage(error));
    } finally {
      setDeliveryBusy(false);
    }
  };

  const testDeliveryConnection = async () => {
    setDeliveryBusy(true);
    setDeliveryMessage(null);
    try {
      saveMedicalRedactDeliveryProfile(deliveryProfile);
      await saveMedicalRedactDeliveryCredentials(
        deliveryProfile.profileId,
        deliveryCredentials,
      );
      await testMedicalRedactDeliveryConnection(
        deliveryProfile,
        deliveryCredentials,
      );
      setDeliveryMessage("连接成功，可以使用当前服务器进行安全交付。");
    } catch (error) {
      setDeliveryMessage(medicalRedactUserErrorMessage(error));
    } finally {
      setDeliveryBusy(false);
    }
  };

  const changeDeliveryProtocol = (protocol: string | null) => {
    if (protocol !== "SFTP" && protocol !== "FTPS" && protocol !== "FTP") {
      return;
    }
    const typedProtocol = protocol;
    setDeliveryProfile((current) => ({
      ...current,
      protocol: typedProtocol,
      port:
        typedProtocol === "SFTP"
          ? 22
          : typedProtocol === "FTPS" && current.ftpsMode === "IMPLICIT"
            ? 990
            : 21,
      ftpsMode:
        typedProtocol === "FTPS" ? (current.ftpsMode ?? "EXPLICIT") : null,
    }));
  };

  const cleanup = async () => {
    setCleaning(true);
    setCleanupMessage(null);
    try {
      const deleted = await cleanupMedicalRedactTemp();
      setCleanupMessage(
        deleted === 0
          ? "临时目录已经是干净的。"
          : `已清理 ${deleted} 个临时文件。`,
      );
    } catch (error) {
      setCleanupMessage(
        medicalRedactUserErrorMessage(error, "清理临时文件失败，请稍后重试。"),
      );
    } finally {
      setCleaning(false);
    }
  };

  return (
    <Box h="100%" style={{ overflow: "auto" }} data-medical-settings>
      <Container size="md" py="xl">
        <Stack gap="lg">
          <Stack gap={4}>
            <Title order={2}>设置</Title>
            <Text c="dimmed">
              这里仅展示与本地医疗资料脱敏直接相关的运行、安全和存储信息。
            </Text>
          </Stack>

          <SettingsSection title="运行环境">
            <SettingsRow
              label="本地服务"
              value={health.isOnline ? "运行正常" : "尚未就绪"}
              tone={health.isOnline ? "success" : "warning"}
            />
            <SettingsRow
              label="文字识别引擎"
              value="PaddleOCR（本机文字识别）"
            />
            <SettingsRow
              label="文字识别模型"
              value="PP-OCRv6 small（中文文字识别）"
            />
            <SettingsRow
              label="操作系统"
              value={
                runtimeCapabilities
                  ? `${runtimeCapabilities.os} ${runtimeCapabilities.osVersion} · ${runtimeCapabilities.arch}`
                  : runtimePlaceholder
              }
            />
            <SettingsRow
              label="处理器"
              value={runtimeCapabilities?.cpuModel ?? runtimePlaceholder}
            />
            <SettingsRow
              label="处理器核心"
              value={
                runtimeCapabilities
                  ? `${runtimeCapabilities.physicalCores} 个物理核心 / ${runtimeCapabilities.logicalCores} 个逻辑核心`
                  : runtimePlaceholder
              }
            />
            <SettingsRow
              label="内存"
              value={
                runtimeCapabilities
                  ? formatMemory(runtimeCapabilities.totalMemoryBytes)
                  : runtimePlaceholder
              }
            />
            <SettingsRow
              label="Apple Silicon"
              value={
                runtimeCapabilities
                  ? runtimeCapabilities.appleSilicon
                    ? "已检测"
                    : "未检测到"
                  : runtimePlaceholder
              }
            />
            <SettingsRow
              label="NVIDIA GPU"
              value={
                runtimeCapabilities
                  ? runtimeCapabilities.nvidiaGpu
                    ? [
                        runtimeCapabilities.nvidiaGpuName,
                        runtimeCapabilities.nvidiaVramBytes
                          ? formatMemory(runtimeCapabilities.nvidiaVramBytes)
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "未检测到"
                  : runtimePlaceholder
              }
            />
            <SettingsRow
              label="当前可用运行时"
              value={runtimeDisplay?.runtimes ?? runtimePlaceholder}
            />
            <SettingsRow
              label="检测到的加速硬件"
              value={runtimeDisplay?.accelerators ?? runtimePlaceholder}
            />
            <SettingsRow
              label="调度档位"
              value={
                runtimeCapabilities
                  ? formatMemoryTier(
                      runtimeCapabilities.workerSchedule.memoryTier,
                    )
                  : runtimePlaceholder
              }
            />
            <SettingsRow
              label="任务并发"
              value={
                runtimeCapabilities
                  ? `文字识别 ${runtimeCapabilities.workerSchedule.ocrWorkers} / 敏感信息识别 ${runtimeCapabilities.workerSchedule.nerWorkers} / 页面预处理 ${runtimeCapabilities.workerSchedule.preprocessWorkers}`
                  : runtimePlaceholder
              }
            />
            <SettingsRow
              label="页面缓存"
              value={
                runtimeCapabilities
                  ? `${runtimeCapabilities.workerSchedule.renderCachePages} 页`
                  : runtimePlaceholder
              }
            />
            <SettingsRow label="智能识别服务" value="本机运行" />
            {runtimeError ? (
              <Alert color="yellow">
                硬件信息暂时无法读取。核心脱敏仍会使用 CPU 安全运行。
              </Alert>
            ) : null}
          </SettingsSection>

          <SettingsSection title="脱敏设置">
            <SettingsRow label="脱敏颜色" value="黑色（固定，不可修改）" />
            <SettingsRow label="安全边距" value="固定安全边距（不可关闭）" />
            <SettingsRow label="最终预览" value="生成前可预览，不修改原文件" />
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <Stack gap={2}>
                <Text size="sm">安全验证</Text>
                <Text size="xs" c="dimmed">
                  开启后，生成时会执行文字残留、PII、黑框覆盖和 PDF 结构复检。
                </Text>
              </Stack>
              <Switch
                checked={securityVerificationEnabled}
                aria-label="安全验证"
                onChange={(event) => {
                  const enabled = event.currentTarget.checked;
                  setSecurityVerificationEnabled(enabled);
                  setMedicalRedactSecurityVerificationEnabled(enabled);
                }}
              />
            </Group>
          </SettingsSection>

          <SettingsSection
            title="交付服务器"
            description="脱敏结果只会在你明确点击“打包并上传”时发送到这里。密码、私钥和加密包口令仅保存在系统安全凭证存储中。"
          >
            <Select
              label="协议"
              data={[
                { value: "SFTP", label: "SFTP（推荐）" },
                { value: "FTPS", label: "FTPS" },
                { value: "FTP", label: "FTP" },
              ]}
              value={deliveryProfile.protocol}
              onChange={changeDeliveryProtocol}
            />
            <Group grow align="flex-start">
              <TextInput
                label="服务器地址 (Host)"
                value={deliveryProfile.host}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDeliveryProfile((current) => ({
                    ...current,
                    host: value,
                  }));
                }}
              />
              <NumberInput
                label="端口 (Port)"
                min={1}
                max={65535}
                value={deliveryProfile.port}
                onChange={(value) =>
                  setDeliveryProfile((current) => ({
                    ...current,
                    port: typeof value === "number" ? value : current.port,
                  }))
                }
              />
            </Group>
            <TextInput
              label="用户名 (Username)"
              value={deliveryProfile.username}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDeliveryProfile((current) => ({
                  ...current,
                  username: value,
                }));
              }}
            />
            <PasswordInput
              label="密码"
              value={deliveryCredentials.password ?? ""}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDeliveryCredentials((current) => ({
                  ...current,
                  password: value,
                }));
              }}
            />
            <TextInput
              label="远程目录"
              value={deliveryProfile.remoteDirectory}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDeliveryProfile((current) => ({
                  ...current,
                  remoteDirectory: value,
                }));
              }}
            />

            {deliveryProfile.protocol === "SFTP" ? (
              <>
                <TextInput
                  label="SFTP 主机密钥指纹"
                  description="必须填写服务器 SHA256 主机密钥指纹，不会静默关闭校验。"
                  placeholder="SHA256:..."
                  value={deliveryProfile.sftpHostKeyFingerprint ?? ""}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDeliveryProfile((current) => ({
                      ...current,
                      sftpHostKeyFingerprint: value,
                    }));
                  }}
                />
                <Textarea
                  label="SFTP 私钥（可选）"
                  minRows={4}
                  autosize
                  value={deliveryCredentials.privateKey ?? ""}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDeliveryCredentials((current) => ({
                      ...current,
                      privateKey: value,
                    }));
                  }}
                />
                <PasswordInput
                  label="SFTP 私钥口令（可选）"
                  value={deliveryCredentials.privateKeyPassphrase ?? ""}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDeliveryCredentials((current) => ({
                      ...current,
                      privateKeyPassphrase: value,
                    }));
                  }}
                />
              </>
            ) : null}

            {deliveryProfile.protocol === "FTPS" ? (
              <Select
                label="FTPS 模式"
                data={[
                  { value: "EXPLICIT", label: "Explicit（AUTH TLS）" },
                  { value: "IMPLICIT", label: "Implicit TLS" },
                ]}
                value={deliveryProfile.ftpsMode ?? "EXPLICIT"}
                onChange={(value) => {
                  if (value !== "EXPLICIT" && value !== "IMPLICIT") return;
                  setDeliveryProfile((current) => ({
                    ...current,
                    ftpsMode: value,
                    port: value === "IMPLICIT" ? 990 : 21,
                  }));
                }}
              />
            ) : null}

            {deliveryProfile.protocol === "FTP" ||
            deliveryProfile.protocol === "FTPS" ? (
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Stack gap={2}>
                  <Text size="sm">FTP 被动模式</Text>
                  <Text size="xs" c="dimmed">
                    默认开启，更适合经过 NAT 或防火墙的网络环境。
                  </Text>
                </Stack>
                <Switch
                  aria-label="FTP 被动模式"
                  checked={deliveryProfile.ftpPassiveMode}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setDeliveryProfile((current) => ({
                      ...current,
                      ftpPassiveMode: checked,
                    }));
                  }}
                />
              </Group>
            ) : null}

            {deliveryProfile.protocol === "FTP" ? (
              <Alert color="yellow" title="FTP 传输链路不加密">
                FTP 本身不会加密网络传输。系统仍会先生成 AES-256
                加密交付包，但建议优先使用 SFTP 或 FTPS。
              </Alert>
            ) : null}

            <PasswordInput
              label="交付包加密口令"
              description="至少 12 个字符，仅保存在系统安全凭证存储中，不写入 manifest。"
              value={deliveryCredentials.archivePassword ?? ""}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDeliveryCredentials((current) => ({
                  ...current,
                  archivePassword: value,
                }));
              }}
            />

            {deliveryMessage ? <Alert>{deliveryMessage}</Alert> : null}
            <Group>
              <Button
                variant="secondary"
                loading={deliveryBusy}
                onClick={() => void saveDeliverySettings()}
              >
                保存配置
              </Button>
              <Button
                loading={deliveryBusy}
                onClick={() => void testDeliveryConnection()}
              >
                测试连接
              </Button>
              <Button
                variant="quiet"
                disabled={deliveryBusy}
                onClick={() => {
                  const reset = defaultMedicalRedactDeliveryProfile();
                  setDeliveryProfile(reset);
                  setDeliveryCredentials({
                    password: "",
                    privateKey: "",
                    privateKeyPassphrase: "",
                    archivePassword: "",
                  });
                  setDeliveryMessage(null);
                }}
              >
                重置表单
              </Button>
            </Group>
          </SettingsSection>

          <SettingsSection title="隐私保护">
            <SettingsRow label="本地处理" value="已启用" tone="success" />
            <SettingsRow label="云端大模型" value="未启用" />
            <Text size="xs" c="dimmed">
              当前脱敏处理均在本机完成，不会将医疗资料发送到云端大模型服务。
            </Text>
          </SettingsSection>

          <SettingsSection title="存储与维护">
            <SettingsRow label="本地数据目录" value="本机应用数据目录" />
            <SettingsRow label="当前占用空间" value="暂未统计" />
            {cleanupMessage ? <Alert>{cleanupMessage}</Alert> : null}
            <Group>
              <Button
                variant="secondary"
                loading={cleaning}
                onClick={() => void cleanup()}
              >
                清理临时文件
              </Button>
            </Group>
          </SettingsSection>

          <SettingsSection title="关于">
            <SettingsRow label="应用名称" value="中文医疗资料自动脱敏" />
            <SettingsRow label="应用版本" value="3.2.1" />
            <SettingsRow label="识别引擎版本" value="PaddleOCR · PP-OCRv6" />
            <SettingsRow label="构建版本" value="3.2.1" />
          </SettingsSection>
        </Stack>
      </Container>
    </Box>
  );
}
