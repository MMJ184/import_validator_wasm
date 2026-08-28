// The pacer trades yields for throughput. Both halves of that trade need to
// hold: it must skip most yields, and it must never stop yielding entirely.
import assert from "node:assert/strict";
import test from "node:test";
import { createTickPacer } from "../dist/pipeline/csvPipeline.js";

/**
 * True if `body` crossed a macrotask boundary.
 *
 * Timers and MessageChannel messages run in different phases, so a setTimeout
 * flag races the pacer's own channel. A self-rescheduling microtask chain is
 * deterministic instead: it only drains fully if something waits for a
 * macrotask, since microtasks always run to exhaustion first.
 */
const MICRO_DEPTH = 50;
async function observeMacrotask(body) {
    let micro = 0;
    const bump = () => {
        if (micro < MICRO_DEPTH) {
            micro += 1;
            Promise.resolve().then(bump);
        }
    };
    bump();
    await body();
    return micro >= MICRO_DEPTH;
}

test("skips yields inside the interval", async () => {
    const maybeTick = createTickPacer(60_000);
    const ran = await observeMacrotask(async () => {
        // Well under the skip ceiling, so none of these should yield.
        for (let i = 0; i < 10; i++) await maybeTick();
    });
    assert.equal(ran, false, "should not have yielded a macrotask yet");
});

test("keeps skipping for as long as the interval lasts", async () => {
    // The probe only discriminates while the body performs few awaits, so keep
    // the loop short: many sequential awaits drain the microtask chain on their
    // own and the detector would read true regardless.
    const maybeTick = createTickPacer(60_000);
    for (let i = 0; i < 500; i++) await maybeTick();
    const ran = await observeMacrotask(async () => {
        for (let i = 0; i < 10; i++) await maybeTick();
    });
    assert.equal(ran, false, "no yields until the interval elapses, however many chunks");
});

test("yields once the interval has elapsed", async () => {
    const maybeTick = createTickPacer(1);
    await new Promise((r) => setTimeout(r, 5));
    const ran = await observeMacrotask(async () => {
        await maybeTick();
    });
    assert.equal(ran, true, "elapsed interval must yield");
});

test("yields to due timers, not only to the message queue", async () => {
    // timeoutMs is a setTimeout inside the worker. Under Node a MessageChannel
    // yield is delivered without draining the timer phase, so a pacer that only
    // ever used port messages would let a validation run past its timeout.
    const maybeTick = createTickPacer(0); // interval 0 => every call yields
    let fired = false;
    const timer = setTimeout(() => { fired = true; }, 0);
    try {
        for (let i = 0; i < 12 && !fired; i++) await maybeTick();
    } finally {
        clearTimeout(timer);
    }
    assert.ok(fired, "a due setTimeout must get a chance to run while ticking");
});

test("each pacer keeps its own state", async () => {
    const a = createTickPacer(60_000);
    const b = createTickPacer(60_000);
    for (let i = 0; i < 60; i++) await a();
    const ran = await observeMacrotask(async () => {
        for (let i = 0; i < 10; i++) await b();
    });
    assert.equal(ran, false, "b must not inherit a's skip count");
});
