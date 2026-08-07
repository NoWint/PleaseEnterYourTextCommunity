// src/app/pages/home/home-projects.tsx
// 照抄 opencode pages/home/home-projects.tsx（props 形状随 View 简化）。

import type { HomeProjectsController } from "./home-projects-controller"
import { HomeProjectsView } from "./home-projects-view"
import type { HomeScrollController } from "./home-scroll-controller"

export function HomeProjects(props: { projects: HomeProjectsController; scroll: HomeScrollController }) {
  return (
    <HomeProjectsView
      language={props.projects.copy.language}
      projects={props.projects.project.list}
      recentlyClosed={props.projects.project.recentlyClosed}
      selection={props.projects.selection.value}
      homedir={props.projects.project.homedir}
      canRevealProject={props.projects.project.canReveal}
      unseenCount={props.projects.project.unseenCount}
      onWheel={props.scroll.viewport.containWheel}
      onChooseProject={props.projects.project.choose}
      onSelectProject={props.projects.project.select}
      onAddProjects={props.projects.project.add}
      onOpenProjectNewSession={props.projects.project.openNewSession}
      onEditProject={props.projects.project.edit}
      onRevealProject={props.projects.project.reveal}
      onClearNotifications={props.projects.project.clearNotifications}
      onCloseProject={props.projects.project.close}
      onOpenSettings={props.projects.utility.settings}
      onOpenHelp={props.projects.utility.help}
    />
  )
}
