import { useEffect, useRef } from "react";

/** Live processing log — events received via SSE (not client polling). */
export default function ProcessingLog({ entries = [] }) {
  const scrollRef = useRef(null);
  const tailRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    tailRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [entries]);

  if (!entries.length) return null;

  const tail = entries.slice(-40);
  const lastIdx = tail.length - 1;

  return (
    <details ref={scrollRef} className="vae-processing-log" data-testid="processing-log" defaultOpen>
      <summary>Processing log ({entries.length} events)</summary>
      <ol className="vae-processing-log-list">
        {tail.map((row, i) => (
          <li
            key={`${row.ts}-${i}`}
            ref={i === lastIdx ? tailRef : undefined}
            data-type={row.type}
            data-tail={i === lastIdx ? "true" : undefined}
          >
            <time dateTime={new Date(row.ts).toISOString()}>
              {new Date(row.ts).toLocaleTimeString()}
            </time>
            {row.phase && <span className="vae-processing-log-phase">{row.phase}</span>}
            <span className="vae-processing-log-text">{row.text}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
