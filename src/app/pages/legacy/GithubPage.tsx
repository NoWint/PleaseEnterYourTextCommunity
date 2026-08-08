// src/app/pages/legacy/GithubPage.tsx
// GitHub 页（legacy vanilla VSCode 式三栏：nav 仓库树 + 主区编辑区）
import { renderGithubNav, renderGithubMain } from "@/pages/githubPage"
import LegacyPageHost from "./LegacyPageHost"

export default function GithubPage() {
  return (
    <LegacyPageHost
      page="github"
      nav={(panel) => renderGithubNav(panel)}
      main={(el) => renderGithubMain(el)}
    />
  )
}
