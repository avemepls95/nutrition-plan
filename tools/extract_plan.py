"""Извлекает план питания из PDF в docs/plan.js.

Запуск: python tools/extract_plan.py <путь к plan_pitaniya_nedeli_8-23.pdf>
Нужен pdfplumber (pip install pdfplumber).
"""
import datetime
import json
import re
import sys
from pathlib import Path

import pdfplumber

OUT = Path(__file__).resolve().parent.parent / "docs" / "plan.js"

BASE_PAGE = 2
WEEK_PAGES = range(3, 19)
RECIPE_PAGES = (19, 20, 21)
FIRST_MONDAY = datetime.date(2026, 10, 12)
FIRST_WEEK = 8

HEBREW_RUN = re.compile(r"[\u0590-\u05FF]+(?:\s+[\u0590-\u05FF]+)*")
WEEK_TITLE = re.compile(r"^Неделя (\d+) · (.+)$")
MENU = re.compile(r"^Меню ([A-Z])\. (.+?) \* Время")
TOTAL = re.compile(r"≈(\d+)\s*ккал\s*Вода:\s*(\d+) стакан\w*\s*\(≈([\d,]+) л\)")
MEAL_KCAL = re.compile(r"^[A-Z]{1,2}\d · ≈(\d+) ккал")
RECIPE_HEAD = re.compile(r"^([A-Z]\d) · (.+) — ≈(\d+) ккал$")
SAUCE_HEAD = re.compile(r"^(SA\d) · (.+) — ≈(\d+) ккал · (.+)$")
GROUPS = ("Завтраки", "Обеды", "Ужины", "Десерты и кино", "Перекусы и вечер", "Соусы")
CONTINUATION = re.compile(r"^[a-zа-яё\d]")
COFFEE_KCAL = 24
TEXT_LEFT = 55
PARAGRAPH_END = 460


def clean(text):
    """pdfplumber отдаёт иврит в визуальном порядке, переворачиваем его в логический."""
    text = " ".join((text or "").split())
    return HEBREW_RUN.sub(lambda m: m.group(0)[::-1], text)


def parse_total(cell):
    m = TOTAL.search(clean(cell))
    return int(m.group(1)), int(m.group(2))


def parse_load(cell):
    parts = [clean(p) for p in cell.split("\n") if p.strip()]
    if parts[0] == "Отдых":
        return {"load": "Отдых", "note": " ".join(parts[1:])}
    return {"load": parts[0], "time": parts[1]}


def parse_days(table, texts):
    days = []
    for row in table[1:]:
        if row[0]:
            day = {"head": clean(row[0]), **parse_load(row[1]), "meals": []}
            day["kcal"], day["water"] = parse_total(row[4])
            days.append(day)
        text = clean(row[3])
        if text not in texts:
            texts.append(text)
        days[-1]["meals"].append([clean(row[2]), texts.index(text)])
    return days


def check_kcal(days, texts, label):
    """ккал блюд в PDF округлены, поэтому итог дня может отличаться от суммы на 1."""
    for day in days:
        meals = sum(int(MEAL_KCAL.match(texts[i]).group(1)) for _, i in day["meals"])
        if abs(meals + COFFEE_KCAL - day["kcal"]) > 1:
            print(f"  {label} {day.get('date') or day.get('name')}: блюда {meals} + кофе {COFFEE_KCAL} != {day['kcal']}")


def extract_weeks(pdf, texts):
    weeks = []
    for pi in WEEK_PAGES:
        page = pdf.pages[pi]
        lines = page.extract_text().split("\n")
        n, period = WEEK_TITLE.match(lines[0]).groups()
        menu = MENU.match(lines[1]).group(1)
        days = parse_days(page.extract_tables()[0], texts)
        monday = FIRST_MONDAY + datetime.timedelta(weeks=int(n) - FIRST_WEEK)
        for offset, day in enumerate(days):
            date = monday + datetime.timedelta(days=offset)
            if not day["head"].startswith(f"{date.day} "):
                raise ValueError(f"Неделя {n}: ожидалось {date}, в таблице «{day['head']}»")
            day["date"] = date.isoformat()
            del day["head"]
        weeks.append({"n": int(n), "period": period, "menu": menu, "days": days})
    return weeks


