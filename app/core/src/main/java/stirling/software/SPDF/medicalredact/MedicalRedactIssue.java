package stirling.software.SPDF.medicalredact;

import java.util.Map;

import com.fasterxml.jackson.annotation.JsonProperty;

public record MedicalRedactIssue(
        String code,
        String severity,
        Map<String, Object> params,
        String documentId,
        String pageId,
        String candidateId,
        String traceId,
        @JsonProperty(access = JsonProperty.Access.WRITE_ONLY) String legacyCode) {

    public MedicalRedactIssue {
        params = params == null ? Map.of() : Map.copyOf(params);
    }
}
