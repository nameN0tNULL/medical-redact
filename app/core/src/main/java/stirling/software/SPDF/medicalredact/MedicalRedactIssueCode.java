package stirling.software.SPDF.medicalredact;

import java.util.Locale;
import java.util.Optional;

public enum MedicalRedactIssueCode {
    MR_GEN_0001("MR-GEN-0001", "ERROR"),
    MR_GEN_0002("MR-GEN-0002", "ERROR"),

    MR_TASK_1001("MR-TASK-1001", "ERROR"),
    MR_TASK_1002("MR-TASK-1002", "ERROR"),
    MR_TASK_1003("MR-TASK-1003", "ERROR"),
    MR_TASK_1004("MR-TASK-1004", "ERROR"),
    MR_TASK_1005("MR-TASK-1005", "ERROR"),
    MR_TASK_1006("MR-TASK-1006", "ERROR"),
    MR_TASK_1007("MR-TASK-1007", "ERROR"),

    MR_IMPORT_2001("MR-IMPORT-2001", "ERROR"),
    MR_IMPORT_2002("MR-IMPORT-2002", "ERROR"),
    MR_IMPORT_2003("MR-IMPORT-2003", "ERROR"),
    MR_IMPORT_2004("MR-IMPORT-2004", "ERROR"),
    MR_IMPORT_2005("MR-IMPORT-2005", "ERROR"),
    MR_IMPORT_2006("MR-IMPORT-2006", "ERROR"),
    MR_IMPORT_2007("MR-IMPORT-2007", "ERROR"),
    MR_IMPORT_2008("MR-IMPORT-2008", "ERROR"),
    MR_IMPORT_2009("MR-IMPORT-2009", "ERROR"),

    MR_OCR_3001("MR-OCR-3001", "WARNING"),
    MR_OCR_3002("MR-OCR-3002", "WARNING"),
    MR_OCR_3003("MR-OCR-3003", "ERROR"),
    MR_OCR_3004("MR-OCR-3004", "ERROR"),
    MR_OCR_3005("MR-OCR-3005", "ERROR"),
    MR_OCR_3006("MR-OCR-3006", "BLOCKING"),
    MR_OCR_3007("MR-OCR-3007", "ERROR"),
    MR_OCR_3008("MR-OCR-3008", "ERROR"),
    MR_OCR_3009("MR-OCR-3009", "ERROR"),
    MR_OCR_3010("MR-OCR-3010", "ERROR"),

    MR_PII_4001("MR-PII-4001", "WARNING"),
    MR_PII_4002("MR-PII-4002", "ERROR"),
    MR_PII_4010("MR-PII-4010", "ERROR"),
    MR_PII_4011("MR-PII-4011", "ERROR"),
    MR_PII_4012("MR-PII-4012", "ERROR"),
    MR_PII_4013("MR-PII-4013", "ERROR"),
    MR_PII_4014("MR-PII-4014", "ERROR"),

    MR_ALIGN_5001("MR-ALIGN-5001", "BLOCKING"),
    MR_ALIGN_5002("MR-ALIGN-5002", "BLOCKING"),
    MR_ALIGN_5003("MR-ALIGN-5003", "WARNING"),
    MR_ALIGN_5004("MR-ALIGN-5004", "BLOCKING"),
    MR_ALIGN_5005("MR-ALIGN-5005", "BLOCKING"),
    MR_ALIGN_5006("MR-ALIGN-5006", "BLOCKING"),
    MR_ALIGN_5101("MR-ALIGN-5101", "WARNING"),
    MR_ALIGN_5102("MR-ALIGN-5102", "WARNING"),
    MR_ALIGN_5103("MR-ALIGN-5103", "BLOCKING"),
    MR_ALIGN_5104("MR-ALIGN-5104", "BLOCKING"),
    MR_ALIGN_5105("MR-ALIGN-5105", "BLOCKING"),
    MR_ALIGN_5106("MR-ALIGN-5106", "ERROR"),
    MR_ALIGN_5107("MR-ALIGN-5107", "BLOCKING"),
    MR_ALIGN_5108("MR-ALIGN-5108", "BLOCKING"),
    MR_ALIGN_5109("MR-ALIGN-5109", "ERROR"),
    MR_ALIGN_5110("MR-ALIGN-5110", "WARNING"),
    MR_ALIGN_5111("MR-ALIGN-5111", "WARNING"),
    MR_ALIGN_5112("MR-ALIGN-5112", "BLOCKING"),
    MR_ALIGN_5113("MR-ALIGN-5113", "BLOCKING"),
    MR_ALIGN_5114("MR-ALIGN-5114", "BLOCKING"),
    MR_ALIGN_5115("MR-ALIGN-5115", "BLOCKING"),
    MR_ALIGN_5116("MR-ALIGN-5116", "BLOCKING"),

