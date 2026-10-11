use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::cli::{CallOptions, Cli};
use crate::docs::Feature;
use crate::model::{Problem, ProblemKind};
use crate::registry::{Tool, ToolsStatus};

pub const UPGRADE_TALLY_COWORKERS: &str = "Actualiza tally a 0.5 para consultar compañeros";
pub const OVERTIME_CAPABILITY: &str = "timesheet.overtime";
const UPGRADE_HINT: &str = "npm install -g @kikedealba/tally@latest";
const OVERTIME_SECONDS: u64 = 90;
const EXCLUDE_SECONDS: u64 = 30;
const MAX_KEY_LENGTH: usize = 20;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkerQuery {
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    pub from_month: String,
    pub to_month: String,
    #[serde(default)]
    pub salary: Option<f64>,
    pub monthly_hours: f64,
    pub multiplier: f64,
    pub currency: String,
    #[serde(default)]
    pub site: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rate {
    #[serde(default)]
    pub hourly_rate: Option<f64>,
    pub monthly_hours: f64,
    pub multiplier: f64,
    pub currency: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OvertimeIssue {
    pub key: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default, deserialize_with = "project_text")]
    pub project: Option<String>,
    #[serde(default, deserialize_with = "loose_text")]
    pub status: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub estimate_seconds: Option<f64>,
    #[serde(default, deserialize_with = "loose_url")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkerMonth {
    pub month: String,
    #[serde(default)]
    pub estimate_seconds: f64,
    #[serde(default)]
    pub expected_seconds: f64,
    #[serde(default)]
    pub overtime_seconds: f64,
    #[serde(default)]
    pub pay_x1: Option<f64>,
    #[serde(default)]
    pub pay_multiplied: Option<f64>,
    #[serde(default)]
    pub issues: Vec<OvertimeIssue>,
    #[serde(default)]
    pub without_estimate: Vec<OvertimeIssue>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkerTotals {
    #[serde(default)]
    pub estimate_seconds: f64,
    #[serde(default)]
    pub expected_seconds: f64,
    #[serde(default)]
    pub overtime_seconds: f64,
    #[serde(default)]
    pub pay_x1: Option<f64>,
    #[serde(default)]
    pub pay_multiplied: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkerOvertime {
    pub person: Person,
    pub rate: Rate,
    #[serde(default)]
    pub months: Vec<CoworkerMonth>,
    #[serde(default)]
    pub totals: Option<CoworkerTotals>,
    #[serde(default, deserialize_with = "loose_url")]
    pub site_url: Option<String>,
}

impl CoworkerOvertime {
    pub fn link_issues(&mut self) {
        let site = self.site_url.as_deref().and_then(site_url);
        for month in &mut self.months {
            for issue in month.issues.iter_mut().chain(month.without_estimate.iter_mut()) {
                issue.url = issue
                    .url
                    .as_deref()
                    .and_then(|url| jira_url(url, &issue.key, site.as_deref()))
                    .or_else(|| site.as_deref().filter(|_| issue_key(&issue.key)).map(|site| format!("{site}/browse/{}", issue.key)));
            }
        }
        self.site_url = site;
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub display_name: String,
    pub email: Option<String>,
    pub account_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CoworkerOutcome {
    Ready { overtime: CoworkerOvertime },
    Ambiguous { candidates: Vec<Candidate> },
}

fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Object(map) => ["key", "name", "displayName"]
            .iter()
            .find_map(|field| map.get(*field).and_then(Value::as_str))
            .map(|found| found.trim().to_string())
            .filter(|found| !found.is_empty()),
        _ => None,
    }
}

fn project_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    Ok(text(&Value::deserialize(deserializer)?))
}

fn loose_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(match &value {
        Value::Object(map) => map.get("name").and_then(Value::as_str).map(str::to_string),
        other => text(other),
    })
}

fn loose_url<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        _ => None,
    })
}

fn url_safe(text: &str) -> bool {
    text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '.' | '_' | '~'))
}

fn https_parts(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("https://")?;
    let (host, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let host_ok = !host.is_empty()
        && !host.starts_with(['.', '-'])
        && host.contains('.')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    (host_ok && url_safe(path)).then_some((host, path))
}

pub fn site_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    https_parts(trimmed)?;
    Some(trimmed.to_string())
}

