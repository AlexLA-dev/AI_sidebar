// The form an agent task's times are shown in (the director on 0a3d9e23: «19:30» asked, «07:30 PM» in the plan on a
// 12-hour device): the one the person wrote a time in, in their request; none written: the device's own clock. Set from
// the task whose card or bubble is drawn (clockFrom). No imports: tests run it as it is.

let form: "h23" | "h12" | undefined

/** The form the person wrote a time in: «19:30» 24-hour, «7:30 pm» 12-hour; undefined when the words hold no time. */
export function clockForm(words: string): "h23" | "h12" | undefined {
  if (/(?<![\d:])(1[0-2]|0?[1-9])(?::[0-5]\d)?\s?[aApP]\.?\s?[mM]\b/.test(words)) return "h12"
  if (/(?<![\d:.,])([01]?\d|2[0-3]):[0-5]\d(?![\d:])/.test(words)) return "h23"
  return undefined
}

/** The task whose times are drawn now: its request's form for them. */
export function clockFrom(request: string | undefined): void {
  form = clockForm(request ?? "")
}

export const hours = () => (form ? { hourCycle: form } : {})

/** A time alone («19:10») in the device's own clock, as `when` shows a time (the director on 126: «07:00 PM» beside «19:10»). */
export function clock(time: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!m) return time
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", ...hours() }).format(new Date(2000, 0, 1, Number(m[1]), Number(m[2])))
  } catch {
    return time
  }
}

/** A 12-hour time the model wrote in words («7:00 PM», «7 pm», «12:30 a.m.») in the task's form, as a 24-hour one is
 *  (the director on 10eed066: «7:00 PM» in the end text for a request that said 19:00). */
export function twelveToClock(text: string): string {
  return text.replace(/(?<![\d:.])(1[0-2]|0?[1-9])(?::([0-5]\d))?\s?([aApP])\.?\s?[mM]\.?(?![\p{L}])/gu, (_m, h: string, mi: string | undefined, ap: string) => {
    const hour = (Number(h) % 12) + (/[pP]/.test(ap) ? 12 : 0)
    return clock(`${String(hour).padStart(2, "0")}:${mi ?? "00"}`)
  })
}
