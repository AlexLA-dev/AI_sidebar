// Long answers run by the background (2.6 (91), similar-26's jobs: Find similar and chat answers that go on after the
// panel or the chat closes). The background is the only writer of "cf:jobs"; the panel reads it to show progress (a
// spinner on the chat's row, "Working on it…" in the chat) and what finished unseen (a dot on the row and on the round
// button), and tells the background which chat it shows ("jobsSeen"), which marks that chat's outcomes seen.
// The same rules as similar-26's src/shared/jobs.ts helpers; once that's in, this reads through them.

const JOBS = "cf:jobs"

export type Job = {
  id: string
  thread: string
  kind: "chat" | "similar" | string
  state: "running" | "done" | "failed"
  at: number
  end?: number
  code?: string
  seen?: true
}
export type Jobs = Record<string, Job>
export type JobsView = { running: Set<string>; unread: Set<string> }

/** Chats with a job under way, and chats whose job finished (or failed) without being on screen. */
export function jobsView(jobs: Jobs): JobsView {
  const all = Object.values(jobs ?? {})
  return {
    running: new Set(all.filter((j) => j.state === "running").map((j) => j.thread)),
    unread: new Set(all.filter((j) => (j.state === "done" || j.state === "failed") && !j.seen).map((j) => j.thread))
  }
}

/** Calls `cb` with the view now and whenever the jobs change. */
export function onJobs(cb: (view: JobsView) => void): () => void {
  let alive = true
  const update = () => {
    try {
      void chrome.storage.local.get(JOBS).then((r) => alive && cb(jobsView((r[JOBS] as Jobs | undefined) ?? {})), () => undefined)
    } catch {
      // No storage: nothing shown.
    }
  }
  update()
  const handler = (changes: Record<string, unknown>, area: string) => {
    if (area === "local" && JOBS in changes) update()
  }
  try {
    chrome.storage.onChanged.addListener(handler)
  } catch {
    // No storage events.
  }
  return () => {
    alive = false
    try {
      chrome.storage.onChanged.removeListener(handler)
    } catch {
      // Already gone.
    }
  }
}

/** The panel shows this chat: the background marks its finished jobs seen. */
export function jobsSeen(thread: string): void {
  try {
    chrome.runtime.sendMessage({ type: "jobsSeen", thread }, () => void chrome.runtime.lastError)
  } catch {
    // No background (tests): nothing to mark.
  }
}
