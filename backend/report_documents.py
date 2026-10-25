import io
import math
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from xml.sax.saxutils import escape

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "report_assets"
MOSCOW = timezone(timedelta(hours=3))
COVERAGE_LABELS = {
    "records": "Запусков проверок",
    "answers": "Получено ответов для расчёта",
    "partial": "Частичных проверок",
    "errors": "Ошибок моделей",
    "failed": "Проверок с ошибкой",
    "running": "В процессе",
    "excluded": "Исключено проверок",
    "excluded_answers": "Ответов прежнего анализа",
}
METRIC_LABELS = {
    "sov": "Share of Voice",
    "visibility": "Brand Visibility",
    "citation": "Citation Rate",
    "position": "Average Position",
}


def _asset(name, development):
    packaged = ASSETS / name
    return packaged if packaged.is_file() else ROOT.parent / development


@lru_cache(maxsize=1)
def report_palette():
    css = _asset("style.css", "css/style.css").read_text(encoding="utf-8")
    root = re.search(r":root\s*\{([^}]+)\}", css).group(1)
    palette = {}
    for name in ("paper", "ink", "muted-light", "line-light", "wash-light", "accent"):
        match = re.search(rf"--{name}\s*:\s*(#[0-9a-fA-F]{{6}})\s*;", root)
        if not match:
            raise ValueError(f"Не найден цвет отчёта: {name}")
        palette[name] = match.group(1)
    return palette


@lru_cache(maxsize=1)
def _register_fonts():
    pdfmetrics.registerFont(TTFont("Vidno", str(ASSETS / "DejaVuSans.ttf")))
    pdfmetrics.registerFont(TTFont("VidnoBold", str(ASSETS / "DejaVuSans-Bold.ttf")))
    pdfmetrics.registerFontFamily("Vidno", normal="Vidno", bold="VidnoBold", italic="Vidno", boldItalic="VidnoBold")


def _generated_at(report):
    return datetime.fromisoformat(report["generated_at"].replace("Z", "+00:00")).astimezone(MOSCOW)


def _number(value, percent=False):
    if value is None:
        return "—"
    if not math.isfinite(value):
        raise ValueError("Некорректное значение показателя")
    return f"{value:g}" + ("%" if percent else "")


def coverage_text(report):
    return " · ".join(f"{label}: {report['coverage'].get(key, 0)}" for key, label in COVERAGE_LABELS.items() if key in {"records", "answers"} or report["coverage"].get(key))


