import { useState } from "react";
import { getSectionCollapsed, setSectionCollapsed } from "../library/librarySections.js";

/** A collapsible library section — one per backend connection. */
export default function CollapsibleSection({
  id, title, subtitle, count, defaultCollapsed = false, children,
}) {
  const [collapsed, setCollapsed] = useState(() => {
    const stored = getSectionCollapsed(id);
    return stored === undefined ? defaultCollapsed : stored;
  });

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      setSectionCollapsed(id, next);
      return next;
    });
  }

  return (
    <section className="vae-lib-section" data-testid={`library-section-${id}`}>
      <button
        type="button"
        className="vae-lib-section-head"
        data-testid={`library-section-toggle-${id}`}
        aria-expanded={!collapsed}
        onClick={toggle}
      >
        <span className={`vae-lib-section-caret${collapsed ? " vae-lib-section-caret-collapsed" : ""}`} aria-hidden>▾</span>
        <span className="vae-lib-section-title">{title}</span>
        {subtitle && <span className="vae-lib-section-subtitle">{subtitle}</span>}
        <span className="vae-lib-section-count">{count}</span>
      </button>
      {!collapsed && children}
    </section>
  );
}
