import { beforeEach, describe, expect, test } from "vitest";
import {
  MEDICAL_REDACT_DELIVERY_PROFILE_STORAGE_KEY,
  defaultMedicalRedactDeliveryProfile,
  loadMedicalRedactDeliveryCredentials,
  loadMedicalRedactDeliveryProfile,
  saveMedicalRedactDeliveryCredentials,
  saveMedicalRedactDeliveryProfile,
} from "@app/services/medicalRedactDelivery";

describe("medicalRedactDelivery preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("defaults to pinned SFTP with passive transfer defaults kept separate", () => {
    expect(defaultMedicalRedactDeliveryProfile()).toEqual({
      profileId: "default",
      protocol: "SFTP",
      host: "",
      port: 22,
      username: "",
      remoteDirectory: ".",
      credentialRef: "default",
      sftpHostKeyFingerprint: "",
      ftpPassiveMode: true,
      ftpsMode: "EXPLICIT",
    });
  });

  test("persists only non-sensitive delivery profile fields", () => {
    const profile = {
      ...defaultMedicalRedactDeliveryProfile(),
      host: "sftp.internal.example",
      username: "delivery",
      remoteDirectory: "/incoming",
      sftpHostKeyFingerprint: "SHA256:test-fingerprint",
    };

    saveMedicalRedactDeliveryProfile(profile);

    const raw = window.localStorage.getItem(
      MEDICAL_REDACT_DELIVERY_PROFILE_STORAGE_KEY,
    );
    expect(raw).not.toBeNull();
    expect(raw).toContain("sftp.internal.example");
    expect(raw).toContain("SHA256:test-fingerprint");
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("privateKey");
    expect(raw).not.toContain("archivePassword");
    expect(loadMedicalRedactDeliveryProfile()).toEqual(profile);
  });

  test("browser test fallback keeps credentials only in memory", async () => {
    await saveMedicalRedactDeliveryCredentials("default", {
      password: "server-secret",
      privateKey: "private-key-secret",
      privateKeyPassphrase: "key-passphrase-secret",
      archivePassword: "archive-secret-123",
    });

    expect(JSON.stringify(window.localStorage)).not.toContain("server-secret");
    expect(
      window.localStorage.getItem(MEDICAL_REDACT_DELIVERY_PROFILE_STORAGE_KEY),
    ).toBeNull();
    expect(await loadMedicalRedactDeliveryCredentials("default")).toEqual({
      password: "server-secret",
      privateKey: "private-key-secret",
      privateKeyPassphrase: "key-passphrase-secret",
      archivePassword: "archive-secret-123",
    });
  });
});
