// src/app/pages/github/SettingsPanel.tsx
// GitHub 设置对话框:全局 Token 配置(get_github_settings 回显 + set_github_token 保存/清除)
// + Token 获取教程(open_external 打开 GitHub 生成页)。
// 命令:get_github_settings / set_github_token / open_external(全部已注册)。

import { createSignal, Show } from "solid-js"
import { call } from "@/api"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogHeader, DialogTitle, DialogFooter } from "@opencode-ai/ui/v2/dialog-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { showToast } from "../../utils/toast"

interface SettingsPanelProps {
  /** 当前已保存 token(回显预填) */
  initialToken: string
  /** 保存/清除成功后回调(父级更新 hasToken 并刷新仓库数据) */
  onSaved: (hasToken: boolean, token: string) => void
}

export default function SettingsPanel(props: SettingsPanelProps) {
  const dialog = useDialog()
  let inputRef: HTMLInputElement | undefined
  const [guideOpen, setGuideOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  const save = async (clear: boolean) => {
    if (busy()) return
    setBusy(true)
    try {
      const raw = clear ? "" : (inputRef?.value.trim() ?? "")
      await call("set_github_token", { token: raw || null })
      showToast({ title: clear ? "Token 已清除" : "Token 已保存" })
      props.onSaved(!clear && raw !== "", raw)
      dialog.close()
    } catch (e) {
      showToast({ title: "保存失败", description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog size="normal">
      <DialogHeader>
        <DialogTitle>GitHub 设置</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex flex-col gap-3">
        <div class="flex flex-col gap-1.5">
          <label class="text-[12px] font-medium text-v2-text-text-base">全局 GitHub Token</label>
          <TextInputV2
            ref={inputRef}
            type="password"
            placeholder="GitHub Token(留空 = 公开只读)"
            value={props.initialToken}
            autocomplete="off"
          />
          <p class="text-[11px] text-v2-text-text-faint">
            无 token 时公开仓库只读;代码搜索与私有仓库需 token。Token 仅保存在本机数据库。
          </p>
        </div>
        <div class="flex items-center gap-2">
          <ButtonV2 size="small" variant="contrast" icon="check" onClick={() => void save(false)}>
            保存 Token
          </ButtonV2>
          <ButtonV2 size="small" variant="neutral" icon="xmark-small" onClick={() => void save(true)}>
            清除 Token
          </ButtonV2>
        </div>

        <div class="flex flex-col items-start gap-2 pt-1">
          <ButtonV2 size="small" variant="ghost" icon="help" onClick={() => setGuideOpen((v) => !v)}>
            {guideOpen() ? "收起教程" : "如何获取 Token"}
          </ButtonV2>
          <Show when={guideOpen()}>
            <ol class="flex list-decimal flex-col gap-1 pl-5 text-[12px] text-v2-text-text-muted">
              <li>登录 GitHub,进入 <b>Settings</b> → <b>Developer settings</b></li>
              <li>打开 <b>Personal access tokens</b>,点击 <b>Generate new token</b></li>
              <li>勾选 <b>repo</b> 权限(读私有仓库/代码搜索),生成后立即复制</li>
              <li>粘贴到上方输入框,点「保存 Token」即可</li>
            </ol>
            <ButtonV2
              size="small"
              variant="ghost"
              icon="outline-square-arrow"
              onClick={() => void call("open_external", { url: "https://github.com/settings/tokens" }).catch(() => {})}
            >
              打开 GitHub Token 生成页
            </ButtonV2>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <span class="flex items-center gap-1 text-[11px] text-v2-text-text-faint">
          <Icon name="check" size="small" />
          全局共享 Token,所有仓库统一使用
        </span>
      </DialogFooter>
    </Dialog>
  )
}
