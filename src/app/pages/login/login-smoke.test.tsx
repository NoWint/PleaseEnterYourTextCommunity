// src/app/pages/login/login-smoke.test.tsx
// 登录页冒烟测试：模块图加载 + 账号卡/标签纯逻辑 + 账号选择区渲染。
// 注意：不使用 jest-dom 专属 matcher（部分环境 setup 不可用），断言基于 DOM 原语。

import { describe, expect, it } from "vitest"
import { createRoot } from "solid-js"
import { render } from "@solidjs/testing-library"
import { accountLabel, AccountPicker } from "./index"
import type { AccountInfo } from "../../context/account"

function account(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id: 1,
    name: "小明",
    addr: "xiaoming@yzjtiantian.cn",
    is_current: false,
    avatar: null,
    ...overrides,
  }
}

describe("login module graph", () => {
  it("imports login page modules", async () => {
    const { default: LoginPage } = await import("./index")
    const { SecureJoinSection } = await import("./secure-join")
    expect(typeof LoginPage).toBe("function")
    expect(typeof SecureJoinSection).toBe("function")
  })
})

describe("accountLabel", () => {
  it("prefers name, falls back to addr, then 账号 id", () => {
    expect(accountLabel(account())).toBe("小明")
    expect(accountLabel(account({ name: "" }))).toBe("xiaoming@yzjtiantian.cn")
    expect(accountLabel(account({ name: "", addr: "" }))).toBe("账号 1")
  })
})

describe("AccountPicker", () => {
  it("renders one card per account with 当前 marker on current", () => {
    const { getByText, queryByText } = render(() => (
      <AccountPicker
        accounts={[
          account({ id: 1, name: "小明" }),
          account({ id: 2, name: "小红", is_current: true }),
        ]}
        busyId={null}
        onPick={() => {}}
      />
    ))
    expect(getByText("小明")).toBeTruthy()
    expect(getByText("小红")).toBeTruthy()
    expect(queryByText("当前")).toBeTruthy()
  })

  it("marks cards disabled while another account is switching", () => {
    const { getByText } = render(() => (
      <AccountPicker
        accounts={[account({ id: 1, name: "小明" }), account({ id: 2, name: "小红" })]}
        busyId={1}
        onPick={() => {}}
      />
    ))
    const card = getByText("小明").closest("button")
    expect(card?.hasAttribute("disabled")).toBe(true)
  })

  it("calls onPick with the account", () => {
    const picked: AccountInfo[] = []
    const { getByText } = render(() => (
      <AccountPicker
        accounts={[account({ id: 1, name: "小明" })]}
        busyId={null}
        onPick={(a) => picked.push(a)}
      />
    ))
    getByText("小明").closest("button")?.click()
    expect(picked.length).toBe(1)
    expect(picked[0].id).toBe(1)
  })
})