fn valid_project(key: &str) -> bool {
    key.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && key.len() <= MAX_KEY_LENGTH
        && key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

pub fn issue_key(key: &str) -> bool {
    let Some((project, number)) = key.rsplit_once('-') else {
        return false;
    };
    valid_project(project)
        && !number.is_empty()
        && number.len() <= 12
        && number.chars().all(|c| c.is_ascii_digit())
}

pub fn jira_url(raw: &str, key: &str, site: Option<&str>) -> Option<String> {
    let url = raw.trim();
    let (host, path) = https_parts(url)?;
    let tail = path.rsplit_once("/browse/")?.1;
    let trusted = host.ends_with(".atlassian.net") || site.is_some_and(|site| url.starts_with(&format!("{site}/")));
    (trusted && issue_key(key) && tail == key).then(|| url.to_string())
}

fn meta_site(envelope: &Value) -> Option<String> {
    [envelope.get("meta"), envelope.get("data").and_then(|data| data.get("meta"))]
        .into_iter()
        .flatten()
        .find_map(|holder| holder.get("siteUrl").and_then(Value::as_str))
        .map(str::to_string)
}

fn invalid(message: impl Into<String>) -> Problem {
    Problem::new(ProblemKind::CliFailed, message)
}

fn upgrade() -> Problem {
    Problem::new(ProblemKind::CliTooOld, UPGRADE_TALLY_COWORKERS).with_hint(Some(UPGRADE_HINT.to_string()))
}

fn valid_month(month: &str) -> bool {
    let bytes = month.as_bytes();
    bytes.len() == 7
        && bytes[4] == b'-'
        && bytes.iter().enumerate().all(|(index, byte)| index == 4 || byte.is_ascii_digit())
        && matches!(month[5..].parse::<u32>(), Ok(1..=12))
}

fn flag_value(value: &str, what: &str) -> Result<String, Problem> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(invalid(format!("Falta {what}.")));
    }
    if trimmed.starts_with('-') {
        return Err(invalid(format!("{what} no puede empezar con guion.")));
    }
    Ok(trimmed.to_string())
}

fn number(value: f64) -> String {
    let rounded = (value * 100.0).round() / 100.0;
    if rounded.fract() == 0.0 {
        format!("{}", rounded as i64)
    } else {
        format!("{rounded}")
    }
}

pub fn overtime_args(query: &CoworkerQuery) -> Result<Vec<String>, Problem> {
    let mut args = vec!["overtime".to_string()];
    let account = query.account_id.as_deref().map(str::trim).filter(|id| !id.is_empty());
    match account {
        Some(id) => {
            args.push("--account-id".into());
            args.push(flag_value(id, "la cuenta de Jira")?);
        }
        None => {
            args.push("--user".into());
            args.push(flag_value(query.user.as_deref().unwrap_or_default(), "el nombre del compañero")?);
        }
    }
    let from = query.from_month.trim();
    let to = query.to_month.trim();
    if !valid_month(from) || !valid_month(to) {
        return Err(invalid("Los meses van como AAAA-MM."));
    }
    if from > to {
        return Err(invalid("El mes de inicio debe ser anterior o igual al final."));
    }
    args.extend(["--from".into(), from.to_string(), "--to".into(), to.to_string()]);
    if let Some(salary) = query.salary {
        if !salary.is_finite() || salary <= 0.0 {
            return Err(invalid("El sueldo debe ser un número mayor que cero."));
        }
        args.push("--salary-stdin".into());
    }
    if !query.monthly_hours.is_finite() || query.monthly_hours < 1.0 || query.monthly_hours > 744.0 {
        return Err(invalid("Las horas al mes deben estar entre 1 y 744."));
    }
    if !query.multiplier.is_finite() || query.multiplier < 1.0 || query.multiplier > 10.0 {
        return Err(invalid("El multiplicador debe estar entre 1 y 10."));
    }
    let currency = query.currency.trim().to_uppercase();
    if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_uppercase()) {
        return Err(invalid("La moneda va en código de tres letras, como MXN."));
    }
    args.extend([
        "--monthly-hours".into(),
        number(query.monthly_hours),
        "--multiplier".into(),
        number(query.multiplier),
        "--currency".into(),
        currency,
    ]);
    if let Some(site) = query.site.as_deref().map(str::trim).filter(|site| !site.is_empty()) {
        args.push("--site".into());
        args.push(flag_value(site, "el sitio de Jira")?);
    }
    Ok(args)
}

