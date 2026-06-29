import { useCallback, useEffect, useRef, useState } from "react";
import {
  downloadOfflinePack, importOfflinePackFiles, cancelPackBuild,
  fetchExternalAudioManifest, importExternalAudioFile, deleteExternalAudio,
  exportInstalledPack, linkPackFolder, unlinkPackFolder, scanLinkedPackFolder,
  supportsFolderLibrary, scanLinkedFolderSummary, getLinkedFolderInfo,
  TIER_VISUAL, TIER_AUDIOBOOK,
} from "../offline/bookSource.js";
import { offlineWorkflowHint } from "../offline/catalogSources.js";
import { isPackArchiveName } from "../offline/packIo.js";
import { deletePack, formatBytes, packSizeBytes } from "../offline/packStore.js";
import { tierLabel } from "../offline/packFormat.js";

function formatImportSummary({ imported, failed, skipped }) {
  const parts = [];
  if (imported.length) parts.push(`${imported.length} imported`);
  if (failed.length) parts.push(`${failed.length} failed`);
  if (skipped.length) parts.push(`${skipped.length} skipped`);
  return parts.join(", ") || "Nothing imported";
}

/** Download, import, export, and folder-link offline packs. */
export default function OfflinePackTray({ bookId, title, onInstalled, onCatalogRefresh, installedPack }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [tier, setTier] = useState(TIER_VISUAL);
  const [forceRebuild, setForceRebuild] = useState(false);
  const [buildProgress, setBuildProgress] = useState(null);
  const [activeJobId, setActiveJobId] = useState(null);
  const [externalAudio, setExternalAudio] = useState(null);
  const [folderInfo, setFolderInfo] = useState(null);
  const [folderSummary, setFolderSummary] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const cancelRef = useRef(false);
  const folderSupported = supportsFolderLibrary();

  const refreshFolderStatus = useCallback(async () => {
    if (!folderSupported) return;
    const info = await getLinkedFolderInfo();
    setFolderInfo(info);
    if (info) {
      try {
        setFolderSummary(await scanLinkedFolderSummary());
      } catch {
        setFolderSummary(null);
      }
    } else {
      setFolderSummary(null);
    }
  }, [folderSupported]);

  useEffect(() => {
    refreshFolderStatus();
  }, [refreshFolderStatus, installedPack?.pack_id]);

  useEffect(() => {
    if (!bookId) { setExternalAudio(null); return undefined; }
    let alive = true;
    (async () => {
      try {
        const m = await fetchExternalAudioManifest(bookId);
        if (alive) setExternalAudio(m);
      } catch {
        if (alive) setExternalAudio(null);
      }
    })();
    return () => { alive = false; };
  }, [bookId, installedPack?.pack_id]);

  async function runImportFiles(fileList) {
    const files = [...(fileList || [])].filter((f) => f && isPackArchiveName(f.name));
    if (!files.length) {
      setMsg("Drop .vaepack or .zip files only.");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const results = await importOfflinePackFiles(files);
      const summary = formatImportSummary(results);
      if (results.imported.length === 1) {
        setMsg(`Imported ${results.imported[0].title}.`);
      } else {
        setMsg(`${summary}.`);
      }
      if (results.failed.length) {
        setMsg((m) => `${m} ${results.failed[0].name}: ${results.failed[0].error}`);
      }
      if (results.imported.length) {
        onInstalled?.(results.imported[results.imported.length - 1]);
        await onCatalogRefresh?.();
      }
    } catch (e) {
      setMsg(e.message || "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload() {
    setBusy(true);
    setMsg("");
    setBuildProgress(null);
    setActiveJobId(null);
    cancelRef.current = false;
    try {
      const rec = await downloadOfflinePack(bookId, {
        tier,
        force: forceRebuild,
        onJobStarted: (jobId, st) => {
          setActiveJobId(jobId);
          if (st.cached) setMsg("Using cached server pack…");
        },
        onProgress: (progress, detail, st) => {
          setBuildProgress({ progress, detail });
          if (st?.cached && progress >= 1) setMsg("Using cached server pack.");
          if (st?.audio_source === "external-pack") {
            setMsg((m) => m || "Building from imported audio clips…");
          }
        },
      });
      if (cancelRef.current) return;
      const size = formatBytes(await packSizeBytes(rec.pack_id));
      setMsg(`Installed to this browser (${tier} pack, ${size}). Open the book to play offline. Export .vaepack to keep a file copy with your reading progress.`);
      onInstalled?.(rec);
      await onCatalogRefresh?.();
    } catch (e) {
      if (!cancelRef.current) setMsg(e.message || "Download failed.");
    } finally {
      setBusy(false);
      setBuildProgress(null);
      setActiveJobId(null);
    }
  }

  async function handleCancel() {
    if (!activeJobId || !bookId) return;
    cancelRef.current = true;
    try {
      await cancelPackBuild(bookId, activeJobId);
      setMsg("Build cancelled.");
    } catch (e) {
      setMsg(e.message || "Cancel failed.");
    } finally {
      setBusy(false);
      setBuildProgress(null);
      setActiveJobId(null);
    }
  }

  async function handleImport(ev) {
    const files = [...(ev.target.files || [])];
    ev.target.value = "";
    if (!files.length) return;
    await runImportFiles(files);
  }

  async function handleExport() {
    if (!installedPack?.pack_id) return;
    setBusy(true);
    setMsg("");
    try {
      await exportInstalledPack(installedPack.pack_id);
      setMsg(`Exported ${installedPack.title || installedPack.book_id}.vaepack.`);
    } catch (e) {
      setMsg(e.message || "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLinkFolder() {
    setBusy(true);
    setMsg("");
    try {
      const linked = await linkPackFolder();
      setFolderInfo({ name: linked.name, linked_at: linked.linked_at });
      const results = await scanLinkedPackFolder({ force: true });
      setMsg(results.imported.length
        ? `Linked "${linked.name}" — ${formatImportSummary(results)}.`
        : `Linked folder "${linked.name}".`);
      if (results.imported.length) await onCatalogRefresh?.();
      await refreshFolderStatus();
    } catch (e) {
      if (e.name !== "AbortError") setMsg(e.message || "Could not link folder.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRescanFolder(force = false) {
    setBusy(true);
    setMsg("");
    try {
      const results = await scanLinkedPackFolder({ force });
      setMsg(results.message || `${formatImportSummary(results)}.`);
      if (results.imported.length) await onCatalogRefresh?.();
      await refreshFolderStatus();
    } catch (e) {
      setMsg(e.message || "Folder scan failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlinkFolder() {
    setBusy(true);
    try {
      await unlinkPackFolder();
      setFolderInfo(null);
      setFolderSummary(null);
      setMsg("Unlinked offline folder.");
    } catch (e) {
      setMsg(e.message || "Unlink failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleImportAudio(ev) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file || !bookId) return;
    setBusy(true);
    setMsg("");
    try {
      const out = await importExternalAudioFile(bookId, file);
      setExternalAudio(out);
      setMsg(`Imported ${out.line_count} external audio clips (maker / custom voices).`);
    } catch (e) {
      setMsg(e.message || "Audio import failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveExternalAudio() {
    if (!bookId) return;
    setBusy(true);
    try {
      await deleteExternalAudio(bookId);
      setExternalAudio({ available: false, line_count: 0 });
      setMsg("Removed external audio clips.");
    } catch (e) {
      setMsg(e.message || "Remove audio failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (!installedPack?.pack_id) return;
    setBusy(true);
    try {
      await deletePack(installedPack.pack_id);
      setMsg("Removed local pack.");
      onInstalled?.(null);
      await onCatalogRefresh?.();
    } catch (e) {
      setMsg(e.message || "Remove failed.");
    } finally {
      setBusy(false);
    }
  }

  function onDragOver(ev) {
    ev.preventDefault();
    setDragOver(true);
  }

  function onDragLeave(ev) {
    if (ev.currentTarget.contains(ev.relatedTarget)) return;
    setDragOver(false);
  }

  async function onDrop(ev) {
    ev.preventDefault();
    setDragOver(false);
    if (busy) return;
    await runImportFiles([...(ev.dataTransfer?.files || [])]);
  }

  const pct = buildProgress ? Math.round((buildProgress.progress || 0) * 100) : 0;

  return (
    <div
      className={`vae-offline-tray${dragOver ? " vae-drop-active" : ""}`}
      data-testid="offline-pack-tray"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <h3 className="vae-lib-heading">Offline pack{title ? `: ${title}` : ""}</h3>
      <p className="vae-offline-hint vae-offline-workflow" data-testid="offline-workflow-hint">
        {offlineWorkflowHint()}
      </p>
      <p className="vae-offline-hint">
        <strong>Install for offline</strong> copies the book into this browser for fast offline play.
        <strong> Export .vaepack</strong> writes a durable file (reading progress included) — save it to
        iOS Files or a linked folder. <strong>Import</strong> restores after the app clears its data.
      </p>

      {folderSupported && (
        <div className="vae-offline-folder" data-testid="offline-folder-panel">
          {folderInfo ? (
            <>
              <div className="vae-offline-installed">
                Folder library: <strong>{folderInfo.name}</strong>
                {folderSummary?.pack_count != null && (
                  <> · {folderSummary.pack_count} pack{folderSummary.pack_count === 1 ? "" : "s"}
                  {folderSummary.pending > 0 && ` · ${folderSummary.pending} new`}</>
                )}
              </div>
              <div className="vae-offline-actions vae-offline-actions-inline">
                <button type="button" className="vae-btn vae-btn-muted" disabled={busy}
                  data-testid="offline-folder-rescan" onClick={() => handleRescanFolder(false)}>
                  Scan folder
                </button>
                <button type="button" className="vae-btn vae-btn-muted" disabled={busy}
                  data-testid="offline-folder-force" onClick={() => handleRescanFolder(true)}>
                  Re-import all
                </button>
                <button type="button" className="vae-btn vae-btn-muted" disabled={busy}
                  data-testid="offline-folder-unlink" onClick={handleUnlinkFolder}>
                  Unlink
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="vae-btn vae-btn-muted" disabled={busy}
              data-testid="offline-folder-link" onClick={handleLinkFolder}>
              Link folder… (Mac/PC)
            </button>
          )}
        </div>
      )}
      {externalAudio?.available && (
        <div className="vae-offline-installed" data-testid="external-audio-status">
          External audio: <strong>{externalAudio.line_count}</strong> clips on server
          <button type="button" className="vae-btn vae-btn-muted vae-btn-inline"
            data-testid="external-audio-remove" disabled={busy}
            onClick={handleRemoveExternalAudio}>Remove</button>
        </div>
      )}
      {installedPack && (
        <div className="vae-offline-installed" data-testid="offline-installed">
          Installed: <strong>{installedPack.tier}</strong> ({installedPack.style})
          {installedPack.pack_size ? ` · ${installedPack.pack_size}` : ""}
        </div>
      )}
      {buildProgress && (
        <div className="vae-offline-build" data-testid="offline-build-progress" data-progress={pct}>
          <div className="vae-offline-build-bar" style={{ width: `${pct}%` }} />
          <span>{buildProgress.detail || "Building audiobook pack…"} · {pct}%</span>
        </div>
      )}
      <div className="vae-offline-actions">
        <label className="vae-offline-tier">
          Pack type
          <select value={tier} disabled={busy} onChange={(e) => setTier(e.target.value)}>
            <option value={TIER_VISUAL}>{tierLabel(TIER_VISUAL)}</option>
            <option value={TIER_AUDIOBOOK}>{tierLabel(TIER_AUDIOBOOK)}</option>
          </select>
        </label>
        {bookId && tier === TIER_AUDIOBOOK && (
          <label className="vae-offline-tier vae-offline-check">
            <input type="checkbox" checked={forceRebuild} disabled={busy}
              onChange={(e) => setForceRebuild(e.target.checked)} />
            Force rebuild (ignore cache)
          </label>
        )}
        {bookId && (
          <button type="button" className="vae-btn" disabled={busy}
            data-testid="offline-download" onClick={handleDownload}>
            {busy ? "Working…" : "Install for offline"}
          </button>
        )}
        {busy && activeJobId && (
          <button type="button" className="vae-btn vae-btn-muted"
            data-testid="offline-cancel" onClick={handleCancel}>
            Cancel build
          </button>
        )}
        <label className="vae-btn vae-btn-file">
          {busy ? "Working…" : "Import .vaepack"}
          <input type="file" accept=".vaepack,.zip,application/zip" multiple hidden
            data-testid="offline-import" onChange={handleImport} disabled={busy} />
        </label>
        {installedPack && (
          <button type="button" className="vae-btn vae-btn-muted" disabled={busy}
            data-testid="offline-export" onClick={handleExport}>
            Export .vaepack
          </button>
        )}
        {bookId && (
          <label className="vae-btn vae-btn-file">
            Import audio zip
            <input type="file" accept=".zip,.vaepack,application/zip" hidden
              data-testid="external-audio-import" onChange={handleImportAudio} disabled={busy} />
          </label>
        )}
        {installedPack && (
          <button type="button" className="vae-btn vae-btn-muted" disabled={busy}
            data-testid="offline-remove" onClick={handleRemove}>
            Remove local pack
          </button>
        )}
      </div>
      {dragOver && (
        <div className="vae-drop-overlay" data-testid="offline-drop-overlay">
          Drop .vaepack files to import
        </div>
      )}
      {msg && <div className="vae-offline-msg" data-testid="offline-msg">{msg}</div>}
    </div>
  );
}
