import { beforeEach, describe, expect, test } from "vitest";
import {
  isMedicalRedactSecurityVerificationEnabled,
  SECURITY_VERIFICATION_STORAGE_KEY,
  setMedicalRedactSecurityVerificationEnabled,
} from "@app/services/medicalRedactPreferences";

describe("medicalRedactPreferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("keeps security verification enabled by default", () => {
    expect(isMedicalRedactSecurityVerificationEnabled()).toBe(true);
  });

  test("persists an explicit disabled preference", () => {
    setMedicalRedactSecurityVerificationEnabled(false);
    expect(window.localStorage.getItem(SECURITY_VERIFICATION_STORAGE_KEY)).toBe(
      "false",
    );
    expect(isMedicalRedactSecurityVerificationEnabled()).toBe(false);
  });

  test("can be enabled again", () => {
    setMedicalRedactSecurityVerificationEnabled(false);
    setMedicalRedactSecurityVerificationEnabled(true);
    expect(isMedicalRedactSecurityVerificationEnabled()).toBe(true);
  });
});
