import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import "./styles-components.css";
import { ErrorBoundary } from "./lib/ErrorBoundary.jsx";
import { PortfolioClerkProvider } from "./lib/portfolioClerk.jsx";
import { initLocalApiBridgeFromUrl } from "./localApiBridge.js";

if (!import.meta.env.VITE_DISABLE_PWA) {
  // Not top-level awaited: the portfolio embed's build target (older browser
  // set, for broad compat across the whole site) doesn't support top-level
  // await, and registration is fire-and-forget anyway — nothing downstream
  // depends on it having resolved.
  import("virtual:pwa-register").then(({ registerSW }) => registerSW({ immediate: true }));
}
initLocalApiBridgeFromUrl();

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <PortfolioClerkProvider publishableKey={publishableKey}>
      <React.StrictMode>
        <App />
      </React.StrictMode>
    </PortfolioClerkProvider>
  </ErrorBoundary>,
);
