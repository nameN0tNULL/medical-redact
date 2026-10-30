package stirling.software.SPDF.medicalredact;

import static org.springframework.http.HttpStatus.BAD_GATEWAY;
import static org.springframework.http.HttpStatus.BAD_REQUEST;
import static org.springframework.http.HttpStatus.CONFLICT;
import static org.springframework.http.HttpStatus.INTERNAL_SERVER_ERROR;
import static org.springframework.http.HttpStatus.NOT_FOUND;

import java.io.IOException;
import java.nio.file.Files;
import java.util.List;
import java.util.NoSuchElementException;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import io.swagger.v3.oas.annotations.Hidden;

import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryConnectionTestResult;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryRecord;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.Batch;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.CleanupResult;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.CreateBatchRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.DocumentTextRegions;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.RuntimeCapabilities;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SaveReviewActionRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactWorkspaceService.OutputFile;
import stirling.software.SPDF.medicalredact.MedicalRedactWorkspaceService.SourceFile;

@RestController
@RequestMapping("/api/v1/medical-redact")
@Hidden
public class MedicalRedactController {

    private static final Logger logger = LoggerFactory.getLogger(MedicalRedactController.class);

    private final MedicalRedactWorkspaceService workspaceService;
    private final MedicalRedactDeliveryService deliveryService;
    private final MedicalRedactTextService textService;
    private final MedicalRedactRuntimeCapabilitiesService runtimeCapabilitiesService;

    public MedicalRedactController(
            MedicalRedactWorkspaceService workspaceService,
            MedicalRedactDeliveryService deliveryService,
            MedicalRedactTextService textService,
            MedicalRedactRuntimeCapabilitiesService runtimeCapabilitiesService) {
        this.workspaceService = workspaceService;
        this.deliveryService = deliveryService;
        this.textService = textService;
        this.runtimeCapabilitiesService = runtimeCapabilitiesService;
    }

    @PostMapping("/batches")
    public Batch createBatch(@RequestBody(required = false) CreateBatchRequest request) {
        try {
            return workspaceService.createBatch(
                    request == null ? null : request.name(),
                    request == null ? List.of() : request.knownEntities());
        } catch (IllegalArgumentException e) {
            throw legacy(BAD_REQUEST, e, MedicalRedactIssueCode.MR_GEN_0001);
        } catch (IOException e) {
            throw error(INTERNAL_SERVER_ERROR, MedicalRedactIssueCode.MR_TASK_1004, e);
        }
    }

    @GetMapping("/batches")
    public List<Batch> listBatches() {
        try {
            return workspaceService.listBatches();
        } catch (IOException e) {
            throw error(INTERNAL_SERVER_ERROR, MedicalRedactIssueCode.MR_TASK_1005, e);
        }
    }

    @GetMapping("/batches/{batchId}")
    public Batch getBatch(@PathVariable String batchId) {
        try {
            return workspaceService.getBatch(batchId);
        } catch (IllegalArgumentException e) {
            throw legacy(BAD_REQUEST, e, MedicalRedactIssueCode.MR_TASK_1002);
        } catch (NoSuchElementException e) {
            throw legacy(NOT_FOUND, e, MedicalRedactIssueCode.MR_TASK_1001);
        } catch (IOException e) {
            throw error(INTERNAL_SERVER_ERROR, MedicalRedactIssueCode.MR_TASK_1005, e);
        }
    }

