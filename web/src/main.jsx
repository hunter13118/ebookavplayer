import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import { ErrorBoundary } from "./lib/ErrorBoundary.jsx";
import { PortfolioClerkProvider } from "./lib/portfolioClerk.jsx";
import { initLocalApiBridgeFromUrl } from "./localApiBridge.js";

if (!import.meta.env.VITE_DISABLE_PWA) {
  const { registerSW } = await import("virtual:pwa-register");
  registerSW({ immediate: true });
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
