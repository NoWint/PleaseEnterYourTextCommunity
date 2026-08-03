//! 实用工具:get_time / calculate / convert_units。
//!
//! 三个工具均为 `is_safe=true`,默认开放给 LLM。核心逻辑(求值/换算)为纯函数,
//! 便于单测。

use async_trait::async_trait;
use chrono::Offset;

use crate::error::{AppError, AppResult};
use crate::tools::{Tool, ToolContext};

/// 当前时间工具:返回本地或 UTC 时间。
pub struct GetTimeTool;

/// 安全数学表达式计算工具(递归下降,零新依赖)。
pub struct CalculateTool;

/// 单位换算工具(长度/重量/温度/数据/时间)。
pub struct ConvertUnitsTool;

#[async_trait]
impl Tool for GetTimeTool {
    fn name(&self) -> &'static str {
        "get_time"
    }

    fn description(&self) -> &'static str {
        "获取当前时间(本地或 UTC)"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "timezone": {
                    "type": "string",
                    "enum": ["local", "utc"],
                    "description": "local=本地时间(默认), utc=UTC"
                }
            }
        })
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext<'_>) -> AppResult<String> {
        let tz = args
            .get("timezone")
            .and_then(|v| v.as_str())
            .unwrap_or("local");
        match tz {
            "local" => {
                let now = chrono::Local::now();
                let offset = now.offset().fix().local_minus_utc();
                Ok(format!(
                    "本地时间 {} (UTC{})",
                    now.format("%Y-%m-%d %H:%M:%S"),
                    fmt_utc_offset(offset)
                ))
            }
            "utc" => {
                let now = chrono::Utc::now();
                Ok(format!(
                    "UTC 时间 {} (UTC+00:00)",
                    now.format("%Y-%m-%d %H:%M:%S")
                ))
            }
            other => Err(AppError::Core(format!("未知时区: {}", other))),
        }
    }
}

#[async_trait]
impl Tool for CalculateTool {
    fn name(&self) -> &'static str {
        "calculate"
    }

    fn description(&self) -> &'static str {
        "安全计算数学表达式"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": "数学表达式"
                }
            },
            "required": ["expression"]
        })
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext<'_>) -> AppResult<String> {
        let expression = args
            .get("expression")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let v = eval_expr(expression)?;
        Ok(format!("result: {}", fmt_num(v)))
    }
}

#[async_trait]
impl Tool for ConvertUnitsTool {
    fn name(&self) -> &'static str {
        "convert_units"
    }

    fn description(&self) -> &'static str {
        "单位换算"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "value": { "type": "number" },
                "from": { "type": "string" },
                "to": { "type": "string" }
            },
            "required": ["value", "from", "to"]
        })
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext<'_>) -> AppResult<String> {
        let value = args.get("value").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let from = args.get("from").and_then(|v| v.as_str()).unwrap_or("");
        let to = args.get("to").and_then(|v| v.as_str()).unwrap_or("");
        let r = convert(value, from, to)?;
        Ok(format!(
            "result: {}{} = {}{}",
            fmt_num(value),
            from,
            fmt_num(r),
            to
        ))
    }
}

/// 数字格式化:整数按整数输出(42),非整数最多 6 位小数并去掉尾部 0(2.5)。
fn fmt_num(v: f64) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    if v.fract() == 0.0 {
        format!("{:.0}", v)
    } else {
        let s = format!("{:.6}", v);
        let t = s.trim_end_matches('0').trim_end_matches('.');
        t.to_string()
    }
}

/// 秒偏移量 → "UTC+08:00" / "UTC-05:00"。
fn fmt_utc_offset(secs: i32) -> String {
    let sign = if secs < 0 { '-' } else { '+' };
    let abs = secs.unsigned_abs();
    format!("{}{:02}:{:02}", sign, abs / 3600, (abs % 3600) / 60)
}