def extract_base(pdf, texts):
    page = pdf.pages[BASE_PAGE]
    lines = page.extract_text().split("\n")
    days = parse_days(page.extract_tables()[0], texts)
    for day in days:
        day["name"] = day.pop("head")
    note = lines[1].split(" * Время")[0]
    return {"note": note, "days": days}


def snack_items(pdf):
    items = []
    for pi in RECIPE_PAGES:
        for table in pdf.pages[pi].extract_tables():
            for code, what, kcal in table:
                if code == "Код":
                    continue
                name, comp = clean(what).split(": ", 1)
                item = {"code": code, "name": name, "kcal": int(kcal), "comp": comp, "steps": []}
                if " — " in comp:
                    comp, when = comp.split(" — ", 1)
                    item["comp"] = comp
                    item["steps"] = [when[0].upper() + when[1:] + "."]
                items.append(item)
    return items


def extract_recipes(pdf):
    """Абзацы восстанавливаются по правому краю строки: короткая строка закрывает абзац.
    Состав может кончаться у самого края, поэтому он продолжается, только если следующая
    строка начинается со строчной буквы или цифры.
    """
    lines = []
    for pi in RECIPE_PAGES:
        for ln in pdf.pages[pi].extract_text_lines():
            if ln["x0"] < TEXT_LEFT:
                lines.append((clean(ln["text"]), ln["x1"]))

    intro, groups, group, item = [], [], None, None
    paragraph = []

    def flush():
        if not paragraph:
            return
        text = " ".join(paragraph)
        paragraph.clear()
        if item is None or text.startswith("Грибной порошок:"):
            (group["notes"] if group else intro).append(text)
        elif text.startswith("Состав: "):
            item["comp"] = text[len("Состав: "):]
        else:
            item["steps"].append(text)

    for i, (text, x1) in enumerate(lines):
        if text == "Рецепты":
            continue
        head = RECIPE_HEAD.match(text) or SAUCE_HEAD.match(text)
        if text in GROUPS or head or text.startswith("Состав: "):
            flush()
        if text in GROUPS:
            group, item = {"title": text, "notes": [], "items": []}, None
            groups.append(group)
            if text == "Перекусы и вечер":
                group["items"] = snack_items(pdf)
            continue
        if head:
            item = {"code": head.group(1), "name": head.group(2), "kcal": int(head.group(3)), "comp": "", "steps": []}
            if head.re is SAUCE_HEAD:
                item["uses"] = head.group(4)
            group["items"].append(item)
            continue
        paragraph.append(text)
        next_text = lines[i + 1][0] if i + 1 < len(lines) else ""
        in_comp = paragraph[0].startswith("Состав: ")
        if x1 < PARAGRAPH_END or (in_comp and not CONTINUATION.match(next_text)):
            flush()
    flush()
    return {"intro": " ".join(intro), "groups": groups}


def main():
    if len(sys.argv) != 2:
        sys.exit("Запуск: python tools/extract_plan.py <путь к plan_pitaniya_nedeli_8-23.pdf>")
    texts = []
    with pdfplumber.open(sys.argv[1]) as pdf:
        weeks = extract_weeks(pdf, texts)
        base = extract_base(pdf, texts)
        recipes = extract_recipes(pdf)

    print("Сверка ккал (сумма блюд + кофе = итог дня):")
    for week in weeks:
        check_kcal(week["days"], texts, f"неделя {week['n']}")
    check_kcal(base["days"], texts, "базовая")

    plan = {"texts": texts, "weeks": weeks, "base": base, "recipes": recipes}
    body = json.dumps(plan, ensure_ascii=False, separators=(",", ":"))
    OUT.write_text(
        "// Сгенерировано tools/extract_plan.py из plan_pitaniya_nedeli_8-23.pdf, руками не править.\n"
        f"window.PLAN = {body};\n",
        encoding="utf-8",
        newline="\n",
    )
    days = sum(len(w["days"]) for w in weeks)
    recipes_count = sum(len(g["items"]) for g in recipes["groups"])
    print(f"Недель: {len(weeks)}, дней: {days}, уникальных приёмов пищи: {len(texts)}, рецептов: {recipes_count}")
    print(f"Записано: {OUT}")


if __name__ == "__main__":
    main()
