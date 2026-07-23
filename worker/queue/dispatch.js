import { handleIngestMessage } from "./ingest-consumer.js";

import { emitJobEvent } from "../_shared/job-events.js";
import { isJobCancelled } from "../_shared/imaging-lock.js";



async function emitStarted(env, message) {

  const { job_id, kind } = message.body || {};

  if (!job_id) return;

  await emitJobEvent(env, job_id, {

    type: "started",

    ts: Date.now(),

    status: "processing",

    kind: kind || "ingest",

  });

}



/** Route queue messages by kind. */

export async function onQueueBatch(batch, env) {

  for (const message of batch.messages) {

    const kind = message.body?.kind || "pack-build";

    try {

      // Cancel-processing marks a job's KV record `cancelled: true`
      // (imaging-lock.js's markJobStale) but can't remove an already-
      // enqueued message — Cloudflare Queues has no delete-by-filter
      // primitive. This is the other half of that mechanism: a message
      // that was still purely queued (never entered its consumer) when
      // the user cancelled now no-ops here instead of doing the work
      // anyway. A message whose consumer already started running before
      // the cancel still relies on that consumer's own mid-run
      // checkCancelled polling (edge-imaging.js) to stop early.
      const jobId = message.body?.job_id;
      if (jobId && await isJobCancelled(env, jobId)) {
        message.ack();
        continue;
      }

      if (kind === "ingest" || kind === "continue-extract") {

        await emitStarted(env, message);

        await handleIngestMessage(message, env);

        continue;

      }

      if (kind === "re-extract") {

        await emitStarted(env, message);

        const { handleReExtractMessage } = await import("./re-extract-consumer.js");

        await handleReExtractMessage(message, env);

        continue;

      }

      if (kind === "imaging-regen") {

        await emitStarted(env, message);

        const { handleImagingRegenMessage } = await import("./imaging-regen-consumer.js");

        await handleImagingRegenMessage(message, env);

        continue;

      }

      if (kind === "chapter-imaging") {

        const { handleChapterImagingMessage } = await import("./chapter-imaging-consumer.js");

        await handleChapterImagingMessage(message, env);

        continue;

      }

      if (kind === "moment-generate") {

        await emitStarted(env, message);

        const { handleMomentGenerateMessage } = await import("./moment-generate-consumer.js");

        await handleMomentGenerateMessage(message, env);

        continue;

      }

      if (kind === "pack-build") {

        const { handlePackBuildMessage } = await import("./pack-build-consumer.js");

        await handlePackBuildMessage(message, env);

        continue;

      }

      if (kind === "ingest-text") {

        await emitStarted(env, message);

        const { handleIngestTextMessage } = await import("./ingest-text-consumer.js");

        await handleIngestTextMessage(message, env);

        continue;

      }

      if (kind === "expression-repass") {

        await emitStarted(env, message);

        const { handleExpressionRepassMessage } = await import("./expression-repass-consumer.js");

        await handleExpressionRepassMessage(message, env);

        continue;

      }

      if (kind === "illustration-character-match") {

        await emitStarted(env, message);

        const { handleIllustrationCharacterMatchMessage } = await import("./illustration-character-match-consumer.js");

        await handleIllustrationCharacterMatchMessage(message, env);

        continue;

      }

      if (kind === "expression-sprites") {

        await emitStarted(env, message);

        const { handleExpressionSpritesMessage } = await import("./expression-sprites-consumer.js");

        await handleExpressionSpritesMessage(message, env);

        continue;

      }

      console.error("unknown queue kind", kind);

      message.retry();

    } catch (e) {

      console.error("queue dispatch", e);

      message.retry();

    }

  }

}

