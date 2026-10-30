import { useEffect } from "react";
import { PdfAnnotationSubtype } from "@embedpdf/models";
import { useAnnotation } from "@embedpdf/plugin-annotation/react";
import { RedactionReviewExtension } from "@app/components/viewer/RedactionReviewExtension";
import { useActiveDocumentId } from "@app/components/viewer/useActiveDocumentId";
import type { AnnotationSelectionMenuProps } from "@core/components/viewer/AnnotationSelectionMenu";

export type { AnnotationSelectionMenuProps } from "@core/components/viewer/AnnotationSelectionMenu";

export function AnnotationSelectionMenu(props: AnnotationSelectionMenuProps) {
  const activeDocumentId = useActiveDocumentId();
  if (!activeDocumentId) return null;
  return (
    <MedicalAnnotationSelectionMenu {...props} documentId={activeDocumentId} />
  );
}

function MedicalAnnotationSelectionMenu({
  context,
  selected,
  menuWrapperProps,
  documentId,
}: AnnotationSelectionMenuProps & { documentId: string }) {
  const annotation = context?.annotation;
  const { provides } = useAnnotation(documentId);

  useEffect(() => {
    if (
      !selected ||
      !annotation ||
      annotation.object.type !== PdfAnnotationSubtype.REDACT
    ) {
      return;
    }

    const dismiss = () => {
      provides?.deselectAnnotation?.();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-medical-redaction-selection-menu]")) return;
      dismiss();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("blur", dismiss);
    };
  }, [annotation, provides, selected]);

  if (
    !selected ||
    !annotation ||
    annotation.object.type !== PdfAnnotationSubtype.REDACT
  ) {
    return null;
  }

  return (
    <div
      ref={menuWrapperProps?.ref}
      className="embedpdf-floating-menu"
      style={{
        ...menuWrapperProps?.style,
        pointerEvents: "auto",
        width: "max-content",
      }}
      data-medical-redaction-selection-menu
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (
          nextTarget instanceof Node &&
          event.currentTarget.contains(nextTarget)
        ) {
          return;
        }
        provides?.deselectAnnotation?.();
      }}
    >
      <RedactionReviewExtension targetId={annotation.object.id} />
    </div>
  );
}
