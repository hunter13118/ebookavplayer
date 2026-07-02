/**
 * runOrderedDrain — bounded-concurrency producer, strictly-ordered consumer.
 * Used by the parallel chapter-extraction path so multiple chapters can be
 * extracted concurrently while every downstream step (voice assignment,
 * checkpointing, character reconciliation) still sees chapters in order.
 * Run: npm run test:ordered-drain
 */
import assert from "node:assert";
import { runOrderedDrain } from "../worker/_shared/ordered-drain.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Items finish production in reverse order (last item resolves first), but
// consumption must still happen strictly 0,1,2,... in a row.
{
  const items = [0, 1, 2, 3, 4, 5];
  const drainOrder = [];
  await runOrderedDrain(items, {
    concurrency: 3,
    produce: async (item) => {
      await delay((items.length - item) * 8);
      return `produced-${item}`;
    },
    consume: async (item, result) => {
      assert.equal(result, `produced-${item}`, "consume receives this item's own produced result");
      drainOrder.push(item);
    },
  });
  assert.deepEqual(drainOrder, items, "consume fires strictly in item order despite scrambled production");
}

// concurrency=1 behaves fully sequentially: produce(N+1) must not start until
// consume(N) has finished — preserves today's one-chapter-at-a-time behavior.
{
  const events = [];
  await runOrderedDrain([0, 1, 2], {
    concurrency: 1,
    produce: async (item) => {
      events.push(`produce-start-${item}`);
      await delay(5);
      events.push(`produce-end-${item}`);
      return item;
    },
    consume: async (item) => {
      events.push(`consume-start-${item}`);
      await delay(5);
      events.push(`consume-end-${item}`);
    },
  });
  assert.deepEqual(events, [
    "produce-start-0", "produce-end-0", "consume-start-0", "consume-end-0",
    "produce-start-1", "produce-end-1", "consume-start-1", "consume-end-1",
    "produce-start-2", "produce-end-2", "consume-start-2", "consume-end-2",
  ]);
}

// A producer error propagates, and later items are never consumed.
{
  const consumed = [];
  let threw = null;
  try {
    await runOrderedDrain([0, 1, 2, 3], {
      concurrency: 2,
      produce: async (item) => {
        if (item === 2) throw new Error("boom");
        await delay(1);
        return item;
      },
      consume: async (item) => { consumed.push(item); },
    });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw && /boom/.test(threw.message), "error from produce() propagates");
  assert.ok(consumed.length <= 2, "items at/after the failed one are never consumed");
  assert.ok(!consumed.includes(2) && !consumed.includes(3), "the failed item and later items are excluded");
}

// A consumer error also propagates and halts further draining.
{
  const consumed = [];
  let threw = null;
  try {
    await runOrderedDrain([0, 1, 2], {
      concurrency: 3,
      produce: async (item) => item,
      consume: async (item) => {
        consumed.push(item);
        if (item === 1) throw new Error("consume-boom");
      },
    });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw && /consume-boom/.test(threw.message));
  assert.deepEqual(consumed, [0, 1], "drain stops right after the failing consume");
}

// Empty input resolves immediately without calling produce/consume.
{
  let called = false;
  await runOrderedDrain([], {
    concurrency: 3,
    produce: async () => { called = true; },
    consume: async () => { called = true; },
  });
  assert.equal(called, false);
}

console.log("ordered-drain: ok");
