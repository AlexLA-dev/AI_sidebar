// 2.6 (98), the owner on TestFlight 97: «В приложении как-то прыгают сообщения в чате, кажется проблема в том, что
// расстояние между строками периодически меняется туда-сюда». Measured in the simulator: every answer block's height
// went back and forth by 1–2 pt on every pass, because the last line's gap was read from the text view's own layout,
// which follows the view's height. It's measured on its own now, and the size kept for the same text and width.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const ux = readFileSync(new URL("../ContextFlow/Shared (App)/ChatUX.swift", import.meta.url), "utf8")
const ios = ux.slice(ux.indexOf("struct SelectableText: UIViewRepresentable"), ux.indexOf("#else", ux.indexOf("struct SelectableText: UIViewRepresentable")))

test("the last line's gap comes from a layout of its own at the proposed width, never the view's", () => {
  assert.match(ios, /let pitch = Self\.lastLinePitch\(text, width: width\), pitch > font\.lineHeight/)
  assert.doesNotMatch(ios, /lastLinePitch\(uiView\)/)
  assert.match(ios, /static func lastLinePitch\(_ text: NSAttributedString, width: CGFloat\) -> CGFloat\? \{[\s\S]*?NSTextContainer\(size: CGSize\(width: width, height: \.greatestFiniteMagnitude\)\)/)
})

test("the same text at the same width gets the same size every pass", () => {
  assert.match(ios, /if let known = context\.coordinator\.measured, known\.width == width, known\.scale == scale, known\.text\.isEqual\(to: text\) \{ return known\.size \}/)
  assert.match(ios, /context\.coordinator\.measured = \(width, scale, text, fitted\)/)
})