/// 安全表达式求值入口。
///
/// 守卫:长度 ≤ 200;字符白名单 `[0-9a-zA-Z.+\-*/%^() ,]`。非法输入 → 错误。
pub fn eval_expr(input: &str) -> AppResult<f64> {
    if input.len() > 200 {
        return Err(err_illegal());
    }
    if !input.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(
                c,
                '.' | '+' | '-' | '*' | '/' | '%' | '^' | '(' | ')' | ',' | ' '
            )
    }) {
        return Err(err_illegal());
    }
    let toks = lex(input)?;
    let mut p = Parser { toks, pos: 0 };
    let v = p.expr()?;
    if p.pos != p.toks.len() {
        return Err(err_illegal());
    }
    if !v.is_finite() {
        return Err(err_illegal());
    }
    Ok(v)
}

fn err_illegal() -> AppError {
    AppError::Core("非法表达式".into())
}

#[derive(Debug, Clone)]
enum Tok {
    Num(f64),
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Caret,
    LParen,
    RParen,
    Comma,
    Ident(String),
}

fn lex(input: &str) -> AppResult<Vec<Tok>> {
    let mut toks = Vec::new();
    let mut chars = input.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c == ' ' {
            chars.next();
            continue;
        }
        let t = match c {
            '+' => {
                chars.next();
                Tok::Plus
            }
            '-' => {
                chars.next();
                Tok::Minus
            }
            '*' => {
                chars.next();
                Tok::Star
            }
            '/' => {
                chars.next();
                Tok::Slash
            }
            '%' => {
                chars.next();
                Tok::Percent
            }
            '^' => {
                chars.next();
                Tok::Caret
            }
            '(' => {
                chars.next();
                Tok::LParen
            }
            ')' => {
                chars.next();
                Tok::RParen
            }
            ',' => {
                chars.next();
                Tok::Comma
            }
            c if c.is_ascii_digit() || c == '.' => {
                let mut num = String::new();
                while let Some(&c2) = chars.peek() {
                    if c2.is_ascii_digit() || c2 == '.' {
                        num.push(c2);
                        chars.next();
                    } else {
                        break;
                    }
                }
                let v: f64 = num.parse().map_err(|_| err_illegal())?;
                Tok::Num(v)
            }
            c if c.is_ascii_alphabetic() => {
                let mut name = String::new();
                while let Some(&c2) = chars.peek() {
                    if c2.is_ascii_alphanumeric() {
                        name.push(c2);
                        chars.next();
                    } else {
                        break;
                    }
                }
                Tok::Ident(name)
            }
            _ => return Err(err_illegal()),
        };
        toks.push(t);
    }
    Ok(toks)
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
}

impl Parser {
    fn next(&mut self) -> Option<Tok> {
        let t = self.toks.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }

    /// expr := term (('+' | '-') term)*
    fn expr(&mut self) -> AppResult<f64> {
        let mut v = self.term()?;
        loop {
            match self.peek() {
                Some(Tok::Plus) => {
                    self.pos += 1;
                    v += self.term()?;
                }
                Some(Tok::Minus) => {
                    self.pos += 1;
                    v -= self.term()?;
                }
                _ => break,
            }
        }
        Ok(v)
    }

    /// term := unary (('*' | '/' | '%') unary)*
    fn term(&mut self) -> AppResult<f64> {
        let mut v = self.unary()?;
        loop {
            match self.peek() {
                Some(Tok::Star) => {
                    self.pos += 1;
                    v *= self.unary()?;
                }
                Some(Tok::Slash) => {
                    self.pos += 1;
                    let r = self.unary()?;
                    if r == 0.0 {
                        return Err(AppError::Core("除零错误".into()));
                    }
                    v /= r;
                }
                Some(Tok::Percent) => {
                    self.pos += 1;
                    let r = self.unary()?;
                    if r == 0.0 {
                        return Err(AppError::Core("除零错误".into()));
                    }
                    v %= r;
                }
                _ => break,
            }
        }
        Ok(v)
    }

    /// unary := ('-' | '+')* power
    fn unary(&mut self) -> AppResult<f64> {
        let mut sign = 1.0;
        loop {
            match self.peek() {
                Some(Tok::Minus) => {
                    self.pos += 1;
                    sign = -sign;
                }
                Some(Tok::Plus) => {
                    self.pos += 1;
                }
                _ => break,
            }
        }
        Ok(sign * self.power()?)
    }

    /// power := primary ('^' unary)?
    fn power(&mut self) -> AppResult<f64> {
        let base = self.primary()?;
        if matches!(self.peek(), Some(Tok::Caret)) {
            self.pos += 1;
            let exp = self.unary()?;
            return Ok(base.powf(exp));
        }
        Ok(base)
    }

