import { test } from "node:test"
import assert from "node:assert/strict"

import { jobsView, type Jobs } from "../src/content/jobsView.ts"

test("the chat list and the round button read similar-26's jobs: running, and finished unseen (failed too)", () => {
  const jobs: Jobs = {
    a: { id: "a", thread: "t1", kind: "similar", state: "running", at: 1 },
    b: { id: "b", thread: "t2", kind: "chat", state: "done", at: 1, end: 2 },
    c: { id: "c", thread: "t3", kind: "similar", state: "failed", at: 1, end: 2, code: "STREAM" },
    d: { id: "d", thread: "t4", kind: "chat", state: "done", at: 1, end: 2, seen: true }
  }
  const view = jobsView(jobs)
  assert.deepEqual([...view.running], ["t1"])
  assert.deepEqual([...view.unread].sort(), ["t2", "t3"])
  assert.equal(jobsView({}).unread.size, 0)
})
