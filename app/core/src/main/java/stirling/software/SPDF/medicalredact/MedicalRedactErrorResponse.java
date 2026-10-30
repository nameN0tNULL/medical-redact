package stirling.software.SPDF.medicalredact;

import java.util.Map;

public record MedicalRedactErrorResponse(String code, Map<String, Object> params, String traceId) {

    public MedicalRedactErrorResponse {
        params = params == null ? Map.of() : Map.copyOf(params);
    }
}
