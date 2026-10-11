use std::collections::HashMap;
use std::path::{Path, PathBuf};

use jiff::tz::TimeZone;
use jiff::Timestamp;
use rust_xlsxwriter::{Chart, ChartType, Format, Workbook, Worksheet, XlsxError};
use serde::Deserialize;
use serde_json::Value;

use crate::cli::node;
use crate::model::{Problem, ProblemKind};
use crate::pdf::{sanitize_with, unique_path_with};

const NO_PROJECT: &str = "Sin proyecto";
pub(crate) const BOM: &str = "\u{feff}";
const NONE_KEY: &str = "none";
const DEFAULT_CURRENCY: &str = "MXN";
const OVERTIME: &str = "Horas extra";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Md,
    Xlsx,
}

impl ExportFormat {
    pub(crate) fn extension(self) -> &'static str {
        match self {
            ExportFormat::Csv => "csv",
            ExportFormat::Md => "md",
            ExportFormat::Xlsx => "xlsx",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupBy {
    #[default]
    Project,
    Day,
    Week,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Include {
    pub charts: Option<bool>,
    pub projects: Option<bool>,
    pub entries: Option<bool>,
    pub jira: Option<bool>,
    pub pay: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ReportRange {
    from_day: Option<String>,
    to_day: Option<String>,
    timezone: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ReportProject {
    project_id: Option<Value>,
    name: Option<String>,
    client_name: Option<String>,
    total_seconds: Option<f64>,
    entry_count: Option<f64>,
    jira: Option<bool>,
    registered_seconds: Option<f64>,
    pending_seconds: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct DayProject {
    project_id: Option<Value>,
    seconds: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ReportDay {
    day: Option<String>,
    from_day: Option<String>,
    to_day: Option<String>,
    total_seconds: Option<f64>,
    projects: Option<Vec<DayProject>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ReportEntry {
    title: Option<String>,
    project_id: Option<Value>,
    start: Option<String>,
    stop: Option<String>,
    local_day: Option<String>,
    seconds: Option<f64>,
    registered: Option<bool>,
    issue_key: Option<String>,
    excluded_reason: Option<String>,
    jira: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ReportOvertimeMonth {
    month: Option<String>,
    partial: Option<bool>,
    estimate_seconds: Option<f64>,
    expected_seconds: Option<f64>,
    overtime_seconds: Option<f64>,
    pay_x1: Option<f64>,
    pay_multiplied: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ReportOvertimeTotals {
    estimate_seconds: Option<f64>,
    expected_seconds: Option<f64>,
    overtime_seconds: Option<f64>,
    pay_x1: Option<f64>,
    pay_multiplied: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ReportOvertime {
    hourly_rate: Option<f64>,
    multiplier: Option<f64>,
    currency: Option<String>,
    months: Option<Vec<ReportOvertimeMonth>>,
    totals: Option<ReportOvertimeTotals>,
    problem: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ReportView {
    range: Option<ReportRange>,
    total_seconds: Option<f64>,
    entry_count: Option<f64>,
    active_days: Option<f64>,
    projects: Option<Vec<ReportProject>>,
    days: Option<Vec<ReportDay>>,
    weeks: Option<Vec<ReportDay>>,
    entries: Option<Vec<ReportEntry>>,
    jira_available: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    overtime: Option<ReportOvertime>,
}

fn lenient<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

#[derive(Debug, Clone, PartialEq)]
struct Project {
    key: String,
    name: String,
    client: String,
    seconds: f64,
    entries: u64,
    jira: Option<JiraTotals>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct JiraTotals {
    applies: bool,
    registered: f64,
    pending: f64,
}

#[derive(Debug, Clone, PartialEq)]
struct Day {
    day: String,
    seconds: f64,
    projects: Vec<(String, f64)>,
}

#[derive(Debug, Clone, PartialEq)]
struct EntryJira {
    status: &'static str,
    issue: String,
}

#[derive(Debug, Clone, PartialEq)]
struct Entry {
    day: String,
    start: String,
    stop: String,
    project: String,
    client: String,
    title: String,
    seconds: f64,
    jira: Option<EntryJira>,
}

#[derive(Debug, Clone, PartialEq)]
struct OvertimeMonth {
    month: String,
    partial: bool,
    estimate: f64,
    expected: f64,
    overtime: f64,
    pay_x1: f64,
    pay_multiplied: f64,
}

#[derive(Debug, Clone, PartialEq)]
struct Overtime {
    hourly_rate: f64,
    multiplier: f64,
    currency: String,
    months: Vec<OvertimeMonth>,
    total: OvertimeMonth,
    problem: Option<String>,
}

#[derive(Debug, Clone)]
struct Report {
    from_day: String,
    to_day: String,
    timezone: String,
    seconds: f64,
    entry_count: u64,
    active_days: u64,
    projects: Vec<Project>,
    days: Vec<Day>,
    weeks: Vec<Day>,
    entries: Option<Vec<Entry>>,
    jira: bool,
    overtime: Option<Overtime>,
}

#[derive(Debug, Clone, Copy)]
struct Sections {
    group_by: GroupBy,
    charts: bool,
    projects: bool,
    entries: bool,
    jira: bool,
    pay: bool,
}

fn project_key(id: &Option<Value>) -> String {
    match id {
        None | Some(Value::Null) => NONE_KEY.into(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

fn count(value: Option<f64>) -> u64 {
    value.filter(|n| n.is_finite() && *n > 0.0).map(|n| n.round() as u64).unwrap_or(0)
}

fn seconds(value: Option<f64>) -> f64 {
    value.filter(|n| n.is_finite() && *n > 0.0).unwrap_or(0.0)
}

fn money(value: Option<f64>) -> f64 {
    value.filter(|n| n.is_finite() && *n > 0.0).unwrap_or(0.0)
}

fn normalize_overtime(view: ReportOvertime) -> Overtime {
    let months: Vec<OvertimeMonth> = view
        .months
        .unwrap_or_default()
        .into_iter()
        .map(|month| OvertimeMonth {
            month: month.month.unwrap_or_default(),
            partial: month.partial.unwrap_or(false),
            estimate: seconds(month.estimate_seconds),
            expected: seconds(month.expected_seconds),
            overtime: seconds(month.overtime_seconds),
            pay_x1: money(month.pay_x1),
            pay_multiplied: money(month.pay_multiplied),
        })
        .collect();
    let totals = view.totals.unwrap_or_default();
    let sum = |pick: fn(&OvertimeMonth) -> f64| months.iter().map(pick).sum::<f64>();
    let total = OvertimeMonth {
        month: "Total".into(),
        partial: false,
        estimate: totals.estimate_seconds.map(|n| seconds(Some(n))).unwrap_or_else(|| sum(|m| m.estimate)),
        expected: totals.expected_seconds.map(|n| seconds(Some(n))).unwrap_or_else(|| sum(|m| m.expected)),
        overtime: totals.overtime_seconds.map(|n| seconds(Some(n))).unwrap_or_else(|| sum(|m| m.overtime)),
        pay_x1: totals.pay_x1.map(|n| money(Some(n))).unwrap_or_else(|| sum(|m| m.pay_x1)),
        pay_multiplied: totals
            .pay_multiplied
            .map(|n| money(Some(n)))
            .unwrap_or_else(|| sum(|m| m.pay_multiplied)),
    };
    let currency = view
        .currency
        .map(|code| code.trim().to_string())
        .filter(|code| !code.is_empty())
        .unwrap_or_else(|| DEFAULT_CURRENCY.into());
    Overtime {
        hourly_rate: money(view.hourly_rate),
        multiplier: view
            .multiplier
            .filter(|n| n.is_finite() && *n > 0.0)
            .or_else(|| (total.pay_x1 > 0.0).then(|| total.pay_multiplied / total.pay_x1))
            .unwrap_or(2.0),
        currency,
        months,
        total,
        problem: view.problem.filter(|text| !text.trim().is_empty()),
    }
}

fn zone(name: &str) -> TimeZone {
    if name.is_empty() {
        return TimeZone::system();
    }
    TimeZone::get(name).unwrap_or_else(|_| TimeZone::system())
}

fn clock(stamp: &str, tz: &TimeZone) -> String {
    match stamp.parse::<Timestamp>() {
        Ok(at) => at.to_zoned(tz.clone()).strftime("%H:%M").to_string(),
        Err(_) => stamp.to_string(),
    }
}

fn entry_jira(entry: &ReportEntry) -> Option<EntryJira> {
    let applies = entry.jira.as_ref().and_then(Value::as_bool);
    let registered = entry.registered;
    let issue = entry.issue_key.clone().filter(|key| !key.trim().is_empty());
    let excluded = entry.excluded_reason.clone();
    if applies.is_none() && registered.is_none() && issue.is_none() && excluded.is_none() {
        return None;
    }
    let status = if excluded.is_some() {
        "excluida"
    } else if registered == Some(true) {
        "registrada"
    } else if applies == Some(false) {
        "sin Jira"
    } else {
        "pendiente"
    };
    Some(EntryJira {
        status,
        issue: issue.unwrap_or_default(),
    })
}

fn normalize(view: ReportView) -> Report {
    let range = view.range.unwrap_or_default();
    let timezone = range.timezone.unwrap_or_default();
    let tz = zone(&timezone);
    let jira = view.jira_available.unwrap_or(false);
    let overtime = view.overtime.map(normalize_overtime);

    let projects: Vec<Project> = view
        .projects
        .unwrap_or_default()
        .into_iter()
        .map(|project| {
            let totals = (project.jira.is_some() || project.registered_seconds.is_some() || project.pending_seconds.is_some())
                .then(|| JiraTotals {
                    applies: project.jira.unwrap_or(false),
                    registered: seconds(project.registered_seconds),
                    pending: seconds(project.pending_seconds),
                });
            let key = project_key(&project.project_id);
            let name = if key == NONE_KEY {
                NO_PROJECT.to_string()
            } else {
                project
                    .name
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| NO_PROJECT.into())
            };
            Project {
                key,
                name,
                client: project.client_name.unwrap_or_default(),
                seconds: seconds(project.total_seconds),
                entries: count(project.entry_count),
                jira: totals,
            }
        })
        .collect();

    let lookup: HashMap<&str, &Project> = projects.iter().map(|p| (p.key.as_str(), p)).collect();
    let name_of = |key: &str| lookup.get(key).map(|p| p.name.clone()).unwrap_or_else(|| NO_PROJECT.into());
    let client_of = |key: &str| lookup.get(key).map(|p| p.client.clone()).unwrap_or_default();

    let buckets = |list: Option<Vec<ReportDay>>| -> Vec<Day> {
        list.unwrap_or_default()
        .into_iter()
        .map(|day| {
            let parts: Vec<(String, f64)> = day
                .projects
                .unwrap_or_default()
                .into_iter()
                .map(|part| (project_key(&part.project_id), seconds(part.seconds)))
                .collect();
            let total = day
                .total_seconds
                .map(|n| seconds(Some(n)))
                .unwrap_or_else(|| parts.iter().map(|(_, s)| s).sum());
            let label = match (day.day, day.from_day, day.to_day) {
                (Some(day), _, _) => day,
                (None, Some(from), Some(to)) if from != to => format!("{from} a {to}"),
                (None, Some(from), _) => from,
                (None, None, to) => to.unwrap_or_default(),
            };
            Day {
                day: label,
                seconds: total,
                projects: parts,
            }
        })
        .collect()
    };
    let days = buckets(view.days);
    let weeks = buckets(view.weeks);

    let entries = view.entries.map(|list| {
        list.into_iter()
            .map(|entry| {
                let key = project_key(&entry.project_id);
                let jira_mark = entry_jira(&entry);
                Entry {
                    day: entry.local_day.clone().unwrap_or_default(),
                    start: entry.start.as_deref().map(|s| clock(s, &tz)).unwrap_or_default(),
                    stop: entry
                        .stop
                        .as_deref()
                        .map(|s| clock(s, &tz))
                        .unwrap_or_else(|| "en curso".into()),
                    project: name_of(&key),
                    client: client_of(&key),
                    title: entry.title.unwrap_or_default(),
                    seconds: seconds(entry.seconds),
                    jira: jira_mark,
                }
            })
            .collect::<Vec<_>>()
    });

    let total = view
        .total_seconds
        .map(|n| seconds(Some(n)))
        .unwrap_or_else(|| projects.iter().map(|p| p.seconds).sum());
    let active_days = view
        .active_days
        .map(|n| count(Some(n)))
        .unwrap_or_else(|| days.iter().filter(|d| d.seconds > 0.0).count() as u64);
    let entry_count = view
        .entry_count
        .map(|n| count(Some(n)))
        .unwrap_or_else(|| projects.iter().map(|p| p.entries).sum());

    Report {
        from_day: range.from_day.unwrap_or_default(),
        to_day: range.to_day.unwrap_or_default(),
        timezone,
        seconds: total,
        entry_count,
        active_days,
        projects,
        days,
        weeks,
        entries,
        jira,
        overtime,
    }
}

impl Report {
    fn sections(&self, include: &Include, group_by: GroupBy) -> Sections {
        Sections {
            group_by,
            charts: include.charts.unwrap_or(true),
            projects: include.projects.unwrap_or(true),
            entries: include.entries.unwrap_or(true) && self.entries.is_some(),
            jira: include.jira.unwrap_or(true) && self.jira,
            pay: include.pay.unwrap_or(false) && self.overtime.is_some(),
        }
    }

    fn pay(&self, sections: Sections) -> Option<&Overtime> {
        self.overtime.as_ref().filter(|_| sections.pay)
    }

    fn average(&self) -> f64 {
        if self.active_days == 0 {
            0.0
        } else {
            self.seconds / self.active_days as f64
        }
    }

    fn jira_share(&self) -> Option<f64> {
        if !self.jira || self.seconds <= 0.0 {
            return None;
        }
        let registered: f64 = self.projects.iter().filter_map(|p| p.jira).map(|j| j.registered).sum();
        Some(registered / self.seconds)
    }

    fn share(&self, part: f64) -> f64 {
        if self.seconds <= 0.0 {
            0.0
        } else {
            part / self.seconds
        }
    }

    fn period(&self) -> String {
        match (self.from_day.is_empty(), self.to_day.is_empty()) {
            (false, false) if self.from_day == self.to_day => self.from_day.clone(),
            (false, false) => format!("{} a {}", self.from_day, self.to_day),
            (false, true) => self.from_day.clone(),
            (true, false) => self.to_day.clone(),
            (true, true) => "sin rango".into(),
        }
    }

    fn default_stem(&self) -> String {
        match (self.from_day.is_empty(), self.to_day.is_empty()) {
            (false, false) => format!("reporte-{}-{}", self.from_day, self.to_day),
            (false, true) => format!("reporte-{}", self.from_day),
            (true, false) => format!("reporte-{}", self.to_day),
            (true, true) => "reporte".into(),
        }
    }
}

pub(crate) fn hours(seconds: f64) -> f64 {
    seconds / 3600.0
}

pub(crate) fn fixed(seconds: f64) -> String {
    format!("{:.2}", hours(seconds))
}

fn short_hours(seconds: f64) -> String {
    format!("{:.1} h", hours(seconds))
}

fn percent(ratio: f64) -> String {
    format!("{:.0} %", ratio * 100.0)
}

fn per_entry(project: &Project) -> f64 {
    if project.entries == 0 {
        0.0
    } else {
        project.seconds / project.entries as f64
    }
}

fn jira_label(totals: Option<JiraTotals>) -> String {
    match totals {
        None => "—".into(),
        Some(totals) if !totals.applies => "no aplica".into(),
        Some(totals) if totals.pending > 0.0 => format!(
            "{} registradas · {} pendientes",
            short_hours(totals.registered),
            short_hours(totals.pending)
        ),
        Some(totals) => format!("{} registradas", short_hours(totals.registered)),
    }
}

pub(crate) fn factor(multiplier: f64) -> String {
    let text = format!("{multiplier:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

pub(crate) fn symbol(currency: &str) -> Option<&'static str> {
    match currency.to_ascii_uppercase().as_str() {
        "MXN" | "USD" | "CAD" | "AUD" | "NZD" | "ARS" | "CLP" | "COP" => Some("$"),
        "EUR" => Some("€"),
        "GBP" => Some("£"),
        _ => None,
    }
}

pub(crate) fn currency_format(currency: &str) -> String {
    match symbol(currency) {
        Some(sign) => format!("\"{sign}\"#,##0.00"),
        None => "#,##0.00".into(),
    }
}

pub(crate) fn amount(value: f64) -> String {
    format!("{value:.2}")
}

pub(crate) fn grouped_amount(value: f64, currency: &str) -> String {
    let fixed = amount(value);
    let (digits, cents) = fixed.split_once('.').unwrap_or((&fixed, "00"));
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    format!("{}{grouped}.{cents}", symbol(currency).unwrap_or(""))
}

const PARTIAL_NOTE: &str = "Los meses en curso se cuentan hasta hoy.";

fn status(month: &OvertimeMonth) -> &'static str {
    if month.partial {
        "en curso"
    } else {
        "cerrado"
    }
}

fn overtime_note(overtime: &Overtime) -> &str {
    overtime.problem.as_deref().unwrap_or("Sin datos de horas extra para este rango.")
}

fn overtime_labels(overtime: &Overtime) -> Vec<String> {
    let code = &overtime.currency;
    vec![
        "Mes".into(),
        "Estado".into(),
        "Estimadas (h)".into(),
        "Esperadas (h)".into(),
        "Extra (h)".into(),
        format!("Pago ×1 ({code})"),
        format!("Pago ×{} ({code})", factor(overtime.multiplier)),
    ]
}

pub(crate) fn csv_field(value: &str) -> String {
    let value = &if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{value}")
    } else {
        value.to_string()
    };
    if value.contains([',', '"', '\n', '\r']) || value.starts_with(' ') || value.ends_with(' ') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

pub(crate) fn csv_line(out: &mut String, fields: &[String]) {
    let line: Vec<String> = fields.iter().map(|f| csv_field(f)).collect();
    out.push_str(&line.join(","));
    out.push_str("\r\n");
}

fn render_csv(report: &Report, sections: Sections) -> String {
    let mut out = String::from(BOM);
    match report.entries.as_ref().filter(|_| sections.entries) {
        Some(entries) => {
            let mut header: Vec<String> = ["Fecha", "Inicio", "Fin", "Proyecto", "Cliente", "Título", "Horas"]
                .map(String::from)
                .to_vec();
            if sections.jira {
                header.extend(["Jira".to_string(), "Issue".to_string()]);
            }
            csv_line(&mut out, &header);
            for entry in entries {
                let mut row = vec![
                    entry.day.clone(),
                    entry.start.clone(),
                    entry.stop.clone(),
                    entry.project.clone(),
                    entry.client.clone(),
                    entry.title.clone(),
                    fixed(entry.seconds),
                ];
                if sections.jira {
                    let mark = entry.jira.as_ref();
                    row.push(mark.map(|m| m.status.to_string()).unwrap_or_default());
                    row.push(mark.map(|m| m.issue.clone()).unwrap_or_default());
                }
                csv_line(&mut out, &row);
            }
        }
        None => {
            let (label, buckets) = match sections.group_by {
                GroupBy::Week if !report.weeks.is_empty() => ("Semana", &report.weeks),
                _ => ("Fecha", &report.days),
            };
            csv_line(&mut out, &[label, "Proyecto", "Cliente", "Horas"].map(String::from));
            let lookup: HashMap<&str, &Project> = report.projects.iter().map(|p| (p.key.as_str(), p)).collect();
            for day in buckets {
                for (key, seconds) in day.projects.iter().filter(|(_, s)| *s > 0.0) {
                    let project = lookup.get(key.as_str());
                    csv_line(
                        &mut out,
                        &[
                            day.day.clone(),
                            project.map(|p| p.name.clone()).unwrap_or_else(|| NO_PROJECT.into()),
                            project.map(|p| p.client.clone()).unwrap_or_default(),
                            fixed(*seconds),
                        ],
                    );
                }
            }
        }
    }
    if let Some(overtime) = report.pay(sections) {
        out.push_str("\r\n");
        csv_line(&mut out, &[OVERTIME.to_string()]);
        if overtime.months.is_empty() {
            csv_line(&mut out, &[overtime_note(overtime).to_string()]);
            return out;
        }
        csv_line(&mut out, &overtime_labels(overtime));
        let rows = overtime.months.iter().map(|m| (m, status(m))).chain([(&overtime.total, "")]);
        for (month, state) in rows {
            csv_line(
                &mut out,
                &[
                    month.month.clone(),
                    state.into(),
                    fixed(month.estimate),
                    fixed(month.expected),
                    fixed(month.overtime),
                    amount(month.pay_x1),
                    amount(month.pay_multiplied),
                ],
            );
        }
        csv_line(
            &mut out,
            &[format!("Tarifa por hora ({})", overtime.currency), amount(overtime.hourly_rate)],
        );
        csv_line(&mut out, &["Multiplicador".into(), factor(overtime.multiplier)]);
        if overtime.months.iter().any(|m| m.partial) {
            csv_line(&mut out, &[PARTIAL_NOTE.to_string()]);
        }
    }
    out
}

pub(crate) fn md_cell(value: &str) -> String {
    let flat: String = value
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let escaped = flat.trim().replace('|', "\\|");
    if escaped.is_empty() {
        "—".into()
    } else {
        escaped
    }
}

pub(crate) fn md_row(out: &mut String, cells: &[String]) {
    out.push_str("| ");
    out.push_str(&cells.iter().map(|c| md_cell(c)).collect::<Vec<_>>().join(" | "));
    out.push_str(" |\n");
}

pub(crate) fn md_rule(out: &mut String, aligns: &[bool]) {
    out.push('|');
    for right in aligns {
        out.push_str(if *right { " ---: |" } else { " --- |" });
    }
    out.push('\n');
}

fn render_md(report: &Report, sections: Sections) -> String {
    let mut out = format!("# Reporte de tiempo · {}\n\n", report.period());
    let mut summary = vec![
        format!("**Total:** {}", short_hours(report.seconds)),
        format!(
            "**Promedio por día activo:** {} ({} días)",
            short_hours(report.average()),
            report.active_days
        ),
        format!("**Proyectos:** {}", report.projects.len()),
        format!("**Entradas:** {}", report.entry_count),
    ];
    if sections.jira {
        if let Some(share) = report.jira_share() {
            summary.push(format!("**En Jira:** {}", percent(share)));
        }
    }
    out.push_str(&summary.join(" · "));
    out.push('\n');
    if !report.timezone.is_empty() {
        out.push_str(&format!("\nZona horaria: {}\n", report.timezone));
    }

    if sections.projects {
        out.push_str("\n## Por proyecto\n\n");
        let mut header: Vec<String> = ["Proyecto", "Horas", "%", "Entradas", "Por entrada"].map(String::from).to_vec();
        let mut aligns = vec![false, true, true, true, true];
        if sections.jira {
            header.push("Jira".into());
            aligns.push(false);
        }
        md_row(&mut out, &header);
        md_rule(&mut out, &aligns);
        for project in &report.projects {
            let name = if project.client.is_empty() {
                project.name.clone()
            } else {
                format!("{} ({})", project.name, project.client)
            };
            let mut row = vec![
                name,
                format!("{:.1}", hours(project.seconds)),
                percent(report.share(project.seconds)),
                project.entries.to_string(),
                short_hours(per_entry(project)),
            ];
            if sections.jira {
                row.push(jira_label(project.jira));
            }
            md_row(&mut out, &row);
        }
    }

    let (heading, label, buckets) = match sections.group_by {
        GroupBy::Week if !report.weeks.is_empty() => ("Por semana", "Semana", &report.weeks),
        _ => ("Por día", "Día", &report.days),
    };
    let grouped = sections.group_by != GroupBy::Project;
    if (grouped || sections.charts) && buckets.iter().any(|d| d.seconds > 0.0) {
        out.push_str(&format!("\n## {heading}\n\n"));
        let mut header = vec![label.to_string(), "Horas".into(), "%".into()];
        let mut aligns = vec![false, true, true];
        if sections.charts {
            header.push("Gráfica".into());
            aligns.push(false);
        }
        md_row(&mut out, &header);
        md_rule(&mut out, &aligns);
        let peak = buckets.iter().map(|d| d.seconds).fold(0.0, f64::max);
        for day in buckets {
            let mut row = vec![
                day.day.clone(),
                format!("{:.1}", hours(day.seconds)),
                percent(report.share(day.seconds)),
            ];
            if sections.charts {
                let width = if peak > 0.0 { (day.seconds / peak * 20.0).round() as usize } else { 0 };
                row.push("█".repeat(width));
            }
            md_row(&mut out, &row);
        }
    }

    if let Some(entries) = report.entries.as_ref().filter(|_| sections.entries) {
        out.push_str("\n## Entradas\n\n");
        let mut header: Vec<String> = ["Fecha", "Inicio", "Fin", "Proyecto", "Título", "Horas"].map(String::from).to_vec();
        let mut aligns = vec![false, false, false, false, false, true];
        if sections.jira {
            header.push("Jira".into());
            aligns.push(false);
        }
        md_row(&mut out, &header);
        md_rule(&mut out, &aligns);
        for entry in entries {
            let mut row = vec![
                entry.day.clone(),
                entry.start.clone(),
                entry.stop.clone(),
                entry.project.clone(),
                entry.title.clone(),
                format!("{:.2}", hours(entry.seconds)),
            ];
            if sections.jira {
                row.push(
                    entry
                        .jira
                        .as_ref()
                        .map(|m| {
                            if m.issue.is_empty() {
                                m.status.to_string()
                            } else {
                                format!("{} {}", m.status, m.issue)
                            }
                        })
                        .unwrap_or_default(),
                );
            }
            md_row(&mut out, &row);
        }
    }

    if let Some(overtime) = report.pay(sections) {
        out.push_str(&format!("\n## {OVERTIME}\n\n"));
        if overtime.months.is_empty() {
            out.push_str(overtime_note(overtime));
            out.push('\n');
        } else {
            out.push_str(&format!(
                "**Tarifa por hora:** {} {} · **Multiplicador:** ×{}\n\n",
                grouped_amount(overtime.hourly_rate, &overtime.currency),
                overtime.currency,
                factor(overtime.multiplier)
            ));
            md_row(&mut out, &overtime_labels(overtime));
            md_rule(&mut out, &[false, false, true, true, true, true, true]);
            for month in &overtime.months {
                md_row(
                    &mut out,
                    &[
                        month.month.clone(),
                        status(month).into(),
                        format!("{:.1}", hours(month.estimate)),
                        format!("{:.1}", hours(month.expected)),
                        format!("{:.1}", hours(month.overtime)),
                        grouped_amount(month.pay_x1, &overtime.currency),
                        grouped_amount(month.pay_multiplied, &overtime.currency),
                    ],
                );
            }
            let total = &overtime.total;
            md_row(
                &mut out,
                &[
                    "**Total**".into(),
                    String::new(),
                    format!("**{:.1}**", hours(total.estimate)),
                    format!("**{:.1}**", hours(total.expected)),
                    format!("**{:.1}**", hours(total.overtime)),
                    format!("**{}**", grouped_amount(total.pay_x1, &overtime.currency)),
                    format!("**{}**", grouped_amount(total.pay_multiplied, &overtime.currency)),
                ],
            );
            if overtime.months.iter().any(|m| m.partial) {
                out.push_str(&format!("\n{PARTIAL_NOTE}\n"));
            }
        }
    }
    out
}

struct Styles {
    header: Format,
    hours: Format,
    ratio: Format,
}

fn header_row(sheet: &mut Worksheet, styles: &Styles, labels: &[&str], widths: &[f64]) -> Result<(), XlsxError> {
    for (col, label) in labels.iter().enumerate() {
        sheet.write_string_with_format(0, col as u16, *label, &styles.header)?;
    }
    for (col, width) in widths.iter().enumerate() {
        sheet.set_column_width(col as u16, *width)?;
    }
    sheet.set_freeze_panes(1, 0)?;
    Ok(())
}

fn render_xlsx(report: &Report, sections: Sections) -> Result<Vec<u8>, XlsxError> {
    let styles = Styles {
        header: Format::new().set_bold(),
        hours: Format::new().set_num_format("0.0"),
        ratio: Format::new().set_num_format("0%"),
    };
    let mut workbook = Workbook::new();

    let summary = workbook.add_worksheet();
    summary.set_name("Resumen")?;
    header_row(summary, &styles, &["Concepto", "Valor"], &[26.0, 24.0])?;
    let mut row = 1u32;
    for (label, value) in [
        ("Desde", report.from_day.as_str()),
        ("Hasta", report.to_day.as_str()),
        ("Zona horaria", report.timezone.as_str()),
    ] {
        summary.write_string(row, 0, label)?;
        summary.write_string(row, 1, value)?;
        row += 1;
    }
    summary.write_string(row, 0, "Horas totales")?;
    summary.write_number_with_format(row, 1, hours(report.seconds), &styles.hours)?;
    row += 1;
    summary.write_string(row, 0, "Promedio por día activo (h)")?;
    summary.write_number_with_format(row, 1, hours(report.average()), &styles.hours)?;
    row += 1;
    for (label, value) in [
        ("Días activos", report.active_days),
        ("Entradas", report.entry_count),
        ("Proyectos", report.projects.len() as u64),
    ] {
        summary.write_string(row, 0, label)?;
        summary.write_number(row, 1, value as f64)?;
        row += 1;
    }
    if sections.jira {
        if let Some(share) = report.jira_share() {
            summary.write_string(row, 0, "En Jira")?;
            summary.write_number_with_format(row, 1, share, &styles.ratio)?;
        }
    }

    if sections.projects {
        let sheet = workbook.add_worksheet();
        sheet.set_name("Proyectos")?;
        let mut labels = vec!["Proyecto", "Cliente", "Horas", "%", "Entradas", "Horas por entrada"];
        let mut widths = vec![30.0, 20.0, 10.0, 8.0, 10.0, 18.0];
        if sections.jira {
            labels.extend(["Jira", "Registradas (h)", "Pendientes (h)"]);
            widths.extend([10.0, 16.0, 16.0]);
        }
        header_row(sheet, &styles, &labels, &widths)?;
        for (index, project) in report.projects.iter().enumerate() {
            let row = index as u32 + 1;
            sheet.write_string(row, 0, &project.name)?;
            sheet.write_string(row, 1, &project.client)?;
            sheet.write_number_with_format(row, 2, hours(project.seconds), &styles.hours)?;
            sheet.write_number_with_format(row, 3, report.share(project.seconds), &styles.ratio)?;
            sheet.write_number(row, 4, project.entries as f64)?;
            sheet.write_number_with_format(row, 5, hours(per_entry(project)), &styles.hours)?;
            if sections.jira {
                if let Some(totals) = project.jira {
                    sheet.write_string(row, 6, if totals.applies { "sí" } else { "no" })?;
                    sheet.write_number_with_format(row, 7, hours(totals.registered), &styles.hours)?;
                    sheet.write_number_with_format(row, 8, hours(totals.pending), &styles.hours)?;
                }
            }
        }
        if sections.charts && !report.projects.is_empty() {
            let last = report.projects.len() as u32;
            let mut chart = Chart::new(ChartType::Bar);
            chart.title().set_name("Horas por proyecto");
            chart
                .add_series()
                .set_name("Horas")
                .set_categories(("Proyectos", 1, 0, last, 0))
                .set_values(("Proyectos", 1, 2, last, 2));
            chart.legend().set_hidden();
            sheet.insert_chart(last + 2, 0, &chart)?;
        }
    }

    let sheet = workbook.add_worksheet();
    sheet.set_name("Días")?;
    let mut labels: Vec<&str> = vec!["Fecha", "Total (h)"];
    labels.extend(report.projects.iter().map(|p| p.name.as_str()));
    let mut widths = vec![12.0, 10.0];
    widths.extend(report.projects.iter().map(|p| (p.name.chars().count() as f64 + 2.0).clamp(10.0, 30.0)));
    header_row(sheet, &styles, &labels, &widths)?;
    let columns: HashMap<&str, u16> = report
        .projects
        .iter()
        .enumerate()
        .map(|(index, p)| (p.key.as_str(), index as u16 + 2))
        .collect();
    for (index, day) in report.days.iter().enumerate() {
        let row = index as u32 + 1;
        sheet.write_string(row, 0, &day.day)?;
        sheet.write_number_with_format(row, 1, hours(day.seconds), &styles.hours)?;
        for (key, seconds) in &day.projects {
            if let Some(col) = columns.get(key.as_str()) {
                sheet.write_number_with_format(row, *col, hours(*seconds), &styles.hours)?;
            }
        }
    }

    if let Some(entries) = report.entries.as_ref().filter(|_| sections.entries) {
        let sheet = workbook.add_worksheet();
        sheet.set_name("Entradas")?;
        let mut labels = vec!["Fecha", "Inicio", "Fin", "Proyecto", "Título", "Horas"];
        let mut widths = vec![12.0, 8.0, 9.0, 24.0, 48.0, 8.0];
        if sections.jira {
            labels.extend(["Jira", "Issue"]);
            widths.extend([12.0, 12.0]);
        }
        header_row(sheet, &styles, &labels, &widths)?;
        for (index, entry) in entries.iter().enumerate() {
            let row = index as u32 + 1;
            sheet.write_string(row, 0, &entry.day)?;
            sheet.write_string(row, 1, &entry.start)?;
            sheet.write_string(row, 2, &entry.stop)?;
            sheet.write_string(row, 3, &entry.project)?;
            sheet.write_string(row, 4, &entry.title)?;
            sheet.write_number_with_format(row, 5, hours(entry.seconds), &styles.hours)?;
            if sections.jira {
                if let Some(mark) = &entry.jira {
                    sheet.write_string(row, 6, mark.status)?;
                    sheet.write_string(row, 7, &mark.issue)?;
                }
            }
        }
    }

    if let Some(overtime) = report.pay(sections) {
        let code = currency_format(&overtime.currency);
        let currency = Format::new().set_num_format(&code);
        let bold_hours = Format::new().set_bold().set_num_format("0.0");
        let bold_currency = Format::new().set_bold().set_num_format(&code);
        let sheet = workbook.add_worksheet();
        sheet.set_name(OVERTIME)?;
        if overtime.months.is_empty() {
            sheet.set_column_width(0, 60.0)?;
            sheet.write_string(0, 0, overtime_note(overtime))?;
            return workbook.save_to_buffer();
        }
        let labels = overtime_labels(overtime);
        let labels: Vec<&str> = labels.iter().map(String::as_str).collect();
        header_row(sheet, &styles, &labels, &[12.0, 10.0, 14.0, 14.0, 10.0, 16.0, 16.0])?;
        let mut row = 1u32;
        for month in &overtime.months {
            sheet.write_string(row, 0, &month.month)?;
            sheet.write_string(row, 1, status(month))?;
            sheet.write_number_with_format(row, 2, hours(month.estimate), &styles.hours)?;
            sheet.write_number_with_format(row, 3, hours(month.expected), &styles.hours)?;
            sheet.write_number_with_format(row, 4, hours(month.overtime), &styles.hours)?;
            sheet.write_number_with_format(row, 5, month.pay_x1, &currency)?;
            sheet.write_number_with_format(row, 6, month.pay_multiplied, &currency)?;
            row += 1;
        }
        let total = &overtime.total;
        sheet.write_string_with_format(row, 0, "Total", &styles.header)?;
        sheet.write_number_with_format(row, 2, hours(total.estimate), &bold_hours)?;
        sheet.write_number_with_format(row, 3, hours(total.expected), &bold_hours)?;
        sheet.write_number_with_format(row, 4, hours(total.overtime), &bold_hours)?;
        sheet.write_number_with_format(row, 5, total.pay_x1, &bold_currency)?;
        sheet.write_number_with_format(row, 6, total.pay_multiplied, &bold_currency)?;
        row += 2;
        sheet.write_string_with_format(row, 0, format!("Tarifa por hora ({})", overtime.currency), &styles.header)?;
        sheet.write_number_with_format(row, 2, overtime.hourly_rate, &currency)?;
        row += 1;
        sheet.write_string_with_format(row, 0, "Multiplicador", &styles.header)?;
        sheet.write_number(row, 2, overtime.multiplier)?;
        if overtime.months.iter().any(|m| m.partial) {
            sheet.write_string(row + 2, 0, PARTIAL_NOTE)?;
        }
    }

    workbook.save_to_buffer()
}

pub(crate) fn failed(message: impl Into<String>) -> Problem {
    Problem::new(ProblemKind::CliFailed, message)
}

fn render(format: ExportFormat, report: &Report, include: &Include, group_by: GroupBy) -> Result<Vec<u8>, Problem> {
    let sections = report.sections(include, group_by);
    match format {
        ExportFormat::Csv => Ok(render_csv(report, sections).into_bytes()),
        ExportFormat::Md => Ok(render_md(report, sections).into_bytes()),
        ExportFormat::Xlsx => {
            render_xlsx(report, sections).map_err(|error| failed(format!("No pude armar el Excel: {error}")))
        }
    }
}

fn write_report(
    dir: &Path,
    format: ExportFormat,
    report: Value,
    include: &Include,
    group_by: GroupBy,
    file_name: Option<&str>,
) -> Result<PathBuf, Problem> {
    let view: ReportView =
        serde_json::from_value(report).map_err(|error| failed(format!("El reporte no se puede leer: {error}")))?;
    let report = normalize(view);
    let bytes = render(format, &report, include, group_by)?;
    save_export(dir, file_name, &report.default_stem(), format.extension(), &bytes)
}

pub(crate) fn save_export(
    dir: &Path,
    file_name: Option<&str>,
    default_stem: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<PathBuf, Problem> {
    let stem = sanitize_with(file_name.map(str::trim).filter(|name| !name.is_empty()).unwrap_or(default_stem), extension);
    std::fs::create_dir_all(dir).map_err(|error| failed(format!("No pude preparar {}: {error}", dir.display())))?;
    let target = unique_path_with(dir, &stem, extension);
    std::fs::write(&target, bytes).map_err(|error| failed(format!("No pude guardar {}: {error}", target.display())))?;
    Ok(target)
}

pub(crate) async fn save_to_downloads<F>(write: F) -> Result<String, Problem>
where
    F: FnOnce(&Path) -> Result<PathBuf, Problem> + Send + 'static,
{
    let downloads = node::home()
        .map(|home| home.join("Downloads"))
        .ok_or_else(|| failed("No sé cuál es tu carpeta de inicio."))?;
    let target = tauri::async_runtime::spawn_blocking(move || write(&downloads))
        .await
        .map_err(|error| failed(format!("La exportación se interrumpió: {error}")))??;
    let _ = crate::media::reveal(&target).await;
    Ok(target.display().to_string())
}

#[tauri::command]
pub async fn export_report(
    format: ExportFormat,
    report: Value,
    include: Option<Include>,
    group_by: Option<GroupBy>,
    file_name: Option<String>,
) -> Result<String, Problem> {
    let include = include.unwrap_or_default();
    let group_by = group_by.unwrap_or_default();
    save_to_downloads(move |downloads| write_report(downloads, format, report, &include, group_by, file_name.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const FIXTURE: &str = r##"{
        "range": {"fromDay": "2026-09-28", "toDay": "2026-10-04", "timezone": "America/Mexico_City", "weekStartsOn": 1},
        "totalSeconds": 111600,
        "entryCount": 20,
        "activeDays": 5,
        "jiraAvailable": true,
        "projects": [
            {"projectId": 222494997, "name": "Pharma STI", "clientName": "Solem", "totalSeconds": 52200, "entryCount": 9, "color": "#c2410c", "jira": true, "registeredSeconds": 43200, "pendingSeconds": 9000},
            {"projectId": 1001, "name": "Apartados", "clientName": "Viva", "totalSeconds": 36900, "entryCount": 6, "color": "#0f766e", "jira": true, "registeredSeconds": 36900, "pendingSeconds": 0},
            {"projectId": 1002, "name": "Den | escritorio", "clientName": null, "totalSeconds": 19800, "entryCount": 4, "color": "#6d28d9", "jira": false, "registeredSeconds": 0, "pendingSeconds": 0},
            {"projectId": null, "name": "(no project)", "clientName": null, "totalSeconds": 2700, "entryCount": 1, "color": "#78716c", "jira": false, "registeredSeconds": 0, "pendingSeconds": 0}
        ],
        "days": [
            {"day": "2026-09-28", "totalSeconds": 25200, "projects": [{"projectId": 222494997, "seconds": 18000}, {"projectId": 1001, "seconds": 7200}]},
            {"day": "2026-09-29", "totalSeconds": 23400, "projects": [{"projectId": 222494997, "seconds": 14400}, {"projectId": 1002, "seconds": 9000}]},
            {"day": "2026-09-30", "totalSeconds": 20700, "projects": [{"projectId": 1001, "seconds": 18000}, {"projectId": null, "seconds": 2700}]},
            {"day": "2026-10-01", "totalSeconds": 30600, "projects": [{"projectId": 222494997, "seconds": 19800}, {"projectId": 1002, "seconds": 10800}]},
            {"day": "2026-10-02", "totalSeconds": 11700, "projects": [{"projectId": 1001, "seconds": 11700}]},
            {"day": "2026-10-03", "totalSeconds": 0, "projects": []},
            {"day": "2026-10-04", "totalSeconds": 0, "projects": []}
        ],
        "weeks": [
            {"fromDay": "2026-09-28", "toDay": "2026-10-04", "totalSeconds": 111600, "projects": [{"projectId": 222494997, "seconds": 52200}, {"projectId": 1001, "seconds": 36900}, {"projectId": 1002, "seconds": 19800}, {"projectId": null, "seconds": 2700}]}
        ],
        "overlaps": [],
        "entries": [
            {"id": 733, "title": "Cognito: revisión \"MFA\", caducidad", "projectId": 222494997, "start": "2026-09-28T15:00:00.000Z", "stop": "2026-09-28T20:00:00.000Z", "localDay": "2026-09-28", "seconds": 18000, "kind": null, "overlapping": false, "registered": true, "issueKey": "PP-20614", "jira": true, "excludedReason": null},
            {"id": 734, "title": "Conciliación de apartados\nsegunda tanda", "projectId": 1001, "start": "2026-09-28T21:00:00.000Z", "stop": "2026-09-28T23:00:00.000Z", "localDay": "2026-09-28", "seconds": 7200, "kind": null, "overlapping": false, "registered": false, "issueKey": "VB-118", "jira": true},
            {"id": 735, "title": "Ventana de reportes | exportación", "projectId": 1002, "start": "2026-09-29T16:30:00.000Z", "stop": null, "localDay": "2026-09-29", "seconds": 9000, "kind": null, "overlapping": true, "jira": false, "blockIds": [735]},
            {"id": 735, "title": "Ventana de reportes | exportación", "projectId": 1002, "start": "2026-10-01T15:00:00.000Z", "stop": "2026-10-01T18:00:00.000Z", "localDay": "2026-10-01", "seconds": 10800, "kind": null, "overlapping": false, "jira": false, "blockIds": [735, 741]},
            {"id": 736, "title": "Café con el equipo", "projectId": null, "start": "2026-09-30T14:15:00.000Z", "stop": "2026-09-30T15:00:00.000Z", "localDay": "2026-09-30", "seconds": 2700, "kind": "meeting", "overlapping": false},
            {"id": 737, "title": "=SUM(A1:A9) y -2+3", "projectId": 1001, "start": "2026-10-02T15:00:00.000Z", "stop": "2026-10-02T18:15:00.000Z", "localDay": "2026-10-02", "seconds": 11700, "kind": null, "overlapping": false, "registered": false, "issueKey": "", "jira": true, "excludedReason": null}
        ]
    }"##;

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("fixture")
    }

    fn report() -> Report {
        normalize(serde_json::from_value(fixture()).expect("view"))
    }

    const MONEY: [&str; 8] = ["287.35", "3448.2", "3,448.20", "6896.4", "6,896.40", "Pago", "Tarifa", "$"];

    fn overtime_fixture() -> Value {
        let mut view = fixture();
        view["overtime"] = serde_json::json!({
            "hourlyRate": 287.35,
            "multiplier": 2,
            "months": [
                {"month": "2026-09", "partial": false, "estimateSeconds": 619200, "expectedSeconds": 576000, "overtimeSeconds": 43200, "payX1": 3448.2, "payMultiplied": 6896.4, "byProject": [{"projectId": 222494997, "estimateSeconds": 619200, "counts": true}]},
                {"month": "2026-10", "partial": true, "estimateSeconds": 72000, "expectedSeconds": 576000, "overtimeSeconds": 0, "payX1": 0, "payMultiplied": 0, "byProject": []}
            ],
            "totals": {"estimateSeconds": 691200, "expectedSeconds": 1152000, "overtimeSeconds": 43200, "payX1": 3448.2, "payMultiplied": 6896.4}
        });
        view
    }

    fn overtime_report() -> Report {
        normalize(serde_json::from_value(overtime_fixture()).expect("view"))
    }

    fn with_pay() -> Include {
        Include { pay: Some(true), ..Include::default() }
    }

    fn xlsx_text(bytes: &[u8]) -> HashMap<String, String> {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("zip");
        let mut parts = HashMap::new();
        for index in 0..archive.len() {
            let mut file = archive.by_index(index).expect("part");
            let mut text = String::new();
            if std::io::Read::read_to_string(&mut file, &mut text).is_ok() {
                parts.insert(file.name().to_string(), text);
            }
        }
        parts
    }

    fn overtime_sheet(parts: &HashMap<String, String>) -> &str {
        let workbook = &parts["xl/workbook.xml"];
        let names: Vec<&str> = workbook.split("<sheet ").skip(1).collect();
        let index = names.iter().position(|sheet| sheet.contains("name=\"Horas extra\"")).expect("overtime sheet");
        &parts[&format!("xl/worksheets/sheet{}.xml", index + 1)]
    }

    fn assert_no_money(text: &str) {
        for needle in MONEY {
            assert!(!text.contains(needle), "{needle} leaked");
        }
        assert!(!text.contains(OVERTIME));
    }

    fn all() -> Include {
        Include::default()
    }

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("den-report-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("root");
        root
    }

    fn parse_csv(text: &str) -> Vec<Vec<String>> {
        let body = text.strip_prefix(BOM).expect("bom");
        csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .from_reader(body.as_bytes())
            .records()
            .map(|record| record.expect("record").iter().map(str::to_string).collect())
            .collect()
    }

    fn table_widths(markdown: &str) -> Vec<Vec<usize>> {
        let mut tables = Vec::new();
        let mut current: Vec<usize> = Vec::new();
        for line in markdown.lines() {
            if line.starts_with('|') {
                let unescaped = line.replace("\\|", "");
                current.push(unescaped.matches('|').count() - 1);
            } else if !current.is_empty() {
                tables.push(std::mem::take(&mut current));
            }
        }
        if !current.is_empty() {
            tables.push(current);
        }
        tables
    }

    #[test]
    fn the_report_is_read_tolerantly() {
        let report = report();
        assert_eq!(report.projects.len(), 4);
        assert_eq!(report.projects[3].name, NO_PROJECT);
        assert_eq!(report.projects[3].key, "none");
        assert_eq!(report.default_stem(), "reporte-2026-09-28-2026-10-04");
        let entries = report.entries.as_ref().expect("entries");
        assert_eq!(entries[0].start, "09:00");
        assert_eq!(entries[0].stop, "14:00");
        assert_eq!(entries[2].stop, "en curso");
        assert_eq!(entries[0].jira, Some(EntryJira { status: "registrada", issue: "PP-20614".into() }));
        assert_eq!(entries[1].jira, Some(EntryJira { status: "pendiente", issue: "VB-118".into() }));
        assert_eq!(entries[2].jira.as_ref().map(|m| m.status), Some("sin Jira"));
        assert_eq!(entries.len(), 6);
        assert_eq!((entries[3].day.as_str(), entries[3].start.as_str()), ("2026-10-01", "09:00"));
        assert_eq!(entries[4].jira, None);
        assert_eq!(entries[4].project, NO_PROJECT);
        assert_eq!(report.weeks[0].day, "2026-09-28 a 2026-10-04");
        assert!((report.jira_share().expect("share") - 80100.0 / 111600.0).abs() < 1e-9);

        let bare = normalize(serde_json::from_value(serde_json::json!({"projects": [{"name": "Solo"}], "unknown": 1})).expect("bare"));
        assert_eq!(bare.default_stem(), "reporte");
        assert!(bare.entries.is_none());
        assert_eq!(bare.seconds, 0.0);
    }

    #[test]
    fn csv_has_one_row_per_entry_with_quoting_and_bom() {
        let report = report();
        let text = render_csv(&report, report.sections(&all(), GroupBy::Project));
        assert!(text.starts_with(BOM));
        assert!(text.contains("\r\n"));
        assert!(text.contains("\"Cognito: revisión \"\"MFA\"\", caducidad\""));
        let rows = parse_csv(&text);
        assert_eq!(rows[0], ["Fecha", "Inicio", "Fin", "Proyecto", "Cliente", "Título", "Horas", "Jira", "Issue"]);
        assert_eq!(rows.len(), 7);
        assert_eq!(rows[1], ["2026-09-28", "09:00", "14:00", "Pharma STI", "Solem", "Cognito: revisión \"MFA\", caducidad", "5.00", "registrada", "PP-20614"]);
        assert_eq!(rows[2][5], "Conciliación de apartados\nsegunda tanda");
        assert_eq!(rows[3][3], "Den | escritorio");
        assert_eq!(rows[4][0], "2026-10-01");
        assert_eq!(rows[4][3], "Den | escritorio");
        assert_eq!(rows[5][3], NO_PROJECT);
        assert_eq!(rows[6][5], "'=SUM(A1:A9) y -2+3");
        assert_eq!(rows[6][7..], ["pendiente", ""]);
        assert!(rows.iter().all(|row| row.len() == 9));
    }

    #[test]
    fn csv_falls_back_to_projects_per_day() {
        let report = report();
        let include = Include { entries: Some(false), ..Include::default() };
        let rows = parse_csv(&render_csv(&report, report.sections(&include, GroupBy::Project)));
        assert_eq!(rows[0], ["Fecha", "Proyecto", "Cliente", "Horas"]);
        assert_eq!(rows.len(), 10);
        assert_eq!(rows[1], ["2026-09-28", "Pharma STI", "Solem", "5.00"]);
        assert_eq!(rows[6], ["2026-09-30", NO_PROJECT, "", "0.75"]);
        let total: f64 = rows[1..].iter().map(|row| row[3].parse::<f64>().expect("hours")).sum();
        assert!((total - 31.0).abs() < 1e-9);
    }

    #[test]
    fn group_by_week_changes_the_buckets() {
        let report = report();
        let include = Include { entries: Some(false), ..Include::default() };
        let rows = parse_csv(&render_csv(&report, report.sections(&include, GroupBy::Week)));
        assert_eq!(rows[0][0], "Semana");
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[4], ["2026-09-28 a 2026-10-04", NO_PROJECT, "", "0.75"]);
        let text = render_md(&report, report.sections(&Include { charts: Some(false), ..Include::default() }, GroupBy::Week));
        assert!(text.contains("## Por semana"));
        assert!(text.contains("| 2026-09-28 a 2026-10-04 | 31.0 | 100 % |"));
        assert!(!text.contains("## Por día"));
        let daily = render_md(&report, report.sections(&Include { charts: Some(false), ..Include::default() }, GroupBy::Day));
        assert!(daily.contains("| 2026-10-03 | 0.0 | 0 % |"));
    }

    #[test]
    fn csv_without_jira_drops_its_columns() {
        let report = report();
        let include = Include { jira: Some(false), ..Include::default() };
        let rows = parse_csv(&render_csv(&report, report.sections(&include, GroupBy::Project)));
        assert!(rows.iter().all(|row| row.len() == 7));
    }

    #[test]
    fn markdown_has_summary_and_consistent_tables() {
        let report = report();
        let text = render_md(&report, report.sections(&all(), GroupBy::Project));
        assert!(text.starts_with("# Reporte de tiempo · 2026-09-28 a 2026-10-04\n"));
        assert!(text.contains("**Total:** 31.0 h"));
        assert!(text.contains("**Promedio por día activo:** 6.2 h (5 días)"));
        assert!(text.contains("**Proyectos:** 4"));
        assert!(text.contains("**En Jira:** 72 %"));
        assert!(text.contains("## Por proyecto"));
        assert!(text.contains("| Pharma STI (Solem) | 14.5 | 47 % | 9 | 1.6 h | 12.0 h registradas · 2.5 h pendientes |"));
        assert!(text.contains("| Den \\| escritorio | 5.5 | 18 % | 4 | 1.4 h | no aplica |"));
        assert!(text.contains("## Por día"));
        assert!(text.contains("## Entradas"));
        assert!(text.contains("Conciliación de apartados segunda tanda"));
        assert!(text.contains("pendiente VB-118"));
        let tables = table_widths(&text);
        assert_eq!(tables.len(), 3);
        for table in tables {
            assert!(table.iter().all(|width| *width == table[0]), "{table:?}");
        }
    }

    #[test]
    fn markdown_respects_include() {
        let report = report();
        let include = Include { charts: Some(false), projects: Some(false), entries: Some(false), jira: Some(false), pay: None };
        let text = render_md(&report, report.sections(&include, GroupBy::Project));
        assert!(!text.contains("## Por proyecto"));
        assert!(!text.contains("## Por día"));
        assert!(!text.contains("## Entradas"));
        assert!(!text.contains("En Jira"));
    }

    #[test]
    fn xlsx_is_a_zip_with_the_expected_sheets() {
        let report = report();
        let bytes = render_xlsx(&report, report.sections(&all(), GroupBy::Project)).expect("xlsx");
        assert_eq!(&bytes[..2], b"PK");
        let without = render_xlsx(&report, report.sections(&Include { entries: Some(false), projects: Some(false), ..Include::default() }, GroupBy::Project))
            .expect("xlsx");
        assert!(without.len() < bytes.len());
    }

    #[test]
    fn files_get_default_names_and_numbered_siblings() {
        let root = scratch("names");
        let first = write_report(&root, ExportFormat::Csv, fixture(), &all(), GroupBy::Project, None).expect("first");
        assert_eq!(first, root.join("reporte-2026-09-28-2026-10-04.csv"));
        let second = write_report(&root, ExportFormat::Csv, fixture(), &all(), GroupBy::Project, None).expect("second");
        assert_eq!(second, root.join("reporte-2026-09-28-2026-10-04 (2).csv"));
        let named = write_report(&root, ExportFormat::Md, fixture(), &all(), GroupBy::Project, Some("Horas: septiembre/octubre.md")).expect("named");
        assert_eq!(named, root.join("Horas- septiembre-octubre.md"));
        let xlsx = write_report(&root, ExportFormat::Xlsx, fixture(), &all(), GroupBy::Project, Some("  ")).expect("xlsx");
        assert_eq!(xlsx, root.join("reporte-2026-09-28-2026-10-04.xlsx"));
        assert!(fs::read(&first).expect("read").starts_with(BOM.as_bytes()));
        let problem = write_report(&root, ExportFormat::Csv, serde_json::json!({"projects": "nope"}), &all(), GroupBy::Project, None)
            .expect_err("bad");
        assert!(problem.message.starts_with("El reporte no se puede leer"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn overtime_is_read_leniently() {
        let report = overtime_report();
        let overtime = report.overtime.as_ref().expect("overtime");
        assert_eq!(overtime.currency, "MXN");
        assert_eq!(overtime.multiplier, 2.0);
        assert_eq!(overtime.months.len(), 2);
        assert!(overtime.months[1].partial);
        assert_eq!(overtime.total.pay_multiplied, 6896.4);

        let mut view = overtime_fixture();
        view["overtime"]["currency"] = Value::from("USD");
        view["overtime"]["totals"] = Value::Null;
        let derived = normalize(serde_json::from_value(view).expect("view"));
        let derived = derived.overtime.expect("overtime");
        assert_eq!(derived.currency, "USD");
        assert_eq!(derived.total.overtime, 43200.0);
        assert!((derived.total.pay_x1 - 3448.2).abs() < 1e-9);

        let mut broken = fixture();
        broken["overtime"] = Value::from("nope");
        let broken = normalize(serde_json::from_value(broken).expect("view"));
        assert!(broken.overtime.is_none());
        assert!(!broken.sections(&with_pay(), GroupBy::Project).pay);
    }

    #[test]
    fn exports_without_pay_have_no_amounts() {
        let report = overtime_report();
        for include in [Include::default(), Include { pay: Some(false), ..Include::default() }] {
            let sections = report.sections(&include, GroupBy::Project);
            assert!(!sections.pay);
            assert_no_money(&render_csv(&report, sections));
            assert_no_money(&render_md(&report, sections));
            let parts = xlsx_text(&render_xlsx(&report, sections).expect("xlsx"));
            assert!(!parts["xl/workbook.xml"].contains(OVERTIME));
            for text in parts.values() {
                for needle in ["287.35", "3448.2", "6896.4", "Pago", "Tarifa", OVERTIME, "&quot;$&quot;"] {
                    assert!(!text.contains(needle), "{needle} leaked");
                }
            }
        }
        let plain = self::report();
        let sections = plain.sections(&with_pay(), GroupBy::Project);
        assert!(!sections.pay);
        assert_no_money(&render_md(&plain, sections));
    }

    #[test]
    fn csv_with_pay_appends_an_overtime_block_after_a_blank_line() {
        let report = overtime_report();
        let text = render_csv(&report, report.sections(&with_pay(), GroupBy::Project));
        assert!(text.contains("\r\n\r\nHoras extra\r\n"));
        let rows = parse_csv(&text);
        let start = rows.iter().position(|row| row == &[OVERTIME]).expect("block");
        assert_eq!(start, 7);
        assert_eq!(
            rows[start + 1],
            ["Mes", "Estado", "Estimadas (h)", "Esperadas (h)", "Extra (h)", "Pago ×1 (MXN)", "Pago ×2 (MXN)"]
        );
        assert_eq!(rows[start + 2], ["2026-09", "cerrado", "172.00", "160.00", "12.00", "3448.20", "6896.40"]);
        assert_eq!(rows[start + 3], ["2026-10", "en curso", "20.00", "160.00", "0.00", "0.00", "0.00"]);
        assert_eq!(rows[start + 4], ["Total", "", "192.00", "320.00", "12.00", "3448.20", "6896.40"]);
        assert_eq!(rows[start + 5], ["Tarifa por hora (MXN)", "287.35"]);
        assert_eq!(rows[start + 6], ["Multiplicador", "2"]);
        assert_eq!(rows[start + 7], [PARTIAL_NOTE]);
        assert_eq!(rows.len(), start + 8);
        assert!(rows[..start].iter().all(|row| row.len() == 9));
    }

    #[test]
    fn markdown_with_pay_adds_an_overtime_table() {
        let report = overtime_report();
        let text = render_md(&report, report.sections(&with_pay(), GroupBy::Project));
        assert!(text.contains("## Horas extra"));
        assert!(text.contains("**Tarifa por hora:** $287.35 MXN · **Multiplicador:** ×2"));
        assert!(text.contains("| Mes | Estado | Estimadas (h) | Esperadas (h) | Extra (h) | Pago ×1 (MXN) | Pago ×2 (MXN) |"));
        assert!(text.contains("| 2026-09 | cerrado | 172.0 | 160.0 | 12.0 | $3,448.20 | $6,896.40 |"));
        assert!(text.contains("| 2026-10 | en curso | 20.0 | 160.0 | 0.0 | $0.00 | $0.00 |"));
        assert!(text.contains("| **Total** | — | **192.0** | **320.0** | **12.0** | **$3,448.20** | **$6,896.40** |"));
        let tables = table_widths(&text);
        assert_eq!(tables.len(), 4);
        for table in tables {
            assert!(table.iter().all(|width| *width == table[0]), "{table:?}");
        }

        let mut view = fixture();
        view["overtime"] = serde_json::json!({"hourlyRate": 287.35, "problem": "Actualiza tally a 0.4 para calcular horas extra"});
        let pending = normalize(serde_json::from_value(view).expect("view"));
        let text = render_md(&pending, pending.sections(&with_pay(), GroupBy::Project));
        assert!(text.contains("## Horas extra\n\nActualiza tally a 0.4 para calcular horas extra\n"));
        assert!(!text.contains("287.35"));
        let csv = render_csv(&pending, pending.sections(&with_pay(), GroupBy::Project));
        assert!(csv.ends_with("\r\nHoras extra\r\nActualiza tally a 0.4 para calcular horas extra\r\n"));
        assert!(!csv.contains("287.35"));
        let parts = xlsx_text(&render_xlsx(&pending, pending.sections(&with_pay(), GroupBy::Project)).expect("xlsx"));
        assert!(parts["xl/sharedStrings.xml"].contains("Actualiza tally a 0.4"));
        assert!(!overtime_sheet(&parts).contains("287.35"));

        let mut view = overtime_fixture();
        view["overtime"]["currency"] = Value::from("CHF");
        view["overtime"]["multiplier"] = Value::Null;
        let foreign = normalize(serde_json::from_value(view).expect("view"));
        let text = render_md(&foreign, foreign.sections(&with_pay(), GroupBy::Project));
        assert!(text.contains("**Tarifa por hora:** 287.35 CHF · **Multiplicador:** ×2"));
        assert!(text.contains("| 3,448.20 | 6,896.40 |"));
        assert_eq!(factor(1.3333333), "1.33");
        assert_eq!(factor(1.5), "1.5");
    }

    #[test]
    fn xlsx_with_pay_adds_an_overtime_sheet_with_currency_format() {
        let report = overtime_report();
        let parts = xlsx_text(&render_xlsx(&report, report.sections(&with_pay(), GroupBy::Project)).expect("xlsx"));
        assert!(parts["xl/workbook.xml"].contains("name=\"Horas extra\""));
        assert!(parts["xl/styles.xml"].contains("formatCode=\"&quot;$&quot;#,##0.00\""));
        assert!(parts["xl/sharedStrings.xml"].contains("Pago ×2 (MXN)"));
        assert!(parts["xl/sharedStrings.xml"].contains("Tarifa por hora (MXN)"));
        assert!(parts["xl/sharedStrings.xml"].contains("en curso"));
        let sheet = overtime_sheet(&parts);
        for value in ["<v>3448.2</v>", "<v>6896.4</v>", "<v>287.35</v>", "<v>12</v>"] {
            assert!(sheet.contains(value), "{value} missing");
        }
    }

    #[test]
    #[ignore]
    fn writes_all_three_formats_for_inspection() {
        let root = std::env::var("DEN_REPORT_EXPORT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| scratch("e2e"));
        let csv_path = write_report(&root, ExportFormat::Csv, fixture(), &all(), GroupBy::Project, Some("e2e")).expect("csv");
        let md_path = write_report(&root, ExportFormat::Md, fixture(), &all(), GroupBy::Project, Some("e2e")).expect("md");
        let xlsx_path = write_report(&root, ExportFormat::Xlsx, fixture(), &all(), GroupBy::Project, Some("e2e")).expect("xlsx");

        let rows = parse_csv(&fs::read_to_string(&csv_path).expect("csv text"));
        assert!(rows.len() > 1 && rows.iter().all(|row| row.len() == rows[0].len()));

        for table in table_widths(&fs::read_to_string(&md_path).expect("md text")) {
            assert!(table.iter().all(|width| *width == table[0]));
        }

        let listing = std::process::Command::new("unzip").arg("-l").arg(&xlsx_path).output().expect("unzip -l");
        let listing = String::from_utf8_lossy(&listing.stdout);
        for part in ["xl/workbook.xml", "xl/worksheets/sheet4.xml", "xl/charts/chart1.xml"] {
            assert!(listing.contains(part), "{part} missing in {listing}");
        }
        let workbook = std::process::Command::new("unzip")
            .arg("-p")
            .arg(&xlsx_path)
            .arg("xl/workbook.xml")
            .output()
            .expect("unzip -p");
        let workbook = String::from_utf8_lossy(&workbook.stdout);
        for sheet in ["Resumen", "Proyectos", "Días", "Entradas"] {
            assert!(workbook.contains(&format!("name=\"{sheet}\"")), "{sheet} missing");
        }
        println!("{}\n{}\n{}", csv_path.display(), md_path.display(), xlsx_path.display());

        let pay = with_pay();
        let paid_csv = write_report(&root, ExportFormat::Csv, overtime_fixture(), &pay, GroupBy::Project, Some("e2e-pago")).expect("csv");
        let paid_md = write_report(&root, ExportFormat::Md, overtime_fixture(), &pay, GroupBy::Project, Some("e2e-pago")).expect("md");
        let paid_xlsx = write_report(&root, ExportFormat::Xlsx, overtime_fixture(), &pay, GroupBy::Project, Some("e2e-pago")).expect("xlsx");
        let unpaid_csv = write_report(&root, ExportFormat::Csv, overtime_fixture(), &all(), GroupBy::Project, Some("e2e-sin-pago")).expect("csv");
        let unpaid_md = write_report(&root, ExportFormat::Md, overtime_fixture(), &all(), GroupBy::Project, Some("e2e-sin-pago")).expect("md");
        let unpaid_xlsx = write_report(&root, ExportFormat::Xlsx, overtime_fixture(), &all(), GroupBy::Project, Some("e2e-sin-pago")).expect("xlsx");

        let rows = parse_csv(&fs::read_to_string(&paid_csv).expect("csv text"));
        assert!(rows.iter().any(|row| row[0] == "2026-09" && row[5] == "3448.20"));
        assert_no_money(&fs::read_to_string(&unpaid_csv).expect("csv text"));
        let paid_text = fs::read_to_string(&paid_md).expect("md text");
        assert!(paid_text.contains("## Horas extra"));
        for table in table_widths(&paid_text) {
            assert!(table.iter().all(|width| *width == table[0]));
        }
        assert_no_money(&fs::read_to_string(&unpaid_md).expect("md text"));
        let list = |path: &Path| {
            let output = std::process::Command::new("unzip").arg("-l").arg(path).output().expect("unzip -l");
            String::from_utf8_lossy(&output.stdout).to_string()
        };
        let workbook = |path: &Path| {
            let output = std::process::Command::new("unzip").arg("-p").arg(path).arg("xl/workbook.xml").output().expect("unzip -p");
            String::from_utf8_lossy(&output.stdout).to_string()
        };
        assert!(list(&paid_xlsx).contains("xl/worksheets/sheet5.xml"));
        assert!(!list(&unpaid_xlsx).contains("xl/worksheets/sheet5.xml"));
        assert!(workbook(&paid_xlsx).contains("name=\"Horas extra\""));
        assert!(!workbook(&unpaid_xlsx).contains(OVERTIME));
        for path in [&paid_csv, &paid_md, &paid_xlsx, &unpaid_csv, &unpaid_md, &unpaid_xlsx] {
            println!("{}", path.display());
        }
    }
}
