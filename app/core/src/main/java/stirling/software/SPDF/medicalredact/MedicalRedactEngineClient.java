package stirling.software.SPDF.medicalredact;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Optional;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import stirling.software.SPDF.medicalredact.MedicalRedactModels.EngineRuntimeCapabilities;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.OcrPageRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.OcrPageResponse;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PiiDetectRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PiiDetectResponse;
import stirling.software.common.model.ApplicationProperties;
import stirling.software.common.model.ApplicationProperties.AiEngine.AiEngineMode;

import tools.jackson.databind.ObjectMapper;

@Service
class MedicalRedactEngineClient implements MedicalRedactOcrGateway {

    private static final String OCR_PATH = "/api/v1/medical-redact/ocr";
    private static final String PII_PATH = "/api/v1/medical-redact/pii/detect";
    private static final String RUNTIME_CAPABILITIES_PATH =
            "/api/v1/medical-redact/runtime/capabilities";
    private static final String LOCAL_USER_ID = "medical-redact-local";

    private final ApplicationProperties applicationProperties;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;
    private final String engineSharedSecret;

    @Autowired
    MedicalRedactEngineClient(
            ApplicationProperties applicationProperties, ObjectMapper objectMapper) {
        this(
                applicationProperties,
                objectMapper,
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build(),
                System.getenv("STIRLING_ENGINE_SHARED_SECRET"));
    }

    MedicalRedactEngineClient(
            ApplicationProperties applicationProperties,
            ObjectMapper objectMapper,
            HttpClient httpClient,
            String engineSharedSecret) {
        this.applicationProperties = applicationProperties;
        this.objectMapper = objectMapper;
        this.httpClient = httpClient;
        this.engineSharedSecret = engineSharedSecret;
    }

