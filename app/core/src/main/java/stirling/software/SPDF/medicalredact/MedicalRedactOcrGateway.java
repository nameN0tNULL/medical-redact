package stirling.software.SPDF.medicalredact;

import java.util.List;
import java.util.Optional;

import stirling.software.SPDF.medicalredact.MedicalRedactModels.EngineRuntimeCapabilities;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.OcrPageRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.OcrPageResponse;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PiiDetectRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PiiDetectResponse;

interface MedicalRedactOcrGateway {

    boolean isHealthy();

    OcrPageResponse recognize(OcrPageRequest request);

    default Optional<EngineRuntimeCapabilities> runtimeCapabilities() {
        return Optional.empty();
    }

    default PiiDetectResponse detectPii(PiiDetectRequest request) {
        return new PiiDetectResponse(false, List.of(), "PII_ENGINE_UNAVAILABLE");
    }
}
