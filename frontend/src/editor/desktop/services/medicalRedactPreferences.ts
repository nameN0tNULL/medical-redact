const SECURITY_VERIFICATION_STORAGE_KEY =
  "medical-redact-security-verification-enabled";

export function isMedicalRedactSecurityVerificationEnabled(): boolean {
  try {
    const stored = window.localStorage.getItem(
      SECURITY_VERIFICATION_STORAGE_KEY,
    );
    return stored !== "false";
  } catch {
    return true;
  }
}

export function setMedicalRedactSecurityVerificationEnabled(
  enabled: boolean,
): void {
  try {
    window.localStorage.setItem(
      SECURITY_VERIFICATION_STORAGE_KEY,
      enabled ? "true" : "false",
    );
  } catch {
    // Keep the in-memory UI usable even when WebView storage is unavailable.
  }
}

export { SECURITY_VERIFICATION_STORAGE_KEY };
