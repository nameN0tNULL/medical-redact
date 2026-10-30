import { useMedicalRedactReview } from "@app/contexts/MedicalRedactReviewContext";
import type { MedicalRedactTextHistory } from "@core/hooks/useMedicalRedactTextHistory";
export type { MedicalRedactTextHistory } from "@core/hooks/useMedicalRedactTextHistory";

export function useMedicalRedactTextHistory(): MedicalRedactTextHistory {
  const {
    canUndoTextSelection,
    canRedoTextSelection,
    undoTextSelection,
    redoTextSelection,
  } = useMedicalRedactReview();

  return {
    canUndo: canUndoTextSelection,
    canRedo: canRedoTextSelection,
    undo: undoTextSelection,
    redo: redoTextSelection,
  };
}
