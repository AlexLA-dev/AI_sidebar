// A clock for the code under test instead of real time: a test bundles that code with esbuild, whose define swaps
// its setTimeout and clearTimeout for this clock's (fakeTimers), and the timers fire only when the test advances
// the clock, in order, with the promise callbacks they start run in between. Real time and the machine's load
// (the whole suite runs its files at once) can't change what a test sees (2.5 (78): a swipe test failed once
// in a full run).

interface Timer {
  at: number
  order: number
  run: () => void
}

export interface FakeClock {
  setTimeout: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => number
  clearTimeout: (id: unknown) => void
  /** Moves the clock `ms` on, firing every timer due by then (those the timers set too). */
  advance: (ms: number) => Promise<void>
  /** Timers waiting to fire. */
  pending: () => number
}

/** The promise callbacks queued now, and those they queue (no real timers or I/O in the code under test). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

export function fakeClock(): FakeClock {
  let now = 0
  let order = 0
  const timers = new Map<number, Timer>()
  return {
    setTimeout(fn, ms = 0, ...args) {
      const id = ++order
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), order: id, run: () => fn(...args) })
      return id
    },
    clearTimeout(id) {
      timers.delete(id as number)
    },
    async advance(ms) {
      const end = now + ms
      await flush()
      for (;;) {
        let next: [number, Timer] | null = null
        for (const entry of timers) {
          const t = entry[1]
          if (t.at <= end && (!next || t.at < next[1].at || (t.at === next[1].at && t.order < next[1].order))) next = entry
        }
        if (!next) break
        timers.delete(next[0])
        now = next[1].at
        next[1].run()
        await flush()
      }
      now = end
    },
    pending: () => timers.size
  }
}

/** esbuild's define: the bundle's setTimeout and clearTimeout are the clock at globalThis[name]. */
export function fakeTimers(name: string): Record<string, string> {
  return { setTimeout: `globalThis.${name}.setTimeout`, clearTimeout: `globalThis.${name}.clearTimeout` }
}
