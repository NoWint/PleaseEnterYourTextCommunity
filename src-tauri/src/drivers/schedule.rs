use async_trait::async_trait;
use chrono::{Datelike, NaiveDateTime, Timelike};

use super::{BotDriver, BotRuntime, DriverKind, ScheduledSend};
use crate::error::AppResult;

/// 定时驱动:按 bot_schedules 表的 cron 字段(minute/hour/day_of_week,全 -1=一次性)
/// 到点产出 ScheduledSend;周期项重算 next_run_at,一次性项直接删除。
/// 无状态。
pub struct ScheduleDriver;

#[async_trait]
impl BotDriver for ScheduleDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::Schedule
    }

    /// 定时驱动不处理进站消息。
    async fn on_message(
        &self,
        _bot: &BotRuntime<'_>,
        _msg: &super::IncomingMsg<'_>,
    ) -> AppResult<Vec<String>> {
        Ok(vec![])
    }

    async fn on_tick(&self, bot: &BotRuntime<'_>) -> AppResult<Vec<ScheduledSend>> {
        let now = chrono::Utc::now().timestamp();
        let due = bot.db.list_due_schedules(now).await?;
        let mut out = Vec::new();
        for row in due {
            if row.bot_id != bot.bot_id {
                continue;
            }
            out.push(ScheduledSend {
                chat_id: row.chat_id,
                text: row.message,
            });
            if row.minute == -1 && row.hour == -1 && row.day_of_week == -1 {
                bot.db.delete_bot_schedule(row.id).await?;
            } else if let Some(nx) = next_cron(now, row.minute, row.hour, row.day_of_week) {
                bot.db.set_schedule_next_run(row.id, nx).await?;
            } else {
                bot.db.delete_bot_schedule(row.id).await?;
            }
        }
        Ok(out)
    }
}

/// 计算 next_run_at 的下一次触发时间;cron 全 -1(一次性)返回 None。
///
/// 语义:字段 -1 表示通配。minute/hour 固定时取当天或次日的 hour:minute;
/// 仅 minute 固定时取接下来 60 分钟内该分钟;day_of_week 固定时取该星期几对应
/// 时刻(00:00 若 hour 通配),今天仅当时刻严格晚于 now 才算,否则下周。
pub fn next_cron(now: i64, minute: i32, hour: i32, day_of_week: i32) -> Option<i64> {
    let base = chrono::DateTime::<chrono::Utc>::from_timestamp(now, 0)?.naive_utc();
    if minute == -1 && hour == -1 && day_of_week == -1 {
        return None;
    }
    // 从 base 所在日的 00:00 起逐小时推进(最多 8 天),直到候选匹配所有固定字段且严格晚于 now。
    // 仅按星期几触发且时分都通配时固定 00:00(午夜),否则逐小时。
    let hours: Vec<u32> = if hour == -1 && minute == -1 && day_of_week != -1 {
        vec![0]
    } else {
        (0..24u32).collect()
    };
    for offset_days in 0..8u32 {
        let day = base.date() + chrono::Days::new(offset_days as u64);
        for h in &hours {
            let m = if minute == -1 { 0 } else { minute };
            let cand = day.and_hms_opt(*h, m as u32, 0)?;
            if cand > base && matches(cand, minute, hour, day_of_week) {
                return Some(cand.timestamp());
            }
        }
    }
    None
}

/// 候选时间是否匹配 cron 字段(-1 视为通配)。
fn matches(candidate: NaiveDateTime, minute: i32, hour: i32, dow: i32) -> bool {
    if minute != -1 && candidate.minute() as i32 != minute {
        return false;
    }
    if hour != -1 && candidate.hour() as i32 != hour {
        return false;
    }
    if dow != -1 {
        let wd = (candidate.weekday().number_from_sunday() - 1) as i32;
        if wd != dow {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minute_only() {
        let now = chrono::DateTime::<chrono::Utc>::from_timestamp(1_700_000_000, 0)
            .unwrap()
            .timestamp();
        let nx = next_cron(now, 30, -1, -1).unwrap();
        assert!(nx > now);
        assert!(nx - now <= 3600);
        let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(nx, 0).unwrap();
        assert_eq!(dt.minute(), 30);
    }

    #[test]
    fn hour_minute_fixed() {
        let now = chrono::DateTime::<chrono::Utc>::from_timestamp(1_700_000_000, 0)
            .unwrap()
            .timestamp();
        let nx = next_cron(now, 0, 9, -1).unwrap();
        assert!(nx > now);
        let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(nx, 0).unwrap();
        assert_eq!(dt.hour(), 9);
        assert_eq!(dt.minute(), 0);
        let delta = chrono::Duration::seconds(nx - now).num_hours();
        assert!(delta >= 0 && delta <= 24, "delta_hours={delta}");
    }

    #[test]
    fn past_nine_goes_tomorrow() {
        let now = chrono::DateTime::<chrono::Utc>::from_timestamp(1_700_000_000, 0)
            .unwrap()
            .timestamp();
        // 挑一个落在当天 09:00 之后的时间点:09:30 UTC。
        let base_day = chrono::DateTime::<chrono::Utc>::from_timestamp(now, 0).unwrap();
        let at = base_day
            .date_naive()
            .and_hms_opt(9, 30, 0)
            .unwrap()
            .and_utc()
            .timestamp();
        let nx = next_cron(at, 0, 9, -1).unwrap();
        let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(nx, 0).unwrap();
        assert_eq!(dt.hour(), 9);
        assert_eq!(dt.minute(), 0);
        let tomorrow = base_day.date_naive() + chrono::Days::new(1);
        assert_eq!(
            dt.date_naive(),
            tomorrow,
            "next 09:00 after 09:30 must be tomorrow"
        );
    }

    #[test]
    fn weekday_monday_midnight() {
        // 2024-01-08 是周一:取当天 12:00 UTC(ts=1704715200)。
        let now = chrono::DateTime::<chrono::Utc>::from_timestamp(1_704_715_200, 0)
            .unwrap()
            .timestamp();
        let nx = next_cron(now, -1, -1, 1).unwrap();
        assert!(nx > now);
        let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(nx, 0).unwrap();
        assert_eq!(dt.weekday().number_from_sunday() - 1, 1);
        assert_eq!(dt.hour(), 0);
        assert_eq!(dt.minute(), 0);
    }

    #[test]
    fn all_wildcard_is_none() {
        assert_eq!(next_cron(1_700_000_000, -1, -1, -1), None);
    }

    #[test]
    fn matches_basic() {
        let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(1_700_000_000, 0)
            .unwrap()
            .naive_utc();
        // 2023-11-14 是周二(weekday=2)。
        assert!(matches(dt, -1, -1, 2));
        assert!(!matches(dt, -1, -1, 1));
        assert!(matches(dt, dt.minute() as i32, -1, -1));
        assert!(matches(dt, -1, dt.hour() as i32, -1));
        assert!(!matches(dt, (dt.minute() as i32 + 1) % 60, -1, -1));
    }
}
