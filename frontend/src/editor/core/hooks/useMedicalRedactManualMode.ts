import { useState } from "react";

export function useMedicalRedactManualMode() {
  return useState(false);
}
