// Bridge to the native app extension (SafariWebExtensionHandler.swift).
// Safari routes sendNativeMessage to the containing app regardless of the id.

const NATIVE_ID = "com.contextflow.app.Extension"

type Browser = { runtime?: { sendNativeMessage?: (id: string, msg: unknown) => Promise<unknown> } }

export async function callNative<T>(command: string, params: Record<string, unknown> = {}, timeoutMs = 4000): Promise<T | null> {
  const browserApi = (globalThis as unknown as { browser?: Browser }).browser
  const message = { command, ...params }
  const call = (): Promise<unknown> => {
    if (browserApi?.runtime?.sendNativeMessage) return browserApi.runtime.sendNativeMessage(NATIVE_ID, message)
    if (typeof chrome !== "undefined" && chrome.runtime?.sendNativeMessage) {
      return new Promise((resolve, reject) =>
        chrome.runtime.sendNativeMessage(NATIVE_ID, message, (res) => {
          const err = chrome.runtime.lastError
          if (err) reject(new Error(err.message))
          else resolve(res)
        })
      )
    }
    return Promise.reject(new Error("native messaging unavailable"))
  }

  try {
    const response = (await Promise.race([
      call(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("native timeout")), timeoutMs))
    ])) as { success?: boolean; data?: T } | null
    if (response && response.success) return (response.data ?? null) as T | null
    return null
  } catch {
    return null
  }
}

export interface NativeEntitlement {
  active: boolean
  productId: string | null
  expiresAt: string | null
  jws: string | null
}