    MR_REVIEW_6001("MR-REVIEW-6001", "ERROR"),
    MR_REVIEW_6002("MR-REVIEW-6002", "ERROR"),
    MR_REVIEW_6003("MR-REVIEW-6003", "ERROR"),
    MR_REVIEW_6004("MR-REVIEW-6004", "ERROR"),
    MR_REVIEW_6005("MR-REVIEW-6005", "ERROR"),
    MR_REVIEW_6006("MR-REVIEW-6006", "ERROR"),
    MR_REVIEW_6007("MR-REVIEW-6007", "ERROR"),
    MR_REVIEW_6008("MR-REVIEW-6008", "ERROR"),
    MR_REVIEW_6009("MR-REVIEW-6009", "ERROR"),
    MR_REVIEW_6010("MR-REVIEW-6010", "ERROR"),
    MR_REVIEW_6011("MR-REVIEW-6011", "ERROR"),
    MR_REVIEW_6012("MR-REVIEW-6012", "ERROR"),
    MR_REVIEW_6013("MR-REVIEW-6013", "ERROR"),
    MR_REVIEW_6014("MR-REVIEW-6014", "ERROR"),
    MR_REVIEW_6015("MR-REVIEW-6015", "ERROR"),
    MR_REVIEW_6016("MR-REVIEW-6016", "ERROR"),

    MR_VERIFY_7001("MR-VERIFY-7001", "BLOCKING"),
    MR_VERIFY_7002("MR-VERIFY-7002", "BLOCKING"),
    MR_VERIFY_7003("MR-VERIFY-7003", "BLOCKING"),
    MR_VERIFY_7004("MR-VERIFY-7004", "BLOCKING"),
    MR_VERIFY_7005("MR-VERIFY-7005", "BLOCKING"),
    MR_VERIFY_7006("MR-VERIFY-7006", "BLOCKING"),
    MR_VERIFY_7007("MR-VERIFY-7007", "BLOCKING"),
    MR_VERIFY_7008("MR-VERIFY-7008", "BLOCKING"),
    MR_VERIFY_7009("MR-VERIFY-7009", "BLOCKING"),
    MR_VERIFY_7010("MR-VERIFY-7010", "BLOCKING"),
    MR_VERIFY_7011("MR-VERIFY-7011", "BLOCKING"),
    MR_VERIFY_7012("MR-VERIFY-7012", "BLOCKING"),
    MR_VERIFY_7013("MR-VERIFY-7013", "BLOCKING"),
    MR_VERIFY_7014("MR-VERIFY-7014", "BLOCKING"),
    MR_VERIFY_7015("MR-VERIFY-7015", "ERROR"),
    MR_VERIFY_7099("MR-VERIFY-7099", "BLOCKING"),

    MR_EXPORT_8001("MR-EXPORT-8001", "BLOCKING"),
    MR_EXPORT_8002("MR-EXPORT-8002", "ERROR"),
    MR_EXPORT_8003("MR-EXPORT-8003", "ERROR"),
    MR_EXPORT_8004("MR-EXPORT-8004", "ERROR"),