pub fn salary_input(query: &CoworkerQuery) -> Option<String> {
    query.salary.filter(|salary| salary.is_finite() && *salary > 0.0).map(|salary| format!("{salary}\n"))
}

fn candidate(value: &Value) -> Option<Candidate> {
    let account_id = value.get("accountId").and_then(Value::as_str)?.trim().to_string();
    if account_id.is_empty() {
        return None;
    }
    let display_name = ["displayName", "name"]
        .iter()
        .find_map(|field| value.get(*field).and_then(Value::as_str))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(&account_id)
        .to_string();
    let email = ["email", "emailAddress"]
        .iter()
        .find_map(|field| value.get(*field).and_then(Value::as_str))
        .map(str::trim)
        .filter(|email| !email.is_empty())
        .map(str::to_string);
    Some(Candidate { display_name, email, account_id })
}

fn candidates(envelope: &Value) -> Vec<Candidate> {
    let data = envelope.get("data");
    let error = envelope.get("error");
    let lists = [
        data.and_then(|data| data.get("candidates")),
        data.filter(|data| data.is_array()),
        error.and_then(|error| error.get("candidates")),
        error.and_then(|error| error.get("details")).and_then(|details| details.get("candidates")),
    ];
    lists
        .into_iter()
        .flatten()
        .find_map(Value::as_array)
        .map(|items| items.iter().filter_map(candidate).collect())
        .unwrap_or_default()
}

fn error_field<'a>(envelope: &'a Value, field: &str) -> Option<&'a str> {
    envelope.get("error").and_then(|error| error.get(field)).and_then(Value::as_str)
}

fn is_unknown_command(code: &str, message: &str) -> bool {
    let lower = message.to_lowercase();
    code == "UNKNOWN_COMMAND" || (code == "USAGE_ERROR" && lower.contains("unknown") && lower.contains("overtime"))
}

fn failure(envelope: &Value) -> Problem {
    let code = error_field(envelope, "code").unwrap_or("UNKNOWN");
    let message = error_field(envelope, "message").unwrap_or("tally falló sin decir por qué.");
    let hint = error_field(envelope, "hint").map(str::to_string);
    Problem::new(ProblemKind::CliFailed, format!("{message} ({code})")).with_hint(hint)
}

fn totals_from(months: &[CoworkerMonth]) -> CoworkerTotals {
    let sum = |pick: fn(&CoworkerMonth) -> Option<f64>| -> Option<f64> {
        months.iter().map(pick).try_fold(0.0, |total, value| value.map(|value| total + value))
    };
    CoworkerTotals {
        estimate_seconds: months.iter().map(|month| month.estimate_seconds).sum(),
        expected_seconds: months.iter().map(|month| month.expected_seconds).sum(),
        overtime_seconds: months.iter().map(|month| month.overtime_seconds).sum(),
        pay_x1: if months.is_empty() { None } else { sum(|month| month.pay_x1) },
        pay_multiplied: if months.is_empty() { None } else { sum(|month| month.pay_multiplied) },
    }
}

pub fn read_outcome(envelope: &Value) -> Result<CoworkerOutcome, Problem> {
    if envelope.get("ok").and_then(Value::as_bool) == Some(true) {
        let data = envelope.get("data").cloned().unwrap_or(Value::Null);
        let mut overtime: CoworkerOvertime = serde_json::from_value(data).map_err(|error| {
            Problem::new(ProblemKind::Unreadable, format!("No entiendo la respuesta de tally overtime: {error}"))
        })?;
        if overtime.totals.is_none() {
            overtime.totals = Some(totals_from(&overtime.months));
        }
        if overtime.site_url.is_none() {
            overtime.site_url = meta_site(envelope);
        }
        overtime.link_issues();
        return Ok(CoworkerOutcome::Ready { overtime });
    }
    let code = error_field(envelope, "code").unwrap_or_default();
    let message = error_field(envelope, "message").unwrap_or_default();
    match code {
        "USER_AMBIGUOUS" => {
            let found = candidates(envelope);
            if found.is_empty() {
                Err(invalid("Hay varias personas con ese nombre en Jira. Escribe el nombre completo."))
            } else {
                Ok(CoworkerOutcome::Ambiguous { candidates: found })
            }
        }
        "USER_NOT_FOUND" => Err(invalid("No encontré a nadie en Jira con ese nombre.")
            .with_hint(Some("Revisa cómo está escrito o prueba con el correo.".to_string()))),
        _ if is_unknown_command(code, message) => Err(upgrade()),
        _ => Err(failure(envelope)),
    }
}

