import { useState } from "react";

import { previewEdgeVoice } from "../api.js";

import {

  mergeVoiceOverride,

  parseVoiceSelect,

  resolveVoiceSettings,

  voiceSelectValue,

} from "../audio/voiceOverrides.js";

import {

  formatHz,

  formatPct,

  parseHz,

  parsePct,

  prosodySummary,

} from "../audio/voiceProsody.js";

import {

  resolveActiveVoiceId,

  voiceFriendlyLabel,

} from "../audio/voiceDisplay.js";



const PREVIEW_PHRASE = "The quick brown fox jumps over the lazy dog.";



function buildOptions(voices, compiledVoice, defaultLabel) {

  const bookLabel = voiceFriendlyLabel(voices, compiledVoice);

  const opts = [

    <option key="def" value={`default:${compiledVoice || ""}`}>

      {defaultLabel} — {bookLabel}

    </option>,

  ];

  (voices || []).forEach((v) => {

    const id = v.id || v.ShortName;

    if (!id || id === compiledVoice) return;

    const label = v.label || v.FriendlyName || v.Name || id;

    opts.push(

      <option key={id} value={`edge:${id}`}>

        {label}

      </option>,

    );

  });

  return opts;

}



/** Voice picker with prosody tweaks + preview of active settings. */

export default function VoiceField({

  label,

  testId,

  compiledVoice,

  compiledPitch = "+0Hz",

  compiledRate = "+0%",

  override,

  voices,

  onChange,

}) {

  const [previewing, setPreviewing] = useState(false);

  const [previewErr, setPreviewErr] = useState("");

  const value = voiceSelectValue(override, compiledVoice);

  const compiled = { voice: compiledVoice, pitch: compiledPitch, rate: compiledRate };

  const active = resolveVoiceSettings(override, compiled);

  const activeId = resolveActiveVoiceId(override, compiledVoice);

  const activeLabel = voiceFriendlyLabel(voices, activeId || active.voice);

  const prosody = prosodySummary(active);



  const pitchVal = parseHz(active.pitch);

  const rateVal = parsePct(active.rate);

  const volumeVal = parsePct(active.volume);



  function patchProsody(patch) {

    onChange(mergeVoiceOverride({
      source: override?.source || "default",
      voice: override?.voice || "",
      ...override,
    }, patch));

  }



  async function preview() {

    setPreviewErr("");

    if (!active.voice) {

      setPreviewErr("No voice selected.");

      return;

    }

    setPreviewing(true);

    try {

      await previewEdgeVoice(PREVIEW_PHRASE, {

        voice: active.voice,

        pitch: active.pitch,

        rate: active.rate,

        volume: active.volume,

      });

    } catch (e) {

      setPreviewErr(e.message || "Preview failed.");

    } finally {

      setPreviewing(false);

    }

  }



  return (

    <div className="vae-voice-field">

      <div className="vae-voice-field-head">

        <span className="vae-voice-field-name">{label}</span>

        <span className="vae-voice-active" data-testid={`${testId}-active`}>

          Active: {activeLabel}{prosody}

        </span>

      </div>

      <div className="vae-voice-field-row">

        <span className="vae-select-wrap">
          <select

            className="vae-select"

            data-testid={testId}

            value={value}

            onChange={(e) => onChange(parseVoiceSelect(e.target.value, override))}

          >

            {buildOptions(voices, compiledVoice, "Book default")}

          </select>
        </span>

        <button

          type="button"

          className="vae-voice-preview-btn"

          data-testid={`${testId}-preview`}

          disabled={previewing}

          title="Preview active voice + pitch/rate/volume with the fox phrase."

          onClick={preview}

        >

          {previewing ? "…" : "▶"}

        </button>

      </div>

      <div className="vae-voice-prosody">

        <label className="vae-voice-slider">

          <span>Pitch {formatHz(pitchVal)}</span>

          <input

            type="range"

            min={-24}

            max={24}

            step={1}

            data-testid={`${testId}-pitch`}

            value={pitchVal}

            onChange={(e) => patchProsody({ pitch: formatHz(e.target.value) })}

          />

        </label>

        <label className="vae-voice-slider">

          <span>Rate {formatPct(rateVal)}</span>

          <input

            type="range"

            min={-40}

            max={40}

            step={1}

            data-testid={`${testId}-rate`}

            value={rateVal}

            onChange={(e) => patchProsody({ rate: formatPct(e.target.value) })}

          />

        </label>

        <label className="vae-voice-slider">

          <span>Volume {formatPct(volumeVal)}</span>

          <input

            type="range"

            min={-50}

            max={50}

            step={1}

            data-testid={`${testId}-volume`}

            value={volumeVal}

            onChange={(e) => patchProsody({ volume: formatPct(e.target.value) })}

          />

        </label>

      </div>

      {previewErr && <span className="vae-voice-preview-err">{previewErr}</span>}

    </div>

  );

}