    /// primary := number | function '(' args ')' | '(' expr ')'
    fn primary(&mut self) -> AppResult<f64> {
        match self.next() {
            Some(Tok::Num(v)) => Ok(v),
            Some(Tok::LParen) => {
                let v = self.expr()?;
                if !matches!(self.next(), Some(Tok::RParen)) {
                    return Err(err_illegal());
                }
                Ok(v)
            }
            Some(Tok::Ident(name)) => {
                if name == "pow" {
                    if !matches!(self.next(), Some(Tok::LParen)) {
                        return Err(err_illegal());
                    }
                    let a = self.expr()?;
                    if !matches!(self.next(), Some(Tok::Comma)) {
                        return Err(err_illegal());
                    }
                    let b = self.expr()?;
                    if !matches!(self.next(), Some(Tok::RParen)) {
                        return Err(err_illegal());
                    }
                    return Ok(a.powf(b));
                }
                if !matches!(self.next(), Some(Tok::LParen)) {
                    return Err(err_illegal());
                }
                let arg = self.expr()?;
                if !matches!(self.next(), Some(Tok::RParen)) {
                    return Err(err_illegal());
                }
                apply_func(&name, arg)
            }
            _ => Err(err_illegal()),
        }
    }
}

fn apply_func(name: &str, x: f64) -> AppResult<f64> {
    let r = match name {
        "sin" => x.sin(),
        "cos" => x.cos(),
        "tan" => x.tan(),
        "sqrt" => x.sqrt(),
        "log" => x.log10(),
        "ln" => x.ln(),
        "abs" => x.abs(),
        "floor" => x.floor(),
        "ceil" => x.ceil(),
        "round" => x.round(),
        _ => return Err(err_illegal()),
    };
    if !r.is_finite() {
        return Err(err_illegal());
    }
    Ok(r)
}

/// 单位换算(纯函数)。
///
/// 同类别 `value * factor_from / factor_to`;温度为摄氏度基准的特殊公式。
pub fn convert(value: f64, from: &str, to: &str) -> AppResult<f64> {
    let from_temp = matches!(from, "c" | "f" | "k");
    let to_temp = matches!(to, "c" | "f" | "k");
    if from_temp || to_temp {
        if !from_temp || !to_temp {
            return Err(not_same_category(from, to));
        }
        return Ok(from_celsius(to_celsius(value, from), to));
    }
    let (fc, ff) =
        unit_factor(from).ok_or_else(|| AppError::Core(format!("未知单位: {}", from)))?;
    let (tc, tf) = unit_factor(to).ok_or_else(|| AppError::Core(format!("未知单位: {}", to)))?;
    if fc != tc {
        return Err(not_same_category(from, to));
    }
    Ok(value * ff / tf)
}

fn not_same_category(from: &str, to: &str) -> AppError {
    AppError::Core(format!("无法换算: {} 与 {} 不是同一类", from, to))
}

/// 任意单位 → 摄氏度。
fn to_celsius(v: f64, unit: &str) -> f64 {
    match unit {
        "f" => (v - 32.0) * 5.0 / 9.0,
        "k" => v - 273.15,
        _ => v,
    }
}

/// 摄氏度 → 任意单位。
fn from_celsius(c: f64, unit: &str) -> f64 {
    match unit {
        "f" => c * 9.0 / 5.0 + 32.0,
        "k" => c + 273.15,
        _ => c,
    }
}

