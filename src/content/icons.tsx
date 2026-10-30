import type { VNode } from "preact"

const base = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" } as const

export const Sparkle = ({ size = 22 }: { size?: number }): VNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2.5c.4 3.9 1.3 5.9 2.7 7.2 1.4 1.4 3.4 2.2 6.8 2.6-3.4.4-5.4 1.3-6.8 2.6-1.4 1.4-2.3 3.4-2.7 7.1-.4-3.7-1.3-5.7-2.7-7.1-1.4-1.3-3.4-2.2-6.8-2.6 3.4-.4 5.4-1.2 6.8-2.6 1.4-1.3 2.3-3.3 2.7-7.2z" />
    <path d="M19 2c.15 1.3.45 2 .95 2.45.5.5 1.2.8 2.35.95-1.15.15-1.85.45-2.35.95-.5.45-.8 1.15-.95 2.45-.15-1.3-.45-2-.95-2.45-.5-.5-1.2-.8-2.35-.95 1.15-.15 1.85-.45 2.35-.95.5-.45.8-1.15.95-2.45z" opacity=".75" />
  </svg>
)
export const Close = (): VNode => <svg {...base}><path d="M18 6 6 18M6 6l12 12" /></svg>
export const Gear = (): VNode => (
  <svg {...base}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
)
export const Plus = (): VNode => <svg {...base}><path d="M12 5v14M5 12h14" /></svg>
export const ArrowUp = (): VNode => <svg {...base} stroke-width={2.4}><path d="M12 19V5M5 12l7-7 7 7" /></svg>
export const Stop = (): VNode => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3" /></svg>
export const Copy = (): VNode => <svg {...base} width={15} height={15}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
export const Share = (): VNode => <svg {...base} width={15} height={15}><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13" /></svg>
export const Retry = (): VNode => <svg {...base} width={15} height={15}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
export const Check = (): VNode => <svg {...base} width={15} height={15}><path d="M20 6 9 17l-5-5" /></svg>
export const Back = (): VNode => <svg {...base}><path d="M15 18l-6-6 6-6" /></svg>
export const Chats = (): VNode => (
  <svg {...base}><path d="M21 11.5a7.5 7.5 0 0 1-11 6.6L4 20l1.6-4.6A7.5 7.5 0 1 1 21 11.5z" /><path d="M8.5 10h7M8.5 13.5h4.5" /></svg>
)
export const Trash = (): VNode => (
  <svg {...base} width={16} height={16}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" /></svg>
)
export const Pencil = (): VNode => (
  <svg {...base} width={16} height={16}><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" /><path d="M14.5 5.5l3 3" /></svg>
)
export const Pin = ({ filled = false }: { filled?: boolean }): VNode => (
  <svg {...base} width={16} height={16} fill={filled ? "currentColor" : "none"}><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4z" /><path d="M12 15v6" /></svg>
)
export const Grip = (): VNode => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
  </svg>
)
export const Doc = (): VNode => <svg {...base} width={14} height={14}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
export const Cursor = (): VNode => <svg {...base} width={14} height={14}><path d="M4 7V4h16v3M9 20h6M12 4v16" /></svg>
export const Lock = (): VNode => <svg {...base} width={14} height={14}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
export const Search = ({ size = 15 }: { size?: number }): VNode => (
  <svg {...base} width={size} height={size}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>
)