    @PostMapping(
            value = "/batches/{batchId}/documents",
            consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Batch importDocuments(
            @PathVariable String batchId, @RequestParam("files") List<MultipartFile> files) {
        try {
            return workspaceService.importDocuments(batchId, files);
        } catch (IllegalArgumentException e) {
            throw legacy(BAD_REQUEST, e, MedicalRedactIssueCode.MR_IMPORT_2005);
        } catch (NoSuchElementException e) {
            throw legacy(NOT_FOUND, e, MedicalRedactIssueCode.MR_TASK_1001);
        } catch (IOException e) {
            throw error(INTERNAL_SERVER_ERROR, MedicalRedactIssueCode.MR_IMPORT_2005, e);
        }
    }

    @GetMapping("/batches/{batchId}/documents/{documentId}/source")
    public ResponseEntity<Resource> getDocumentSource(
            @PathVariable String batchId, @PathVariable String documentId) {
        try {
            SourceFile source = workspaceService.openSource(batchId, documentId);
            String safeDownloadName = source.document().id() + "." + source.document().fileType();
            MediaType mediaType = safeMediaType(source.document().mimeType());
            return ResponseEntity.ok()
                    .contentType(mediaType)
                    .contentLength(Files.size(source.path()))
                    .header(
                            HttpHeaders.CONTENT_DISPOSITION,
                            ContentDisposition.attachment()
                                    .filename(safeDownloadName)
                                    .build()
                                    .toString())
                    .body(new FileSystemResource(source.path()));
        } catch (IllegalArgumentException e) {
            throw legacy(BAD_REQUEST, e, MedicalRedactIssueCode.MR_TASK_1002);
        } catch (NoSuchElementException e) {
            throw legacy(NOT_FOUND, e, MedicalRedactIssueCode.MR_TASK_1006);
        } catch (IOException e) {
            throw error(INTERNAL_SERVER_ERROR, MedicalRedactIssueCode.MR_IMPORT_2007, e);
        }
    }

    @GetMapping("/batches/{batchId}/documents/{documentId}/review")
    public ResponseEntity<Resource> getDocumentReviewPdf(
            @PathVariable String batchId, @PathVariable String documentId) {
        try {
            SourceFile review = workspaceService.openReviewPdf(batchId, documentId);
            return ResponseEntity.ok()
                    .contentType(MediaType.APPLICATION_PDF)
                    .contentLength(Files.size(review.path()))
                    .header(
                            HttpHeaders.CONTENT_DISPOSITION,
                            ContentDisposition.attachment()
                                    .filename(review.document().id() + ".pdf")
                                    .build()
                                    .toString())
                    .body(new FileSystemResource(review.path()));
        } catch (IllegalArgumentException e) {
            throw legacy(BAD_REQUEST, e, MedicalRedactIssueCode.MR_TASK_1002);
        } catch (NoSuchElementException e) {
            throw legacy(NOT_FOUND, e, MedicalRedactIssueCode.MR_TASK_1006);
        } catch (IOException e) {
            throw error(INTERNAL_SERVER_ERROR, MedicalRedactIssueCode.MR_IMPORT_2009, e);
        }
    }

    @GetMapping("/batches/{batchId}/documents/{documentId}/text-regions")
    public DocumentTextRegions getDocumentTextRegions(
            @PathVariable String batchId, @PathVariable String documentId) {
        try {
            return textService.extract(batchId, documentId);
        } catch (IllegalArgumentException e) {
            throw legacy(BAD_REQUEST, e, MedicalRedactIssueCode.MR_TASK_1002);
        } catch (NoSuchElementException e) {
            throw legacy(NOT_FOUND, e, MedicalRedactIssueCode.MR_TASK_1006);
        } catch (IOException e) {
            throw error(INTERNAL_SERVER_ERROR, MedicalRedactIssueCode.MR_REVIEW_6014, e);
        }
    }

    @PostMapping("/batches/{batchId}/review-actions")
    public Batch saveReviewAction(
            @PathVariable String batchId, @RequestBody SaveReviewActionRequest request) {
        try {
            return workspaceService.saveReviewAction(batchId, request);
        } catch (IllegalArgumentException e) {
            throw legacy(BAD_REQUEST, e, MedicalRedactIssueCode.MR_REVIEW_6001);
        } catch (NoSuchElementException e) {
            throw legacy(NOT_FOUND, e, MedicalRedactIssueCode.MR_TASK_1006);
        } catch (IOException e) {
            throw error(INTERNAL_SERVER_ERROR, MedicalRedactIssueCode.MR_REVIEW_6013, e);
        }
    }

    @PostMapping("/batches/{batchId}/documents/{documentId}/finalize")
    public Batch finalizeDocument(
            @PathVariable String batchId,
            @PathVariable String documentId,
            @RequestParam(name = "verify", defaultValue = "true") boolean verify) {
        try {
            if (!verify) {
                return workspaceService.finalizeDocument(batchId, documentId, null, null, false);
            }
            DocumentTextRegions textRegions = textService.extract(batchId, documentId);
            return workspaceService.finalizeDocument(
                    batchId,
                    documentId,
                    textRegions,
                    (document, outputPath) ->
                            textService.verifyRedactedOutputIssues(batchId, document, outputPath),
                    true);
        } catch (IllegalArgumentException e) {
            throw legacy(BAD_REQUEST, e, MedicalRedactIssueCode.MR_GEN_0001);
        } catch (NoSuchElementException e) {
            throw legacy(NOT_FOUND, e, MedicalRedactIssueCode.MR_TASK_1006);
        } catch (IOException e) {
            throw error(INTERNAL_SERVER_ERROR, MedicalRedactIssueCode.MR_VERIFY_7015, e);
        }
    }

    @GetMapping("/batches/{batchId}/documents/{documentId}/output")
    public ResponseEntity<Resource> getVerifiedOutput(
            @PathVariable String batchId, @PathVariable String documentId) {
        try {
            OutputFile output = workspaceService.openOutput(batchId, documentId);
            return ResponseEntity.ok()
                    .contentType(MediaType.APPLICATION_PDF)
                    .contentLength(Files.size(output.path()))
                    .header(
                            HttpHeaders.CONTENT_DISPOSITION,
                            ContentDisposition.attachment()
                                    .filename(output.report().outputFilename())
                                    .build()
                                    .toString())
                    .body(new FileSystemResource(output.path()));
        } catch (IllegalStateException e) {
            throw legacy(CONFLICT, e, MedicalRedactIssueCode.MR_EXPORT_8001);
        } catch (IllegalArgumentException e) {
            throw legacy(BAD_REQUEST, e, MedicalRedactIssueCode.MR_TASK_1002);
        } catch (NoSuchElementException e) {
            throw legacy(NOT_FOUND, e, MedicalRedactIssueCode.MR_TASK_1006);
        } catch (IOException e) {
            throw error(INTERNAL_SERVER_ERROR, MedicalRedactIssueCode.MR_EXPORT_8003, e);
        }
    }

    @GetMapping("/batches/{batchId}/delivery")
    public DeliveryRecord getDelivery(@PathVariable String batchId) {
        try {
            return deliveryService.getDelivery(batchId);
        } catch (IllegalArgumentException e) {
            throw legacy(BAD_REQUEST, e, MedicalRedactIssueCode.MR_TASK_1002);
        } catch (NoSuchElementException e) {
            throw legacy(NOT_FOUND, e, MedicalRedactIssueCode.MR_TASK_1001);
        } catch (IOException e) {
            throw error(INTERNAL_SERVER_ERROR, MedicalRedactIssueCode.MR_DELIVERY_8599, e);
        }
    }

    @PostMapping("/delivery/test-connection")
    public DeliveryConnectionTestResult testDeliveryConnection(
            @RequestBody DeliveryRequest request) {
        try {
            return deliveryService.testConnection(request);
        } catch (MedicalRedactDeliveryException e) {
            throw deliveryError(e);
        }
    }

    @PostMapping("/batches/{batchId}/delivery")
    public DeliveryRecord deliverBatch(
            @PathVariable String batchId, @RequestBody DeliveryRequest request) {
        try {
            return deliveryService.deliver(batchId, request);
        } catch (MedicalRedactDeliveryException e) {
            throw deliveryError(e);
        } catch (IllegalArgumentException e) {
            throw legacy(BAD_REQUEST, e, MedicalRedactIssueCode.MR_TASK_1002);
        } catch (NoSuchElementException e) {
            throw legacy(NOT_FOUND, e, MedicalRedactIssueCode.MR_TASK_1001);
        } catch (IOException e) {
            throw error(INTERNAL_SERVER_ERROR, MedicalRedactIssueCode.MR_DELIVERY_8599, e);
        }
    }

    @GetMapping("/runtime/capabilities")
    public RuntimeCapabilities getRuntimeCapabilities() {
        return runtimeCapabilitiesService.probe();
    }

    @PostMapping("/workspace/cleanup-temp")
    public CleanupResult cleanupTemp() {
        try {
            return workspaceService.cleanupTemp();
        } catch (IOException e) {
            throw error(INTERNAL_SERVER_ERROR, MedicalRedactIssueCode.MR_STORAGE_9501, e);
        }
    }

    @ExceptionHandler(MedicalRedactException.class)
    public ResponseEntity<MedicalRedactErrorResponse> handleMedicalRedactException(
            MedicalRedactException exception) {
        Throwable cause = exception.getCause();
        logger.warn(
                "Medical redact request failed code={} traceId={} cause={}",
                exception.issueCode().code(),
                exception.traceId(),
                cause == null ? "unknown" : cause.getClass().getSimpleName());
        return ResponseEntity.status(exception.status())
                .contentType(MediaType.APPLICATION_JSON)
                .body(
                        new MedicalRedactErrorResponse(
                                exception.issueCode().code(),
                                exception.params(),
                                exception.traceId()));
    }

    private MedicalRedactException legacy(
            HttpStatus status, RuntimeException cause, MedicalRedactIssueCode fallback) {
        return MedicalRedactIssueMapper.fromLegacyException(status, cause, fallback);
    }

    private MedicalRedactException error(
            HttpStatus status, MedicalRedactIssueCode code, Throwable cause) {
        return MedicalRedactIssueMapper.error(status, code, cause);
    }

    private MedicalRedactException deliveryError(MedicalRedactDeliveryException cause) {
        HttpStatus status =
                cause.issueCode() == MedicalRedactIssueCode.MR_DELIVERY_8501
                        ? BAD_REQUEST
                        : BAD_GATEWAY;
        return error(status, cause.issueCode(), cause);
    }

    private MediaType safeMediaType(String value) {
        try {
            return MediaType.parseMediaType(value);
        } catch (IllegalArgumentException e) {
            return MediaType.APPLICATION_OCTET_STREAM;
        }
    }
}