    MR_DELIVERY_8501("MR-DELIVERY-8501", "ERROR"),
    MR_DELIVERY_8502("MR-DELIVERY-8502", "ERROR"),
    MR_DELIVERY_8503("MR-DELIVERY-8503", "ERROR"),
    MR_DELIVERY_8504("MR-DELIVERY-8504", "ERROR"),
    MR_DELIVERY_8505("MR-DELIVERY-8505", "ERROR"),
    MR_DELIVERY_8506("MR-DELIVERY-8506", "ERROR"),
    MR_DELIVERY_8507("MR-DELIVERY-8507", "ERROR"),
    MR_DELIVERY_8508("MR-DELIVERY-8508", "ERROR"),
    MR_DELIVERY_8509("MR-DELIVERY-8509", "ERROR"),
    MR_DELIVERY_8510("MR-DELIVERY-8510", "ERROR"),
    MR_DELIVERY_8511("MR-DELIVERY-8511", "ERROR"),
    MR_DELIVERY_8512("MR-DELIVERY-8512", "ERROR"),
    MR_DELIVERY_8513("MR-DELIVERY-8513", "ERROR"),
    MR_DELIVERY_8599("MR-DELIVERY-8599", "ERROR"),

    MR_RUNTIME_9001("MR-RUNTIME-9001", "WARNING"),
    MR_RUNTIME_9002("MR-RUNTIME-9002", "ERROR"),
    MR_RUNTIME_9003("MR-RUNTIME-9003", "ERROR"),
    MR_RUNTIME_9004("MR-RUNTIME-9004", "ERROR"),
    MR_RUNTIME_9005("MR-RUNTIME-9005", "ERROR"),
    MR_RUNTIME_9006("MR-RUNTIME-9006", "ERROR"),
    MR_RUNTIME_9007("MR-RUNTIME-9007", "ERROR"),

    MR_STORAGE_9501("MR-STORAGE-9501", "ERROR"),
    MR_STORAGE_9502("MR-STORAGE-9502", "BLOCKING");

    private final String code;
    private final String severity;

    MedicalRedactIssueCode(String code, String severity) {
        this.code = code;
        this.severity = severity;
    }

    public String code() {
        return code;
    }

    public String severity() {
        return severity;
    }

    public static Optional<MedicalRedactIssueCode> fromCode(String value) {
        if (value == null || value.isBlank()) {
            return Optional.empty();
        }
        String normalized = value.strip().toUpperCase(Locale.ROOT);
        for (MedicalRedactIssueCode code : values()) {
            if (code.code.equals(normalized)) {
                return Optional.of(code);
            }
        }
        return Optional.empty();
    }

