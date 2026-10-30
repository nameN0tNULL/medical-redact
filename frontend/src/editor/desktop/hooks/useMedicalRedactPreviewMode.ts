import { useMedicalRedactReview } from "@app/contexts/MedicalRedactReviewContext";

export function useMedicalRedactPreviewMode() {
  return useMedicalRedactReview().isFinalPreview;
}
