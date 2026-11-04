// Page watch's eye: the mark for "tell me when it changes" (the bell is time), the same lines as chat UX's bell.
import type { VNode } from "preact"

export const Eye = ({ size = 16 }: { size?: number }): VNode => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width={2} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)