    public static Optional<MedicalRedactIssueCode> fromLegacyCode(String value) {
        if (value == null || value.isBlank()) {
            return Optional.empty();
        }
        Optional<MedicalRedactIssueCode> current = fromCode(value);
        if (current.isPresent()) {
            return current;
        }
        if (value.startsWith("AI_ENGINE_HTTP_")) {
            return Optional.of(MR_RUNTIME_9005);
        }
        return Optional.ofNullable(
                switch (value) {
                    case "NER_UNAVAILABLE" -> MR_PII_4001;
                    case "LOCAL_PII_ENGINE_UNAVAILABLE", "PII_ENGINE_UNAVAILABLE" -> MR_PII_4002;
                    case "OCR_NO_TEXT_DETECTED" -> MR_OCR_3001;
                    case "OCR_LOW_CONFIDENCE_PRESENT" -> MR_OCR_3002;
                    case "OCR_INVALID_REQUEST_IMAGE" -> MR_OCR_3003;
                    case "OCR_IMAGE_DECODE_FAILED" -> MR_OCR_3004;
                    case "OCR_IMAGE_DIMENSION_MISMATCH" -> MR_OCR_3005;
                    case "OCR_TRANSFORM_NON_INVERTIBLE" -> MR_OCR_3006;
                    case "PADDLEOCR_MODEL_MISSING" -> MR_OCR_3007;
                    case "PADDLEOCR_RUNTIME_UNAVAILABLE" -> MR_OCR_3008;
                    case "PADDLEOCR_INFERENCE_FAILED" -> MR_OCR_3009;
                    case "LOCAL_OCR_ENGINE_UNAVAILABLE" -> MR_OCR_3010;
                    case "NO_SOURCE_TOKEN" -> MR_ALIGN_5001;
                    case "INVALID_TOKEN_POLYGON" -> MR_ALIGN_5002;
                    case "PARTIAL_TOKEN_NEEDS_REOCR" -> MR_ALIGN_5003;
                    case "MISSING_BBOX" -> MR_ALIGN_5004;
                    case "BBOX_OUT_OF_BOUNDS" -> MR_ALIGN_5005;
                    case "TOKEN_REGION_MAPPING_CONFLICT" -> MR_ALIGN_5006;
                    case "LOCAL_REOCR_FAILED" -> MR_ALIGN_5101;
                    case "LOCAL_REOCR_FUZZY_MATCH" -> MR_ALIGN_5102;
                    case "LOCAL_REOCR_MISSING_BBOX" -> MR_ALIGN_5103;
                    case "LOCAL_REOCR_PAGE_MISMATCH" -> MR_ALIGN_5104;
                    case "LOCAL_REOCR_INVALID_BBOX" -> MR_ALIGN_5105;
                    case "LOCAL_REOCR_IMAGE_DECODE_FAILED" -> MR_ALIGN_5106;
                    case "LOCAL_REOCR_IMAGE_DIMENSION_MISMATCH" -> MR_ALIGN_5107;
                    case "LOCAL_REOCR_INVALID_CROP" -> MR_ALIGN_5108;
                    case "LOCAL_REOCR_IMAGE_ENCODE_FAILED" -> MR_ALIGN_5109;
                    case "LOCAL_REOCR_UNAVAILABLE" -> MR_ALIGN_5110;
                    case "LOCAL_REOCR_NO_TEXT" -> MR_ALIGN_5111;
                    case "LOCAL_REOCR_NO_SAFE_MATCH" -> MR_ALIGN_5112;
                    case "LOCAL_REOCR_NO_CHAR_BOX" -> MR_ALIGN_5113;
                    case "LOCAL_REOCR_MULTI_PAGE_UNSUPPORTED" -> MR_ALIGN_5114;
                    case "LOCAL_REOCR_LIMIT_EXCEEDED" -> MR_ALIGN_5115;
                    case "LOCAL_REOCR_IMAGE_UNAVAILABLE" -> MR_ALIGN_5116;
                    case "NO_SELECTED_REDACTION" -> MR_VERIFY_7001;
                    case "UNRESOLVED_PII_RISK" -> MR_VERIFY_7002;
                    case "VERIFICATION_OUTPUT_READ_FAILED" -> MR_VERIFY_7003;
                    case "KNOWN_VALUE_SURVIVED" -> MR_VERIFY_7004;
                    case "OUTPUT_PII_DETECTED" -> MR_VERIFY_7005;
                    case "OUTPUT_OCR_UNAVAILABLE" -> MR_VERIFY_7006;
                    case "OUTPUT_PII_SCAN_UNAVAILABLE" -> MR_VERIFY_7007;
                    case "TEXT_LAYER_SURVIVED" -> MR_VERIFY_7008;
                    case "PDF_STRUCTURE_SURVIVED" -> MR_VERIFY_7009;
                    case "METADATA_SURVIVED" -> MR_VERIFY_7010;
                    case "ANNOTATION_SURVIVED" -> MR_VERIFY_7011;
                    case "PAGE_COUNT_MISMATCH" -> MR_VERIFY_7012;
                    case "REDACTION_BOX_NOT_BLACK" -> MR_VERIFY_7013;
                    case "SEMANTIC_VERIFICATION_FAILED" -> MR_VERIFY_7014;
                    case "AI_ENGINE_DISABLED" -> MR_RUNTIME_9001;
                    case "AI_ENGINE_TIMEOUT" -> MR_RUNTIME_9002;
                    case "AI_ENGINE_UNREACHABLE" -> MR_RUNTIME_9003;
                    case "AI_ENGINE_INTERRUPTED" -> MR_RUNTIME_9004;
                    default -> null;
                });
    }

