import { useMemo } from "react";
import {
  useTranslatedToolCatalog as useCoreCatalog,
  type TranslatedToolCatalog,
} from "@core/data/useTranslatedToolRegistry";
import { useLocalProcessingOnly } from "@app/hooks/useLocalProcessingOnly";
import { useMultipleEndpointsEnabled } from "@app/hooks/useEndpointConfig";
import type { ToolRegistryEntry } from "@app/data/toolsTaxonomy";

export type { TranslatedToolCatalog } from "@core/data/useTranslatedToolRegistry";

const MEDICAL_TOOL_IDS = new Set([
  "redact",
  "ocr",
  "sanitize",
  "changeMetadata",
  "getPdfInfo",
]);

/** Hide non-medical and server-only tools from every catalogue consumer. */
export function useTranslatedToolCatalog(): TranslatedToolCatalog {
  const catalog = useCoreCatalog();
  const localOnly = useLocalProcessingOnly();
  const endpoints = useMemo(
    () =>
      localOnly
        ? [
            ...new Set(
              Object.entries(catalog.allTools).flatMap(([id, tool]) =>
                MEDICAL_TOOL_IDS.has(id) ? (tool.endpoints ?? []) : [],
              ),
            ),
          ]
        : [],
    [catalog, localOnly],
  );
  const { endpointStatus } = useMultipleEndpointsEnabled(endpoints);

  return useMemo(() => {
    const restrict = <T extends Record<string, ToolRegistryEntry>>(
      registry: T,
    ): T =>
      Object.fromEntries(
        Object.entries(registry).map(([id, tool]) => [
          id,
          {
            ...tool,
            hiddenFromToolList:
              tool.hiddenFromToolList ||
              !MEDICAL_TOOL_IDS.has(id) ||
              Boolean(
                localOnly &&
                tool.endpoints?.length &&
                !tool.endpoints.some(
                  (endpoint) => endpointStatus[endpoint] === true,
                ),
              ),
          },
        ]),
      ) as T;

    return {
      allTools: restrict(catalog.allTools),
      regularTools: restrict(catalog.regularTools),
      superTools: restrict(catalog.superTools),
      linkTools: restrict(catalog.linkTools),
    };
  }, [catalog, endpointStatus, localOnly]);
}
