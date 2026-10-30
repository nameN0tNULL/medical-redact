import { forwardRef } from "react";
import type { RulerOverlayHandle as CoreRulerOverlayHandle } from "@core/components/viewer/RulerOverlay";

export type RulerOverlayHandle = CoreRulerOverlayHandle;

export const RulerOverlay = forwardRef<
  RulerOverlayHandle,
  Record<string, unknown>
>(function MedicalRulerOverlay(_props, _ref) {
  return null;
});
