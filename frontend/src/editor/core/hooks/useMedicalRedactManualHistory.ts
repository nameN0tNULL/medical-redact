export interface MedicalRedactManualHistory {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

const NOOP = () => {};

export function useMedicalRedactManualHistory(): MedicalRedactManualHistory {
  return {
    canUndo: false,
    canRedo: false,
    undo: NOOP,
    redo: NOOP,
  };
}
