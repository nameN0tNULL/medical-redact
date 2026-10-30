import { renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  localOnly: true,
  status: {} as Record<string, boolean>,
}));

vi.mock("@app/hooks/useLocalProcessingOnly", () => ({
  useLocalProcessingOnly: () => state.localOnly,
}));

vi.mock("@app/hooks/useEndpointConfig", () => ({
  useMultipleEndpointsEnabled: () => ({ endpointStatus: state.status }),
}));

vi.mock("@core/data/useTranslatedToolRegistry", () => {
  const tools = {
    merge: { name: "Merge", endpoints: ["merge-pdfs"] },
    convert: { name: "Convert", endpoints: ["pdf-to-img"] },
    ocr: { name: "OCR", endpoints: ["ocr-pdf"] },
    redact: { name: "Redact", endpoints: ["auto-redact"] },
    sanitize: { name: "Sanitize", endpoints: ["sanitize-pdf"] },
    changeMetadata: { name: "Metadata", endpoints: ["update-metadata"] },
    getPdfInfo: { name: "PDF info", endpoints: ["get-info-on-pdf"] },
  };
  const catalog = {
    allTools: tools,
    regularTools: tools,
    superTools: {
      automate: { name: "Automate" },
    },
    linkTools: {
      devApi: { name: "API" },
    },
  };
  return { useTranslatedToolCatalog: () => catalog };
});

import { useTranslatedToolCatalog } from "@app/data/useTranslatedToolRegistry";
import { filterToolRegistryByQuery } from "@app/utils/toolSearch";

const visibleRegularTools = () => {
  const { result } = renderHook(useTranslatedToolCatalog);
  return filterToolRegistryByQuery(result.current.regularTools, "").map(
    ({ item }) => item[0],
  );
};

test("desktop catalogue only exposes medical-redaction tools", () => {
  state.localOnly = false;
  state.status = {};

  expect(visibleRegularTools()).toEqual([
    "ocr",
    "redact",
    "sanitize",
    "changeMetadata",
    "getPdfInfo",
  ]);
});

test("local-only mode also hides medical tools whose local endpoint is unavailable", () => {
  state.localOnly = true;
  state.status = {
    "ocr-pdf": false,
    "auto-redact": true,
    "sanitize-pdf": true,
    "update-metadata": true,
    "get-info-on-pdf": true,
  };

  expect(visibleRegularTools()).toEqual([
    "redact",
    "sanitize",
    "changeMetadata",
    "getPdfInfo",
  ]);
});
