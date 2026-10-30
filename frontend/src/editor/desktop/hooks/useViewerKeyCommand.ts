import { useCallback } from "react";

export function useViewerKeyCommand(): (event: KeyboardEvent) => boolean {
  return useCallback((event: KeyboardEvent): boolean => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return false;

    switch (event.key) {
      case "p":
      case "P":
      case "s":
      case "S":
      case "f":
      case "F":
      case "r":
      case "R":
        event.preventDefault();
        event.stopPropagation();
        return true;
      default:
        return false;
    }
  }, []);
}
