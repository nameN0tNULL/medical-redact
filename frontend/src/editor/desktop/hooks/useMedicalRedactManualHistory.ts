import { useMedicalRedactReview } from "@app/contexts/MedicalRedactReviewContext";
import type { MedicalRedactManualHistory } from "@core/hooks/useMedicalRedactManualHistory";
export type { MedicalRedactManualHistory } from "@core/hooks/useMedicalRedactManualHistory";

export function useMedicalRedactManualHistory(): MedicalRedactManualHistory {
  const {
    canUndoManualReview,
    canRedoManualReview,
    undoManualReview,
    redoManualReview,
  } = useMedicalRedactReview();

  return {
    canUndo: canUndoManualReview,
    canRedo: canRedoManualReview,
    undo: undoManualReview,
    redo: redoManualReview,
  };
}