pub fn read_excludes(data: &Value) -> Option<Vec<String>> {
    let list = match data {
        Value::Array(items) => items,
        Value::Object(map) => ["excludedProjects", "excluded", "keys", "projects", "exclude"]
            .iter()
            .find_map(|field| map.get(*field).and_then(Value::as_array))?,
        _ => return None,
    };
    let mut keys: Vec<String> = list.iter().filter_map(text).map(|key| key.to_uppercase()).collect();
    keys.sort();
    keys.dedup();
    Some(keys)
}

pub fn project_key(key: &str) -> Result<String, Problem> {
    let key = key.trim().to_uppercase();
    if !valid_project(&key) {
        return Err(invalid("La clave de proyecto de Jira va en mayúsculas, como PP."));
    }
    Ok(key)
}

pub fn supported(status: &ToolsStatus) -> Option<bool> {
    let tally = status.tool(Tool::Tally)?;
    if tally.capabilities.iter().any(|cap| cap == OVERTIME_CAPABILITY) {
        return Some(true);
    }
    if tally.verified {
        return Some(false);
    }
    None
}

async fn tally() -> Result<Cli, Problem> {
    let status = crate::docs::require(Feature::Jira).await?;
    if supported(&status) == Some(false) {
        return Err(upgrade());
    }
    Cli::for_tool(Tool::Tally).await
}

#[tauri::command]
pub async fn coworker_overtime(query: CoworkerQuery) -> Result<CoworkerOutcome, Problem> {
    let args = overtime_args(&query)?;
    let cli = tally().await?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut options = CallOptions::timeout(OVERTIME_SECONDS);
    if let Some(input) = salary_input(&query) {
        options = options.with_stdin(input);
    }
    let envelope = cli.raw_envelope(&refs, options).await.map_err(old_tally_output)?;
    read_outcome(&envelope)
}

pub fn old_tally_output(problem: Problem) -> Problem {
    let lower = problem.message.to_lowercase();
    if problem.kind == ProblemKind::Unreadable && lower.contains("unknown command") && lower.contains("overtime") {
        upgrade()
    } else {
        problem
    }
}

async fn excludes(args: &[&str]) -> Result<Vec<String>, Problem> {
    let cli = tally().await?;
    let envelope = cli.raw_envelope(args, CallOptions::timeout(EXCLUDE_SECONDS)).await.map_err(old_tally_output)?;
    if envelope.get("ok").and_then(Value::as_bool) != Some(true) {
        let code = error_field(&envelope, "code").unwrap_or_default();
        let message = error_field(&envelope, "message").unwrap_or_default();
        return Err(if is_unknown_command(code, message) { upgrade() } else { failure(&envelope) });
    }
    if let Some(keys) = envelope.get("data").and_then(read_excludes) {
        return Ok(keys);
    }
    let listed = if args.get(2) == Some(&"ls") {
        envelope
    } else {
        cli.raw_envelope(&["overtime", "exclude", "ls"], CallOptions::timeout(EXCLUDE_SECONDS)).await?
    };
    listed.get("data").and_then(read_excludes).ok_or_else(|| {
        Problem::new(ProblemKind::Unreadable, "No entiendo la lista de proyectos excluidos de tally.")
    })
}

#[tauri::command]
pub async fn overtime_excludes_list() -> Result<Vec<String>, Problem> {
    excludes(&["overtime", "exclude", "ls"]).await
}

#[tauri::command]
pub async fn overtime_excludes_add(key: String) -> Result<Vec<String>, Problem> {
    let key = project_key(&key)?;
    excludes(&["overtime", "exclude", "add", &key]).await
}

