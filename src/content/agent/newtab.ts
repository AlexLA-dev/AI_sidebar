// A page that opens its place in a new tab by script (window.open): Safari blocks that for a tap that isn't a person's
// (128, the iPad: the stand's card said «the new tab was blocked»). During the agent's own tap, the page's window.open
// keeps the address instead; the runner sends the task there through the same checks as any «go» (runner.ts, NEW_TAB_ID).
// The catch never outlives its tap (the director on 1cf627ab: a stopped task left a window.open that returned null, so
// the person's own taps did nothing until a reload): it's put back when the tap ends (`done`, in a finally), and by the
// injected script itself after BOUND_MS whatever happens to the content script. No imports: tests run it as it is.

/** How long the page's window.open stays caught at most, from the tap (the tap's settle waits up to 4 s). */
export const BOUND_MS = 5000

/** The script that runs in the page's own world for one tap; `NONCE` marks it as this tap's (a page can't fake it). */
export function newTabScript(nonce: string, bound = BOUND_MS): string {
  return `(()=>{const d=document.documentElement,o=window.open;let off=false;const w=function(u){try{d.setAttribute("data-cf-open",new URL(String(u==null?"":u),location.href).href)}catch(e){}return null};window.open=w;d.setAttribute("data-cf-win",${JSON.stringify(nonce)});const back=()=>{if(off)return;off=true;if(window.open===w)window.open=o;if(d.getAttribute("data-cf-win")===${JSON.stringify(nonce)})d.removeAttribute("data-cf-win")};document.addEventListener("cf-win-off",back,{once:true});setTimeout(back,${Math.max(0, Math.round(bound))})})()`
}

/**
 * Starts watching the page's window.open for one tap: `done()` (call it in a finally) puts it back and says what address
 * the page asked for — only when this tap's own script ran (`reached`): an address a page wrote itself without it
 * isn't read.
 */
export function catchNewTab(doc: Document, bound = BOUND_MS): { done(): { url: string; reached: boolean } } {
  const root = doc.documentElement
  root.removeAttribute("data-cf-open")
  const nonce = `cf${Math.random().toString(36).slice(2, 10)}`
  let reached = false
  try {
    const s = doc.createElement("script")
    s.setAttribute("data-cf-shim", "")
    s.textContent = newTabScript(nonce, bound)
    ;(doc.head ?? root).appendChild(s)
    s.remove()
    reached = root.getAttribute("data-cf-win") === nonce
  } catch {
    reached = false
  }
  let ended = false
  return {
    done() {
      const url = reached && !ended ? root.getAttribute("data-cf-open") ?? "" : ""
      ended = true
      root.removeAttribute("data-cf-open")
      try {
        doc.dispatchEvent(new (doc.defaultView ?? window).CustomEvent("cf-win-off"))
      } catch {
        // (The page is gone: nothing to put back.)
      }
      return { url: /^https?:\/\//.test(url) ? url : "", reached }
    }
  }
}
