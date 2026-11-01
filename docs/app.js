(() => {
  "use strict";

  const PLAN = window.PLAN;
  const FOODS = window.FOODS;
  const EDITS_KEY = "np.v1.edits";
  const WEIGHTS_KEY = "np.v1.weights";
  const KCAL_KEY = "np.v1.kcal";
  const THEME_KEY = "np.v1.theme";

  const MON_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const WD = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
  const WD_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const LABELS = { B: "завтрак", M: "обед", S: "перекус", D: "ужин", E: "вечер", F: "десерт", K: "кино" };
  const PRE_TRAINING = new Set(["S4", "F4"]);
  // По справке плана «Кофе × 2 ≈24 ккал».
  const COFFEE_KCAL = 12;
  const BAR_COLOR = { light: "#2b5b5e", dark: "#16302f" };

  const CODE_RE = /^\s*([A-Z]{1,2}\d{1,2})\s*·\s*/;
  // В правке ккал записаны по калорийности по умолчанию. Если ккал вписаны руками меньше, чем дают
  // продукты со своей калорийностью, число в правке меньше нуля.
  const KCAL_RE = /^≈?\s*(-?\d+)\s*ккал\.?\s*/;
  // Объём молока и жирность в правках могут быть любыми.
  const COFFEE_RE = /\s*Кофе\s*\+\s*(\d+(?:[.,]\d+)?)\s*мл\s+молока(?:\s+(\d+(?:[.,]\d+)?)\s*%)?\.?/giu;
  // В тексте из плана после состава идут пояснения с заглавной буквы: «За 1–1,5 часа до тренировки.»
  const NOTE_RE = /\.\s+(?=[А-ЯЁA-Z])/;
  const HEBREW_RE = /\p{Script=Hebrew}+(?:\s+\p{Script=Hebrew}+)*/gu;
  const UNIT_RE = /(\d)\s+(г|мл|шт\.|ч\. л\.|ст\. л\.|кг|л)(?=[\s.,;)]|$)/g;

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const icon = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
  const plural = (n, one, few, many) => {
    const t = n % 100;
    if (t >= 11 && t <= 14) return many;
    return n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many;
  };
  // Число для поля ввода: «12,5», без «½». Количество хранится с той же точностью, что и в тексте состава.
  const round1 = (n) => Math.round(n * 10) / 10;
  const numText = (n) => String(round1(n)).replace(".", ",");
  const readNum = (s) => {
    const v = Number(String(s).trim().replace(",", "."));
    return String(s).trim() && Number.isFinite(v) && v >= 0 ? v : null;
  };

  function load(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || {};
    } catch {
      return {};
    }
  }

  function store(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  const edits = Object.fromEntries(Object.entries(load(EDITS_KEY)).filter(([, e]) => typeof e?.t === "string"));
  const weights = load(WEIGHTS_KEY);

  /* Тема */

  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  let themePref = (() => {
    const v = load(THEME_KEY);
    return v === "dark" || v === "auto" ? v : "light";
  })();

  function applyTheme() {
    const dark = themePref === "dark" || (themePref === "auto" && darkQuery.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    $('meta[name="theme-color"]').content = BAR_COLOR[dark ? "dark" : "light"];
    for (const b of document.querySelectorAll("[data-theme-set]")) b.setAttribute("aria-pressed", String(b.dataset.themeSet === themePref));
  }

  darkQuery.addEventListener?.("change", applyTheme);

  /* Даты */

  const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dateOf = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const shift = (iso, n) => {
    const d = dateOf(iso);
    d.setDate(d.getDate() + n);
    return isoOf(d);
  };
  let today = isoOf(new Date());

  /* Данные плана */

  const recipes = new Map();
  for (const group of PLAN.recipes.groups) for (const item of group.items) recipes.set(item.code, item);
  const mealCodes = [...recipes.values()].filter((r) => !r.code.startsWith("SA"));
  const planTexts = new Set(PLAN.texts);

  const meals = new Map();
  const days = [];
  const dayById = new Map();

  function makeDay(src, id, extra) {
    const day = { ...src, ...extra, id };
    day.meals = src.meals.map(([time, textIndex], index) => {
      const meal = { key: `${id}#${index}`, day, time, text: PLAN.texts[textIndex] };
      meals.set(meal.key, meal);
      return meal;
    });
    dayById.set(id, day);
    return day;
  }

  for (const week of PLAN.weeks) {
    week.items = week.days.map((d) => makeDay(d, d.date, { iso: d.date, week }));
    days.push(...week.items);
  }
  const baseDays = PLAN.base.days.map((d, i) => makeDay(d, `base${i}`, { iso: null }));

  const current = (meal) => (edits[meal.key] ? edits[meal.key].t : meal.text);
  // Блюдо, переехавшее при обмене без изменений, показывается как блюдо плана.
  const isPlain = (meal) => !edits[meal.key] || planTexts.has(edits[meal.key].t);

  // Текст приёма пищи: «B1 · ≈340 ккал. состав». Код и ккал в начале необязательны.
  function splitHead(text) {
    let rest = text.trim();
    let code = null;
    let kcal = null;
    const c = rest.match(CODE_RE);
    if (c) {
      code = c[1];
      rest = rest.slice(c[0].length);
    }
    const k = rest.match(KCAL_RE);
    if (k) {
      kcal = Number(k[1]);
      rest = rest.slice(k[0].length);
    }
    return { code, kcal, rest };
  }

  function compose(code, kcal, comp) {
    const body = comp.replace(/\s*\n\s*/g, " ").trim();
    if (!body) return "";
    return `${code ? `${code} · ` : ""}${kcal ? `≈${kcal} ккал. ` : ""}${body}`;
  }

  function cutNote(rest) {
    const cut = rest.search(NOTE_RE);
    return cut < 0 ? { body: rest, note: "" } : { body: rest.slice(0, cut + 1), note: rest.slice(cut + 1).trim() };
  }

  // Пояснения из плана («Десерт-вечер: …») уходят из строки в раскрытую часть и после правки количества.
  const planNotes = new Set(PLAN.texts.map((t) => cutNote(splitHead(t).rest.replace(COFFEE_RE, "").trim()).note).filter(Boolean));

  function parse(text, plain) {
    const { code, kcal, rest: head } = splitHead(text);
    const coffee = [...head.matchAll(COFFEE_RE)].map((m) => ({ ml: m[1], fat: m[2] || "" }));
    const rest = head.replace(COFFEE_RE, "").trim();
    const split = cutNote(rest);
    if (plain || planNotes.has(split.note)) return { code, kcal, coffee, ...split };
    return { code, kcal, coffee, body: rest, note: "" };
  }

  const copyLine = (text) => text.replace(COFFEE_RE, "").replace(/\s{2,}/g, " ").trim();

  function labelOf(code) {
    if (!code) return "приём пищи";
    if (PRE_TRAINING.has(code)) return "перекус перед тренировкой";
    return LABELS[code[0]] || "приём пищи";
  }

  function slotOf(code) {
    if (!code) return null;
    if (PRE_TRAINING.has(code)) return "pre";
    return "EFK".includes(code[0]) ? "evening" : code[0];
  }

  const planKcal = (meal) => splitHead(meal.text).kcal || 0;

  // Приём пищи с учётом своей калорийности продуктов в этот день. Блюдо из плана держит ккал, граммовка
  // продуктов подстраивается. Правка и блюдо с «Менять ккал» держат граммовку, пересчитываются ккал.
  // edit: правка приёма пищи (по умолчанию сохранённая), null для блюда из плана.
  // text: что показывать и копировать. kcal: ккал для итога дня, у правки без числа как в плане, у убранного 0.
  function shownOf(meal, edit = edits[meal.key]) {
    const text = edit ? edit.t : meal.text;
    if (!text.trim()) return { text: "", kcal: 0 };
    const keepKcal = (!edit || planTexts.has(edit.t)) && edit?.mode !== "kcal";
    const { code, kcal, rest } = splitHead(text);
    const parts = FOODS.parseBody(rest);
    const { qtys, extra } = FOODS.adapt(parts, kcalTable(meal.day.iso), defaultKcal, keepKcal);
    const total = (k) => Math.max(0, k + Math.round(extra));
    return {
      text: compose(code, kcal == null ? "" : String(total(kcal)), FOODS.compose(parts, qtys)),
      kcal: total(kcal ?? planKcal(meal)),
    };
  }

  const cupsKcal = (text) => COFFEE_KCAL * (text.match(COFFEE_RE) || []).length;

  // Итог из PDF уже включает кофе, поэтому к нему прибавляется только разница с планом.
  // editOf: правка приёма пищи, по умолчанию сохранённая. Редактор подставляет ещё не сохранённую.
  const dayTotal = (day, editOf = (m) => edits[m.key]) => day.kcal + day.meals.reduce((sum, m) => {
    const edit = editOf(m);
    return sum + shownOf(m, edit).kcal + cupsKcal(edit ? edit.t : m.text) - planKcal(m) - cupsKcal(m.text);
  }, 0);

  // Итог дня без правок: план, пересчитанный под свою калорийность продуктов.
  const planTotal = (day) => dayTotal(day, () => null);

  function relLabel(iso) {
    if (iso === today) return "сегодня";
    if (iso === shift(today, -1)) return "вчера";
    if (iso === shift(today, 1)) return "завтра";
    return "";
  }

  const dateShort = (iso) => {
    const d = dateOf(iso);
    return `${d.getDate()} ${MON_SHORT[d.getMonth()]}`;
  };

  function dayShort(day) {
    if (!day.iso) return cap(day.name);
    const d = dateOf(day.iso);
    return `${WD_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]}`;
  }

  function nextMeal() {
    const day = dayById.get(today);
    if (!day) return null;
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    return day.meals.find((meal) => {
      const [h, m] = meal.time.split("/").pop().split(":").map(Number);
      return h * 60 + m > minutes;
    }) || null;
  }

  /* Калорийность продуктов */

  const UNIT_LABEL = { г: "на 100 г", мл: "на 100 мл", "шт.": "за 1 шт.", пачка: "за пачку" };

  const defaultKcal = new Map(FOODS.DEFAULTS.map(([key, name, unit, kcal, note]) => [FOODS.keyOf(key), { name, unit, kcal, def: kcal, note }]));

  // Своя калорийность продуктов: { ключ: { n: название, u: единица, h: история для FOODS.valueAt } }.
  // Значение действует с дня, когда его вписали, поэтому прошедшие дни не меняются.
  const foodKcal = {};
  let datedNow = false;
  for (const [id, v] of Object.entries(load(KCAL_KEY))) {
    if (Array.isArray(v?.h)) foodKcal[id] = v;
    else if (Number.isFinite(v?.k)) {
      // У значения без даты днём начала становится день загрузки, поэтому прошедшие дни остаются как были.
      foodKcal[id] = { n: v.n, u: v.u, h: [[today, v.k]] };
      datedNow = true;
    }
  }
  if (datedNow) store(KCAL_KEY, foodKcal);

  // Калорийность продуктов в этот день (по умолчанию сегодня): из foods.js и своя. Ключ из FOODS.foodId.
  function kcalTable(iso) {
    const table = new Map([...defaultKcal].map(([id, entry]) => [id, { ...entry }]));
    for (const [id, v] of Object.entries(foodKcal)) {
      const k = FOODS.valueAt(v.h, iso || today);
      if (k === undefined) continue;
      const entry = table.get(id);
      if (entry) entry.kcal = k ?? entry.def;
      else table.set(id, { name: v.n || id.split("|")[0], unit: v.u || "г", kcal: k, def: null });
    }
    return table;
  }

  // С какого дня действует своя калорийность продукта, которая видна сегодня.
  const kcalSince = (id) => foodKcal[id]?.h.filter(([d]) => d <= today).pop()?.[0];

  function setFoodKcal(id, name, unit, value, from = today) {
    const hist = FOODS.withValue(foodKcal[id]?.h || [], from, value === defaultKcal.get(id)?.kcal ? null : value);
    if (hist.length) foodKcal[id] = { n: name, u: unit, h: hist };
    else delete foodKcal[id];
    if (!store(KCAL_KEY, foodKcal)) toast("Не получилось сохранить калорийность на устройстве");
  }

  /* Разметка */

  let nextKey = null;
  const expanded = new Set();
  const withHebrew = (s) => esc(s).replace(HEBREW_RE, (m) => `<bdi lang="he" dir="rtl">${m}</bdi>`);
  // «100 г» не разрывается на две строки.
  const nbspUnits = (html) => html.replace(UNIT_RE, (_, n, unit) => `${n}\xa0${unit.replace(". ", ".\xa0")}`);

  // Кофе стоит под составом отдельной плашкой, чтобы было видно, сколько молока.
  const coffeeHtml = (c) => `<span class="coffee">${icon("i-cup")}<span>кофе + <b>${esc(c.ml)}\xa0мл</b> молока${c.fat ? ` ${esc(c.fat)}%` : ""}</span></span>`;

  function mealHtml(meal) {
    const edit = edits[meal.key];
    const shown = shownOf(meal);
    const text = shown.text;
    const empty = !text.trim();
    const plain = isPlain(meal);
    const p = parse(text, plain);
    const recipe = p.code && recipes.get(p.code);
    const [t1, t2] = meal.time.split("/");
    const cls = ["meal"];
    if (edit) cls.push("is-edited");
    if (meal.key === nextKey) cls.push("is-next");

    let body = p.code ? `<span class="m-sku">${esc(p.code)}</span> ` : "";
    body += empty ? `<span class="m-empty">убрано</span>` : nbspUnits(esc(p.body));
    const source = edit?.f && meals.get(edit.f);
    if (edit) body += `<span class="m-from">${source ? `из ${esc(dayShort(source.day))}` : "правка"}</span>`;
    const name = empty ? "убрано" : plain && recipe ? recipe.name : p.body;

    let price = "";
    const plan = edit && splitHead(meal.text).kcal != null ? shownOf(meal, null).kcal : null;
    if (plan != null && shown.kcal !== plan) {
      price += `<s class="m-was"><span class="visually-hidden">в плане </span>${plan}</s>`;
    }
    if (p.kcal != null && !empty) price += `<b>${p.kcal}</b><span class="visually-hidden"> ккал</span>`;
    if (price) price = `<span class="m-kcal">${price}</span>`;

    return `<li class="${cls.join(" ")}" data-key="${esc(meal.key)}">
      <button class="meal-row" type="button" aria-expanded="false">
        <span class="m-time"><span>${esc(t1)}</span>${t2 ? `<span class="alt">${esc(t2)}</span>` : ""}</span>
        <span class="m-text"><span class="m-body">${body}</span><span class="m-name">${esc(name)}</span><span class="m-extra">${p.coffee.map(coffeeHtml).join("")}</span></span>
        <span class="m-price">${price}</span>
      </button>
    </li>`;
  }

  function dayHtml(day) {
    const isBase = !day.iso;
    const isToday = day.iso === today;
    const past = !isBase && day.iso < today;
    const brief = past && !expanded.has(day.id);
    const cls = ["day"];
    if (isToday) cls.push("is-today");
    if (brief) cls.push("is-brief");

    let date = "";
    let title;
    if (isBase) {
      title = `<span>${esc(day.name)}</span>`;
    } else {
      const d = dateOf(day.iso);
      const rel = relLabel(day.iso);
      date = `<span class="d-date" aria-hidden="true"><span class="d-num">${d.getDate()}</span><span class="d-mon">${MON_SHORT[d.getMonth()]}</span></span>`;
      title = rel ? `<span>${cap(rel)}</span><span class="d-wd">${WD_SHORT[d.getDay()]}</span>` : `<span>${cap(WD[d.getDay()])}</span>`;
    }
    if (past) title += `<svg class="d-more" aria-hidden="true"><use href="#i-down"/></svg>`;

    const load = day.load === "Отдых"
      ? `<span>Отдых${day.note ? ` · ${withHebrew(day.note)}` : ""}</span>`
      : `<span class="badge">${esc(day.load)} ${esc(day.time)}</span>`;
    const water = `<span class="d-water">${icon("i-drop")}${day.water} ${plural(day.water, "стакан", "стакана", "стаканов")}<span class="visually-hidden"> воды</span></span>`;

    const total = dayTotal(day);
    const plan = planTotal(day);
    const changed = total !== plan;
    const what = isBase ? day.name.toLowerCase() : dayShort(day);
    // Прошедший день сворачивается нажатием на любое место заголовка: кнопка растянута под ним.
    const toggle = past ? `<button class="d-toggle" type="button" data-toggle aria-expanded="${!brief}" aria-label="${esc(cap(what))}: состав"></button>` : "";

    return `<section class="${cls.join(" ")}" data-day="${esc(day.id)}" aria-label="${esc(cap(what))}">
      <header class="day-head${isBase ? " no-date" : ""}">
        ${toggle}${date}
        <span class="d-title">${title}</span>
        <span class="d-total${changed ? " is-changed" : ""}">${changed ? `<s class="d-was"><span class="visually-hidden">в плане </span>${plan}</s>` : ""}<b>${total}</b><small>ккал</small></span>
        <button class="copy" type="button" aria-label="Скопировать состав за день: ${esc(what)}">${icon("i-copy")}</button>
        <span class="d-sub">${load}${water}</span>
      </header>
      <ol class="meals">${day.meals.map(mealHtml).join("")}</ol>
    </section>`;
  }

  function weekHtml(week) {
    return `<div class="wk" id="w${week.n}">
      <h2 class="wk-t">Неделя ${week.n} · меню ${esc(week.menu)}</h2>
      <label class="wk-w">Вес в пн <input type="text" inputmode="decimal" enterkeyhint="done" maxlength="5" autocomplete="off" data-week="${week.n}" value="${esc(weights[week.n] || "")}" placeholder="—" aria-label="Вес в понедельник утром, неделя ${week.n}"> кг</label>
    </div>`;
  }

  function panelHtml(meal) {
    const edit = edits[meal.key];
    const text = current(meal);
    const p = parse(text, isPlain(meal));
    const recipe = p.code && recipes.get(p.code);
    const parts = [];
    if (recipe) parts.push(`<p class="p-title">${esc(recipe.name)}</p>`);
    if (p.note) parts.push(`<p class="p-note">${esc(p.note)}</p>`);
    if (recipe) for (const step of recipe.steps) parts.push(`<p>${esc(step)}</p>`);
    if (edit || shownOf(meal).text !== meal.text) parts.push(`<p class="p-orig"><b>В плане</b>${esc(meal.text)}</p>`);
    const actions = [`<button class="btn" type="button" data-act="edit">Изменить</button>`];
    if (meal.day.iso) actions.push(`<button class="btn" type="button" data-act="swap">Поменять</button>`);
    if (text.trim()) actions.push(`<button class="btn" type="button" data-act="copy">${icon("i-copy")}Копировать</button>`);
    if (edit) actions.push(`<button class="btn" type="button" data-act="reset">Как в плане</button>`);
    return `<div class="meal-panel">${parts.join("")}<div class="p-actions">${actions.join("")}</div></div>`;
  }

  // Блюдо из плана, от которого считается приём пищи: свой текст плана, переехавший при обмене
  // или тот, от которого сделана правка.
  function planOf(meal) {
    const edit = edits[meal.key];
    if (edit && planTexts.has(edit.t)) return edit.t;
    return meals.get(edit?.f)?.text || meal.text;
  }

  // Блюдо из плана в режиме переключателя: "grams" с граммовкой под свою калорийность, "kcal" с граммовкой из плана.
  const planView = (meal, plan, mode) => shownOf(meal, mode === "kcal" ? { t: plan, mode } : { t: plan });
  const modeOf = (meal) => (edits[meal.key]?.mode === "kcal" ? "kcal" : "grams");

  // У убранного приёма пищи редактор открывается с блюдом из плана.
  const editSource = (meal) => (current(meal).trim() ? shownOf(meal).text : planView(meal, planOf(meal), "grams").text);

  function editorHtml(meal) {
    const { code, kcal, rest } = splitHead(editSource(meal));
    const options = mealCodes.some((r) => r.code === code) || !code ? mealCodes : [{ code, name: "" }, ...mealCodes];
    const select = options
      .map((r) => `<option value="${esc(r.code)}"${r.code === code ? " selected" : ""}>${esc(r.code)}${r.name ? ` · ${esc(r.name)}` : ""}</option>`)
      .join("");
    // Переключатель есть у блюда из плана, если своя калорийность меняет граммовку его продуктов.
    let modes = "";
    if (isPlain(meal) || !current(meal).trim()) {
      const parts = FOODS.parseBody(splitHead(planOf(meal)).rest);
      const { qtys } = FOODS.adapt(parts, kcalTable(meal.day.iso), defaultKcal, true);
      const names = parts.filter((p, i) => qtys[i] !== undefined && qtys[i] !== p.item.qty).map((p) => p.item.name);
      const mode = modeOf(meal);
      if (names.length) modes = `<div class="ed-mode">
        <p class="ed-label">Своя калорийность: ${esc(names.join(", "))}</p>
        <div class="seg" role="group" aria-label="Своя калорийность продуктов">
          <button type="button" data-mode="grams" aria-pressed="${mode === "grams"}">Менять граммовку</button>
          <button type="button" data-mode="kcal" aria-pressed="${mode === "kcal"}">Менять ккал</button>
        </div>
      </div>`;
    }
    return `<div class="meal-panel editor">
      <div class="ed-fields">
        <label class="ed-field ed-code">Блюдо<select name="code"><option value="">без кода</option>${select}</select></label>
        <label class="ed-field">Ккал<input name="kcal" value="${kcal ?? ""}" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" enterkeyhint="done"></label>
      </div>
      <p class="ed-day" aria-live="polite"></p>
      ${modes}
      <ul class="ed-items" aria-label="Количество продуктов"></ul>
      <div class="ed-missing" hidden></div>
      <label class="ed-label" for="comp-${esc(meal.key)}">Состав</label>
      <textarea id="comp-${esc(meal.key)}" name="comp" rows="3" enterkeyhint="done">${esc(rest)}</textarea>
      <div class="p-actions">
        <button class="btn primary" type="button" data-act="save">Сохранить</button>
        <button class="btn" type="button" data-act="cancel">Отмена</button>
      </div>
    </div>`;
  }

  // Правка, которую сохранит редактор: { t, mode }. Если код, ккал и состав совпали с блюдом из плана,
  // приём пищи остаётся блюдом из плана, с граммовкой под свою калорийность или из плана («Менять ккал»).
  function editorEntry(li) {
    const meal = meals.get(ed.key);
    const code = $("[name=code]", li).value;
    const kcal = $("[name=kcal]", li).value.replace(/\D/g, "");
    const comp = $("[name=comp]", li).value;
    const text = compose(code, kcal, comp);
    const grams = planView(meal, ed.plan, "grams").text;
    const plan = planView(meal, ed.plan, "kcal").text;
    if (text === grams && (ed.mode === "grams" || text !== plan)) return { t: ed.plan };
    if (text === plan) return { t: ed.plan, mode: "kcal" };
    const { extra } = FOODS.adapt(FOODS.parseBody(comp), kcalTable(meal.day.iso), defaultKcal, false);
    return { t: compose(code, kcal && String(Number(kcal) - Math.round(extra)), comp) };
  }

  /* Количество продуктов в редакторе */

  // Открытый редактор: части состава, новое количество по номеру части, точка отсчёта для пересчёта ккал,
  // блюдо из плана и режим переключателя.
  let ed = null;

  function startEditor(li, meal) {
    const parts = FOODS.parseBody($("[name=comp]", li).value);
    const { kcal } = splitHead(editSource(meal));
    ed = { key: meal.key, li, parts, qtys: [], base: { kcal, parts }, plan: planOf(meal), mode: modeOf(meal) };
    // Если ккал правки получены пересчётом от блюда из плана, считаем от него же: тогда возврат к граммовкам
    // плана даёт ровно ккал плана, без накопленного округления.
    if (!isPlain(meal) && current(meal).trim()) {
      const table = kcalTable(meal.day.iso);
      for (const m of ["grams", "kcal"]) {
        const head = splitHead(planView(meal, ed.plan, m).text);
        const viewParts = FOODS.parseBody(head.rest);
        const d = FOODS.delta(viewParts, currentItems(), table);
        if (head.kcal != null && !d.missing.length && Math.max(0, Math.round(head.kcal + d.kcal)) === kcal) {
          ed.base = { kcal: head.kcal, parts: viewParts };
          break;
        }
      }
    }
    $(".ed-items", li).innerHTML = itemsHtml();
    refreshEditor();
    ed.initial = JSON.stringify(editorEntry(li));
  }

  // Переключатель «Менять граммовку / Менять ккал» открывает блюдо из плана в выбранном режиме.
  function setMode(mode) {
    const view = splitHead(planView(meals.get(ed.key), ed.plan, mode).text);
    ed.mode = mode;
    for (const b of ed.li.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    $("[name=code]", ed.li).value = view.code || "";
    $("[name=kcal]", ed.li).value = view.kcal ?? "";
    const ta = $("[name=comp]", ed.li);
    ta.value = view.rest;
    autosize(ta);
    ed.parts = FOODS.parseBody(view.rest);
    ed.qtys = [];
    ed.base = { kcal: view.kcal, parts: ed.parts };
    $(".ed-items", ed.li).innerHTML = itemsHtml();
    refreshEditor();
  }

  const qtyOf = (i) => ed.qtys[i] ?? ed.parts[i].item.qty;
  const unitText = (item) => (item.unit === "пачка" ? "пач." : item.unitWord);

  function itemsHtml() {
    return ed.parts.map((part, i) => {
      if (!part.item) return "";
      const { name } = part.item;
      return `<li class="ed-item" data-i="${i}">
        <span class="ed-name">${esc(name)}</span>
        <span class="stepper">
          <button type="button" data-step="-1" aria-label="Меньше: ${esc(name)}">${icon("i-minus")}</button>
          <label><input value="${numText(qtyOf(i))}" inputmode="decimal" autocomplete="off" enterkeyhint="done" maxlength="6" aria-label="${esc(name)}, ${esc(part.item.unitWord)}"><span class="unit">${esc(unitText(part.item))}</span></label>
          <button type="button" data-step="1" aria-label="Больше: ${esc(name)}">${icon("i-plus")}</button>
        </span>
        <span class="ed-k"></span>
      </li>`;
    }).join("");
  }

  const currentItems = () => ed.parts.flatMap((p, i) => (p.item ? [{ item: p.item, qty: qtyOf(i) }] : []));

  // Ккал пересчитываются от точки отсчёта: сколько было у блюда и каких продуктов стало больше или меньше.
  function refreshEditor() {
    const li = ed.li;
    const meal = meals.get(ed.key);
    const table = kcalTable(meal.day.iso);
    const baseQty = new Map();
    for (const p of ed.base.parts) if (p.item) baseQty.set(p.item.key, (baseQty.get(p.item.key) || 0) + p.item.qty * p.item.factor);
    const nowQty = new Map();
    for (const { item, qty } of currentItems()) nowQty.set(item.key, (nowQty.get(item.key) || 0) + qty * item.factor);

    for (const row of li.querySelectorAll(".ed-item")) {
      const i = Number(row.dataset.i);
      const { item } = ed.parts[i];
      const k = FOODS.kcalOf(item.key, qtyOf(i), item.unit, item.factor, table);
      $(".ed-k", row).textContent = k === null ? "" : `${Math.round(k)}`;
      row.classList.toggle("is-changed", Math.abs((nowQty.get(item.key) || 0) - (baseQty.get(item.key) || 0)) > 1e-9);
    }

    // Продукту без калорийности её можно вписать прямо здесь. Пока поле в фокусе, блок не перерисовывается.
    // Экран продуктов пишет калорийность с сегодняшнего дня, поэтому прошедшему приёму пищи её вписывают здесь.
    const { kcal, missing } = FOODS.delta(ed.base.parts, currentItems(), table);
    const box = $(".ed-missing", li);
    const past = meal.day.iso && meal.day.iso < today;
    if (!box.contains(document.activeElement)) {
      const items = [...new Map(missing.map((item) => [FOODS.foodId(item.key, item.unit), item])).values()];
      box.hidden = !items.length;
      box.innerHTML = items.length
        ? `<p>Нет калорийности, поэтому ккал не пересчитаны. ${past ? `Впишите её здесь, она будет действовать с ${dateShort(meal.day.iso)}.` : "Впишите её здесь или на экране продуктов."}</p>${items.map((item) => {
          const per = UNIT_LABEL[item.unit];
          return `<label><span>${esc(cap(item.name))}</span><input data-food="${esc(FOODS.foodId(item.key, item.unit))}" data-name="${esc(item.name)}" data-unit="${esc(item.unit)}" inputmode="decimal" autocomplete="off" enterkeyhint="done" maxlength="6" aria-label="${esc(cap(item.name))}, ккал ${esc(per)}"><span class="f-unit">ккал<br>${esc(per)}</span></label>`;
        }).join("")}`
        : "";
    }
    const kcalInput = $("[name=kcal]", li);
    if (!missing.length && ed.base.kcal != null && document.activeElement !== kcalInput) {
      kcalInput.value = Math.max(0, Math.round(ed.base.kcal + kcal));
    }

    const saved = dayTotal(meal.day);
    const entry = editorEntry(li);
    const total = dayTotal(meal.day, (m) => (m.key === meal.key ? entry : edits[m.key]));
    $(".ed-day", li).innerHTML = `За день <b>${total}</b> ккал${total !== saved ? `, сейчас ${saved}` : ""}`;
  }

  // Количество поменяли кнопками или в поле: состав в тексте переписывается.
  function applyQtys() {
    const ta = $("[name=comp]", ed.li);
    ta.value = FOODS.compose(ed.parts, ed.qtys);
    autosize(ta);
    refreshEditor();
  }

  function stepItem(row, dir) {
    const i = Number(row.dataset.i);
    const { item } = ed.parts[i];
    const base = ed.base.parts.find((p) => p.item && p.item.key === item.key && p.item.unit === item.unit)?.item.qty;
    ed.qtys[i] = FOODS.stepQty(item, qtyOf(i), dir, base);
    $("input", row).value = numText(ed.qtys[i]);
    applyQtys();
  }

  /* Отрисовка */

  const feed = $("#feed");
  const dayEl = (day) => document.querySelector(`[data-day="${CSS.escape(day.id)}"]`);
  const mealEl = (key) => document.querySelector(`[data-key="${CSS.escape(key)}"]`);
  const barHeight = () => $(".bar").offsetHeight;

  // Своя калорийность продуктов, по которой нарисована лента. Всю ленту перерисовываем только после её смены.
  let feedFoods = null;
  const foodsChanged = () => JSON.stringify(foodKcal) !== feedFoods;

  function renderFeed() {
    nextKey = nextMeal()?.key ?? null;
    feedFoods = JSON.stringify(foodKcal);
    feed.innerHTML = PLAN.weeks.map((week) => weekHtml(week) + week.items.map(dayHtml).join("")).join("");
    observeToday();
  }

  function renderBase() {
    $("#base-note").textContent = PLAN.base.note;
    $("#base-week").innerHTML = baseDays.map(dayHtml).join("");
  }

  function renderRecipes() {
    const groups = PLAN.recipes.groups;
    $("#recipe-jump").innerHTML = groups
      .map((g, i) => `<button type="button" data-jump="rg${i}">${esc(g.title)}</button>`)
      .join("");
    $("#recipe-list").innerHTML = `<p class="r-intro">${esc(PLAN.recipes.intro)}</p>` + groups.map((g, i) => `
      <section class="r-group" id="rg${i}">
        <h2>${esc(g.title)}</h2>
        ${g.notes.map((n) => `<p class="r-note">${esc(n)}</p>`).join("")}
        <ul class="r-list">${g.items.map((r) => `
          <li class="recipe">
            <p class="r-head"><span class="r-code">${esc(r.code)}</span><span class="r-name">${esc(r.name)}</span><span class="r-kcal">${r.kcal}<small>ккал</small></span></p>
            ${r.comp ? `<p class="r-comp">${esc(r.comp)}</p>` : ""}
            ${r.steps.map((s) => `<p class="r-steps">${esc(s)}</p>`).join("")}
            ${r.uses ? `<p class="r-uses">${esc(cap(r.uses))}</p>` : ""}
          </li>`).join("")}
        </ul>
      </section>`).join("");
  }

  // Подпись у своей калорийности продукта: «по плану 43, своё с 1 ноя».
  function wasText(id, def) {
    const since = kcalSince(id);
    return `по плану ${numText(def)}${since ? `, своё с ${dateShort(since)}` : ""}`;
  }

  // Продукты плана, свои продукты из правок и всё, чему пользователь вписал калорийность.
  function renderFoods() {
    const table = kcalTable();
    for (const edit of Object.values(edits)) {
      for (const part of FOODS.parseBody(splitHead(edit.t).rest)) {
        const item = part.item;
        const id = item && FOODS.foodId(item.key, item.unit);
        if (item && !table.has(id)) table.set(id, { name: item.name, unit: item.unit, kcal: null, def: null });
      }
    }
    const rows = [...table.entries()].sort(([, a], [, b]) => a.name.localeCompare(b.name, "ru"));
    $("#food-list").innerHTML = rows.map(([key, f]) => {
      const name = cap(f.name);
      const per = UNIT_LABEL[f.unit] || UNIT_LABEL.г;
      const edited = f.def != null && f.kcal !== f.def;
      const note = f.def == null ? "свой продукт" : f.note || "";
      return `<li class="f-item${edited ? " is-edited" : ""}" data-food="${esc(key)}" data-name="${esc(f.name)}" data-unit="${esc(f.unit)}">
        <span><span class="f-name">${esc(name)}</span>${note ? `<span class="f-note f-def">${esc(note)}</span>` : ""}${f.def != null ? `<span class="f-note f-was">${esc(wasText(key, f.def))}</span>` : ""}</span>
        <span class="f-in">
          <input value="${f.kcal == null ? "" : esc(numText(f.kcal))}" placeholder="—" inputmode="decimal" autocomplete="off" enterkeyhint="done" maxlength="6" aria-label="${esc(name)}, ккал ${esc(per)}">
          <span class="f-unit">ккал<br>${esc(per)}</span>
          ${f.def != null ? `<button class="f-reset" type="button" aria-label="Вернуть ${esc(numText(f.def))}">${icon("i-undo")}</button>` : ""}
        </span>
      </li>`;
    }).join("");
  }

  function noAnim(li, fn) {
    const row = li.querySelector(".meal-row");
    row.classList.add("no-anim");
    fn();
    void row.offsetWidth;
    row.classList.remove("no-anim");
  }

  // Наклейка проявляется на новой правке и гаснет при возврате к плану.
  function animate(keys) {
    for (const key of keys) {
      const li = mealEl(key);
      if (!li) continue;
      if (edits[key]) noAnim(li, () => li.classList.remove("is-edited"));
      else noAnim(li, () => li.classList.add("is-edited"));
      requestAnimationFrame(() => li.classList.toggle("is-edited", Boolean(edits[key])));
    }
  }

  // Перерисовывает дни приёмов пищи keys, а после смены своей калорийности всю ленту и базовую неделю.
  function rerender(keys, anchorKey) {
    const anchor = anchorKey && mealEl(anchorKey);
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    const touched = new Set(keys.map((k) => meals.get(k).day));
    if (foodsChanged()) {
      renderFeed();
      renderBase();
    } else {
      for (const day of touched) {
        const el = dayEl(day);
        if (el) el.outerHTML = dayHtml(day);
      }
      if ([...touched].some((d) => d.iso === today)) observeToday();
    }
    if (anchor) {
      const after = mealEl(anchorKey);
      if (after) window.scrollBy(0, after.getBoundingClientRect().top - before);
    }
    animate(keys);
  }

  /* Правка */

  // Новая правка гасит устаревшее «Отменить» от прошлого обмена.
  function persist() {
    hideToast();
    if (store(EDITS_KEY, edits)) return true;
    toast("Не получилось сохранить правку на устройстве");
    return false;
  }

  // mode "kcal": у блюда из плана граммовка из плана, пересчитываются ккал («Менять ккал»).
  function setEdit(meal, text, from, mode) {
    const t = text.replace(/\s*\n\s*/g, " ").trim();
    if (t === meal.text && !mode) {
      delete edits[meal.key];
      return;
    }
    edits[meal.key] = from && from !== meal.key ? { t, f: from } : { t };
    if (mode) edits[meal.key].mode = mode;
  }

  const editSnapshot = (key) => JSON.stringify(edits[key] ?? null);

  let openKey = null;
  // Правка приёма пищи на момент открытия редактора (editSnapshot).
  let editStart = null;

  // Как в заметках iOS: черновик сохраняется, когда уходишь из редактора или сворачиваешь приложение.
  // force: нажата «Сохранить». Тогда сохраняется то, что видно в редакторе, даже без изменений.
  function commitEditor(force) {
    const li = openKey && mealEl(openKey);
    if (!li || !$(".editor", li)) return;
    const meal = meals.get(openKey);
    const entry = editorEntry(li);
    // Редактор открыли и закрыли без изменений: убранный приём пищи остаётся убранным, хотя в редакторе состав из плана.
    if (!force && ed && JSON.stringify(entry) === ed.initial && editSnapshot(openKey) === editStart) return;
    const before = editSnapshot(openKey);
    setEdit(meal, entry.t, edits[openKey]?.f, entry.mode);
    if (editSnapshot(openKey) !== before) persist();
  }

  function closePanel(save) {
    if (!openKey) return;
    commitEditor(save === true);
    const key = openKey;
    const li = mealEl(key);
    const changed = editStart !== null && editSnapshot(key) !== editStart;
    openKey = null;
    editStart = null;
    ed = null;
    document.body.classList.remove("is-editing");
    if (!li) return;
    li.classList.remove("is-open");
    li.querySelector(".meal-row").setAttribute("aria-expanded", "false");
    li.querySelector(".meal-panel")?.remove();
    // В редакторе могли вписать калорийность своего продукта, он бывает и в других днях.
    if (changed || foodsChanged()) rerender(changed ? [key] : [], key);
  }

  function openPanel(key, editing) {
    closePanel();
    const li = mealEl(key);
    const meal = meals.get(key);
    li.insertAdjacentHTML("beforeend", editing ? editorHtml(meal) : panelHtml(meal));
    li.classList.add("is-open");
    li.querySelector(".meal-row").setAttribute("aria-expanded", "true");
    openKey = key;
    document.body.classList.toggle("is-editing", editing);
    if (editing) {
      editStart = editSnapshot(key);
      const ta = $("textarea", li);
      autosize(ta);
      startEditor(li, meal);
      // Если в составе есть продукты с количеством, клавиатура не нужна: их меняют кнопками.
      if (!li.querySelector(".ed-item")) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }
    const rect = li.getBoundingClientRect();
    const overflow = rect.bottom - (window.innerHeight - 16);
    if (overflow > 0) window.scrollBy({ top: Math.min(overflow, rect.top - barHeight() - 8), behavior: "smooth" });
  }

  // Черновик мог уже сохраниться при сворачивании, «Отмена» возвращает правку на момент открытия.
  function cancelEdit(key) {
    mealEl(key).querySelector(".editor").remove();
    ed = null;
    const reverted = editStart !== null && editSnapshot(key) !== editStart;
    if (reverted) {
      const start = JSON.parse(editStart);
      if (start) edits[key] = start;
      else delete edits[key];
      persist();
    }
    editStart = null;
    if (reverted) rerender([key], key);
    openPanel(key, false);
  }

  function autosize(ta) {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
  }

  function resetEdit(key) {
    delete edits[key];
    persist();
    openKey = null;
    rerender([key], key);
  }

  /* Обмен приёмами пищи */

  let swapFrom = null;

  function startSwap(key) {
    closePanel();
    swapFrom = key;
    const meal = meals.get(key);
    const code = parse(current(meal)).code;
    const slot = slotOf(code);
    $("#swapbar-text").innerHTML = `<b>${esc(cap(labelOf(code)))}, ${esc(dayShort(meal.day))}.</b> Нажмите приём пищи, с которым поменять.`;
    $("#swapbar").hidden = false;
    document.body.classList.add("is-swapping");
    for (const li of feed.querySelectorAll(".meal")) {
      if (li.dataset.key === key) li.classList.add("is-source");
      else if (slot && slotOf(parse(current(meals.get(li.dataset.key))).code) === slot) li.classList.add("is-match");
    }
  }

  function endSwap() {
    if (!swapFrom) return;
    swapFrom = null;
    $("#swapbar").hidden = true;
    document.body.classList.remove("is-swapping");
    for (const li of feed.querySelectorAll(".is-source, .is-match")) li.classList.remove("is-source", "is-match");
  }

  function finishSwap(target) {
    const source = swapFrom;
    endSwap();
    if (target === source) return;
    const a = meals.get(source);
    const b = meals.get(target);
    const snapshot = { [source]: edits[source], [target]: edits[target] };
    const textA = current(a);
    const textB = current(b);
    const fromA = edits[source]?.f || source;
    const fromB = edits[target]?.f || target;
    // «Менять ккал» переезжает вместе с блюдом.
    setEdit(a, textB, fromB, snapshot[target]?.mode);
    setEdit(b, textA, fromA, snapshot[source]?.mode);
    const saved = persist();
    rerender([source, target], target);
    if (!saved) return;
    toast("Приёмы пищи поменялись местами", "Отменить", () => {
      closePanel();
      for (const [key, value] of Object.entries(snapshot)) {
        if (value) edits[key] = value;
        else delete edits[key];
      }
      persist();
      rerender([source, target], target);
    });
  }

  /* Копирование */

  async function writeClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // ниже запасной путь через выделение
      }
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  // Иконка копирования ненадолго становится галочкой.
  function markCopied(btn) {
    const use = $("use", btn);
    btn.classList.add("is-done");
    use.setAttribute("href", "#i-check");
    setTimeout(() => {
      btn.classList.remove("is-done");
      use.setAttribute("href", "#i-copy");
    }, 1600);
  }

  async function copyText(text, btn, what) {
    if (!text) return;
    if (!(await writeClipboard(text))) {
      toast("Не получилось скопировать");
      return;
    }
    markCopied(btn);
    toast(`Скопировано: ${what}`);
  }

  const copyDay = (day, btn) => copyText(day.meals.map((m) => copyLine(shownOf(m).text)).filter(Boolean).join("\n"), btn, dayShort(day));

  function copyMeal(meal, btn) {
    const text = shownOf(meal).text;
    copyText(copyLine(text), btn, `${labelOf(splitHead(text).code)}, ${dayShort(meal.day)}`);
  }

  /* Сообщения */

  let toastTimer = 0;

  function hideToast() {
    $("#toast").hidden = true;
    document.body.classList.remove("has-toast");
  }

  function toast(text, actionLabel, action) {
    const el = $("#toast");
    const btn = $("#toast-action");
    el.hidden = true;
    $("#toast-text").textContent = text;
    btn.hidden = !actionLabel;
    btn.textContent = actionLabel || "";
    btn.onclick = action ? () => { hideToast(); action(); } : null;
    void el.offsetWidth;
    el.hidden = false;
    document.body.classList.add("has-toast");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 2200);
  }

  /* Навигация по ленте */

  function homeDay() {
    if (today < days[0].iso) return days[0];
    if (today > days[days.length - 1].iso) return days[days.length - 1];
    return dayById.get(shift(today, -1)) || dayById.get(today);
  }

  let homeY = -1;

  function goHome(smooth) {
    const el = dayEl(homeDay());
    homeY = Math.round(el.getBoundingClientRect().top + window.scrollY - barHeight() - 8);
    // Прокрутка дальше двух экранов идёт без анимации.
    const near = Math.abs(homeY - window.scrollY) < window.innerHeight * 2;
    window.scrollTo({ top: homeY, behavior: smooth && near ? "smooth" : "auto" });
  }

  let todayObserver = null;

  function observeToday() {
    todayObserver?.disconnect();
    const target = dayEl(dayById.get(today) || homeDay());
    todayObserver = new IntersectionObserver(([entry]) => {
      $("#to-today").hidden = entry.isIntersecting || document.body.dataset.view !== "plan";
    }, { rootMargin: `-${barHeight()}px 0px 0px 0px` });
    todayObserver.observe(target);
  }

  const weekSelect = $("#week-select");
  let shownWeek = null;

  function periodShort(week) {
    const a = dateOf(week.items[0].iso);
    const b = dateOf(week.items[week.items.length - 1].iso);
    return a.getMonth() === b.getMonth()
      ? `${a.getDate()}–${b.getDate()} ${MON_SHORT[b.getMonth()]}`
      : `${a.getDate()} ${MON_SHORT[a.getMonth()]} – ${b.getDate()} ${MON_SHORT[b.getMonth()]}`;
  }

  function showWeek(week) {
    if (week === shownWeek) return;
    shownWeek = week;
    $("#week-n").textContent = `Неделя ${week.n}`;
    $("#week-r").textContent = periodShort(week);
    weekSelect.value = String(week.n);
  }

  function syncWeek() {
    const line = barHeight() + 80;
    let found = PLAN.weeks[0];
    for (const week of PLAN.weeks) {
      if (document.getElementById(`w${week.n}`).getBoundingClientRect().top <= line) found = week;
      else break;
    }
    showWeek(found);
  }

  weekSelect.innerHTML = PLAN.weeks.map((w) => `<option value="${w.n}">Неделя ${w.n} · ${esc(w.period)}</option>`).join("");
  weekSelect.addEventListener("change", () => {
    const el = document.getElementById(`w${weekSelect.value}`);
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - barHeight(), behavior: "auto" });
    weekSelect.blur();
  });

  let scrollQueued = false;
  window.addEventListener("scroll", () => {
    if (scrollQueued || document.body.dataset.view !== "plan") return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      syncWeek();
    });
  }, { passive: true });

  /* Экраны */

  const VIEWS = { "#recipes": "recipes", "#info": "info", "#products": "products" };
  const TITLES = { recipes: "Рецепты", info: "Справка", products: "Продукты" };
  let view = "plan";
  // План ещё не показывался, если приложение открыли сразу на другом экране.
  let planScroll = null;

  function showPlan() {
    if (planScroll === null) goHome(false);
    else window.scrollTo(0, planScroll);
    syncWeek();
    observeToday();
  }

  function route() {
    const next = VIEWS[location.hash] || "plan";
    if (next === view) return;
    if (view === "plan" && homeY >= 0) planScroll = window.scrollY;
    endSwap();
    closePanel();
    // На экране продуктов могли поменять калорийность, от неё зависят граммовка и ккал в ленте.
    if (foodsChanged()) {
      renderFeed();
      renderBase();
    }
    view = next;
    document.body.dataset.view = next;
    for (const name of ["plan", "recipes", "info", "products"]) $(`#view-${name}`).hidden = name !== next;
    $("#sub-title").textContent = TITLES[next] || "";
    $("#to-today").hidden = true;
    if (next === "products") renderFoods();
    if (next === "plan") showPlan();
    else window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", route);

  /* События */

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("#to-today")) {
      goHome(true);
      return;
    }
    if (t.closest("#swap-cancel")) {
      endSwap();
      return;
    }
    const theme = t.closest("[data-theme-set]");
    if (theme) {
      themePref = theme.dataset.themeSet;
      store(THEME_KEY, themePref);
      applyTheme();
      return;
    }
    const jump = t.closest("[data-jump]");
    if (jump) {
      document.getElementById(jump.dataset.jump).scrollIntoView();
      return;
    }
    const step = t.closest("[data-step]");
    if (step && ed) {
      stepItem(step.closest(".ed-item"), Number(step.dataset.step));
      return;
    }
    const mode = t.closest("[data-mode]");
    if (mode && ed) {
      setMode(mode.dataset.mode);
      return;
    }
    const reset = t.closest(".f-reset");
    if (reset) {
      const row = reset.closest(".f-item");
      setFoodKcal(row.dataset.food, row.dataset.name, row.dataset.unit, null);
      renderFoods();
      return;
    }
    const row = t.closest(".meal-row");
    if (row && swapFrom) {
      if (feed.contains(row)) finishSwap(row.closest(".meal").dataset.key);
      return;
    }
    if (row) {
      const key = row.closest(".meal").dataset.key;
      if (key === openKey) closePanel();
      else openPanel(key, false);
      return;
    }
    const act = t.closest("[data-act]");
    if (act) {
      const key = act.closest(".meal").dataset.key;
      const name = act.dataset.act;
      if (name === "edit") openPanel(key, true);
      else if (name === "cancel") cancelEdit(key);
      else if (name === "save") closePanel(true);
      else if (name === "reset") resetEdit(key);
      else if (name === "swap") startSwap(key);
      else if (name === "copy") copyMeal(meals.get(key), act);
      return;
    }
    const copyBtn = t.closest(".copy");
    if (copyBtn) {
      copyDay(dayById.get(copyBtn.closest(".day").dataset.day), copyBtn);
      return;
    }
    const toggle = t.closest("[data-toggle]");
    if (toggle) {
      const section = toggle.closest(".day");
      const id = section.dataset.day;
      const open = section.classList.toggle("is-brief") === false;
      toggle.setAttribute("aria-expanded", String(open));
      if (open) expanded.add(id);
      else expanded.delete(id);
    }
  });

  document.addEventListener("input", (e) => {
    const t = e.target;
    if (ed && ed.li.contains(t)) {
      if (t.matches("textarea")) {
        autosize(t);
        ed.parts = FOODS.parseBody(t.value);
        ed.qtys = [];
        $(".ed-items", ed.li).innerHTML = itemsHtml();
        refreshEditor();
      } else if (t.matches(".ed-item input")) {
        const value = readNum(t.value);
        if (value !== null) {
          ed.qtys[Number(t.closest(".ed-item").dataset.i)] = round1(value);
          applyQtys();
        }
      } else if (t.matches("[name=kcal]")) {
        // Ккал вписаны руками: дальше считаем от них и от текущего состава.
        const kcal = t.value.replace(/\D/g, "");
        ed.base = { kcal: kcal ? Number(kcal) : null, parts: FOODS.parseBody($("[name=comp]", ed.li).value) };
        refreshEditor();
      } else if (t.matches("[data-food]")) {
        // Калорийность, вписанная у прошедшего дня, действует с этого дня, чтобы приём пищи её увидел.
        const iso = meals.get(ed.key).day.iso;
        const before = kcalTable(iso);
        setFoodKcal(t.dataset.food, t.dataset.name, t.dataset.unit, readNum(t.value), iso && iso < today ? iso : today);
        // Ккал точки отсчёта посчитаны без этой калорийности, добавляем её и для количества в точке отсчёта.
        if (ed.base.kcal != null) {
          const extra = (table) => FOODS.adapt(ed.base.parts, table, defaultKcal, false).extra;
          ed.base.kcal += extra(kcalTable(iso)) - extra(before);
        }
        refreshEditor();
      }
      return;
    }
    if (t.matches(".f-item input")) {
      const row = t.closest(".f-item");
      setFoodKcal(row.dataset.food, row.dataset.name, row.dataset.unit, readNum(t.value));
      const f = kcalTable().get(row.dataset.food);
      row.classList.toggle("is-edited", Boolean(f && f.def != null && f.kcal !== f.def));
      if (f?.def != null) $(".f-was", row).textContent = wasText(row.dataset.food, f.def);
      return;
    }
    if (t.matches("[data-week]")) {
      const value = t.value.trim();
      if (value) weights[t.dataset.week] = value;
      else delete weights[t.dataset.week];
      if (!store(WEIGHTS_KEY, weights)) toast("Не получилось сохранить вес на устройстве");
    }
  });

  // Поле количества или калорийности после ввода показывает число в обычном виде.
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (ed && t.matches(".ed-item input")) t.value = numText(qtyOf(Number(t.closest(".ed-item").dataset.i)));
    if (ed && t.matches(".ed-missing input")) setTimeout(() => ed && refreshEditor());
    if (t.matches(".f-item input")) {
      const f = kcalTable().get(t.closest(".f-item").dataset.food);
      t.value = f?.kcal == null ? "" : numText(f.kcal);
    }
  });

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t.matches(".ed-item input, .f-item input, [data-food]") && e.key === "Enter") {
      e.preventDefault();
      t.blur();
    } else if (t.closest(".editor")) {
      if (e.key === "Escape") cancelEdit(t.closest(".meal").dataset.key);
      else if (e.key === "Enter" && !e.shiftKey && t.matches("input, textarea")) {
        e.preventDefault();
        closePanel(true);
      }
    } else if (t.matches("[data-week]") && e.key === "Enter") {
      t.blur();
    } else if (e.key === "Escape" && swapFrom) {
      endSwap();
    }
  });

  function updateNext() {
    const key = nextMeal()?.key ?? null;
    if (key === nextKey) return;
    if (nextKey) mealEl(nextKey)?.classList.remove("is-next");
    nextKey = key;
    if (key) mealEl(key)?.classList.add("is-next");
  }

  // Дата могла смениться, пока приложение было свёрнуто или открыто через полночь.
  function refreshDay() {
    const now = isoOf(new Date());
    if (now === today) {
      updateNext();
      return;
    }
    closePanel();
    endSwap();
    today = now;
    renderFeed();
    if (view === "plan") goHome(false);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") commitEditor();
    else refreshDay();
  });
  window.addEventListener("pagehide", () => commitEditor());
  setInterval(refreshDay, 60000);

  /* Запуск */

  applyTheme();
  renderFeed();
  renderBase();
  renderRecipes();
  route();
  if (view === "plan") showPlan();
  // Шрифт меняет высоту строк, поэтому положение пересчитывается, если пользователь ещё не листал.
  document.fonts?.ready.then(() => {
    if (view === "plan" && Math.abs(window.scrollY - homeY) < 2) goHome(false);
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
