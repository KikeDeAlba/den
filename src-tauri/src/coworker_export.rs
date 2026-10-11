use std::path::{Path, PathBuf};

use rust_xlsxwriter::{Format, Workbook, Worksheet, XlsxError};
use serde::Deserialize;
use serde_json::Value;

use crate::coworkers::{site_url, CoworkerMonth, CoworkerOvertime, CoworkerTotals, OvertimeIssue};
use crate::model::Problem;
use crate::report_export::{
    amount, csv_line, currency_format, factor, failed, fixed, grouped_amount, hours, md_cell, md_row, md_rule, save_export, save_to_downloads, ExportFormat,
    BOM,
};

const CARDS: &str = "Tarjetas";
const MISSING: &str = "Sin estimación";
const NO_CARDS: &str = "Sin tarjetas terminadas con estimación en esos meses.";
const NO_MONTHS: &str = "Sin meses en el rango.";

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CoworkerInclude {
    pub pay: bool,
    pub without_estimate: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportPayload {
    #[serde(flatten)]
    overtime: CoworkerOvertime,
    #[serde(default)]
    from_month: Option<String>,
    #[serde(default)]
    to_month: Option<String>,
}

struct Rate {
    hourly: f64,
    multiplier: f64,
    currency: String,
}

struct Sheet {
    person: String,
    from: String,
    to: String,
    monthly_hours: f64,
    months: Vec<CoworkerMonth>,
    totals: CoworkerTotals,
    pay: Option<Rate>,
    without_estimate: bool,
}

fn clean_month(month: Option<&str>) -> Option<String> {
    month.map(str::trim).filter(|month| month.len() == 7 && month.as_bytes()[4] == b'-').map(str::to_string)
}

fn strip_pay(month: &mut CoworkerMonth) {
    month.pay_x1 = None;
    month.pay_multiplied = None;
}

fn prepare(payload: ExportPayload, include: CoworkerInclude) -> Sheet {
    let ExportPayload { mut overtime, from_month, to_month } = payload;
    overtime.site_url = overtime.site_url.as_deref().and_then(site_url).filter(|site| site.ends_with(".atlassian.net"));
    overtime.link_issues();
    let first = overtime.months.first().map(|month| month.month.clone()).unwrap_or_default();
    let last = overtime.months.last().map(|month| month.month.clone()).unwrap_or_default();
    let from = clean_month(from_month.as_deref()).unwrap_or(first);
    let to = clean_month(to_month.as_deref()).unwrap_or(last);
    let pay = match overtime.rate.hourly_rate {
        Some(hourly) if include.pay && hourly.is_finite() && hourly > 0.0 => Some(Rate {
            hourly,
            multiplier: overtime.rate.multiplier,
            currency: overtime.rate.currency.trim().to_uppercase(),
        }),
        _ => None,
    };
    let mut totals = overtime.totals.take().unwrap_or_default();
    if pay.is_none() {
        overtime.months.iter_mut().for_each(strip_pay);
        totals.pay_x1 = None;
        totals.pay_multiplied = None;
    }
    for month in &mut overtime.months {
        month.issues.sort_by(by_start);
        month.without_estimate.sort_by(by_start);
    }
    Sheet {
        person: overtime.person.name.trim().to_string(),
        from,
        to,
        monthly_hours: overtime.rate.monthly_hours,
        months: overtime.months,
        totals,
        pay,
        without_estimate: include.without_estimate,
    }
}

fn by_start(a: &OvertimeIssue, b: &OvertimeIssue) -> std::cmp::Ordering {
    a.start_date.as_deref().unwrap_or("").cmp(b.start_date.as_deref().unwrap_or("")).then_with(|| a.key.cmp(&b.key))
}

impl Sheet {
    fn range(&self) -> String {
        if self.from == self.to {
            self.from.clone()
        } else {
            format!("{} a {}", self.from, self.to)
        }
    }

    fn cards(&self) -> impl Iterator<Item = (&str, &OvertimeIssue)> {
        self.months.iter().flat_map(|month| month.issues.iter().map(move |issue| (month.month.as_str(), issue)))
    }

    fn missing(&self) -> impl Iterator<Item = (&str, &OvertimeIssue)> {
        self.months.iter().flat_map(|month| month.without_estimate.iter().map(move |issue| (month.month.as_str(), issue)))
    }

    fn has_missing(&self) -> bool {
        self.without_estimate && self.missing().next().is_some()
    }

    fn month_labels(&self) -> Vec<String> {
        let mut labels: Vec<String> =
            ["Mes", "Estimadas (h)", "Esperadas (h)", "Extra (h)"].map(String::from).to_vec();
        if let Some(rate) = &self.pay {
            labels.push(format!("Pago ×1 ({})", rate.currency));
            labels.push(format!("Pago ×{} ({})", factor(rate.multiplier), rate.currency));
        }
        labels
    }

    fn default_stem(&self) -> String {
        let slug: String = self
            .person
            .to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        let slug = if slug.is_empty() { "companero".to_string() } else { slug };
        format!("horas-extra-{slug}-{}-{}", self.from, self.to)
    }
}

fn day(issue: &OvertimeIssue) -> String {
    issue.start_date.as_deref().map(|date| date.chars().take(10).collect()).unwrap_or_default()
}

fn text(value: &Option<String>) -> String {
    value.clone().unwrap_or_default()
}

fn optional_amount(value: Option<f64>) -> String {
    value.map(amount).unwrap_or_default()
}

fn render_csv(sheet: &Sheet) -> String {
    let mut out = String::from(BOM);
    let header = ["Mes", "Clave", "URL", "Título", "Proyecto", "Estado", "Fecha de inicio", "Horas estimadas"];
    csv_line(&mut out, &header.map(String::from));
    for (month, issue) in sheet.cards() {
        csv_line(
            &mut out,
            &[
                month.to_string(),
                issue.key.clone(),
                text(&issue.url),
                issue.summary.clone(),
                text(&issue.project),
                text(&issue.status),
                day(issue),
                issue.estimate_seconds.map(fixed).unwrap_or_default(),
            ],
        );
    }
    if sheet.has_missing() {
        out.push_str("\r\n");
        csv_line(&mut out, &[MISSING.to_string()]);
        csv_line(&mut out, &header[..7].iter().map(|label| label.to_string()).collect::<Vec<_>>());
        for (month, issue) in sheet.missing() {
            csv_line(
                &mut out,
                &[
                    month.to_string(),
                    issue.key.clone(),
                    text(&issue.url),
                    issue.summary.clone(),
                    text(&issue.project),
                    text(&issue.status),
                    day(issue),
                ],
            );
        }
    }
    out.push_str("\r\n");
    csv_line(&mut out, &["Por mes".to_string()]);
    csv_line(&mut out, &sheet.month_labels());
    let rows = sheet
        .months
        .iter()
        .map(|month| {
            (month.month.clone(), month.estimate_seconds, month.expected_seconds, month.overtime_seconds, month.pay_x1, month.pay_multiplied)
        })
        .chain([(
            "Total".to_string(),
            sheet.totals.estimate_seconds,
            sheet.totals.expected_seconds,
            sheet.totals.overtime_seconds,
            sheet.totals.pay_x1,
            sheet.totals.pay_multiplied,
        )]);
    for (label, estimate, expected, overtime, x1, multiplied) in rows {
        let mut row = vec![label, fixed(estimate), fixed(expected), fixed(overtime)];
        if sheet.pay.is_some() {
            row.push(optional_amount(x1));
            row.push(optional_amount(multiplied));
        }
        csv_line(&mut out, &row);
    }
    if let Some(rate) = &sheet.pay {
        csv_line(&mut out, &[format!("Tarifa por hora ({})", rate.currency), amount(rate.hourly)]);
        csv_line(&mut out, &["Multiplicador".into(), factor(rate.multiplier)]);
    }
    out
}

fn md_key(issue: &OvertimeIssue) -> String {
    match &issue.url {
        Some(url) => format!("[{}]({url})", issue.key),
        None => issue.key.clone(),
    }
}

fn md_amount(value: Option<f64>, currency: &str) -> String {
    value.map(|value| grouped_amount(value, currency)).unwrap_or_default()
}

fn md_issues(out: &mut String, rows: Vec<(&str, &OvertimeIssue)>, with_estimate: bool) {
    let mut header: Vec<String> = ["Mes", "Clave", "Título", "Proyecto", "Estado", "Fecha de inicio"].map(String::from).to_vec();
    let mut aligns = vec![false; 6];
    if with_estimate {
        header.push("Horas".into());
        aligns.push(true);
    }
    md_row(out, &header);
    md_rule(out, &aligns);
    for (month, issue) in rows {
        let mut cells = vec![
            month.to_string(),
            md_key(issue),
            issue.summary.replace('[', "\\[").replace(']', "\\]"),
            text(&issue.project),
            text(&issue.status),
            day(issue),
        ];
        if with_estimate {
            cells.push(issue.estimate_seconds.map(|seconds| format!("{:.1}", hours(seconds))).unwrap_or_default());
        }
        md_row(out, &cells);
    }
}

fn render_md(sheet: &Sheet) -> String {
    let mut out = format!("# Horas extra · {}\n\n", md_cell(&sheet.person));
    let mut summary = vec![
        format!("**Rango:** {}", sheet.range()),
        format!("**Horas esperadas al mes:** {}", factor(sheet.monthly_hours)),
        format!(
            "**Estimadas:** {:.1} h de {:.1} h esperadas",
            hours(sheet.totals.estimate_seconds),
            hours(sheet.totals.expected_seconds)
        ),
        format!("**Extra:** {:.1} h", hours(sheet.totals.overtime_seconds)),
    ];
    if let Some(rate) = &sheet.pay {
        summary.push(format!("**Tarifa por hora:** {} {}", grouped_amount(rate.hourly, &rate.currency), rate.currency));
    }
    out.push_str(&summary.join("  \n"));
    out.push_str("\n\n## Por mes\n\n");
    if sheet.months.is_empty() {
        out.push_str(NO_MONTHS);
        out.push('\n');
    } else {
        let labels = sheet.month_labels();
        md_row(&mut out, &labels);
        let aligns: Vec<bool> = labels.iter().enumerate().map(|(index, _)| index > 0).collect();
        md_rule(&mut out, &aligns);
        let currency = sheet.pay.as_ref().map(|rate| rate.currency.as_str()).unwrap_or("");
        for month in &sheet.months {
            let mut row = vec![
                month.month.clone(),
                format!("{:.1}", hours(month.estimate_seconds)),
                format!("{:.1}", hours(month.expected_seconds)),
                format!("{:.1}", hours(month.overtime_seconds)),
            ];
            if sheet.pay.is_some() {
                row.push(md_amount(month.pay_x1, currency));
                row.push(md_amount(month.pay_multiplied, currency));
            }
            md_row(&mut out, &row);
        }
        let totals = &sheet.totals;
        let mut row = vec![
            "**Total**".to_string(),
            format!("**{:.1}**", hours(totals.estimate_seconds)),
            format!("**{:.1}**", hours(totals.expected_seconds)),
            format!("**{:.1}**", hours(totals.overtime_seconds)),
        ];
        if sheet.pay.is_some() {
            row.push(format!("**{}**", md_amount(totals.pay_x1, currency)));
            row.push(format!("**{}**", md_amount(totals.pay_multiplied, currency)));
        }
        md_row(&mut out, &row);
    }
    out.push_str(&format!("\n## {CARDS}\n\n"));
    let cards: Vec<_> = sheet.cards().collect();
    if cards.is_empty() {
        out.push_str(NO_CARDS);
        out.push('\n');
    } else {
        md_issues(&mut out, cards, true);
    }
    if sheet.has_missing() {
        out.push_str(&format!("\n## {MISSING}\n\nNo suman horas.\n\n"));
        md_issues(&mut out, sheet.missing().collect(), false);
    }
    out
}

struct Styles {
    header: Format,
    hours: Format,
    bold_hours: Format,
}

fn header_row(sheet: &mut Worksheet, styles: &Styles, labels: &[String], widths: &[f64]) -> Result<(), XlsxError> {
    for (col, label) in labels.iter().enumerate() {
        sheet.write_string_with_format(0, col as u16, label, &styles.header)?;
    }
    for (col, width) in widths.iter().enumerate() {
        sheet.set_column_width(col as u16, *width)?;
    }
    sheet.set_freeze_panes(1, 0)?;
    Ok(())
}

fn issue_sheet(
    workbook: &mut Workbook,
    styles: &Styles,
    name: &str,
    rows: Vec<(&str, &OvertimeIssue)>,
    with_estimate: bool,
) -> Result<(), XlsxError> {
    let sheet = workbook.add_worksheet();
    sheet.set_name(name)?;
    let mut labels: Vec<String> = ["Mes", "Clave", "Título", "Proyecto", "Estado", "Fecha de inicio"].map(String::from).to_vec();
    let mut widths = vec![10.0, 12.0, 52.0, 12.0, 14.0, 14.0];
    if with_estimate {
        labels.push("Horas estimadas".into());
        widths.push(15.0);
    }
    header_row(sheet, styles, &labels, &widths)?;
    for (index, (month, issue)) in rows.into_iter().enumerate() {
        let row = index as u32 + 1;
        sheet.write_string(row, 0, month)?;
        match &issue.url {
            Some(url) => {
                sheet.write_url_with_text(row, 1, url.as_str(), issue.key.as_str())?;
            }
            None => {
                sheet.write_string(row, 1, &issue.key)?;
            }
        }
        sheet.write_string(row, 2, &issue.summary)?;
        sheet.write_string(row, 3, text(&issue.project))?;
        sheet.write_string(row, 4, text(&issue.status))?;
        sheet.write_string(row, 5, day(issue))?;
        if with_estimate {
            if let Some(seconds) = issue.estimate_seconds {
                sheet.write_number_with_format(row, 6, hours(seconds), &styles.hours)?;
            }
        }
    }
    Ok(())
}

fn render_xlsx(sheet: &Sheet) -> Result<Vec<u8>, XlsxError> {
    let styles = Styles {
        header: Format::new().set_bold(),
        hours: Format::new().set_num_format("0.0"),
        bold_hours: Format::new().set_bold().set_num_format("0.0"),
    };
    let mut workbook = Workbook::new();

    let summary = workbook.add_worksheet();
    summary.set_name("Resumen")?;
    let labels = sheet.month_labels();
    header_row(summary, &styles, &labels, &[26.0, 14.0, 14.0, 12.0, 18.0, 18.0])?;
    let mut row = 1u32;
    for month in &sheet.months {
        summary.write_string(row, 0, &month.month)?;
        summary.write_number_with_format(row, 1, hours(month.estimate_seconds), &styles.hours)?;
        summary.write_number_with_format(row, 2, hours(month.expected_seconds), &styles.hours)?;
        summary.write_number_with_format(row, 3, hours(month.overtime_seconds), &styles.hours)?;
        row += 1;
    }
    summary.write_string_with_format(row, 0, "Total", &styles.header)?;
    summary.write_number_with_format(row, 1, hours(sheet.totals.estimate_seconds), &styles.bold_hours)?;
    summary.write_number_with_format(row, 2, hours(sheet.totals.expected_seconds), &styles.bold_hours)?;
    summary.write_number_with_format(row, 3, hours(sheet.totals.overtime_seconds), &styles.bold_hours)?;
    if let Some(rate) = &sheet.pay {
        let code = currency_format(&rate.currency);
        let currency = Format::new().set_num_format(&code);
        let bold_currency = Format::new().set_bold().set_num_format(&code);
        for (index, month) in sheet.months.iter().enumerate() {
            let line = index as u32 + 1;
            if let Some(value) = month.pay_x1 {
                summary.write_number_with_format(line, 4, value, &currency)?;
            }
            if let Some(value) = month.pay_multiplied {
                summary.write_number_with_format(line, 5, value, &currency)?;
            }
        }
        if let Some(value) = sheet.totals.pay_x1 {
            summary.write_number_with_format(row, 4, value, &bold_currency)?;
        }
        if let Some(value) = sheet.totals.pay_multiplied {
            summary.write_number_with_format(row, 5, value, &bold_currency)?;
        }
        row += 2;
        summary.write_string_with_format(row, 0, format!("Tarifa por hora ({})", rate.currency), &styles.header)?;
        summary.write_number_with_format(row, 1, rate.hourly, &currency)?;
        row += 1;
        summary.write_string_with_format(row, 0, "Multiplicador", &styles.header)?;
        summary.write_number(row, 1, rate.multiplier)?;
    }
    row += 2;
    for (label, value) in [
        ("Persona", sheet.person.clone()),
        ("Rango", sheet.range()),
        ("Horas esperadas al mes", factor(sheet.monthly_hours)),
    ] {
        summary.write_string_with_format(row, 0, label, &styles.header)?;
        summary.write_string(row, 1, value)?;
        row += 1;
    }

    issue_sheet(&mut workbook, &styles, CARDS, sheet.cards().collect(), true)?;
    if sheet.has_missing() {
        issue_sheet(&mut workbook, &styles, MISSING, sheet.missing().collect(), false)?;
    }
    workbook.save_to_buffer()
}

fn render(format: ExportFormat, sheet: &Sheet) -> Result<Vec<u8>, Problem> {
    match format {
        ExportFormat::Csv => Ok(render_csv(sheet).into_bytes()),
        ExportFormat::Md => Ok(render_md(sheet).into_bytes()),
        ExportFormat::Xlsx => render_xlsx(sheet).map_err(|error| failed(format!("No pude armar el Excel: {error}"))),
    }
}

fn write_report(
    dir: &Path,
    format: ExportFormat,
    report: Value,
    include: CoworkerInclude,
    file_name: Option<&str>,
) -> Result<PathBuf, Problem> {
    let payload: ExportPayload =
        serde_json::from_value(report).map_err(|error| failed(format!("El reporte del compañero no se puede leer: {error}")))?;
    let sheet = prepare(payload, include);
    let bytes = render(format, &sheet)?;
    save_export(dir, file_name, &sheet.default_stem(), format.extension(), &bytes)
}

#[tauri::command]
pub async fn export_coworker_report(
    format: ExportFormat,
    report: Value,
    include: Option<CoworkerInclude>,
    file_name: Option<String>,
) -> Result<String, Problem> {
    let include = include.unwrap_or_default();
    save_to_downloads(move |downloads| write_report(downloads, format, report, include, file_name.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::fs;

    const MONEY: [&str; 10] =
        ["187.5", "1500", "1,500.00", "3000", "3,000.00", "Pago", "Tarifa", "$", "Multiplicador", "MXN"];

    fn fixture(hourly: Option<f64>) -> Value {
        let paid = hourly.is_some();
        let pay = |value: f64| if paid { json!(value) } else { Value::Null };
        json!({
            "person": {"name": "Ana Pérez", "accountId": "acc-1", "source": "jira"},
            "rate": {"hourlyRate": hourly, "monthlyHours": 160, "multiplier": 2, "currency": "MXN"},
            "siteUrl": "https://gruposti.atlassian.net",
            "fromMonth": "2026-08",
            "toMonth": "2026-09",
            "months": [
                {
                    "month": "2026-08", "estimateSeconds": 576000, "expectedSeconds": 576000, "overtimeSeconds": 0,
                    "payX1": pay(0.0), "payMultiplied": pay(0.0), "issues": [], "withoutEstimate": []
                },
                {
                    "month": "2026-09", "estimateSeconds": 604800, "expectedSeconds": 576000, "overtimeSeconds": 28800,
                    "payX1": pay(1500.0), "payMultiplied": pay(3000.0),
                    "issues": [
                        {"key": "PP-12", "summary": "Conciliación | segunda tanda, \"urgente\"", "project": "PP", "status": "Listo", "startDate": "2026-09-08", "estimateSeconds": 302400, "url": "https://gruposti.atlassian.net/browse/PP-12"},
                        {"key": "PP-11", "summary": "=SUM(A1) alta", "project": "PP", "status": "Listo", "startDate": "2026-09-01", "estimateSeconds": 302400, "url": null}
                    ],
                    "withoutEstimate": [
                        {"key": "OPS-7", "summary": "Revisión sin estimar", "project": "OPS", "status": "Listo", "startDate": "2026-09-15", "estimateSeconds": null, "url": "https://gruposti.atlassian.net/browse/OPS-7"}
                    ]
                }
            ],
            "totals": {"estimateSeconds": 1180800, "expectedSeconds": 1152000, "overtimeSeconds": 28800, "payX1": pay(1500.0), "payMultiplied": pay(3000.0)}
        })
    }

    fn sheet(value: Value, pay: bool, without_estimate: bool) -> Sheet {
        prepare(serde_json::from_value(value).expect("payload"), CoworkerInclude { pay, without_estimate })
    }

    fn paid(pay: bool) -> Sheet {
        sheet(fixture(Some(187.5)), pay, true)
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
                current.push(line.replace("\\|", "").matches('|').count() - 1);
            } else if !current.is_empty() {
                tables.push(std::mem::take(&mut current));
            }
        }
        if !current.is_empty() {
            tables.push(current);
        }
        tables
    }

    fn xlsx_parts(bytes: &[u8]) -> HashMap<String, String> {
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

    fn assert_no_money(text: &str) {
        for needle in MONEY {
            assert!(!text.contains(needle), "{needle} leaked");
        }
    }

    #[test]
    fn csv_lists_each_card_with_its_url_then_the_months() {
        let rows = parse_csv(&render_csv(&paid(true)));
        assert_eq!(rows[0], ["Mes", "Clave", "URL", "Título", "Proyecto", "Estado", "Fecha de inicio", "Horas estimadas"]);
        assert_eq!(rows[1][1], "PP-11");
        assert_eq!(rows[1][2], "https://gruposti.atlassian.net/browse/PP-11");
        assert_eq!(rows[1][3], "'=SUM(A1) alta");
        assert_eq!(rows[2][3], "Conciliación | segunda tanda, \"urgente\"");
        assert_eq!(rows[2][7], "84.00");
        assert!(rows.iter().any(|row| row == &["Sin estimación"]));
        assert!(rows.iter().any(|row| row.get(1).map(String::as_str) == Some("OPS-7")));
        let months = rows.iter().position(|row| row == &["Por mes"]).expect("months block");
        assert_eq!(rows[months + 1], ["Mes", "Estimadas (h)", "Esperadas (h)", "Extra (h)", "Pago ×1 (MXN)", "Pago ×2 (MXN)"]);
        assert_eq!(rows[months + 3], ["2026-09", "168.00", "160.00", "8.00", "1500.00", "3000.00"]);
        assert_eq!(rows[months + 4][0], "Total");
        assert!(rows.iter().any(|row| row == &["Tarifa por hora (MXN)", "187.50"]));
    }

    #[test]
    fn without_estimate_can_be_left_out() {
        let text = render_csv(&sheet(fixture(None), false, false));
        assert!(!text.contains("OPS-7"));
        assert!(!render_md(&sheet(fixture(None), false, false)).contains("OPS-7"));
        let parts = xlsx_parts(&render_xlsx(&sheet(fixture(None), false, false)).expect("xlsx"));
        assert!(!parts["xl/workbook.xml"].contains(MISSING));
    }

    #[test]
    fn markdown_links_keys_and_keeps_tables_consistent() {
        let text = render_md(&paid(true));
        assert!(text.starts_with("# Horas extra · Ana Pérez\n"));
        assert!(text.contains("**Rango:** 2026-08 a 2026-09"));
        assert!(text.contains("[PP-12](https://gruposti.atlassian.net/browse/PP-12)"));
        assert!(text.contains("[OPS-7](https://gruposti.atlassian.net/browse/OPS-7)"));
        assert!(text.contains("| 2026-09 | 168.0 | 160.0 | 8.0 | $1,500.00 | $3,000.00 |"));
        assert!(text.contains("Conciliación \\| segunda tanda"));
        for table in table_widths(&text) {
            assert!(table.iter().all(|width| *width == table[0]), "{table:?}");
        }
    }

    #[test]
    fn xlsx_has_summary_cards_and_missing_sheets_with_hyperlinks() {
        let parts = xlsx_parts(&render_xlsx(&paid(true)).expect("xlsx"));
        let workbook = &parts["xl/workbook.xml"];
        for name in ["Resumen", CARDS, MISSING] {
            assert!(workbook.contains(&format!("name=\"{name}\"")), "{name} missing");
        }
        let rels = &parts["xl/worksheets/_rels/sheet2.xml.rels"];
        assert!(rels.contains("relationships/hyperlink"));
        assert!(rels.contains("https://gruposti.atlassian.net/browse/PP-12"));
        assert!(parts["xl/worksheets/sheet2.xml"].contains("<hyperlink"));
        assert!(parts["xl/worksheets/_rels/sheet3.xml.rels"].contains("browse/OPS-7"));
        assert!(parts["xl/styles.xml"].contains("formatCode=\"&quot;$&quot;#,##0.00\""));
        assert!(parts["xl/worksheets/sheet1.xml"].contains("<v>187.5</v>"));
    }

    #[test]
    fn without_pay_no_amount_or_rate_appears_anywhere() {
        for source in [paid(false), sheet(fixture(None), true, true)] {
            assert!(source.pay.is_none());
            assert_no_money(&render_csv(&source));
            assert_no_money(&render_md(&source));
            let parts = xlsx_parts(&render_xlsx(&source).expect("xlsx"));
            for (name, part) in &parts {
                if name.ends_with(".xml") && !name.contains("styles") && !name.contains("docProps") && !name.contains("theme") {
                    assert_no_money(part);
                }
            }
            assert!(!parts["xl/styles.xml"].contains("#,##0.00"));
        }
    }

    #[test]
    fn file_names_use_the_person_and_range_and_never_the_salary() {
        let root = std::env::temp_dir().join(format!("den-coworker-names-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let first = write_report(&root, ExportFormat::Csv, fixture(Some(187.5)), CoworkerInclude { pay: true, without_estimate: true }, None)
            .expect("csv");
        assert_eq!(first.file_name().and_then(|name| name.to_str()), Some("horas-extra-ana-pérez-2026-08-2026-09.csv"));
        let second = write_report(&root, ExportFormat::Csv, fixture(Some(187.5)), CoworkerInclude::default(), None).expect("csv");
        assert_eq!(second.file_name().and_then(|name| name.to_str()), Some("horas-extra-ana-pérez-2026-08-2026-09 (2).csv"));
        let named = write_report(&root, ExportFormat::Md, fixture(None), CoworkerInclude::default(), Some("a/b:c.md")).expect("md");
        assert_eq!(named.file_name().and_then(|name| name.to_str()), Some("a-b-c.md"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn brackets_are_escaped_and_empty_sections_are_left_out() {
        let mut value = fixture(None);
        value["months"][1]["issues"][0]["summary"] = json!("[Backend] Fix login");
        value["months"][1]["withoutEstimate"] = json!([]);
        let source = sheet(value, false, true);
        assert!(render_md(&source).contains("\\[Backend\\] Fix login"));
        assert!(!render_md(&source).contains(MISSING));
        assert!(!render_csv(&source).contains(MISSING));
        let parts = xlsx_parts(&render_xlsx(&source).expect("xlsx"));
        assert!(!parts["xl/workbook.xml"].contains(MISSING));
    }

    #[test]
    fn hostile_urls_from_the_payload_are_dropped() {
        let mut value = fixture(None);
        value["siteUrl"] = Value::Null;
        value["months"][1]["issues"][0]["url"] = json!("https://evil.example.com/browse/PP-12");
        value["months"][1]["issues"][1]["url"] = json!("https://gruposti.atlassian.net/browse/PP-11) [x](javascript:1");
        let text = render_md(&sheet(value, false, true));
        assert!(!text.contains("evil.example.com"));
        assert!(!text.contains("javascript"));
        assert!(text.contains("| PP-11 |"));
    }

    #[test]
    #[ignore]
    fn writes_coworker_exports_for_inspection() {
        let root = std::env::var("DEN_REPORT_EXPORT_DIR").map(PathBuf::from).unwrap_or_else(|_| {
            let dir = std::env::temp_dir().join(format!("den-coworker-e2e-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            dir
        });
        let with = CoworkerInclude { pay: true, without_estimate: true };
        let without = CoworkerInclude { pay: false, without_estimate: true };
        let mut written = Vec::new();
        for (include, name) in [(with, "e2e-companero-pago"), (without, "e2e-companero-sin-pago")] {
            for format in [ExportFormat::Csv, ExportFormat::Md, ExportFormat::Xlsx] {
                written.push((include.pay, format, write_report(&root, format, fixture(Some(187.5)), include, Some(name)).expect("write")));
            }
        }
        for (pay, format, path) in &written {
            match format {
                ExportFormat::Csv => {
                    let text = fs::read_to_string(path).expect("csv");
                    let rows = parse_csv(&text);
                    assert!(rows.iter().skip(1).take(2).all(|row| row.len() == rows[0].len()));
                    assert!(text.contains("https://gruposti.atlassian.net/browse/PP-12"));
                    if !pay {
                        assert_no_money(&text);
                    }
                }
                ExportFormat::Md => {
                    let text = fs::read_to_string(path).expect("md");
                    for table in table_widths(&text) {
                        assert!(table.iter().all(|width| *width == table[0]));
                    }
                    assert!(text.contains("[PP-12](https://gruposti.atlassian.net/browse/PP-12)"));
                    if !pay {
                        assert_no_money(&text);
                    }
                }
                ExportFormat::Xlsx => {
                    let listing = std::process::Command::new("unzip").arg("-l").arg(path).output().expect("unzip -l");
                    let listing = String::from_utf8_lossy(&listing.stdout);
                    assert!(listing.contains("xl/worksheets/_rels/sheet2.xml.rels"), "{listing}");
                    let rels = std::process::Command::new("unzip")
                        .arg("-p")
                        .arg(path)
                        .arg("xl/worksheets/_rels/sheet2.xml.rels")
                        .output()
                        .expect("unzip -p");
                    let rels = String::from_utf8_lossy(&rels.stdout);
                    assert!(rels.contains("relationships/hyperlink") && rels.contains("browse/PP-12"), "{rels}");
                    if !pay {
                        let shared = std::process::Command::new("unzip")
                            .arg("-p")
                            .arg(path)
                            .arg("xl/sharedStrings.xml")
                            .output()
                            .expect("unzip -p");
                        assert_no_money(&String::from_utf8_lossy(&shared.stdout));
                    }
                }
            }
            println!("{}", path.display());
        }
    }
}