def _pdf(report):
    _register_fonts()
    palette = {key: colors.HexColor(value) for key, value in report_palette().items()}
    output = io.BytesIO()
    width = A4[0] - 36 * mm - 12
    document = SimpleDocTemplate(output, pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm, topMargin=16 * mm, bottomMargin=19 * mm, title=f"Отчёт о видимости — {report['brand']['name']}", author="Vidno")
    body = ParagraphStyle("Body", fontName="Vidno", fontSize=9, leading=14, textColor=palette["ink"], spaceAfter=6, splitLongWords=True)
    muted = ParagraphStyle("Muted", parent=body, fontSize=8, leading=12, textColor=palette["muted-light"])
    introduction = ParagraphStyle("Introduction", parent=muted, keepWithNext=True)
    heading = ParagraphStyle("Heading", parent=body, fontName="VidnoBold", fontSize=12, leading=17, spaceBefore=15, spaceAfter=9, keepWithNext=True)
    title = ParagraphStyle("Title", parent=heading, fontSize=22, leading=29, spaceBefore=0, spaceAfter=12)
    cell = ParagraphStyle("Cell", parent=body, fontSize=8, leading=12, spaceAfter=0)
    cell_right = ParagraphStyle("CellRight", parent=cell, alignment=TA_RIGHT)
    cell_head = ParagraphStyle("CellHead", parent=cell, fontName="VidnoBold", textColor=palette["muted-light"])
    story = []

    def paragraph(text, style=body):
        return Paragraph(escape(str(text)).replace("\n", "<br/>"), style)

    def table(headers, rows, widths, own_rows=()):
        data = [[paragraph(label, cell_head) for label in headers]]
        data.extend([[paragraph(value, cell if index == 0 else cell_right) for index, value in enumerate(row)] for row in rows])
        result = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
        commands = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOTTOMPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 8), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7), ("LINEBELOW", (0, 0), (-1, -1), .5, palette["line-light"])]
        commands.extend(("BACKGROUND", (0, row), (-1, row), palette["wash-light"]) for row in own_rows)
        result.setStyle(TableStyle(commands))
        return result

    logo = _asset("vidno-logo.png", "assets/vidno-logo.png")
    image_width, image_height = ImageReader(str(logo)).getSize()
    brand_logo = Image(str(logo), width=image_width * 9 * mm / image_height, height=9 * mm)
    brand_logo.hAlign = "LEFT"
    date_style = ParagraphStyle("Date", parent=muted, alignment=TA_RIGHT)
    wordmark = ParagraphStyle("Wordmark", parent=title, fontSize=21, leading=27, spaceAfter=0)
    logo_group = Table([[brand_logo, paragraph("Vidno", wordmark)]], colWidths=[13 * mm, width * .4 - 13 * mm])
    logo_group.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
    header = Table([[logo_group, paragraph(f"Сформирован {_generated_at(report):%d.%m.%Y %H:%M} МСК", date_style)]], colWidths=[width * .4, width * .6])
    header.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 14), ("LINEBELOW", (0, 0), (-1, -1), .5, palette["line-light"])]))
    story.extend([header, Spacer(1, 18), paragraph("Отчёт о видимости", muted), paragraph(report["brand"]["name"], title), paragraph(report["period"]["label"], muted), paragraph("AI-модели: " + ", ".join(item["name"] for item in report["providers"]), muted), Spacer(1, 6)])
    coverage = Table([[paragraph(coverage_text(report), muted)]], colWidths=[width])
    coverage.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), palette["wash-light"]), ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10), ("TOPPADDING", (0, 0), (-1, -1), 9), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    story.extend([coverage, Spacer(1, 14)])
    metric_value = ParagraphStyle("Metric", parent=heading, fontSize=21, leading=29, spaceBefore=0, spaceAfter=4)
    notes = {"sov": "Доля голоса с учётом позиции", "visibility": f"{report['own_mentions']} из {report['coverage']['answers']} ответов", "citation": f"{report['citation']['count']} из {report['coverage']['answers']} ответов" if report["citation"]["measured"] else "Домены бренда не указаны", "position": "В извлечённых списках брендов"}
    metric_cards = []
    for key, label in METRIC_LABELS.items():
        metric_cards.append([paragraph(label, muted), paragraph(_number(report["metrics"][key], key != "position"), metric_value), paragraph(notes[key], muted)])
    metrics = Table([metric_cards], colWidths=[width / 4] * 4)
    metrics.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOX", (0, 0), (-1, -1), .5, palette["line-light"]), ("INNERGRID", (0, 0), (-1, -1), .5, palette["line-light"]), ("TOPPADDING", (0, 0), (-1, -1), 10), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
    story.append(metrics)
    story.extend([paragraph("Видимость по AI-моделям", heading), table(["Модель", "Ответы", "Упоминания", "Видимость"], [[row["name"], row["answers"], row["mentions"], _number(row["visibility"], True)] for row in report["models"]], [width * .34, width * .2, width * .23, width * .23])])
    story.extend([paragraph("Бренд и конкуренты", heading), paragraph("Активный бренд и до пяти конкурентов по доле голоса.", introduction), table(["Бренд", "SoV", "Видимость", "Ср. позиция"], [[row["name"] + (" · ваш бренд" if row["own"] else ""), _number(row["sov"], True), _number(row["visibility"], True), _number(row["position"])] for row in report["brands"]], [width * .43, width * .17, width * .2, width * .2], [index + 1 for index, row in enumerate(report["brands"]) if row["own"]])])
    story.append(paragraph("Источники в ответах AI", heading))
    if report["sources"]:
        story.append(table(["Домен", "Ответы с источником", "Доля ответов"], [[row["name"], row["answers"], _number(row["share"], True)] for row in report["sources"]], [width * .45, width * .3, width * .25]))
    else:
        story.append(paragraph("В выбранных ответах нет источников.", muted))
    story.append(paragraph("Как читать цифры", heading))
    story.extend(paragraph(text, muted) for text in report["methodology"])

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(palette["line-light"])
        canvas.line(18 * mm, 15 * mm, A4[0] - 18 * mm, 15 * mm)
        canvas.setFont("Vidno", 8)
        canvas.setFillColor(palette["muted-light"])
        canvas.drawString(18 * mm, 10 * mm, "Vidno · vidno.one")
        canvas.drawRightString(A4[0] - 18 * mm, 10 * mm, str(doc.page))
        canvas.restoreState()

    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()


