// Round 142, the director's item 5 (approved widening): sign-in, sign-up and account words match spaced or not, in every
// language («회원 가입» was classed free on Agoda).
import assert from "node:assert/strict"
import { test } from "node:test"

import { wordKind } from "../src/shared/agent/match.ts"
import { classify } from "../src/shared/agent/classify.ts"
import type { PageMap } from "../src/shared/agent/types.ts"

test("sign-in and sign-up words, spaced and unspaced, in the panel's languages", () => {
  for (const l of ["회원 가입", "회원가입", "로그 인", "가입 하기", "Sign up", "Signup", "Sign-up", "Sign-in", "Signin", "Log in", "Login", "新規 登録", "会員 登録", "ログ イン", "登 录", "注 册", "登入", "登錄", "註冊", "Regístrate", "Iscriviti", "Kaydol", "giriş yap", "girişyap", "Konto anlegen", "Đăng kí", "Đăng ký", "Зарегистрируйтесь", "Зареєструйтеся", "Inscrever-se", "S'inscrire", "إنشاء حساب"])
    assert.equal(wordKind(l)?.kind, "auth", l)
  for (const l of ["회원 탈퇴", "회원탈퇴", "계정삭제", "アカウントを 削除", "删除 账户"]) assert.equal(wordKind(l)?.kind, "account", l)
  for (const l of ["Logistics", "Signing", "Log Inn Hotel", "Design in Paris"]) assert.notEqual(wordKind(l)?.kind, "auth", l)
})

test("Agoda's «회원 가입» on a city page is the person's own step, not a free press", () => {
  const map = { url: "https://stays.example/ko-kr/city/seoul.html", title: "", lang: "ko", forms: [], more: 0, part: 1, parts: 1, text: "", items: [{ id: "1", role: "button", label: "회원 가입" }] } as PageMap
  assert.deepEqual(classify({ tool: "click", id: "1", why: "", expect: { label: "회원 가입", role: "button" } }, { map, startHost: "stays.example", request: "서울 숙소 예약", confirmedHere: false, policy: {} } as never), { cls: "self", reason: "auth" })
})
