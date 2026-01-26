import type { PlasmoCSConfig } from "plasmo"
import type { PlasmoMessaging } from "@plasmohq/messaging"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"]
}

export type RequestBody = {
  action: "getPageText"
}

export type ResponseBody = {
  success: boolean
  text?: string
  title?: string
  url?: string
  error?: string
}

const handler: PlasmoMessaging.MessageHandler<RequestBody, ResponseBody> = async (req, res) => {
  try {
    if (req.body?.action === "getPageText") {
      const text = document.body.innerText
      const title = document.title
      const url = window.location.href

      res.send({
        success: true,
        text,
        title,
        url
      })
    } else {
      res.send({
        success: false,
        error: "Unknown action"
      })
    }
  } catch (error) {
    res.send({
      success: false,
      error: error instanceof Error ? error.message : "Failed to read page"
    })
  }
}

export default handler
