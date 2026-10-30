import { useEffect, useState } from "react";
import { Group, NumberInput, Paper } from "@mantine/core";
import { ZoomMode } from "@embedpdf/plugin-zoom/react";
import { useTranslation } from "react-i18next";
import { useViewer } from "@app/contexts/ViewerContext";
import { Tooltip } from "@app/components/shared/Tooltip";
import { ActionIcon } from "@app/ui/ActionIcon";
import { Icon } from "@app/ui/Icon";
import "@core/components/viewer/PdfViewerToolbar.css";

interface PdfViewerToolbarProps {
  currentPage?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
}

export function PdfViewerToolbar({
  currentPage = 1,
  onPageChange,
}: PdfViewerToolbarProps) {
  const { t } = useTranslation();
  const {
    getScrollState,
    getZoomState,
    scrollActions,
    zoomActions,
    zoomRestorePendingRef,
    zoomRestoreSettledTick,
    registerImmediateZoomUpdate,
    registerImmediateScrollUpdate,
  } = useViewer();
  const scrollState = getScrollState();
  const zoomState = getZoomState();
  const [pageInput, setPageInput] = useState(
    scrollState.currentPage || currentPage,
  );
  const [zoomPercent, setZoomPercent] = useState(
    () => zoomState.zoomPercent || 100,
  );
  const [zoomLevel, setZoomLevel] = useState(() => zoomState.level);

  useEffect(() => {
    const unregister = registerImmediateScrollUpdate((page) => {
      setPageInput(page);
    });
    setPageInput(scrollState.currentPage);
    return () => unregister?.();
  }, [registerImmediateScrollUpdate, scrollState.currentPage]);

  useEffect(() => {
    const unregister = registerImmediateZoomUpdate((percent) => {
      if (zoomRestorePendingRef.current) return;
      setZoomPercent(percent);
      setZoomLevel(getZoomState().level);
    });
    if (!zoomRestorePendingRef.current) {
      setZoomPercent(zoomState.zoomPercent || 100);
      setZoomLevel(zoomState.level);
    }
    return () => unregister?.();
  }, [
    getZoomState,
    registerImmediateZoomUpdate,
    zoomRestorePendingRef,
    zoomRestoreSettledTick,
    zoomState.level,
    zoomState.zoomPercent,
  ]);

  const goToPage = (page: number) => {
    scrollActions.scrollToPage(page);
    onPageChange?.(page);
    setPageInput(page);
  };
  const fitWidth = zoomLevel === ZoomMode.FitWidth;
  const fitPage = zoomLevel === ZoomMode.FitPage;

  return (
    <Paper
      className="pdf-viewer-toolbar"
      px={10}
      py={6}
      data-medical-viewer-toolbar
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        pointerEvents: "auto",
      }}
    >
      <ActionIcon
        variant="tertiary"
        size="sm"
        onClick={() => scrollActions.scrollToFirstPage()}
        disabled={scrollState.currentPage === 1}
        aria-label={t("viewer.firstPage", "第一页")}
      >
        <Icon name="chevron-first" size={18} />
      </ActionIcon>
      <ActionIcon
        variant="tertiary"
        size="sm"
        onClick={() => scrollActions.scrollToPreviousPage()}
        disabled={scrollState.currentPage === 1}
        aria-label={t("viewer.previousPage", "上一页")}
      >
        <Icon name="chevron-left" size={18} />
      </ActionIcon>

      <NumberInput
        value={pageInput}
        onChange={(value) => {
          const page = Number(value);
          setPageInput(page);
          if (
            Number.isFinite(page) &&
            page >= 1 &&
            page <= scrollState.totalPages
          ) {
            goToPage(page);
          }
        }}
        min={1}
        max={scrollState.totalPages}
        hideControls
        size="xs"
        aria-label="当前页"
        styles={{ input: { width: 52, textAlign: "center" } }}
      />
      <span aria-label="总页数">/ {scrollState.totalPages}</span>

      <ActionIcon
        variant="tertiary"
        size="sm"
        onClick={() => scrollActions.scrollToNextPage()}
        disabled={scrollState.currentPage === scrollState.totalPages}
        aria-label={t("viewer.nextPage", "下一页")}
      >
        <Icon name="chevron-right" size={18} />
      </ActionIcon>
      <ActionIcon
        variant="tertiary"
        size="sm"
        onClick={() => scrollActions.scrollToLastPage()}
        disabled={scrollState.currentPage === scrollState.totalPages}
        aria-label={t("viewer.lastPage", "最后一页")}
      >
        <Icon name="chevron-last" size={18} />
      </ActionIcon>

      <div className="pdf-viewer-toolbar__divider" />

      <ActionIcon
        variant="tertiary"
        size="sm"
        onClick={() => zoomActions.zoomOut()}
        aria-label={t("viewer.zoomOut", "缩小")}
      >
        <Icon name="zoom-out" size={18} />
      </ActionIcon>
      <span
        style={{
          minWidth: "3rem",
          textAlign: "center",
          fontSize: 12,
          color: "var(--c-text-subtle)",
        }}
        aria-label="缩放比例"
      >
        {zoomPercent}%
      </span>
      <ActionIcon
        variant="tertiary"
        size="sm"
        onClick={() => zoomActions.zoomIn()}
        aria-label={t("viewer.zoomIn", "放大")}
      >
        <Icon name="zoom-in" size={18} />
      </ActionIcon>

      <Group gap={4} wrap="nowrap">
        <Tooltip
          content={t("viewer.fitWidth", "适合宽度")}
          position="top"
          arrow
        >
          <ActionIcon
            variant={fitWidth ? "primary" : "tertiary"}
            size="sm"
            onClick={() => zoomActions.requestZoom(ZoomMode.FitWidth)}
            aria-label={t("viewer.fitWidth", "适合宽度")}
            aria-pressed={fitWidth}
          >
            <Icon name="arrow-left-right" size={18} />
          </ActionIcon>
        </Tooltip>
        <Tooltip content={t("viewer.fitPage", "适合页面")} position="top" arrow>
          <ActionIcon
            variant={fitPage ? "primary" : "tertiary"}
            size="sm"
            onClick={() => zoomActions.requestZoom(ZoomMode.FitPage)}
            aria-label={t("viewer.fitPage", "适合页面")}
            aria-pressed={fitPage}
          >
            <Icon name="scan" size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Paper>
  );
}
