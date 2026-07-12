import { createContext, useContext, useRef } from "react";
import ArtCompareSheet from "../components/ArtCompareSheet.jsx";
import { useCompareQueue } from "./useCompareQueue.js";

const CompareModalContext = createContext(null);

/** Compare modal lives here — outside Player — so book/player re-renders cannot unmount it. */
export function CompareModalProvider({ bookId, book, children }) {
  const compare = useCompareQueue(bookId, book);
  const onResolvedRef = useRef(() => {});

  // Always-visible signal even when the compare modal itself isn't currently
  // showing (e.g. between popups, or after the user resolves an item while
  // later ones are still generating) — otherwise the user has no way to
  // tell whether art generation is still succeeding in the background.
  const showProgress = compare.comparePending && !compare.compareOpen
    && (compare.resolvedCount > 0 || compare.queueRemaining > 0);

  return (
    <CompareModalContext.Provider value={{ ...compare, onResolvedRef }}>
      {children}
      {showProgress && (
        <div className="vae-note vae-note-float vae-compare-progress" data-testid="compare-progress">
          Art review: {compare.resolvedCount} resolved
          {compare.queueRemaining > 0 ? ` · ${compare.queueRemaining} more coming` : " · waiting on more…"}
        </div>
      )}
      <ArtCompareSheet
        book={book}
        comparison={compare.activeCompare}
        queueRemaining={compare.queueRemaining}
        open={compare.compareOpen}
        onResolved={(outcome) => onResolvedRef.current?.(outcome)}
        onRetry={(jobId) => compare.startCompareJob(jobId)}
      />
    </CompareModalContext.Provider>
  );
}

export function useCompareModal() {
  const ctx = useContext(CompareModalContext);
  if (!ctx) {
    throw new Error("useCompareModal must be used inside CompareModalProvider");
  }
  return ctx;
}