#[tauri::command]
pub async fn overtime_excludes_remove(key: String) -> Result<Vec<String>, Problem> {
    let key = project_key(&key)?;
    excludes(&["overtime", "exclude", "rm", &key]).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SALARY: f64 = 12345.67;

    fn query() -> CoworkerQuery {
        CoworkerQuery {
            user: Some("Ana Pérez".into()),
            account_id: None,
            from_month: "2026-09".into(),
            to_month: "2026-10".into(),
            salary: Some(SALARY),
            monthly_hours: 160.0,
            multiplier: 2.0,
            currency: "mxn".into(),
            site: None,
        }
    }

    #[test]
    fn the_salary_goes_by_stdin_and_never_in_the_arguments() {
        let args = overtime_args(&query()).expect("args");
        assert_eq!(
            args,
            vec![
                "overtime", "--user", "Ana Pérez", "--from", "2026-09", "--to", "2026-10", "--salary-stdin",
                "--monthly-hours", "160", "--multiplier", "2", "--currency", "MXN",
            ]
        );
        assert!(args.iter().all(|arg| !arg.contains("12345")));
        assert!(!args.iter().any(|arg| arg == "--json"));
        assert_eq!(salary_input(&query()).as_deref(), Some("12345.67\n"));
    }

    #[test]
    fn without_salary_there_is_no_stdin_flag() {
        let plain = CoworkerQuery { salary: None, ..query() };
        let args = overtime_args(&plain).expect("args");
        assert!(!args.iter().any(|arg| arg == "--salary-stdin"));
        assert!(salary_input(&plain).is_none());
    }

    #[test]
    fn an_account_id_and_a_site_replace_the_name_search() {
        let picked = CoworkerQuery {
            account_id: Some(" 5b10ac8d82e05b22cc7d4ef5 ".into()),
            site: Some("gruposti".into()),
            multiplier: 2.5,
            monthly_hours: 180.0,
            ..query()
        };
        let args = overtime_args(&picked).expect("args");
        assert_eq!(&args[1..3], ["--account-id", "5b10ac8d82e05b22cc7d4ef5"]);
        assert!(!args.iter().any(|arg| arg == "--user"));
        assert!(args.windows(2).any(|pair| pair == ["--multiplier", "2.5"]));
        assert!(args.windows(2).any(|pair| pair == ["--monthly-hours", "180"]));
        assert_eq!(&args[args.len() - 2..], ["--site", "gruposti"]);
    }

    #[test]
    fn bad_input_is_rejected_before_calling_tally() {
        let cases = [
            CoworkerQuery { user: Some("  ".into()), ..query() },
            CoworkerQuery { user: Some("--salary".into()), ..query() },
            CoworkerQuery { from_month: "2026-9".into(), ..query() },
            CoworkerQuery { to_month: "2026-13".into(), ..query() },
            CoworkerQuery { from_month: "2026-11".into(), ..query() },
            CoworkerQuery { salary: Some(-5.0), ..query() },
            CoworkerQuery { salary: Some(f64::NAN), ..query() },
            CoworkerQuery { monthly_hours: 0.0, ..query() },
            CoworkerQuery { multiplier: 0.5, ..query() },
            CoworkerQuery { currency: "MX$".into(), ..query() },
            CoworkerQuery { site: Some("-x".into()), ..query() },
        ];
        for case in cases {
            let problem = overtime_args(&case).expect_err("rejected");
            assert!(!problem.message.contains("12345"));
        }
    }

    fn two_months() -> Value {
        json!({
            "schemaVersion": 1,
            "ok": true,
            "command": "overtime",
            "data": {
                "person": {"name": "Ana Pérez", "accountId": "acc-1", "source": "jira"},
                "rate": {"hourlyRate": 100.0, "monthlyHours": 160, "multiplier": 2, "currency": "MXN"},
                "months": [
                    {
                        "month": "2026-09", "estimateSeconds": 612000, "expectedSeconds": 576000, "overtimeSeconds": 36000,
                        "payX1": 1000.0, "payMultiplied": 2000.0,
                        "issues": [{"key": "PP-1", "summary": "Alta", "project": {"key": "PP", "name": "DPSuite"}, "status": "Done", "startDate": "2026-09-03", "estimateSeconds": 612000}],
                        "withoutEstimate": [{"key": "PP-2", "summary": "Sin estimar", "project": "PP", "status": {"name": "Listo"}, "startDate": "2026-09-10", "estimateSeconds": null}]
                    },
                    {"month": "2026-10", "estimateSeconds": 0, "expectedSeconds": 576000, "overtimeSeconds": 0, "payX1": 0, "payMultiplied": 0, "issues": [], "withoutEstimate": []}
                ],
                "totals": {"estimateSeconds": 612000, "expectedSeconds": 1152000, "overtimeSeconds": 36000, "payX1": 1000.0, "payMultiplied": 2000.0}
            }
        })
    }

    #[test]
    fn a_two_month_result_is_read() {
        let CoworkerOutcome::Ready { overtime } = read_outcome(&two_months()).expect("ready") else {
            panic!("expected ready");
        };
        assert_eq!(overtime.person.account_id.as_deref(), Some("acc-1"));
        assert_eq!(overtime.months.len(), 2);
        let september = &overtime.months[0];
        assert_eq!(september.issues[0].project.as_deref(), Some("PP"));
        assert_eq!(september.without_estimate[0].project.as_deref(), Some("PP"));
        assert_eq!(september.without_estimate[0].status.as_deref(), Some("Listo"));
        assert_eq!(september.without_estimate[0].estimate_seconds, None);
        assert_eq!(overtime.totals.expect("totals").pay_multiplied, Some(2000.0));
        let json = serde_json::to_value(read_outcome(&two_months()).expect("ready")).expect("json");
        assert_eq!(json["status"], "ready");
        assert!(!json.to_string().contains("salary"));
    }

    fn real_overtime(first_url: Value, site_url: Value) -> Value {
        json!({
            "schemaVersion": 1,
            "ok": true,
            "command": "overtime",
            "meta": {"site": null, "siteUrl": site_url, "startField": {"id": "customfield_10015"}, "excludedProjects": ["OPS"], "queries": [], "warnings": []},
            "data": {
                "person": {"name": "Ana Pérez", "accountId": "acc-1", "source": "jira"},
                "rate": {"hourlyRate": null, "monthlyHours": 160, "multiplier": 2, "currency": "MXN"},
                "months": [{
                    "month": "2026-09", "estimateSeconds": 28800, "expectedSeconds": 576000, "overtimeSeconds": 0, "payX1": null, "payMultiplied": null,
                    "issues": [
                        {"key": "PP-101", "summary": "Alta", "project": "PP", "status": "Listo", "startDate": "2026-09-03", "estimateSeconds": 28800, "url": first_url},
                        {"key": "PP-102", "summary": "Baja", "project": "PP", "status": "Listo", "startDate": "2026-09-04", "estimateSeconds": 0, "url": "javascript:alert(1)//browse/PP-102"}
                    ],
                    "withoutEstimate": [{"key": "PP-103", "summary": "Sin estimar", "project": "PP", "status": "Listo", "startDate": "2026-09-10", "estimateSeconds": null, "url": null}]
                }],
                "totals": {"estimateSeconds": 28800, "expectedSeconds": 576000, "overtimeSeconds": 0, "payX1": null, "payMultiplied": null}
            }
        })
    }

    fn urls(overtime: &CoworkerOvertime) -> Vec<Option<String>> {
        overtime.months.iter().flat_map(|month| month.issues.iter().chain(&month.without_estimate)).map(|issue| issue.url.clone()).collect()
    }

    #[test]
    fn issue_urls_are_kept_validated_or_built_from_the_site() {
        let envelope = real_overtime(json!("https://gruposti.atlassian.net/browse/PP-101"), json!("https://gruposti.atlassian.net/"));
        let CoworkerOutcome::Ready { overtime } = read_outcome(&envelope).expect("ready") else {
            panic!("expected ready");
        };
        assert_eq!(overtime.site_url.as_deref(), Some("https://gruposti.atlassian.net"));
        assert_eq!(overtime.months[0].issues[0].project.as_deref(), Some("PP"));
        assert_eq!(overtime.months[0].issues[0].status.as_deref(), Some("Listo"));
        assert_eq!(
            urls(&overtime),
            vec![
                Some("https://gruposti.atlassian.net/browse/PP-101".to_string()),
                Some("https://gruposti.atlassian.net/browse/PP-102".to_string()),
                Some("https://gruposti.atlassian.net/browse/PP-103".to_string()),
            ]
        );
        let json = serde_json::to_value(CoworkerOutcome::Ready { overtime }).expect("json");
        assert_eq!(json["overtime"]["months"][0]["issues"][0]["url"], "https://gruposti.atlassian.net/browse/PP-101");
        assert_eq!(json["overtime"]["siteUrl"], "https://gruposti.atlassian.net");
    }

    #[test]
    fn an_old_tally_without_urls_leaves_keys_as_text() {
        let mut envelope = real_overtime(Value::Null, Value::Null);
        envelope.as_object_mut().expect("object").remove("meta");
        let CoworkerOutcome::Ready { overtime } = read_outcome(&envelope).expect("ready") else {
            panic!("expected ready");
        };
        assert_eq!(urls(&overtime), vec![None, None, None]);
        let hostile = real_overtime(json!("https://evil.example.com/browse/PP-101"), json!("http://gruposti.atlassian.net"));
        let CoworkerOutcome::Ready { overtime } = read_outcome(&hostile).expect("ready") else {
            panic!("expected ready");
        };
        assert_eq!(overtime.site_url, None);
        assert_eq!(urls(&overtime), vec![None, None, None]);
    }

    #[test]
    fn jira_urls_must_be_https_and_end_in_the_key() {
        assert!(jira_url("https://acme.atlassian.net/browse/PP-1", "PP-1", None).is_some());
        assert!(jira_url("https://jira.acme.com/jira/browse/OPS_2-77", "OPS_2-77", Some("https://jira.acme.com/jira")).is_some());
        assert!(jira_url("https://jira.acme.com/jira/browse/OPS_2-77", "OPS_2-77", None).is_none());
        assert!(jira_url("https://evil.example.com/browse/PP-1", "PP-1", Some("https://acme.atlassian.net")).is_none());
        for bad in [
            "http://acme.atlassian.net/browse/PP-1",
            "https://acme.atlassian.net/browse/PP-2",
            "https://acme.atlassian.net/browse/PP-1?x=\"<",
            "https://acme.atlassian.net/browse/PP-1 x",
            "https://-acme/browse/PP-1",
            "https:///browse/PP-1",
            "javascript:alert(1)",
        ] {
            assert!(jira_url(bad, "PP-1", None).is_none(), "{bad} accepted");
        }
        assert!(jira_url("https://acme.atlassian.net/browse/pp-1", "pp-1", None).is_none());
    }

    #[test]
    fn a_result_without_salary_has_no_amounts_and_totals_are_filled() {
        let envelope = json!({
            "ok": true,
            "data": {
                "person": {"name": "Ana Pérez", "accountId": "acc-1", "source": "jira"},
                "rate": {"hourlyRate": null, "monthlyHours": 160, "multiplier": 2, "currency": "MXN"},
                "months": [{"month": "2026-10", "estimateSeconds": 600000, "expectedSeconds": 576000, "overtimeSeconds": 24000, "payX1": null, "payMultiplied": null}]
            }
        });
        let CoworkerOutcome::Ready { overtime } = read_outcome(&envelope).expect("ready") else {
            panic!("expected ready");
        };
        assert_eq!(overtime.rate.hourly_rate, None);
        let totals = overtime.totals.expect("totals");
        assert_eq!(totals.overtime_seconds, 24000.0);
        assert_eq!(totals.pay_x1, None);
        assert!(overtime.months[0].issues.is_empty());
    }

    #[test]
    fn an_ambiguous_name_returns_candidates() {
        let envelope = json!({
            "ok": false,
            "error": {"code": "USER_AMBIGUOUS", "message": "Several users match \"Ana\"."},
            "data": {"candidates": [
                {"displayName": "Ana Pérez", "email": "ana@example.com", "accountId": "acc-1"},
                {"displayName": "Ana López", "accountId": "acc-2"},
                {"displayName": "Sin cuenta"}
            ]}
        });
        assert_eq!(
            read_outcome(&envelope).expect("ambiguous"),
            CoworkerOutcome::Ambiguous {
                candidates: vec![
                    Candidate { display_name: "Ana Pérez".into(), email: Some("ana@example.com".into()), account_id: "acc-1".into() },
                    Candidate { display_name: "Ana López".into(), email: None, account_id: "acc-2".into() },
                ]
            }
        );
        let in_error = json!({"ok": false, "error": {"code": "USER_AMBIGUOUS", "message": "x", "candidates": [{"name": "Ana", "accountId": "acc-3"}]}});
        let CoworkerOutcome::Ambiguous { candidates } = read_outcome(&in_error).expect("ambiguous") else {
            panic!("expected ambiguous");
        };
        assert_eq!(candidates[0].display_name, "Ana");
        let json = serde_json::to_value(read_outcome(&envelope).expect("ambiguous")).expect("json");
        assert_eq!(json["status"], "ambiguous");
        assert_eq!(json["candidates"][0]["displayName"], "Ana Pérez");
    }

    #[test]
    fn nobody_found_is_a_spanish_problem() {
        let envelope = json!({"ok": false, "error": {"code": "USER_NOT_FOUND", "message": "No user matches."}});
        let problem = read_outcome(&envelope).expect_err("not found");
        assert_eq!(problem.message, "No encontré a nadie en Jira con ese nombre.");
        let other = json!({"ok": false, "error": {"code": "ATL_FAILED", "message": "atl failed", "hint": "atl site test"}});
        let problem = read_outcome(&other).expect_err("failed");
        assert_eq!(problem.message, "atl failed (ATL_FAILED)");
        assert_eq!(problem.hint.as_deref(), Some("atl site test"));
    }

    #[test]
    fn an_old_tally_asks_to_upgrade() {
        let envelope = json!({"ok": false, "error": {"code": "UNKNOWN_COMMAND", "message": "Unknown command \"overtime\"."}});
        let problem = read_outcome(&envelope).expect_err("old");
        assert_eq!(problem.kind, ProblemKind::CliTooOld);
        assert_eq!(problem.message, UPGRADE_TALLY_COWORKERS);
        let usage = json!({"ok": false, "error": {"code": "USAGE_ERROR", "message": "Unknown command overtime"}});
        assert_eq!(read_outcome(&usage).expect_err("old").message, UPGRADE_TALLY_COWORKERS);
        let plain = Problem::new(ProblemKind::Unreadable, "tally no devolvió una respuesta que entienda: error: unknown command 'overtime'");
        assert_eq!(old_tally_output(plain).message, UPGRADE_TALLY_COWORKERS);
        let other = Problem::new(ProblemKind::CliFailed, "tally no respondió en 90 s.");
        assert_eq!(old_tally_output(other).message, "tally no respondió en 90 s.");
    }

    #[test]
    fn capabilities_decide_support_when_known() {
        use crate::registry::{Modules, ToolState, ToolStatus};
        let status = |capabilities: &[&str], verified: bool| ToolsStatus {
            registry_dir: "/r".into(),
            tools: vec![ToolStatus {
                name: "tally".into(),
                known: true,
                state: ToolState::Ready,
                version: None,
                capabilities: capabilities.iter().map(|cap| cap.to_string()).collect(),
                verified,
                origin: None,
                command: None,
                manifest: None,
                install: String::new(),
                purpose: None,
            }],
            invalid: Vec::new(),
            modules: Modules::default(),
            inkwell_migrated: None,
        };
        assert_eq!(supported(&status(&["timesheet.summary", OVERTIME_CAPABILITY], true)), Some(true));
        assert_eq!(supported(&status(&["timesheet.summary"], true)), Some(false));
        assert_eq!(supported(&status(&["timesheet.summary"], false)), None);
    }

    #[test]
    fn excludes_are_read_from_lists_or_objects() {
        assert_eq!(read_excludes(&json!(["pp", "OPS"])), Some(vec!["OPS".to_string(), "PP".to_string()]));
        assert_eq!(read_excludes(&json!({"excluded": [{"key": "PP"}, "PP"]})), Some(vec!["PP".to_string()]));
        assert_eq!(read_excludes(&json!({"added": "PP"})), None);
        let real = json!({"ok": true, "command": "overtime exclude ls", "meta": {"path": "/x/overtime.json"}, "data": {"excludedProjects": []}});
        assert_eq!(real.get("data").and_then(read_excludes), Some(Vec::new()));
        let added = json!({"ok": true, "command": "overtime exclude add", "meta": {"path": "/x/overtime.json"}, "data": {"excludedProjects": ["PP", "ops"]}});
        assert_eq!(added.get("data").and_then(read_excludes), Some(vec!["OPS".to_string(), "PP".to_string()]));
        assert_eq!(project_key(" pp ").expect("key"), "PP");
        assert!(project_key("1PP").is_err());
        assert!(project_key("-PP").is_err());
        assert!(project_key("P P").is_err());
    }
}