/// 基准单位换算表:(类别, 到基准的系数)。
fn unit_factor(u: &str) -> Option<(&'static str, f64)> {
    match u {
        // length(基准 m)
        "m" => Some(("length", 1.0)),
        "cm" => Some(("length", 0.01)),
        "mm" => Some(("length", 0.001)),
        "km" => Some(("length", 1000.0)),
        "ft" => Some(("length", 0.3048)),
        "in" => Some(("length", 0.0254)),
        "mi" => Some(("length", 1609.344)),
        // weight(基准 kg)
        "kg" => Some(("weight", 1.0)),
        "g" => Some(("weight", 0.001)),
        "mg" => Some(("weight", 0.000001)),
        "lb" => Some(("weight", 0.45359237)),
        "oz" => Some(("weight", 0.028349523125)),
        "t" => Some(("weight", 1000.0)),
        // data(基准 B)
        "B" => Some(("data", 1.0)),
        "KB" => Some(("data", 1024.0)),
        "MB" => Some(("data", 1024.0 * 1024.0)),
        "GB" => Some(("data", 1024.0 * 1024.0 * 1024.0)),
        // time(基准 s)
        "s" => Some(("time", 1.0)),
        "min" => Some(("time", 60.0)),
        "h" => Some(("time", 3600.0)),
        "day" => Some(("time", 86400.0)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use deltachat::chat::ChatId;
    use deltachat::context::Context;

    use super::*;
    use crate::db::Db;

    /// 持有构造 ToolContext 所需的所有权对象(短生命周期,仅测试用)。
    struct TestCtx {
        _tmp: tempfile::TempDir,
        dc: Context,
        db: Db,
        data_dir: std::path::PathBuf,
    }

    impl TestCtx {
        async fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let mut accounts = deltachat::accounts::Accounts::new(tmp.path().join("accounts"), true)
                .await
                .unwrap();
            let id = accounts.add_account().await.unwrap();
            let dc = accounts.get_account(id).unwrap();
            let db = Db::new(tmp.path().join("app.db")).await.unwrap();
            let data_dir = tmp.path().to_path_buf();
            Self {
                _tmp: tmp,
                dc,
                db,
                data_dir,
            }
        }

        fn tool_ctx(&self) -> ToolContext<'_> {
            ToolContext {
                dc: &self.dc,
                db: &self.db,
                bot_id: 1,
                chat_id: ChatId::new(123),
                data_dir: &self.data_dir,
            }
        }
    }

    #[test]
    fn test_eval_expr_basics() {
        assert!((eval_expr("2+3*4").unwrap() - 14.0).abs() < 1e-9);
        assert!((eval_expr("(2+3)*4").unwrap() - 20.0).abs() < 1e-9);
        assert!((eval_expr("2^10").unwrap() - 1024.0).abs() < 1e-9);
        assert!((eval_expr("10/4").unwrap() - 2.5).abs() < 1e-9);
        assert!((eval_expr("sqrt(16)+1").unwrap() - 5.0).abs() < 1e-9);
        assert!((eval_expr("pow(2,3)").unwrap() - 8.0).abs() < 1e-9);
        assert!((eval_expr("-5+3").unwrap() - (-2.0)).abs() < 1e-9);
    }

    #[test]
    fn test_eval_expr_errors() {
        assert!(eval_expr("1/0").is_err());
        assert!(eval_expr("abc").is_err());
        assert!(eval_expr("").is_err());
        assert!(eval_expr("   ").is_err());
        let too_long = "1+".repeat(120);
        assert!(too_long.len() > 200);
        assert!(eval_expr(&too_long).is_err());
    }

    #[test]
    fn test_convert_ok() {
        assert!((convert(100.0, "cm", "m").unwrap() - 1.0).abs() < 1e-9);
        assert!((convert(1.0, "km", "m").unwrap() - 1000.0).abs() < 1e-9);
        assert!(convert(32.0, "f", "c").unwrap().abs() < 1e-9);
        assert!((convert(1.0, "GB", "MB").unwrap() - 1024.0).abs() < 1e-9);
        assert!((convert(2.0, "h", "min").unwrap() - 120.0).abs() < 1e-9);
    }

    #[test]
    fn test_convert_err() {
        assert!(convert(1.0, "cm", "kg").is_err());
        assert!(convert(1.0, "foo", "m").is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_get_time_execute() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();
        let out = GetTimeTool
            .execute(serde_json::json!({}), &ctx)
            .await
            .unwrap();
        assert!(!out.is_empty());
        assert!(out.contains("时间"));
    }

    #[test]
    fn test_tool_meta() {
        let tools: [Box<dyn Tool>; 3] = [
            Box::new(GetTimeTool),
            Box::new(CalculateTool),
            Box::new(ConvertUnitsTool),
        ];
        for t in tools {
            assert!(!t.name().is_empty());
            assert!(!t.description().is_empty());
            assert_eq!(t.parameters()["type"], "object");
        }
    }
}
