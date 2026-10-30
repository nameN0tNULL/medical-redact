import { useMedicalRedactReview } from "@app/contexts/MedicalRedactReviewContext";

export function useMedicalRedactManualMode() {
  const { manualRedactMode, setManualRedactMode } = useMedicalRedactReview();
  return [manualRedactMode, setManualRedactMode] as const;
}