    @Override
    public boolean isHealthy() {
        if (!canUseLocalEngine()) {
            return false;
        }
        HttpRequest request = authenticatedRequest("/health", Duration.ofSeconds(2)).GET().build();
        try {
            HttpResponse<Void> response =
                    httpClient.send(request, HttpResponse.BodyHandlers.discarding());
            return response.statusCode() >= 200 && response.statusCode() < 300;
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    @Override
    public Optional<EngineRuntimeCapabilities> runtimeCapabilities() {
        if (!canUseLocalEngine()) {
            return Optional.empty();
        }

        Duration timeout =
                Duration.ofSeconds(
                        Math.max(10, applicationProperties.getAiEngine().getTimeoutSeconds()));
        try {
            HttpRequest request =
                    authenticatedRequest(RUNTIME_CAPABILITIES_PATH, timeout).GET().build();
            HttpResponse<String> response =
                    httpClient.send(
                            request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                return Optional.empty();
            }
            EngineRuntimeCapabilities parsed =
                    objectMapper.readValue(response.body(), EngineRuntimeCapabilities.class);
            return Optional.of(
                    new EngineRuntimeCapabilities(
                            parsed.available(),
                            parsed.selectedRuntime(),
                            parsed.availableRuntimes(),
                            parsed.fallbackChain(),
                            parsed.onnxProviders(),
                            parsed.onnxruntimeVersion(),
                            parsed.modelFormats(),
                            parsed.warningCode()));
        } catch (IOException e) {
            return Optional.empty();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Optional.empty();
        }
    }

    @Override
    public OcrPageResponse recognize(OcrPageRequest request) {
        if (!applicationProperties.getAiEngine().isEnabled()) {
            return unavailable("AI_ENGINE_DISABLED");
        }
        if (!canUseLocalEngine()) {
            return unavailable("LOCAL_OCR_ENGINE_UNAVAILABLE");
        }

        Duration timeout =
                Duration.ofSeconds(
                        Math.max(1, applicationProperties.getAiEngine().getTimeoutSeconds()));
        try {
            String requestBody = objectMapper.writeValueAsString(request);
            HttpRequest httpRequest =
                    authenticatedRequest(OCR_PATH, timeout)
                            .header("Content-Type", "application/json")
                            .POST(
                                    HttpRequest.BodyPublishers.ofString(
                                            requestBody, StandardCharsets.UTF_8))
                            .build();
            HttpResponse<String> response =
                    httpClient.send(
                            httpRequest,
                            HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                return unavailable("AI_ENGINE_HTTP_" + response.statusCode());
            }
            OcrPageResponse parsed = objectMapper.readValue(response.body(), OcrPageResponse.class);
            return new OcrPageResponse(
                    parsed.available(),
                    parsed.engine(),
                    parsed.engineVersion(),
                    parsed.tokens() == null ? List.of() : List.copyOf(parsed.tokens()),
                    MedicalRedactIssueMapper.protocolCodeOrNull(parsed.warningCode()),
                    parsed.elapsedMs());
        } catch (HttpTimeoutException e) {
            return unavailable("AI_ENGINE_TIMEOUT");
        } catch (IOException e) {
            return unavailable("AI_ENGINE_UNREACHABLE");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return unavailable("AI_ENGINE_INTERRUPTED");
        }
    }

    @Override
    public PiiDetectResponse detectPii(PiiDetectRequest request) {
        if (!applicationProperties.getAiEngine().isEnabled()) {
            return unavailablePii("AI_ENGINE_DISABLED");
        }
        if (!canUseLocalEngine()) {
            return unavailablePii("LOCAL_PII_ENGINE_UNAVAILABLE");
        }

        Duration timeout =
                Duration.ofSeconds(
                        Math.max(1, applicationProperties.getAiEngine().getTimeoutSeconds()));
        try {
            String requestBody = objectMapper.writeValueAsString(request);
            HttpRequest httpRequest =
                    authenticatedRequest(PII_PATH, timeout)
                            .header("Content-Type", "application/json")
                            .POST(
                                    HttpRequest.BodyPublishers.ofString(
                                            requestBody, StandardCharsets.UTF_8))
                            .build();
            HttpResponse<String> response =
                    httpClient.send(
                            httpRequest,
                            HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                return unavailablePii("AI_ENGINE_HTTP_" + response.statusCode());
            }
            PiiDetectResponse parsed =
                    objectMapper.readValue(response.body(), PiiDetectResponse.class);
            return new PiiDetectResponse(
                    parsed.available(),
                    parsed.candidates() == null ? List.of() : List.copyOf(parsed.candidates()),
                    MedicalRedactIssueMapper.protocolCodeOrNull(parsed.warningCode()));
        } catch (HttpTimeoutException e) {
            return unavailablePii("AI_ENGINE_TIMEOUT");
        } catch (IOException e) {
            return unavailablePii("AI_ENGINE_UNREACHABLE");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return unavailablePii("AI_ENGINE_INTERRUPTED");
        }
    }

    private boolean canUseLocalEngine() {
        return applicationProperties.getAiEngine().isEnabled()
                && applicationProperties.getAiEngine().getMode() == AiEngineMode.SELF_HOSTED
                && applicationProperties.getAiEngine().getUrl() != null
                && !applicationProperties.getAiEngine().getUrl().isBlank();
    }

    private HttpRequest.Builder authenticatedRequest(String path, Duration timeout) {
        String baseUrl = applicationProperties.getAiEngine().getUrl().strip().replaceAll("/+$", "");
        HttpRequest.Builder builder =
                HttpRequest.newBuilder()
                        .uri(URI.create(baseUrl + path))
                        .timeout(timeout)
                        .header("Accept", "application/json")
                        .header("X-User-Id", LOCAL_USER_ID);
        if (engineSharedSecret != null && !engineSharedSecret.isBlank()) {
            builder.header("X-Engine-Auth", engineSharedSecret);
        }
        return builder;
    }

    private OcrPageResponse unavailable(String warningCode) {
        return new OcrPageResponse(
                false,
                "paddleocr",
                null,
                List.of(),
                MedicalRedactIssueMapper.protocolCode(warningCode),
                0);
    }

    private PiiDetectResponse unavailablePii(String warningCode) {
        return new PiiDetectResponse(
                false, List.of(), MedicalRedactIssueMapper.protocolCode(warningCode));
    }
}
