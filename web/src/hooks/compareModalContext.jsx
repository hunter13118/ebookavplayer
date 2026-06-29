import { createContext, useContext, useRef } from "react";
import ArtCompareSheet from "../components/ArtCompareSheet.jsx";
import { useCompareQueue } from "./useCompareQueue.js";

const CompareModalContext = createContext(null);

/** Compare modal lives here — outside Player — so book/player re-renders cannot unmount it. */
export function CompareModalProvider({ bookId, book, children }) {
  const compare = useCompareQueue(bookId, book);
  const onResolvedRef = useRef(() => {});

  return (
    <CompareModalContext.Provider value={{ ...compare, onResolvedRef }}>
      {children}
      <ArtCompareSheet
        book={book}
        comparison={compare.activeCompare}
        queueRemaining={compare.queueRemaining}
        open={compare.compareOpen}
        onResolved={(outcome) => onResolvedRef.current?.(outcome)}
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
