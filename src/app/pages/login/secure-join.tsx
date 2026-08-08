// src/app/pages/login/secure-join.tsx
// 登录页「邀请加入」区块：粘贴邀请链接 secure_join（调 invoke）+ 个人邀请二维码。
// - 邀请链接支持 peyt 品牌域名 / i.delta.chat / OPENPGP4FPR:（经 normalizeUrlForQr 归一化）。
// - secure_join 需要已激活账号（后端 state.current()）；未登录时报错 → toast 引导先选/建账号。
// - 个人二维码 get_securejoin_qr(chatId:null) 同样依赖激活账号；
//   无账号时显示引导文案，不报错。

import type { Component } from "solid-js"
import { Show, createSignal, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { call } from "../../../api"
import { normalizeUrlForQr } from "../../../utils/deepLink"
import { useAccount } from "../../context/account"
import { showToast } from "../../utils/toast"

// qrcode 包无类型声明，跳过类型检查（与旧登录/群二维码用法一致）
// @ts-expect-error qrcode 无类型声明
import QRCode from "qrcode"

export const SecureJoinSection: Component = () => {
  const account = useAccount()
  const navigate = useNavigate()
  const [link, setLink] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  // 个人邀请二维码：仅在存在激活账号时可用（get_securejoin_qr 依赖 state.current()）
  const [qrUrl, setQrUrl] = createSignal<string>("")
  const [qrText, setQrText] = createSignal<string>("")
  const [qrFailed, setQrFailed] = createSignal(false)

  onMount(() => {
    void loadQr()
  })

  const loadQr = async () => {
    setQrFailed(false)
    try {
      const qr = await call<string>("get_securejoin_qr", { chatId: null })
      const dataUrl = await QRCode.toDataURL(normalizeUrlForQr(qr), { margin: 1, width: 220 })
      setQrText(qr)
      setQrUrl(dataUrl)
    } catch {
      setQrUrl("")
      setQrFailed(true)
    }
  }

  const copyQr = async () => {
    if (!qrText()) return
    try {
      await navigator.clipboard.writeText(qrText())
      showToast({ title: "链接已复制" })
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : String(e) })
    }
  }

  const join = async () => {
    const raw = link().trim()
    if (!raw || busy()) return
    setBusy(true)
    try {
      await account.joinSecure(normalizeUrlForQr(raw))
      showToast({ title: "已加入" })
      navigate("/home")
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="login-card">
      <h2 class="login-section-title">邀请加入</h2>
      <p class="login-hint">粘贴同事发来的邀请链接，加入对方的频道</p>
      <div class="login-join-row">
        <TextInputV2
          appearance="base"
          placeholder="粘贴邀请链接…"
          value={link()}
          disabled={busy()}
          onInput={(e) => setLink(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void join()
          }}
        />
        <ButtonV2 variant="outline" disabled={busy() || !link().trim()} onClick={() => void join()}>
          加入
        </ButtonV2>
      </div>
      <Show when={busy()}>
        <p class="login-status">加入中…</p>
      </Show>

      <div class="login-divider" role="separator" />

      <div class="login-qr">
        <Show when={qrUrl()} fallback={null}>
          <img class="login-qr-img" src={qrUrl()} alt="个人邀请二维码" />
          <p class="login-hint">扫一扫，添加我为联系人</p>
          <ButtonV2 variant="ghost" size="small" onClick={() => void copyQr()}>
            复制链接
          </ButtonV2>
        </Show>
        <Show when={qrFailed()}>
          <p class="login-status">登录后可在账号管理里生成个人邀请二维码</p>
        </Show>
      </div>
    </div>
  )
}
