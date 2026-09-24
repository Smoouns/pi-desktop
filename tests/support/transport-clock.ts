import assert from "node:assert/strict";
import type { TransportOptions } from "../../evals/core/request-transport.js";

/** Never replaces global timers. Advance only after observing the intended phase. */
export function createTransportTestClock() {
  let current = 0, nextId = 0;
  const timers = new Map<number, { callback: () => void; deadline: number; delay: number }>();
  const delays: number[] = [];
  const timing: Required<Pick<TransportOptions, "now" | "setTimer" | "clearTimer">> = {
    now: () => current,
    setTimer: ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
      assert.ok(Number.isFinite(delay) && delay >= 0);
      const id = ++nextId;
      timers.set(id, { callback: () => callback(...args), deadline: current + delay, delay });
      delays.push(delay);
      return id;
    }) as unknown as typeof setTimeout,
    clearTimer: ((id: unknown) => { timers.delete(Number(id)); }) as typeof clearTimeout,
  };
  return {
    timing,
    snapshot: () => ({ current, pending: timers.size, delays: [...delays] }),
    expireNext(expectedDelay: number) {
      // A cleared journal timer must not fire while testing the network phase.
      assert.equal(timers.size, 1, "Expected exactly one active phase deadline");
      const [id, timer] = timers.entries().next().value!;
      assert.equal(timer.delay, expectedDelay);
      current = timer.deadline;
      timers.delete(id);
      timer.callback();
    },
  };
}

export function phaseSignal() {
  let reached!: () => void;
  const promise = new Promise<void>(resolve => { reached = resolve; });
  return { promise, reached };
}

/** Real watchdog only bounds a broken test; it never selects the expected stop code. */
export async function expectTimeoutAtPhase(
  pending: Promise<unknown>, phase: Promise<void>, clock: ReturnType<typeof createTransportTestClock>,
  code: "REQUEST_TIMEOUT" | "JOURNAL_FAILURE", delay: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Transport phase test did not settle")), 30_000);
  });
  try {
    // An early failure (e.g. real journal I/O rejection) must fail, not hang waiting
    // for fetch or get mistaken for the deliberately injected timeout.
    await Promise.race([phase, pending.then(() => { throw new Error("Request finished before the test deadline"); }), watchdog]);
    clock.expireNext(delay);
    await Promise.race([assert.rejects(pending, { code }), watchdog]);
    assert.equal(clock.snapshot().pending, 0);
  } finally { clearTimeout(timer); }
}
