import { useCallback, useState } from "react";
import { createClientBanner } from "../clientBanners.js";

const MAX_CLIENT = 8;

/** Local banner stack (not persisted; session-only). */
export function useClientBanners() {
  const [banners, setBanners] = useState([]);

  const pushBanner = useCallback((level, code, message) => {
    const b = createClientBanner(level, code, message);
    setBanners((prev) => [...prev, b].slice(-MAX_CLIENT));
    return b.id;
  }, []);

  return { banners, pushBanner };
}