def _xlsx(report):
    palette = {key: value.lstrip("#") for key, value in report_palette().items()}
    workbook = Workbook()
    workbook.remove(workbook.active)
    workbook.properties.creator = "Vidno"
    workbook.properties.title = f"Отчёт о видимости — {report['brand']['name']}"

    def write(sheet, row, column, value, number_format=None):
        target = sheet.cell(row, column, "—" if value is None else value)
        if isinstance(target.value, str):
            target.value = re.sub(r"[\x00-\x08\x0b-\x0c\x0e-\x1f]", "", target.value)
            target.data_type = "s"
        target.font = Font(name="DejaVu Sans", size=11, color=palette["ink"])
        target.alignment = Alignment(horizontal="left" if isinstance(target.value, str) else "right", vertical="top", wrap_text=True)
        if number_format and value is not None:
            target.number_format = number_format
        return target

    def sheet(title, widths):
        result = workbook.create_sheet(title)
        result.sheet_view.showGridLines = False
        for index, size in enumerate(widths, 1):
            result.column_dimensions[get_column_letter(index)].width = size
        result.sheet_properties.pageSetUpPr.fitToPage = True
        result.page_setup.orientation = "landscape"
        result.page_setup.paperSize = result.PAPERSIZE_A4
        result.page_setup.fitToWidth = 1
        result.page_setup.fitToHeight = 0
        result.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(widths))
        write(result, 1, 1, title).font = Font(name="DejaVu Sans", size=18, bold=True, color=palette["ink"])
        result.row_dimensions[1].height = 32
        return result

    def header(result, row, labels):
        for column, label in enumerate(labels, 1):
            target = write(result, row, column, label)
            target.fill = PatternFill("solid", fgColor=palette["wash-light"])
            target.font = Font(name="DejaVu Sans", bold=True, size=11, color=palette["ink"])
            target.border = Border(bottom=Side(style="thin", color=palette["line-light"]))
        result.row_dimensions[row].height = 34
        result.freeze_panes = f"A{row + 1}"
        result.print_title_rows = f"1:{row}"

    summary = sheet("Сводка", [40, 74])
    metadata = [("Бренд", report["brand"]["name"]), ("Период", report["period"]["label"]), ("AI-модели", ", ".join(item["name"] for item in report["providers"])), ("Сформирован (МСК)", _generated_at(report).replace(tzinfo=None))]
    for row, (label, value) in enumerate(metadata, 3):
        write(summary, row, 1, label)
        write(summary, row, 2, value, "yyyy-mm-dd hh:mm" if isinstance(value, datetime) else None)
        summary.row_dimensions[row].height = max(28, 17 * math.ceil(len(str(value)) / 58))
    header(summary, 8, ["Показатель", "Значение"])
    for row, (key, label) in enumerate(METRIC_LABELS.items(), 9):
        value = report["metrics"][key]
        write(summary, row, 1, label)
        write(summary, row, 2, value / 100 if value is not None and key != "position" else value, "0%" if key != "position" else "0.00")
        summary.row_dimensions[row].height = 25
    header(summary, 15, ["Объём выборки", "Количество"])
    for row, (key, label) in enumerate(COVERAGE_LABELS.items(), 16):
        write(summary, row, 1, label)
        write(summary, row, 2, report["coverage"].get(key, 0), "#,##0")
        summary.row_dimensions[row].height = 26
    summary.freeze_panes = "B9"
    summary.print_title_rows = "1:8"

    models = sheet("AI-модели", [30, 18, 22, 22])
    header(models, 3, ["Модель", "Ответы", "Упоминания", "Видимость"])
    for index, row in enumerate(report["models"], 4):
        for column, value in enumerate([row["name"], row["answers"], row["mentions"], row["visibility"] / 100 if row["visibility"] is not None else None], 1):
            write(models, index, column, value, "0%" if column == 4 else "#,##0" if column > 1 else None)
        models.row_dimensions[index].height = 26

    competitors = sheet("Конкуренты", [64, 18, 22, 22])
    write(competitors, 3, 1, "Активный бренд и до пяти конкурентов по доле голоса.")
    competitors.merge_cells("A3:D3")
    header(competitors, 5, ["Бренд", "SoV", "Видимость", "Ср. позиция"])
    for index, row in enumerate(report["brands"], 6):
        for column, value in enumerate([row["name"] + (" · ваш бренд" if row["own"] else ""), row["sov"] / 100 if row["sov"] is not None else None, row["visibility"] / 100, row["position"]], 1):
            target = write(competitors, index, column, value, "0%" if column in (2, 3) else "0.00" if column == 4 else None)
            if row["own"]:
                target.fill = PatternFill("solid", fgColor=palette["wash-light"])
        competitors.row_dimensions[index].height = max(26, 17 * math.ceil((len(row["name"]) + 12) / 52))

    sources = sheet("Источники", [64, 26, 24])
    header(sources, 3, ["Домен", "Ответы с источником", "Доля ответов"])
    for index, row in enumerate(report["sources"], 4):
        for column, value in enumerate([row["name"], row["answers"], row["share"] / 100], 1):
            write(sources, index, column, value, "0%" if column == 3 else "#,##0" if column == 2 else None)
        sources.row_dimensions[index].height = max(26, 17 * math.ceil(len(row["name"]) / 52))
    if not report["sources"]:
        write(sources, 4, 1, "В выбранных ответах нет источников.")

    method = sheet("Методика", [112])
    for index, text in enumerate(report["methodology"], 3):
        write(method, index, 1, text)
        method.row_dimensions[index].height = 18 * (math.ceil(len(text) / 94) + 1)
    for result in workbook:
        result.print_options.horizontalCentered = True
        result.print_area = result.dimensions
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


def export_report(report, format):
    if format == "pdf":
        return _pdf(report)
    if format == "xlsx":
        return _xlsx(report)
    raise ValueError("Неизвестный формат отчёта")
