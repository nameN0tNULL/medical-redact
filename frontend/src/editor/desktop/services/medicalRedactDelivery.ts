import { invoke, isTauri } from "@tauri-apps/api/core";
import apiClient from "@app/services/apiClient";

export type MedicalRedactDeliveryProtocol = "SFTP" | "FTPS" | "FTP";
export type MedicalRedactFtpsMode = "EXPLICIT" | "IMPLICIT";
export type MedicalRedactDeliveryStatus =
  | "NOT_DELIVERED"
  | "PACKAGED"
  | "UPLOADING"
  | "UPLOAD_FAILED"
  | "UPLOADED";

export interface MedicalRedactDeliveryProfile {
  profileId: string;
  protocol: MedicalRedactDeliveryProtocol;
  host: string;
  port: number;
  username: string;
  remoteDirectory: string;
  credentialRef: string;
  sftpHostKeyFingerprint: string | null;
  ftpPassiveMode: boolean;
  ftpsMode: MedicalRedactFtpsMode | null;
}

export interface MedicalRedactDeliveryCredentials {
  password: string | null;
  privateKey: string | null;
  privateKeyPassphrase: string | null;
  archivePassword: string | null;
}

export interface MedicalRedactDeliveryRecord {
  batchId: string;
  status: MedicalRedactDeliveryStatus;
  packageId: string | null;
  profileId: string | null;
  archiveFilename: string | null;
  archiveRelativePath: string | null;
  packageSha256: string | null;
  archiveSha256: string | null;
  encryptionAlgorithm: string | null;
  documentCount: number;
  remotePath: string | null;
  createdAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
}

const PROFILE_STORAGE_KEY = "medical-redact-delivery-profile-v1";
const DEFAULT_PROFILE_ID = "default";
const API_ROOT = "/api/v1/medical-redact";

let browserSessionCredentials: MedicalRedactDeliveryCredentials | null = null;

export function defaultMedicalRedactDeliveryProfile(): MedicalRedactDeliveryProfile {
  return {
    profileId: DEFAULT_PROFILE_ID,
    protocol: "SFTP",
    host: "",
    port: 22,
    username: "",
    remoteDirectory: ".",
    credentialRef: DEFAULT_PROFILE_ID,
    sftpHostKeyFingerprint: "",
    ftpPassiveMode: true,
    ftpsMode: "EXPLICIT",
  };
}

export function loadMedicalRedactDeliveryProfile(): MedicalRedactDeliveryProfile {
  try {
    const value = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!value) return defaultMedicalRedactDeliveryProfile();
    const parsed = JSON.parse(value) as Partial<MedicalRedactDeliveryProfile>;
    const fallback = defaultMedicalRedactDeliveryProfile();
    const protocol =
      parsed.protocol === "FTP" ||
      parsed.protocol === "FTPS" ||
      parsed.protocol === "SFTP"
        ? parsed.protocol
        : fallback.protocol;
    const profileId =
      typeof parsed.profileId === "string" && parsed.profileId
        ? parsed.profileId
        : DEFAULT_PROFILE_ID;
    return {
      profileId,
      protocol,
      host: typeof parsed.host === "string" ? parsed.host : "",
      port:
        typeof parsed.port === "number" && Number.isInteger(parsed.port)
          ? parsed.port
          : protocol === "SFTP"
            ? 22
            : protocol === "FTPS" && parsed.ftpsMode === "IMPLICIT"
              ? 990
              : 21,
      username: typeof parsed.username === "string" ? parsed.username : "",
      remoteDirectory:
        typeof parsed.remoteDirectory === "string"
          ? parsed.remoteDirectory
          : ".",
      credentialRef: profileId,
      sftpHostKeyFingerprint:
        typeof parsed.sftpHostKeyFingerprint === "string"
          ? parsed.sftpHostKeyFingerprint
          : "",
      ftpPassiveMode:
        typeof parsed.ftpPassiveMode === "boolean"
          ? parsed.ftpPassiveMode
          : true,
      ftpsMode:
        parsed.ftpsMode === "IMPLICIT" || parsed.ftpsMode === "EXPLICIT"
          ? parsed.ftpsMode
          : "EXPLICIT",
    };
  } catch {
    return defaultMedicalRedactDeliveryProfile();
  }
}

