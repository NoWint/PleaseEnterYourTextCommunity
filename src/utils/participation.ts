// 参与度统计:纯前端,0 token。per_member 消息/字符/活跃天数;hours 活跃时段;density 每日密度。
// 看板 participation 区块 = 此统计(数字准确) + LLM 解读(语义)。
import type { WindowMsg } from './summaryContext.js';

export interface MemberStat { name: string; msg_count: number; char_count: number; active_days: number }
export interface Participation {
  per_member: MemberStat[];
  hours: Array<{ hour: number; count: number }>;
  density: Array<{ day: string; count: number }>;
}

/** 统计参与度。day 用本地时区 YYYY-MM-DD;hour 用 0-23。 */
export function computeParticipation(win: WindowMsg[]): Participation {
  const memberMap = new Map<string, MemberStat>();
  const hourMap = new Map<number, number>();
  const dayMap = new Map<string, number>();
  for (const w of win) {
    const d = new Date(w.ts * 1000);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hour = d.getHours();
    const m = memberMap.get(w.sender) ?? { name: w.sender, msg_count: 0, char_count: 0, active_days: 0 };
    m.msg_count += 1;
    m.char_count += w.text.length;
    hourMap.set(hour, (hourMap.get(hour) ?? 0) + 1);
    dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
    memberMap.set(w.sender, m);
  }
  // 活跃天数:重建成员→Set<day>(成员维度需独立统计,不能复用全局 dayMap)
  const memberDays = new Map<string, Set<string>>();
  for (const w of win) {
    const d = new Date(w.ts * 1000);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!memberDays.has(w.sender)) memberDays.set(w.sender, new Set());
    memberDays.get(w.sender)!.add(day);
  }
  for (const m of memberMap.values()) {
    m.active_days = memberDays.get(m.name)?.size ?? 0;
  }
  return {
    per_member: [...memberMap.values()].sort((a, b) => b.msg_count - a.msg_count),
    hours: [...hourMap.entries()].map(([hour, count]) => ({ hour, count })).sort((a, b) => a.hour - b.hour),
    density: [...dayMap.entries()].map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day)),
  };
}
