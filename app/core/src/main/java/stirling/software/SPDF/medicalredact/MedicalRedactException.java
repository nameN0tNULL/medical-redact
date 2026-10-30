package stirling.software.SPDF.medicalredact;

import java.util.Map;
import java.util.UUID;

import org.springframework.http.HttpStatus;

public class MedicalRedactException extends RuntimeException {

    private final HttpStatus status;
    private final MedicalRedactIssueCode issueCode;
    private final Map<String, Object> params;
    private final String traceId;

    public MedicalRedactException(
            HttpStatus status,
            MedicalRedactIssueCode issueCode,
            Map<String, Object> params,
            Throwable cause) {
        super(issueCode.code(), cause);
        this.status = status;
        this.issueCode = issueCode;
        this.params = params == null ? Map.of() : Map.copyOf(params);
        this.traceId = UUID.randomUUID().toString();
    }

    public HttpStatus status() {
        return status;
    }

    public MedicalRedactIssueCode issueCode() {
        return issueCode;
    }

    public Map<String, Object> params() {
        return params;
    }

    public String traceId() {
        return traceId;
    }
}
