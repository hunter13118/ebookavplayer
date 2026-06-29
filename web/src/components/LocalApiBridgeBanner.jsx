import { useEffect, useState } from "react";
import {
  BRIDGE_CHANGE_EVENT,
  clearLocalApiBridge,
  localBridgeLabel,
} from "../localApiBridge.js";

/** Shown when API calls are redirected to a local wrangler edge worker. */
export default function LocalApiBridgeBanner() {
  const [label, setLabel] = useState(() => localBridgeLabel());

  useEffect(() => {
    const refresh = () => setLabel(localBridgeLabel());
    window.addEventListener(BRIDGE_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(BRIDGE_CHANGE_EVENT, refresh);
  }, []);

  if (!label) return null;

  return (
    <div className="vae-local-api-banner" data-testid="local-api-banner" role="status">
      <span>Local API: {label}</span>
      <button
        type="button"
        className="vae-local-api-banner-dismiss"
        onClick={() => {
          clearLocalApiBridge();
          window.location.reload();
        }}
      >
        Disconnect
      </button>
    </div>
  );
}