export function saveMedicalRedactDeliveryProfile(
  profile: MedicalRedactDeliveryProfile,
): void {
  const nonSensitive: MedicalRedactDeliveryProfile = {
    ...profile,
    credentialRef: profile.profileId,
  };
  window.localStorage.setItem(
    PROFILE_STORAGE_KEY,
    JSON.stringify(nonSensitive),
  );
}

export async function saveMedicalRedactDeliveryCredentials(
  profileId: string,
  credentials: MedicalRedactDeliveryCredentials,
): Promise<void> {
  if (!isTauri()) {
    browserSessionCredentials = { ...credentials };
    return;
  }
  await invoke<void>("save_medical_delivery_credentials", {
    profileId,
    credentials,
  });
}

export async function loadMedicalRedactDeliveryCredentials(
  profileId: string,
): Promise<MedicalRedactDeliveryCredentials | null> {
  if (!isTauri()) {
    return browserSessionCredentials ? { ...browserSessionCredentials } : null;
  }
  return await invoke<MedicalRedactDeliveryCredentials | null>(
    "get_medical_delivery_credentials",
    { profileId },
  );
}

export async function clearMedicalRedactDeliveryCredentials(
  profileId: string,
): Promise<void> {
  if (!isTauri()) {
    browserSessionCredentials = null;
    return;
  }
  await invoke<void>("clear_medical_delivery_credentials", { profileId });
}

function requestBody(
  profile: MedicalRedactDeliveryProfile,
  credentials: MedicalRedactDeliveryCredentials,
) {
  return {
    profile: {
      ...profile,
      credentialRef: profile.profileId,
      sftpHostKeyFingerprint:
        profile.protocol === "SFTP"
          ? profile.sftpHostKeyFingerprint || null
          : null,
      ftpsMode: profile.protocol === "FTPS" ? profile.ftpsMode : null,
    },
    credentials,
  };
}

export async function testMedicalRedactDeliveryConnection(
  profile: MedicalRedactDeliveryProfile,
  credentials: MedicalRedactDeliveryCredentials,
): Promise<void> {
  await apiClient.post(
    `${API_ROOT}/delivery/test-connection`,
    requestBody(profile, credentials),
    { suppressErrorToast: true },
  );
}

export async function loadMedicalRedactDeliveryRecord(
  batchId: string,
): Promise<MedicalRedactDeliveryRecord> {
  const { data } = await apiClient.get<MedicalRedactDeliveryRecord>(
    `${API_ROOT}/batches/${encodeURIComponent(batchId)}/delivery`,
  );
  return data;
}

export async function deliverMedicalRedactBatch(
  batchId: string,
  profile: MedicalRedactDeliveryProfile,
  credentials: MedicalRedactDeliveryCredentials,
): Promise<MedicalRedactDeliveryRecord> {
  const { data } = await apiClient.post<MedicalRedactDeliveryRecord>(
    `${API_ROOT}/batches/${encodeURIComponent(batchId)}/delivery`,
    requestBody(profile, credentials),
    { suppressErrorToast: true },
  );
  return data;
}

export function deliveryStatusLabel(
  status: MedicalRedactDeliveryStatus,
): string {
  if (status === "PACKAGED") return "已打包";
  if (status === "UPLOADING") return "正在上传";
  if (status === "UPLOAD_FAILED") return "上传失败";
  if (status === "UPLOADED") return "已上传";
  return "未交付";
}

export { PROFILE_STORAGE_KEY as MEDICAL_REDACT_DELIVERY_PROFILE_STORAGE_KEY };
