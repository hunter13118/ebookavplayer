// Dev-only harness for the M4B-first karaoke reader (Task: reader-first
// milestone). Mounted by main.jsx when the URL has ?karaoke-demo, it loads the
// real transcript fixture (produced by the align server's /transcribe over the
// 6-min demo clip) plus the demo audio, and drops straight into KaraokeReader.
// Not part of any production path — lets the reader be verified end-to-end
// against real word timings before the upload flow is wired.
import { useEffect, useState } from "react";
import KaraokeReader from "./KaraokeReader.jsx";
import transcript from "./__fixtures__/demoTranscript.json";

export default function KaraokeDemo() {
  const [blob, setBlob] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}__karaoke_demo__.m4b`)
      .then((r) => { if (!r.ok) throw new Error(`demo audio HTTP ${r.status}`); return r.blob(); })
      .then(setBlob)
      .catch((e) => setErr(e.message));
  }, []);

  if (err) return <div style={{ padding: 24, color: "#e0525b" }}>Karaoke demo: {err}</div>;
  if (!blob) return <div style={{ padding: 24, color: "#9aa3bd" }}>Loading demo audio…</div>;
  return <KaraokeReader transcript={transcript} blob={blob} onExit={() => { window.location.search = ""; }} />;
}
