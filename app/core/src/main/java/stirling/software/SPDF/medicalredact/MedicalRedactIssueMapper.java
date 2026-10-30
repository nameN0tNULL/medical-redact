package stirling.software.SPDF.medicalredact;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;

public final class MedicalRedactIssueMapper {

    private MedicalRedactIssueMapper() {}

    public static String protocolCode(String legacyCode) {
        return MedicalRedactIssueCode.fromLegacyCode(legacyCode)
                .orElse(MedicalRedactIssueCode.MR_GEN_0001)
                .code();
    }

    public static String protocolCodeOrNull(String legacyCode) {
        if (legacyCode == null || legacyCode.isBlank()) {
            return null;
        }
        return protocolCode(legacyCode);
    }

    public static List<String> protocolCodes(List<String> legacyCodes) {
        if (legacyCodes == null) {
            return List.of();
        }
        return legacyCodes.stream().map(MedicalRedactIssueMapper::protocolCode).distinct().toList();
    }

    public static List<MedicalRedactIssue> verificationIssues(List<String> findingCodes) {
        if (findingCodes == null || findingCodes.isEmpty()) {
            return List.of(issue(MedicalRedactIssueCode.MR_VERIFY_7099, null));
        }
        Map<String, MedicalRedactIssue> issues = new LinkedHashMap<>();
        for (String findingCode : findingCodes) {
            MedicalRedactIssueCode issueCode =
                    MedicalRedactIssueCode.fromLegacyCode(findingCode)
                            .filter(code -> code.code().startsWith("MR-VERIFY-"))
                            .orElse(MedicalRedactIssueCode.MR_VERIFY_7099);
            MedicalRedactIssue issue = issue(issueCode, findingCode);
            issues.putIfAbsent(issue.code(), issue);
        }
        return List.copyOf(issues.values());
    }

    public static MedicalRedactIssue issue(MedicalRedactIssueCode issueCode, String legacyCode) {
        return new MedicalRedactIssue(
                issueCode.code(),
                issueCode.severity(),
                Map.of(),
                null,
                null,
                null,
                null,
                legacyCode);
    }

    public static MedicalRedactException fromLegacyException(
            HttpStatus status, Throwable cause, MedicalRedactIssueCode fallback) {
        MedicalRedactIssueCode code =
                MedicalRedactIssueCode.fromLegacyMessage(cause == null ? null : cause.getMessage())
                        .orElse(fallback);
        return new MedicalRedactException(status, code, Map.of(), cause);
    }

    public static MedicalRedactException error(
            HttpStatus status, MedicalRedactIssueCode code, Throwable cause) {
        return new MedicalRedactException(status, code, Map.of(), cause);
    }
}
