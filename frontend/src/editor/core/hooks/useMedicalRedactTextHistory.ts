export interface MedicalRedactTextHistory {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

const NOOP = () => {};

export function useMedicalRedactTextHistory(): MedicalRedactTextHistory {
  return {
    canUndo: false,
    canRedo: false,
    undo: NOOP,
    redo: NOOP,
  };
}
