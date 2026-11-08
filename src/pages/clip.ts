export {}

// A Tips clip, played in the extension's own page (2.6 (91)). The panel shows it in a frame of this page: the clip's
// bytes come from the app (src/background/tipClips.ts), and a page's own media rules (GitHub's, X's) don't apply to
// a page of the extension. `still=1`: one frame (3.5 s in) until it's told to play; the panel says "play" and "pause"
// as the card comes on and off screen. "missing" tells the panel to show its words instead.

const q = new URLSearchParams(location.search)
const clip = q.get("name") ?? ""
const lang = q.get("lang") === "ru" ? "ru" : "en"
let still = q.get("still") === "1"
const video = document.querySelector("video") as HTMLVideoElement
const tell = (state: "ready" | "missing") => parent.postMessage({ cfClip: state, name: clip }, "*")

const play = () => void video.play()?.catch(() => undefined)

chrome.runtime.sendMessage({ type: "tipClip", name: clip, lang }, (reply: { ok: boolean; data?: string } | undefined) => {
  void chrome.runtime.lastError
  if (!reply?.ok || !reply.data) return tell("missing")
  const raw = atob(reply.data)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  video.src = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }))
  video.onloadedmetadata = () => {
    if (still) video.currentTime = Math.min(3.5, video.duration || 3.5)
  }
  video.onloadeddata = () => {
    tell("ready")
    if (!still) play()
  }
  video.onerror = () => tell("missing")
})

addEventListener("message", (e: MessageEvent) => {
  if (e.data?.cfClip === "play" && q.get("motion") !== "0") {
    still = false
    play()
  } else if (e.data?.cfClip === "pause") video.pause()
})
// A tap on a still frame plays it (the Tips cards' rule).
video.addEventListener("click", () => {
  if (q.get("motion") === "0") return
  still = false
  play()
})
