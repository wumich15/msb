"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Matches the breakpoint where globals.css turns the three panels into tabs. */
export const NARROW_LAYOUT_QUERY = "(max-width: 900px)";

/**
 * Reads a media query as React state.
 *
 * The workspace panels are laid out side by side on wide screens and become
 * tabs on narrow ones, so the tab selection may only hide a panel while the
 * tabs are actually on screen. Server rendering reports no match, and
 * `useSyncExternalStore` re-renders with the real value after hydration.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
