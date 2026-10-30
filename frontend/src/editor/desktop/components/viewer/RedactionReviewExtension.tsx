import { useViewer } from "@app/contexts/ViewerContext";
import { useAllFiles } from "@app/contexts/FileContext";
import { useMedicalRedactReview } from "@app/contexts/MedicalRedactReviewContext";
import { isStirlingFile } from "@app/types/fileContext";
import type { RedactionReviewExtensionProps } from "@core/components/viewer/RedactionReviewExtension";
export type { RedactionReviewExtensionProps } from "@core/components/viewer/RedactionReviewExtension";

export const hideImmediateRedactionApply = true;

export function RedactionReviewExtension({
  targetId,
}: RedactionReviewExtensionProps) {
  const { activeFileId } = useViewer();
  const { files } = useAllFiles();
  const { changeEntityType, entityTypes, error, getTargetEntityType } =
    useMedicalRedactReview();
  const activeFile = files.find(
    (file) => isStirlingFile(file) && file.fileId === activeFileId,
  );
  const fileKey = activeFile?.name ?? activeFileId;

  return (
    <>
      <label title={error ?? undefined}>
        <select
          aria-label="敏感类型"
          value={getTargetEntityType("MANUAL_RECTANGLE", targetId)}
          disabled={!fileKey}
          onChange={(event) => {
            if (fileKey) {
              changeEntityType(
                fileKey,
                "MANUAL_RECTANGLE",
                targetId,
                event.currentTarget.value,
              );
            }
          }}
        >
          {entityTypes.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="embedpdf-floating-divider" />
    </>
  );
}