    public static Optional<MedicalRedactIssueCode> fromLegacyMessage(String value) {
        if (value == null || value.isBlank()) {
            return Optional.empty();
        }
        return Optional.ofNullable(
                switch (value) {
                    case "Batch not found" -> MR_TASK_1001;
                    case "Invalid batch id", "Batch id is required" -> MR_TASK_1002;
                    case "Batch name must be 120 characters or fewer" -> MR_TASK_1003;
                    case "Unable to create the local task" -> MR_TASK_1004;
                    case "Unable to read local tasks", "Unable to read the local task" ->
                            MR_TASK_1005;
                    case "Document not found" -> MR_TASK_1006;
                    case "Document id is required" -> MR_TASK_1007;
                    case "At least one PDF or image is required" -> MR_IMPORT_2001;
                    case "Only PDF and common image files are supported" -> MR_IMPORT_2002;
                    case "Empty files are not supported" -> MR_IMPORT_2003;
                    case "A valid filename is required" -> MR_IMPORT_2004;
                    case "Unable to import documents" -> MR_IMPORT_2005;
                    case "Document source is unavailable" -> MR_IMPORT_2006;
                    case "Unable to read the document source" -> MR_IMPORT_2007;
                    case "The image file could not be decoded" -> MR_IMPORT_2008;
                    case "Unable to create the review PDF" -> MR_IMPORT_2009;
                    case "Known entity context is limited to 100 entries" -> MR_PII_4010;
                    case "Known entity type and value are required" -> MR_PII_4011;
                    case "Unsupported known entity type" -> MR_PII_4012;
                    case "Known entity values must contain 1 to 256 characters" -> MR_PII_4013;
                    case "Known entity role is too long" -> MR_PII_4014;
                    case "Review action is required" -> MR_REVIEW_6001;
                    case "Review target type is required" -> MR_REVIEW_6002;
                    case "Review target id is required" -> MR_REVIEW_6003;
                    case "Review target id must be 200 characters or fewer" -> MR_REVIEW_6004;
                    case "Review action type is required" -> MR_REVIEW_6005;
                    case "Text selection actions require a text region target" -> MR_REVIEW_6006;
                    case "Manual rectangle action has an invalid target type" -> MR_REVIEW_6007;
                    case "Review action must include before or after state" -> MR_REVIEW_6008;
                    case "Selection state is required" -> MR_REVIEW_6009;
                    case "Selection source is required" -> MR_REVIEW_6010;
                    case "Review action page does not belong to document" -> MR_REVIEW_6011;
                    case "Review action box is invalid" -> MR_REVIEW_6012;
                    case "Unable to save the review action" -> MR_REVIEW_6013;
                    case "Unable to extract document text regions" -> MR_REVIEW_6014;
                    case "Entity type must be 80 characters or fewer" -> MR_REVIEW_6015;
                    case "Entity role must be 80 characters or fewer" -> MR_REVIEW_6016;
                    case "At least one selected redaction region is required" -> MR_VERIFY_7001;
                    case "Unresolved PII risks require review before Verification" ->
                            MR_VERIFY_7002;
                    case "Unable to finalize the redacted document" -> MR_VERIFY_7015;
                    case "Verified output is not available", "Verified output is unavailable" ->
                            MR_EXPORT_8002;
                    case "Unable to read the verified output" -> MR_EXPORT_8003;
                    case "PNG encoder is unavailable" -> MR_RUNTIME_9006;
                    case "SHA-256 is unavailable" -> MR_RUNTIME_9007;
                    case "Unable to clean temporary workspace files" -> MR_STORAGE_9501;
                    case "Unable to mark source file as read-only" -> MR_STORAGE_9502;
                    default -> null;
                });
    }
}
