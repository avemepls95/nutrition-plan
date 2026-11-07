(() => {
  "use strict";

  const PLAN = window.PLAN;
  const FOODS = window.FOODS;
  const BACKUP = window.BACKUP;
  const EDITS_KEY = "np.v1.edits";
  const WEIGHTS_KEY = "np.v1.weights";
  const KCAL_KEY = "np.v1.kcal";
  const THEME_KEY = "np.v1.theme";
  const DISHES_KEY = "np.v1.dishes";
  const DATA_KEYS = [EDITS_KEY, WEIGHTS_KEY, KCAL_KEY, DISHES_KEY, THEME_KEY];

  const MON_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const WD = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
  const WD_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const LABELS = { B: "завтрак", M: "обед", S: "перекус", D: "ужин", E: "вечер", F: "десерт", K: "кино" };
  const PRE_TRAINING = new Set(["S4", "F4"]);
  const BAR_COLOR = { light: "#2b5b5e", dark: "#16302f" };

  const CODE_RE = /^\s*([A-Z]{1,2}\d{1,2})\s*·\s*/;
  // В правке ккал записаны по калорийности по умолчанию. Если ккал вписаны руками меньше, чем дают
  // продукты со своей калорийностью, число в правке меньше нуля.
  const KCAL_RE = /^≈?\s*(-?\d+)\s*ккал\.?\s*/;
  const { COFFEE_RE } = FOODS;
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

  // Правка приёма пищи: { t: текст, f: откуда переехал при обмене, mode: "kcal" у блюда из плана с граммовкой
  // из плана («Менять ккал»), n: название моего блюда, at: время добавленного приёма пищи }.
  const edits = Object.fromEntries(Object.entries(load(EDITS_KEY)).filter(([, e]) => typeof e?.t === "string"));
  const weights = load(WEIGHTS_KEY);
  // Мои блюда: { id: { n: название, t: состав без кода, ккал и кофе, p: true у блюда, которое встаёт
  // в приём пищи порцией, w: вес готового блюда в граммах, если его вписали } }.
  const myDishes = Object.fromEntries(Object.entries(load(DISHES_KEY)).filter(([, d]) => typeof d?.n === "string" && typeof d?.t === "string"));
  const newId = () => Date.now().toString(36);

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

  // Добавленный приём пищи хранится правкой со временем at под ключом «день+id». В плане у него пустой текст.
  const timeKey = (time) => {
    const [h, m] = time.split("/")[0].split(":").map(Number);
    // Поздний перекус после полуночи относится к вечеру того же дня.
    return (h < 5 ? h + 24 : h) * 60 + m;
  };

  function placeMeal(meal) {
    const list = meal.day.meals;
    if (list.includes(meal)) list.splice(list.indexOf(meal), 1);
    const i = list.findIndex((m) => timeKey(m.time) > timeKey(meal.time));
    list.splice(i < 0 ? list.length : i, 0, meal);
  }

  function addMeal(day, key, time) {
    const meal = { key, day, time, text: "", added: true };
    meals.set(key, meal);
    placeMeal(meal);
    return meal;
  }

  function dropMeal(meal) {
    meals.delete(meal.key);
    meal.day.meals.splice(meal.day.meals.indexOf(meal), 1);
  }

  for (const [key, edit] of Object.entries(edits)) {
    const day = typeof edit.at === "string" && dayById.get(key.slice(0, key.lastIndexOf("+")));
    if (day?.iso) addMeal(day, key, edit.at);
  }

  // Время для поля ввода: «08:30». Из поля: «8:30», null для пустого.
  const timeValue = (time) => time.split("/")[0].padStart(5, "0");
  const readTime = (value) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(value);
    return m ? `${Number(m[1])}:${m[2]}` : null;
  };

  // Время нового приёма пищи: сейчас, с округлением вверх до 5 минут.
  function defaultTime() {
    const now = new Date();
    const m = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 5) * 5;
    return `${Math.floor(m / 60) % 24}:${String(m % 60).padStart(2, "0")}`;
  }

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
    const coffee = [...head.matchAll(COFFEE_RE)].map((m) => ({ ml: m.groups.ml, fat: m.groups.fat || "" }));
    const rest = head.replace(COFFEE_RE, "").trim();
    const split = cutNote(rest);
    if (plain || planNotes.has(split.note)) return { code, kcal, coffee, ...split };
    return { code, kcal, coffee, body: rest, note: "" };
  }

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

  // Приём пищи с учётом своей калорийности продуктов в этот день. Блюдо из плана держит ккал, граммовка
  // продуктов подстраивается. Правка и блюдо с «Менять ккал» держат граммовку, пересчитываются ккал.
  // edit: правка приёма пищи (по умолчанию сохранённая), null для блюда из плана. table: калорийность продуктов.
  // text: что показывать и копировать. kcal: ккал для итога дня, у правки без числа как в плане, у убранного 0.
  // В тексте плана и правки ккал записаны без кофе, ккал кофе прибавляются по его молоку.
  // Удалённые к этому дню продукты уходят из состава вместе с их ккал, переименованные идут под новым названием.
  // Порции моих блюд держат ккал приёма пищи, их граммовка следует за ккал на 100 г блюда.
  function shownOf(meal, edit = edits[meal.key], table = kcalTable(meal.day.iso)) {
    const text = edit ? edit.t : meal.text;
    if (!text.trim()) return { text: "", kcal: 0 };
    const keepKcal = (!edit || planTexts.has(edit.t)) && edit?.mode !== "kcal";
    const { code, kcal, rest } = splitHead(text);
    const parts = FOODS.parseBody(rest);
    const adapted = FOODS.adapt(parts, table, defaultKcal, keepKcal, droppedIn(table));
    const total = (k) => Math.max(0, k + Math.round(adapted.extra));
    const portions = kcal != null && parts.some((p) => p.item && isPortionItem(p.item));
    const qtys = portions ? FOODS.followPortions(parts, adapted.qtys, total(kcal), editorTable(meal.day.iso, table)) : adapted.qtys;
    return {
      text: compose(code, kcal == null ? "" : String(total(kcal)), FOODS.compose(parts, qtys, nameOf)),
      kcal: total(kcal ?? (splitHead(meal.text).kcal || 0)),
    };
  }

  // Приём пищи из плана по калорийности продуктов по умолчанию, вместе с кофе. Из таких ккал сложен итог дня в PDF.
  const planDefault = (meal) => shownOf(meal, null, defaultKcal);

  // К итогу из PDF прибавляется только разница с планом.
  // editOf: правка приёма пищи, по умолчанию сохранённая. Редактор подставляет ещё не сохранённую.
  const dayTotal = (day, editOf = (m) => edits[m.key]) =>
    day.kcal + day.meals.reduce((sum, m) => sum + shownOf(m, editOf(m)).kcal - planDefault(m).kcal, 0);

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

  // text: название продукта так, как оно пишется в составе («батончик Nestlé Fitness»).
  const defaultKcal = new Map(FOODS.DEFAULTS.map(([key, name, unit, kcal, note]) => [FOODS.keyOf(key), { name, text: key, unit, kcal, def: kcal, note }]));

  // Своя калорийность и названия продуктов: { ключ: { n: название, u: единица, h: история для FOODS.valueAt,
  // off: день, с которого продукт удалён, a: названия, которые дал пользователь, последнее действует } }.
  // Калорийность и удаление действуют с дня, когда их задали, поэтому прошедшие дни не меняются.
  // off: true у продукта, удалённого прошлой версией: он только скрыт из списков и из состава не уходит.
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

  // Название продукта, данное пользователем, и название, под которым он был в плане или был добавлен.
  const ownName = (id) => foodKcal[id]?.a?.[foodKcal[id].a.length - 1];
  const firstName = (id) => defaultKcal.get(id)?.text ?? foodKcal[id]?.n ?? id.split("|")[0];

  // Переименованные продукты: ключ из FOODS.foodId → название в составе. Все названия, которые продукт
  // носил, остаются его названиями в тексте правок и моих блюд.
  const renamedFoods = new Map();
  function syncNames() {
    renamedFoods.clear();
    const aliases = [];
    for (const [id, v] of Object.entries(foodKcal)) {
      if (!v.a?.length) continue;
      const key = id.split("|")[0];
      for (const name of v.a) aliases.push([name, key]);
      if (ownName(id).toLowerCase() !== firstName(id).toLowerCase()) renamedFoods.set(id, ownName(id));
    }
    FOODS.setAliases(aliases);
  }
  syncNames();
  // У кофе название в составе своё («Кофе + 20 мл молока 3%»), его молоко не переименовывается.
  const nameOf = (item) => (item.milk ? undefined : renamedFoods.get(FOODS.foodId(item.key, item.unit)));

  // Калорийность продуктов в этот день (по умолчанию сегодня): из foods.js и своя, с названием от пользователя
  // и пометкой off у удалённого. Ключ из FOODS.foodId.
  function kcalTable(iso) {
    const day = iso || today;
    const table = new Map([...defaultKcal].map(([id, entry]) => [id, { ...entry }]));
    for (const [id, v] of Object.entries(foodKcal)) {
      const k = FOODS.valueAt(v.h, day);
      let entry = table.get(id);
      if (entry) {
        if (k !== undefined) entry.kcal = k ?? entry.def;
      } else {
        entry = { name: v.n || id.split("|")[0], unit: v.u || "г", kcal: k ?? null, def: null };
        table.set(id, entry);
      }
      if (renamedFoods.has(id)) {
        entry.orig = firstName(id);
        entry.name = entry.text = renamedFoods.get(id);
      }
      if (typeof v.off === "string" && v.off <= day) entry.off = true;
    }
    return table;
  }

  // Удалённый к этому дню продукт уходит из состава. Кофе остаётся, даже если удалили его молоко.
  const droppedIn = (table) => (item) => !item.milk && Boolean(table.get(FOODS.foodId(item.key, item.unit))?.off);

  // Состав моего блюда в этот день: без удалённых продуктов и с названиями от пользователя.
  function dishView(body, iso) {
    const table = kcalTable(iso);
    const parts = FOODS.parseBody(body);
    return FOODS.compose(parts, FOODS.adapt(parts, table, defaultKcal, false, droppedIn(table)).qtys, nameOf);
  }

  // Ключ порции моего блюда с названием name в таблице калорийности.
  const portionId = (name) => FOODS.foodId(FOODS.keyOf(FOODS.portionName(name)), "г");
  // Порция моего блюда в составе: название в кавычках, как его пишет FOODS.portionName.
  const isPortionItem = (item) => item.key.startsWith("«");

  // Ккал на 100 г готового моего блюда в этот день. null, если веса нет или у продукта блюда нет калорийности.
  // Вес вписан пользователем или посчитан суммой продуктов, кроме продуктов в штуках и пачках.
  function per100Of(dish, iso, table = kcalTable(iso)) {
    const items = itemsOf(dishView(dish.t, iso));
    const weight = dish.w || FOODS.weightOf(items).grams;
    const { kcal, missing } = FOODS.delta([], items, table);
    return weight && !missing.length ? (kcal * 100) / weight : null;
  }

  // Калорийность продуктов products (по умолчанию в этот день) вместе с порциями моих блюд, у порции ккал
  // на 100 г готового блюда. В итог дня ккал порции идут числом из правки, поэтому правка блюда меняет у порций
  // только граммовку. Блюдо, название которого в составе не разбирается как название продукта, порцией
  // не считается.
  function editorTable(iso, products = kcalTable(iso)) {
    const table = new Map(products);
    for (const dish of Object.values(myDishes)) {
      const name = FOODS.portionName(dish.n);
      const per100 = dish.p && nameOk(name) ? per100Of(dish, iso, products) : null;
      if (per100 !== null) table.set(portionId(dish.n), { name, unit: "г", kcal: per100, def: null, portion: true });
    }
    return table;
  }

  // С какого дня действует своя калорийность продукта, которая видна сегодня.
  const kcalSince = (id) => foodKcal[id]?.h.filter(([d]) => d <= today).pop()?.[0];

  // Название продукта из состава на экране продуктов. У кофе это его молоко.
  const foodName = (item) => item.milk || item.name;

  // Название и единица остаются те, с которыми продукт появился впервые.
  function setFoodKcal(id, name, unit, value, from = today) {
    const before = foodKcal[id];
    const hist = FOODS.withValue(before?.h || [], from, value === defaultKcal.get(id)?.kcal ? null : value);
    const entry = { ...before, n: before?.n || name, u: before?.u || unit, h: hist };
    if (hist.length || entry.off || entry.a?.length) foodKcal[id] = entry;
    else delete foodKcal[id];
    saveFoods();
  }

  function saveFoods() {
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
    if (meal.added) cls.push("is-added");
    if (meal.key === nextKey) cls.push("is-next");
    if (empty) cls.push("is-empty");

    // Новый приём пищи пуст, пока его не сохранили.
    // Из состава могли уйти все продукты, если их удалили.
    const gone = current(meal).trim() ? "продукты удалены" : meal.added ? "новый приём пищи" : "убрано";
    let body = p.code ? `<span class="m-sku">${esc(p.code)}</span> ` : "";
    body += empty ? `<span class="m-empty">${gone}</span>` : nbspUnits(esc(p.body));
    const source = edit?.f && meals.get(edit.f);
    if (edit && !empty) body += `<span class="m-from">${meal.added ? "добавлено" : source ? `из ${esc(dayShort(source.day))}` : "правка"}</span>`;
    const name = empty ? gone : plain && recipe ? recipe.name : edit?.n || p.body;

    let price = "";
    const plan = edit && splitHead(meal.text).kcal != null ? shownOf(meal, null).kcal : null;
    if (plan != null && shown.kcal !== plan) {
      price += `<s class="m-was"><span class="visually-hidden">в плане </span>${plan}</s>`;
    }
    if (p.kcal != null && !empty) price += `<b>${p.kcal}</b><span class="visually-hidden"> ккал</span>`;
    if (price) price = `<span class="m-kcal">${price}</span>`;

    // Строка смахивается влево поверх полосы «Убрать». Кнопка копирования лежит поверх строки под числом ккал,
    // место под ней держит пустой блок в колонке ккал.
    const strip = empty ? "" : `<span class="m-swipe" aria-hidden="true">${meal.added ? "Удалить" : "Убрать"}</span>`;
    const copy = empty ? "" : `<button class="m-copy" type="button" aria-label="Скопировать: ${esc(labelOf(p.code))}, ${esc(dayShort(meal.day))}">${icon("i-copy")}</button>`;
    return `<li class="${cls.join(" ")}" data-key="${esc(meal.key)}">
      ${strip}<button class="meal-row" type="button" aria-expanded="false">
        <span class="m-time"><span>${esc(t1)}</span>${t2 ? `<span class="alt">${esc(t2)}</span>` : ""}</span>
        <span class="m-text"><span class="m-body">${body}</span><span class="m-name">${esc(name)}</span><span class="m-extra">${p.coffee.map(coffeeHtml).join("")}</span></span>
        <span class="m-price">${price}${empty ? "" : `<span class="m-copy-space${price ? "" : " is-tall"}"></span>`}</span>
      </button>${copy}
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
      ${isBase ? "" : `<button class="add-meal" type="button" data-add-meal>${icon("i-plus")}<span>Добавить приём пищи</span></button>`}
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
    const title = recipe ? recipe.name : edit?.n;
    const parts = [];
    if (title) parts.push(`<p class="p-title">${esc(title)}</p>`);
    if (p.note) parts.push(`<p class="p-note">${esc(p.note)}</p>`);
    // У S4 и F4 шаг рецепта повторяет пояснение из плана.
    if (recipe) for (const step of recipe.steps) if (step !== p.note) parts.push(`<p>${esc(step)}</p>`);
    const plan = planDefault(meal).text;
    if (!meal.added && (edit || shownOf(meal).text !== plan)) parts.push(`<p class="p-orig"><b>В плане</b>${esc(plan)}</p>`);
    const actions = [`<button class="btn" type="button" data-act="edit">Изменить</button>`];
    if (meal.day.iso && !meal.added) actions.push(`<button class="btn" type="button" data-act="swap">Поменять</button>`);
    // Убранный приём пищи из плана остаётся в дне с пометкой «убрано», добавленный удаляется совсем.
    if (meal.added) actions.push(`<button class="btn" type="button" data-act="delete">Удалить</button>`);
    else if (text.trim()) actions.push(`<button class="btn" type="button" data-act="remove">Убрать</button>`);
    if (edit && !meal.added) actions.push(`<button class="btn" type="button" data-act="reset">Как в плане</button>`);
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

  // Переключатель «Менять граммовку / Менять ккал» у блюда из плана plan, если своя калорийность
  // меняет граммовку его продуктов. Пустая строка, если не меняет.
  function modesHtml(meal, plan, mode) {
    const parts = FOODS.parseBody(splitHead(plan).rest);
    const table = kcalTable(meal.day.iso);
    const { qtys } = FOODS.adapt(parts, table, defaultKcal, true, droppedIn(table));
    const names = parts.filter((p, i) => qtys[i] > 0 && qtys[i] !== p.item.qty).map((p) => nameOf(p.item) || p.item.name);
    if (!names.length) return "";
    return `<p class="ed-label">Своя калорийность: ${esc(names.join(", "))}</p>
      <div class="seg" role="group" aria-label="Своя калорийность продуктов">
        <button type="button" data-mode="grams" aria-pressed="${mode === "grams"}">Менять граммовку</button>
        <button type="button" data-mode="kcal" aria-pressed="${mode === "kcal"}">Менять ккал</button>
      </div>`;
  }

  // Блюдо code из плана для приёма пищи с составом rest. Кофе относится к приёму пищи, а не к блюду,
  // поэтому остаётся от прежнего состава. null, если такого блюда в плане нет.
  function dishText(code, rest) {
    const source = code && PLAN.texts.find((t) => splitHead(t).code === code);
    if (!source) return null;
    const head = splitHead(source);
    const food = head.rest.replace(COFFEE_RE, "").trim();
    const coffee = (rest.match(COFFEE_RE) || []).map((c) => c.trim()).join(" ");
    return compose(code, head.kcal == null ? "" : String(head.kcal), coffee ? `${food} ${coffee}` : food);
  }

  // Варианты поля «Блюдо»: мои блюда, перекусы перед тренировкой и остальные блюда плана по группам.
  // Перекусы перед тренировкой стоят наверху, их добавляют в день, когда тренировка случилась вне плана.
  // dishId: выбранное моё блюдо.
  function codeOptions(code, dishId) {
    const option = (r) => `<option value="${esc(r.code)}"${r.code === code ? " selected" : ""}>${esc(r.code)} · ${esc(r.name)}</option>`;
    const group = (title, items) => (items.length ? `<optgroup label="${esc(title)}">${items.map(option).join("")}</optgroup>` : "");
    const own = sortedDishes().map(([id, d]) => `<option value="dish:${esc(id)}"${id === dishId ? " selected" : ""}>${esc(d.n)}</option>`).join("");
    const pre = group("Перед тренировкой", mealCodes.filter((r) => PRE_TRAINING.has(r.code)));
    const groups = PLAN.recipes.groups.map((g) => group(g.title, g.items.filter((r) => !r.code.startsWith("SA") && !PRE_TRAINING.has(r.code)))).join("");
    const other = code && !mealCodes.some((r) => r.code === code) ? `<option value="${esc(code)}" selected>${esc(code)}</option>` : "";
    return `<option value="">свой состав</option>${other}${own ? `<optgroup label="Мои блюда">${own}</optgroup>` : ""}${pre}${groups}`;
  }

  function addFormHtml() {
    return `<div class="ed-add">
        <button class="btn ed-add-open" type="button" data-add="open">${icon("i-plus")}Добавить продукт</button>
        <div class="ed-add-form" hidden>
          <label class="ed-field ed-select">Продукт<select name="add-food">${addOptions()}</select></label>
          <div class="ed-add-new" hidden>
            <label class="ed-field">Название<input name="add-name" autocomplete="off" enterkeyhint="done" maxlength="60"></label>
            <label class="ed-field ed-select">Единица<select name="add-unit"><option value="г">г</option><option value="мл">мл</option><option value="шт.">шт.</option></select></label>
          </div>
          <label class="ed-field">Количество<span class="ed-add-qty"><input name="add-qty" inputmode="decimal" autocomplete="off" enterkeyhint="done" maxlength="6"><span class="unit"></span></span></label>
          <div class="p-actions">
            <button class="btn primary" type="button" data-add="confirm">Добавить</button>
            <button class="btn" type="button" data-add="cancel">Отмена</button>
          </div>
        </div>
      </div>`;
  }

  function editorHtml(meal) {
    const edit = edits[meal.key];
    const { code, kcal, rest } = splitHead(editSource(meal));
    const dishId = !code && edit?.n ? dishByName(edit.n) : undefined;
    const fresh = meal.added && !edit;
    const modes = isPlain(meal) || !current(meal).trim() ? modesHtml(meal, planOf(meal), modeOf(meal)) : "";
    return `<div class="meal-panel editor">
      <div class="ed-fields">
        <label class="ed-field ed-code">Блюдо<select name="code">${codeOptions(code, dishId)}</select></label>
        <label class="ed-field">Ккал<input name="kcal" value="${kcal ?? ""}" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" enterkeyhint="done"></label>
      </div>
      ${meal.added ? `<div class="ed-fields"><label class="ed-field ed-time">Время<input type="time" name="time" value="${esc(timeValue(meal.time))}"></label></div>` : ""}
      <p class="ed-day" aria-live="polite"></p>
      <div class="ed-mode"${modes ? "" : " hidden"}>${modes}</div>
      <ul class="ed-items" aria-label="Количество продуктов"></ul>
      <p class="ed-hint">Смахните продукт влево, чтобы убрать его.</p>
      ${addFormHtml()}
      <div class="ed-missing" hidden></div>
      <label class="ed-label" for="comp-${esc(meal.key)}">Состав</label>
      <textarea id="comp-${esc(meal.key)}" name="comp" rows="3" enterkeyhint="done">${esc(rest)}</textarea>
      <div class="ed-keep" hidden>
        <label class="ed-field">Название блюда<input name="keep-name" autocomplete="off" enterkeyhint="done" maxlength="60"></label>
        <div class="p-actions">
          <button class="btn primary" type="button" data-keep="confirm">Сохранить блюдо</button>
          <button class="btn" type="button" data-keep="cancel">Отмена</button>
        </div>
      </div>
      <div class="p-actions">
        <button class="btn primary" type="button" data-act="save">${fresh ? "Добавить" : "Сохранить"}</button>
        <button class="btn" type="button" data-act="cancel">Отмена</button>
        <button class="btn" type="button" data-keep="open">В мои блюда</button>
      </div>
    </div>`;
  }

  // Моё блюдо, выбранное в поле «Блюдо» редактора li.
  function pickedDish(li) {
    const picked = $("[name=code]", li).value;
    return picked.startsWith("dish:") ? myDishes[picked.slice(5)] : null;
  }

  // Правка, которую сохранит редактор. Если код, ккал и состав совпали с блюдом из плана,
  // приём пищи остаётся блюдом из плана, с граммовкой под свою калорийность или из плана («Менять ккал»).
  function editorEntry(li) {
    const meal = meals.get(ed.key);
    const picked = $("[name=code]", li).value;
    const dish = pickedDish(li);
    const entry = planEntry(meal, dish ? "" : picked, $("[name=kcal]", li).value.replace(/\D/g, ""), $("[name=comp]", li).value);
    if (dish) entry.n = dish.n;
    const time = $("[name=time]", li);
    if (time) entry.at = readTime(time.value) || meal.time;
    return entry;
  }

  function planEntry(meal, code, kcal, comp) {
    const text = compose(code, kcal, comp);
    const grams = planView(meal, ed.plan, "grams").text;
    const plan = planView(meal, ed.plan, "kcal").text;
    if (text === grams && (ed.mode === "grams" || text !== plan)) return { t: ed.plan };
    if (text === plan) return { t: ed.plan, mode: "kcal" };
    const { extra } = FOODS.adapt(FOODS.parseBody(comp), kcalTable(meal.day.iso), defaultKcal, false);
    return { t: compose(code, kcal && String(Number(kcal) - Math.round(extra)), comp) };
  }

  /* Количество продуктов в редакторе */

  // Открытый редактор приёма пищи или моего блюда (dish): части состава, новое количество по номеру части,
  // точка отсчёта для пересчёта ккал (sum: ккал посчитаны суммой продуктов), день для калорийности,
  // блюдо из плана и режим переключателя.
  let ed = null;

  function startEditor(li, meal) {
    const parts = FOODS.parseBody($("[name=comp]", li).value);
    const { kcal } = splitHead(editSource(meal));
    const plan = planOf(meal);
    const from = edits[meal.key]?.f;
    // У нового приёма пищи ккал набираются из добавленных продуктов.
    const base = kcal == null && meal.added ? { kcal: 0, parts: [] } : { kcal, parts };
    ed = { key: meal.key, iso: meal.day.iso, li, parts, qtys: [], base, plan, mode: modeOf(meal), from, start: { plan, from } };
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
    // Блюдо добавили целиком продуктами, а потом сделали порцией: приём пищи открывается порцией с теми же ккал.
    const dish = pickedDish(li);
    if (dish?.p && foodPart($("[name=comp]", li).value) === foodPart(dishView(dish.t, ed.iso))) usePortion(dish);
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

  // В поле «Блюдо» выбрали другое блюдо: состав, граммовка и ккал берутся у этого блюда в плане,
  // как будто оно стоит в плане на этом месте. Без кода состав остаётся прежним.
  function switchDish(code) {
    if (code.startsWith("dish:")) {
      const dish = myDishes[code.slice(5)];
      if (dish.p && usePortion(dish)) return;
      useMyDish(dish);
      if (dish.p) toast(`У блюда «${dish.n}» не посчитать ккал на 100 г, поэтому оно встало продуктами`);
      return;
    }
    const meal = meals.get(ed.key);
    const back = code && code === splitHead(ed.start.plan).code;
    const plan = back ? ed.start.plan : dishText(code, $("[name=comp]", ed.li).value);
    if (!plan) {
      refreshEditor();
      return;
    }
    ed.plan = plan;
    // Пометка «из сб 31 окт» относится к блюду, которое переехало при обмене, а не к новому.
    ed.from = back ? ed.start.from : undefined;
    const box = $(".ed-mode", ed.li);
    box.innerHTML = modesHtml(meal, plan, ed.mode);
    box.hidden = !box.innerHTML;
    setMode(ed.mode);
  }

  // Кофе приёма пищи из поля «Состав»: при выборе моего блюда он остаётся.
  const coffeeOf = () => ($("[name=comp]", ed.li).value.match(COFFEE_RE) || []).map((c) => c.trim()).join(" ");
  const withCoffee = (food, coffee) => (coffee && food ? `${food.replace(/[\s.]+$/, "")}. ${coffee}` : food || coffee);
  // Состав без кофе и точки в конце.
  const foodPart = (body) => body.replace(COFFEE_RE, "").replace(/[\s.]+$/, "").trim();

  // Состав из моего блюда в редакторе приёма пищи. kcal: ккал приёма пищи, без него сумма продуктов.
  function setDishBody(body, kcal) {
    const ta = $("[name=comp]", ed.li);
    ed.from = undefined;
    const box = $(".ed-mode", ed.li);
    box.innerHTML = "";
    box.hidden = true;
    ta.value = body;
    autosize(ta);
    ed.parts = FOODS.parseBody(body);
    ed.qtys = [];
    ed.base = kcal === undefined
      ? { kcal: Math.round(FOODS.delta([], currentItems(), editorTable(ed.iso)).kcal), parts: ed.parts, sum: true }
      : { kcal, parts: ed.parts };
    $("[name=kcal]", ed.li).value = ed.base.kcal;
    $(".ed-items", ed.li).innerHTML = itemsHtml();
    refreshEditor();
  }

  // Моё блюдо в поле «Блюдо»: его состав, кофе остаётся от приёма пищи. Ккал считаются по продуктам.
  function useMyDish(dish) {
    setDishBody(withCoffee(dishView(dish.t, ed.iso), coffeeOf()));
  }

  // Моё блюдо порцией: одна строка «Торт» 100 г, кофе остаётся от приёма пищи. Если у прежнего состава
  // без кофе были ккал, порция получает их. false, если ккал на 100 г у блюда не посчитать (нет веса или ккал).
  function usePortion(dish) {
    const table = editorTable(ed.iso);
    if (!table.get(portionId(dish.n))?.kcal) return false;
    const coffee = coffeeOf();
    const body = withCoffee(FOODS.segmentText(FOODS.portionName(dish.n), 100, "г"), coffee);
    const kcal = Number($("[name=kcal]", ed.li).value) || 0;
    if (kcal - FOODS.delta([], itemsOf(coffee), table).kcal < 1) {
      setDishBody(body);
      return true;
    }
    const parts = FOODS.parseBody(body);
    setDishBody(FOODS.compose(parts, FOODS.fitPortions(parts, [], kcal, table)), kcal);
    return true;
  }

  // Ккал приёма пищи вписали руками: граммовка порций моих блюд подстраивается под них. Пропорция между
  // порциями берётся из количества на момент входа в поле «Ккал» (fitFrom), промежуточные числа при наборе
  // («2», «20») её не меняют.
  function fitPortionsTo(kcal) {
    const qtys = FOODS.fitPortions(ed.parts, ed.fitFrom || ed.qtys, kcal, editorTable(ed.iso));
    if (!qtys.length) return;
    qtys.forEach((qty, i) => {
      ed.qtys[i] = qty;
      $(`.ed-item[data-i="${i}"] input`, ed.li).value = numText(qty);
    });
    const ta = $("[name=comp]", ed.li);
    ta.value = FOODS.compose(ed.parts, ed.qtys);
    autosize(ta);
  }

  const qtyOf = (i) => ed.qtys[i] ?? ed.parts[i].item.qty;
  const unitText = (item) => (item.unit === "пачка" ? "пач." : item.unitWord);

  // Строка продукта смахивается влево, под ней «Убрать». Убранный продукт остаётся в списке с «Вернуть».
  // Кнопка «Убрать» видна только с клавиатуры, на телефоне продукт убирают свайпом.
  function itemsHtml() {
    return ed.parts.map((part, i) => {
      if (!part.item) return "";
      const { name } = part.item;
      return `<li class="ed-item" data-i="${i}">
        <span class="ed-swipe" aria-hidden="true">Убрать</span>
        <div class="ed-row">
          <span class="ed-name"><span class="ed-title">${esc(name)}</span><span class="ed-k"></span></span>
          <span class="stepper">
            <button type="button" data-step="-1" aria-label="Меньше: ${esc(name)}">${icon("i-minus")}</button>
            <label><input value="${numText(qtyOf(i))}" inputmode="decimal" autocomplete="off" enterkeyhint="done" maxlength="6" aria-label="${esc(name)}, ${esc(part.item.unitWord)}"><span class="unit">${esc(unitText(part.item))}</span></label>
            <button type="button" data-step="1" aria-label="Больше: ${esc(name)}">${icon("i-plus")}</button>
          </span>
          <button class="btn ed-restore" type="button" data-restore>Вернуть</button>
          <button class="ed-remove" type="button" data-remove aria-label="Убрать: ${esc(name)}">${icon("i-x")}</button>
        </div>
      </li>`;
    }).join("");
  }

  // Продукт убрали свайпом или кнопкой либо вернули с количеством, которое было перед тем, как его убрали.
  function setRemoved(item, removed) {
    const i = Number(item.dataset.i);
    ed.kept = ed.kept || [];
    if (removed) ed.kept[i] = qtyOf(i);
    ed.qtys[i] = removed ? 0 : ed.kept[i] || ed.parts[i].item.qty;
    $("input", item).value = numText(ed.qtys[i]);
    applyQtys();
  }

  /* Добавление продукта */

  const OTHER_FOOD = "__other";
  const COFFEE_FOOD = "__coffee";

  // Обычное количество продукта в плане, им заполняется поле при добавлении. planCoffee: кофе из плана.
  const typicalQty = new Map();
  let planCoffee = null;
  for (const text of PLAN.texts) {
    for (const { item } of FOODS.parseBody(splitHead(text).rest)) {
      if (!item) continue;
      if (item.milk && !planCoffee) planCoffee = item;
      const id = item.milk ? COFFEE_FOOD : FOODS.foodId(item.key, item.unit);
      if (!typicalQty.has(id)) typicalQty.set(id, item.qty);
    }
  }

  // Продукты экрана продуктов и кофе. Кофе относится к приёму пищи, поэтому в моё блюдо его не добавляют.
  function addOptions() {
    const rows = foodRows().map(([id, f]) => [id, `${cap(f.name)}${id.includes("|") ? `, ${f.unit}` : ""}`]);
    if (planCoffee && !ed?.dish) rows.push([COFFEE_FOOD, cap(planCoffee.name)]);
    rows.sort(([, a], [, b]) => a.localeCompare(b, "ru"));
    const options = rows.map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`);
    return `<option value="" disabled selected>Выберите продукт</option>${options.join("")}<option value="${OTHER_FOOD}">Другой продукт…</option>`;
  }

  // Продукт, выбранный в форме добавления: как его написать в составе и в каких единицах.
  function addChoice() {
    const form = $(".ed-add-form", ed.li);
    const id = $("[name=add-food]", form).value;
    if (id === OTHER_FOOD) {
      const name = $("[name=add-name]", form).value.trim();
      return { id, name, unit: $("[name=add-unit]", form).value };
    }
    if (id === COFFEE_FOOD) return { id, name: planCoffee.name, unit: planCoffee.unit, coffee: planCoffee };
    const entry = id && kcalTable(ed.iso).get(id);
    const custom = foodKcal[id];
    if (!id) return null;
    return { id, name: entry?.text || custom?.n || entry?.name || id.split("|")[0], unit: entry?.unit || custom?.u || id.split("|")[1] || "г" };
  }

  function syncAddForm() {
    const form = $(".ed-add-form", ed.li);
    const id = $("[name=add-food]", form).value;
    const other = id === OTHER_FOOD;
    $(".ed-add-new", form).hidden = !other;
    const choice = addChoice();
    const unit = choice?.unit || "г";
    $(".ed-add-qty .unit", form).textContent = unit === "пачка" ? "пач." : unit;
    const qty = typicalQty.get(id) ?? (unit === "шт." ? 1 : unit === "пачка" ? 0.5 : 100);
    $("[name=add-qty]", form).value = numText(qty);
  }

  function toggleAddForm(open) {
    const form = $(".ed-add-form", ed.li);
    form.hidden = !open;
    $(".ed-add-open", ed.li).hidden = open;
    if (open) {
      $("[name=add-food]", form).innerHTML = addOptions();
      $("[name=add-name]", form).value = "";
      syncAddForm();
      $("[name=add-food]", form).focus();
    }
  }

  // Продукт, который уже есть в составе, получает добавленное количество, убранный возвращается с ним.
  // Новый встаёт в конец состава, перед кофе или пояснением. Кофе встаёт в самый конец.
  function addProduct() {
    const form = $(".ed-add-form", ed.li);
    const choice = addChoice();
    const qty = readNum($("[name=add-qty]", form).value);
    if (!choice || (choice.id === OTHER_FOOD && !choice.name)) {
      $(choice ? "[name=add-name]" : "[name=add-food]", form).focus();
      return;
    }
    if (!qty) {
      $("[name=add-qty]", form).focus();
      return;
    }
    const key = choice.coffee ? choice.coffee.key : FOODS.keyOf(choice.name);
    // Удалённый продукт ушёл бы из состава сразу после сохранения.
    if (!choice.coffee && kcalTable(ed.iso).get(FOODS.foodId(key, choice.unit))?.off) {
      toast("Продукт удалён. Вернуть его можно на экране продуктов через «Новый продукт»");
      $("[name=add-name]", form).focus();
      return;
    }
    const i = ed.parts.findIndex((p) => p.item && p.item.key === key && FOODS.unitKind(p.item.unit) === FOODS.unitKind(choice.unit));
    if (i >= 0 && ed.parts[i].item.factor === 1) {
      ed.qtys[i] = round1(qtyOf(i) + qty);
      applyQtys();
    } else {
      const ta = $("[name=comp]", ed.li);
      const segment = choice.coffee ? FOODS.coffeeText(choice.coffee.milk, round1(qty)) : FOODS.segmentText(choice.name, round1(qty), choice.unit);
      ta.value = FOODS.addSegment(ta.value, segment);
      autosize(ta);
      ed.parts = FOODS.parseBody(ta.value);
      ed.qtys = [];
    }
    $(".ed-items", ed.li).innerHTML = itemsHtml();
    toggleAddForm(false);
    refreshEditor();
  }

  const currentItems = () => ed.parts.flatMap((p, i) => (p.item ? [{ item: p.item, qty: qtyOf(i) }] : []));

  // Ккал пересчитываются от точки отсчёта: сколько было у блюда и каких продуктов стало больше или меньше.
  function refreshEditor() {
    const li = ed.li;
    const table = editorTable(ed.iso);
    const baseQty = new Map();
    for (const p of ed.base.parts) if (p.item) baseQty.set(p.item.key, (baseQty.get(p.item.key) || 0) + p.item.qty * p.item.factor);
    const nowQty = new Map();
    for (const { item, qty } of currentItems()) nowQty.set(item.key, (nowQty.get(item.key) || 0) + qty * item.factor);
    // Количество помечается изменённым, только если есть с чем сравнить: у нового приёма пищи и в редакторе
    // моего блюда все продукты новые.
    const marked = ed.base.parts.some((p) => p.item);

    for (const row of li.querySelectorAll(".ed-item")) {
      const i = Number(row.dataset.i);
      const { item } = ed.parts[i];
      const removed = qtyOf(i) === 0;
      const k = FOODS.kcalOf(item.key, qtyOf(i), item.unit, item.factor, table);
      $(".ed-k", row).textContent = removed ? "убрано" : k === null ? "" : `${Math.round(k)} ккал`;
      row.classList.toggle("is-removed", removed);
      row.classList.toggle("is-changed", marked && Math.abs((nowQty.get(item.key) || 0) - (baseQty.get(item.key) || 0)) > 1e-9);
    }
    $(".ed-hint", li).hidden = !li.querySelector(".ed-item:not(.is-removed)");

    // Продукту без калорийности её можно вписать прямо здесь. Пока поле в фокусе, блок не перерисовывается.
    // Экран продуктов пишет калорийность с сегодняшнего дня, поэтому прошедшему приёму пищи её вписывают здесь.
    const { kcal, missing: changed } = FOODS.delta(ed.base.parts, currentItems(), table);
    // В ккал, посчитанные суммой продуктов, продукт без калорийности не вошёл, даже если его количество не меняли.
    // Порция без калорийности (её моё блюдо удалили или переименовали) продуктом не становится, поэтому
    // её в блоке нет.
    const missing = (ed.base.sum ? FOODS.delta([], currentItems(), table).missing : changed).filter((item) => !isPortionItem(item));
    const box = $(".ed-missing", li);
    const past = ed.iso && ed.iso < today;
    if (!box.contains(document.activeElement)) {
      const items = [...new Map(missing.map((item) => [FOODS.foodId(item.key, item.unit), item])).values()];
      box.hidden = !items.length;
      box.innerHTML = items.length
        ? `<p>Нет калорийности, поэтому ккал не пересчитаны. ${past ? `Впишите её здесь, она будет действовать с ${dateShort(ed.iso)}.` : "Впишите её здесь или на экране продуктов."}</p>${items.map((item) => {
          const per = UNIT_LABEL[item.unit];
          const name = foodName(item);
          return `<label><span>${esc(cap(name))}</span><input data-food="${esc(FOODS.foodId(item.key, item.unit))}" data-name="${esc(name)}" data-unit="${esc(item.unit)}" inputmode="decimal" autocomplete="off" enterkeyhint="done" maxlength="6" aria-label="${esc(cap(name))}, ккал ${esc(per)}"><span class="f-unit">ккал<br>${esc(per)}</span></label>`;
        }).join("")}`
        : "";
    }
    if (ed.dish) {
      const per100 = syncWeight(kcal);
      const shown = per100 !== null && !missing.length;
      $(".ed-day", li).innerHTML = `<b>${Math.round(kcal)}</b> ккал${shown ? `, ${Math.round(per100)} ккал на 100\xa0г` : ""}`;
      return;
    }
    const kcalInput = $("[name=kcal]", li);
    if (!missing.length && ed.base.kcal != null && (ed.base.kcal || currentItems().length) && document.activeElement !== kcalInput) {
      kcalInput.value = Math.max(0, Math.round(ed.base.kcal + kcal));
    }
    // Ккал моего блюда считаются по калорийности продуктов, поэтому состав с порцией в мои блюда не сохраняется.
    const portion = currentItems().some(({ item, qty }) => qty > 0 && isPortionItem(item));
    $("[data-keep=open]", li).hidden = !$("[name=comp]", li).value.trim() || !$(".ed-keep", li).hidden || portion;

    const meal = meals.get(ed.key);
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

  // Своя калорийность продуктов и мои блюда, по которым нарисована лента: от них зависят граммовка и ккал
  // продуктов и порций. Всю ленту перерисовываем только после их смены.
  let feedFoods = null;
  const feedSource = () => JSON.stringify([foodKcal, myDishes]);
  const foodsChanged = () => feedSource() !== feedFoods;

  function renderFeed() {
    nextKey = nextMeal()?.key ?? null;
    feedFoods = feedSource();
    feed.innerHTML = PLAN.weeks.map((week) => weekHtml(week) + week.items.map(dayHtml).join("")).join("");
    observeToday();
  }

  function renderBase() {
    $("#base-note").textContent = PLAN.base.note;
    $("#base-week").innerHTML = baseDays.map(dayHtml).join("");
  }

  function renderRecipes() {
    const groups = PLAN.recipes.groups;
    $("#recipe-jump").innerHTML = `<button type="button" data-jump="rg-mine">Мои блюда</button>` + groups
      .map((g, i) => `<button type="button" data-jump="rg${i}">${esc(g.title)}</button>`)
      .join("");
    $("#recipe-list").innerHTML = `<p class="r-intro">${esc(PLAN.recipes.intro)}</p>
      <section class="r-group" id="rg-mine">
        <h2>Мои блюда</h2>
        <button class="btn r-new" type="button" data-dish-new>${icon("i-plus")}Новое блюдо</button>
        <ul class="r-list" id="dish-list"></ul>
      </section>` + groups.map((g, i) => `
      <section class="r-group" id="rg${i}">
        <h2>${esc(g.title)}</h2>
        ${g.notes.map((n) => `<p class="r-note">${esc(n)}</p>`).join("")}
        <ul class="r-list">${g.items.map((r) => `
          <li class="recipe">
            <p class="r-head"><span class="r-code">${esc(r.code)}</span><span class="r-name">${esc(r.name)}</span><span class="r-kcal">${r.kcal}<small>ккал</small></span></p>
            ${r.comp ? `<p class="r-comp">${esc(FOODS.compose(FOODS.parseBody(r.comp), [], nameOf))}</p>` : ""}
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

  // Продукты из правок и моих блюд: ключ из FOODS.foodId → название и единица, как продукт впервые встретился.
  // Порции моих блюд («Торт» 54 г) продуктами не считаются.
  function usedFoods() {
    const used = new Map();
    const bodies = [...Object.values(edits).map((edit) => splitHead(edit.t).rest), ...Object.values(myDishes).map((dish) => dish.t)];
    for (const body of bodies) {
      for (const { item } of FOODS.parseBody(body)) {
        const id = item && FOODS.foodId(item.key, item.unit);
        if (item && !used.has(id) && !isPortionItem(item)) used.set(id, { name: foodName(item), unit: item.unit });
      }
    }
    return used;
  }

  // Продукты плана, свои продукты из правок и моих блюд и всё, чему пользователь вписал калорийность, по алфавиту.
  // Удалённых продуктов в списке нет.
  function foodRows() {
    const table = kcalTable();
    for (const [id, item] of usedFoods()) if (!table.has(id)) table.set(id, { name: item.name, unit: item.unit, kcal: null, def: null });
    return [...table.entries()].filter(([id]) => !foodKcal[id]?.off).sort(([, a], [, b]) => a.name.localeCompare(b.name, "ru"));
  }

  const searchKey = (s) => s.toLowerCase().replace(/ё/g, "е").trim();

  // Строка продукта смахивается влево поверх полосы «Удалить», кнопка «Удалить» видна только с клавиатуры.
  // Нажатие на название открывает поле для нового названия. Поиск ищет и по названию из плана.
  function renderFoods() {
    const query = searchKey($("#food-search").value);
    const rows = foodRows().filter(([, f]) => searchKey(`${f.name} ${f.orig || ""}`).includes(query));
    $("#food-empty").hidden = rows.length > 0;
    $("#food-list").innerHTML = rows.map(([key, f]) => {
      const name = cap(f.name);
      const per = UNIT_LABEL[f.unit] || UNIT_LABEL.г;
      const edited = f.def != null && f.kcal !== f.def;
      const note = f.def == null ? "свой продукт" : f.note || "";
      return `<li class="f-item${edited ? " is-edited" : ""}" data-food="${esc(key)}" data-name="${esc(f.name)}" data-unit="${esc(f.unit)}">
        <span class="f-swipe" aria-hidden="true">Удалить</span>
        <div class="f-row">
          <span class="f-text"><button class="f-name" type="button" aria-label="${esc(name)}, переименовать">${esc(name)}</button>${f.orig && f.def != null ? `<span class="f-note">в плане: ${esc(f.orig)}</span>` : ""}${note ? `<span class="f-note f-def">${esc(note)}</span>` : ""}${f.def != null ? `<span class="f-note f-was">${esc(wasText(key, f.def))}</span>` : ""}</span>
          <span class="f-in">
            <input value="${f.kcal == null ? "" : esc(numText(f.kcal))}" placeholder="—" inputmode="decimal" autocomplete="off" enterkeyhint="done" maxlength="6" aria-label="${esc(name)}, ккал ${esc(per)}">
            <span class="f-unit">ккал<br>${esc(per)}</span>
            ${f.def != null ? `<button class="f-reset" type="button" aria-label="Вернуть ${esc(numText(f.def))}">${icon("i-undo")}</button>` : ""}
          </span>
          <button class="f-del" type="button" aria-label="Удалить: ${esc(name)}">${icon("i-x")}</button>
        </div>
      </li>`;
    }).join("");
  }

  /* Переименование продукта */

  function startRename(li) {
    const id = li.dataset.food;
    const input = document.createElement("input");
    input.className = "f-rename";
    // Escape возвращает это значение.
    input.defaultValue = renamedFoods.get(id) || defaultKcal.get(id)?.text || li.dataset.name;
    input.maxLength = 60;
    input.autocomplete = "off";
    input.enterKeyHint = "done";
    input.setAttribute("aria-label", "Название продукта");
    $(".f-name", li).replaceWith(input);
    input.focus();
    input.select();
  }

  // Название продукта в составе разбирается как продукт: в нём есть буквы и нет количества с единицей и «;».
  const BAD_NAME = "В названии не должно быть количества и «;»";
  function nameOk(name) {
    const [part, ...rest] = FOODS.parseBody(`${name} 1 г`);
    return !rest.length && part.item?.name === name && part.item.qty === 1 && !part.item.milk;
  }

  // Новое название не должно совпадать с другим продуктом, иначе его состав стал бы этим продуктом.
  // Пустое поле возвращает название из плана или то, с которым продукт появился.
  function renameFood(li, value) {
    const id = li.dataset.food;
    const first = firstName(id);
    const name = value.replace(/\s+/g, " ").trim() || first;
    if (searchKey(name) === searchKey(renamedFoods.get(id) || li.dataset.name)) {
      renderFoods();
      return;
    }
    if (!nameOk(name)) {
      toast(BAD_NAME);
      renderFoods();
      return;
    }
    const key = FOODS.keyOf(name);
    const used = usedFoods();
    const table = kcalTable();
    const clash = [...table.keys(), ...used.keys()].find((other) => other !== id && other.split("|")[0] === key);
    if (clash) {
      toast(`Такой продукт уже есть: ${cap((table.get(clash) || used.get(clash)).name)}`);
      renderFoods();
      return;
    }
    const before = foodKcal[id];
    const names = (before?.a || []).filter((n) => n.toLowerCase() !== name.toLowerCase());
    foodKcal[id] = { ...(before || { n: li.dataset.name, u: li.dataset.unit, h: [] }), a: [...names, name] };
    syncNames();
    saveFoods();
    renderFoods();
  }

  /* Новый и удалённый продукт */

  let foodFormOpen = false;

  function renderFoodForm() {
    const box = $("#food-new");
    if (!foodFormOpen) {
      box.innerHTML = `<div class="f-actions">
        <button class="btn" type="button" data-food-form="open">${icon("i-plus")}Новый продукт</button>
        <a class="btn" href="#recipes">Мои блюда</a>
      </div>`;
      return;
    }
    box.innerHTML = `<div class="f-form">
      <label class="ed-field">Название<input name="food-name" autocomplete="off" enterkeyhint="next" maxlength="60"></label>
      <div class="f-form-row">
        <label class="ed-field ed-select">Единица<select name="food-unit">${Object.keys(UNIT_LABEL).map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join("")}</select></label>
        <label class="ed-field"><span>Ккал <span class="f-per">${esc(UNIT_LABEL.г)}</span></span><input name="food-kcal" inputmode="decimal" autocomplete="off" enterkeyhint="done" maxlength="6"></label>
      </div>
      <div class="p-actions">
        <button class="btn primary" type="button" data-food-form="add">Добавить</button>
        <button class="btn" type="button" data-food-form="cancel">Отмена</button>
      </div>
    </div>`;
  }

  function toggleFoodForm(open) {
    foodFormOpen = open;
    renderFoodForm();
    if (open) $("[name=food-name]").focus();
  }

  const showFood = (id) => $(`.f-item[data-food="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });

  // Продукт с тем же названием и единицей уже есть: показываем его. Удалённый раньше возвращается в список.
  function addFood() {
    const box = $("#food-new");
    const nameInput = $("[name=food-name]", box);
    const kcalInput = $("[name=food-kcal]", box);
    const name = nameInput.value.replace(/\s+/g, " ").trim();
    const unit = $("[name=food-unit]", box).value;
    const kcal = readNum(kcalInput.value);
    if (!/\p{L}/u.test(name)) {
      toast("Впишите название");
      nameInput.focus();
      return;
    }
    if (!nameOk(name)) {
      toast(BAD_NAME);
      nameInput.focus();
      return;
    }
    if (kcal === null) {
      toast("Впишите калорийность");
      kcalInput.focus();
      return;
    }
    const id = FOODS.foodId(FOODS.keyOf(name), unit);
    const have = kcalTable().get(id);
    if (have && !foodKcal[id]?.off) {
      toast(`Такой продукт уже есть: ${cap(have.name)}`);
      showFood(id);
      return;
    }
    if (foodKcal[id]) delete foodKcal[id].off;
    // Продукта, которого нет ни в плане, ни в одном составе, нет и в прошедших днях, поэтому его калорийность
    // действует с начала плана.
    const start = days[0].iso < today ? days[0].iso : today;
    const fresh = !defaultKcal.has(id) && !usedFoods().has(id);
    setFoodKcal(id, name, unit, kcal, fresh ? start : today);
    toggleFoodForm(false);
    $("#food-search").value = "";
    renderFoods();
    showFood(id);
  }

  // Продукт пропадает из списков и с сегодняшнего дня из состава приёмов пищи и моих блюд. Прошедшие дни
  // не меняются.
  function deleteFood(row) {
    const id = row.dataset.food;
    const before = foodKcal[id];
    foodKcal[id] = { ...(before || { n: row.dataset.name, u: row.dataset.unit, h: [] }), off: today };
    saveFoods();
    renderFoods();
    toast(`Удалено: ${cap(row.dataset.name)}`, "Отменить", () => {
      if (before) foodKcal[id] = before;
      else delete foodKcal[id];
      saveFoods();
      renderFoods();
    });
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

  // Перерисовывает дни приёмов пищи keys и дни days, а после смены своей калорийности всю ленту и базовую неделю.
  function rerender(keys, anchorKey, days = []) {
    const anchor = anchorKey && mealEl(anchorKey);
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    const touched = new Set([...keys.map((k) => meals.get(k).day), ...days]);
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

  // entry: правка из редактора. Добавленный приём пищи хранит в правке и своё время.
  function setEdit(meal, entry, from) {
    const t = entry.t.replace(/\s*\n\s*/g, " ").trim();
    if (t === meal.text && !entry.mode) {
      delete edits[meal.key];
      return;
    }
    const edit = from && from !== meal.key ? { t, f: from } : { t };
    if (entry.mode) edit.mode = entry.mode;
    if (entry.n && t) edit.n = entry.n;
    if (meal.added) edit.at = meal.time;
    edits[meal.key] = edit;
  }

  const editSnapshot = (key) => JSON.stringify(edits[key] ?? null);

  let openKey = null;
  // Правка приёма пищи на момент открытия редактора (editSnapshot).
  let editStart = null;

  // Как в заметках iOS: черновик сохраняется, когда уходишь из редактора или сворачиваешь приложение.
  // force: нажата «Сохранить» или «Добавить». Тогда сохраняется то, что видно в редакторе, даже без изменений.
  // closing: редактор закрывается.
  function commitEditor(force, closing) {
    const li = openKey && mealEl(openKey);
    if (!li || !$(".editor", li)) return;
    const meal = meals.get(openKey);
    const entry = editorEntry(li);
    // Новый приём пищи попадает в день только по «Добавить». Пустой состав удаляет добавленный приём пищи
    // только при закрытии редактора, где есть «Отменить».
    if (meal.added && !force && (!edits[openKey] || (!closing && !entry.t))) return;
    // Редактор открыли и закрыли без изменений: убранный приём пищи остаётся убранным, хотя в редакторе состав из плана.
    if (!force && ed && JSON.stringify(entry) === ed.initial && editSnapshot(openKey) === editStart) return;
    const before = editSnapshot(openKey);
    if (entry.at && entry.at !== meal.time) {
      meal.time = entry.at;
      placeMeal(meal);
    }
    setEdit(meal, entry, ed ? ed.from : edits[openKey]?.f);
    if (editSnapshot(openKey) !== before) persist();
  }

  function closePanel(save) {
    if (!openKey) return;
    const key = openKey;
    const meal = meals.get(key);
    const li = mealEl(key);
    // Новый приём пищи закрыли, не нажав «Добавить»: его состав можно добавить из тоста.
    const draft = meal.added && !edits[key] && ed && li ? editorEntry(li) : null;
    commitEditor(save === true, true);
    const start = editStart;
    const changed = editStart !== null && editSnapshot(key) !== editStart;
    openKey = null;
    editStart = null;
    ed = null;
    document.body.classList.remove("is-editing");
    if (meal.added && !edits[key]) {
      dropAdded(meal, start && JSON.parse(start), draft);
      return;
    }
    if (!li) return;
    li.classList.remove("is-open");
    li.querySelector(".meal-row").setAttribute("aria-expanded", "false");
    li.querySelector(".meal-panel")?.remove();
    // В редакторе могли вписать калорийность своего продукта, он бывает и в других днях.
    if (changed || foodsChanged()) rerender(changed ? [key] : [], key);
    if (changed) revealMeal(key);
  }

  // После сохранения строка должна быть на экране, а если помещается, то вместе с заголовком дня и его итогом.
  // Высокий редактор схлопывается, и строка уезжает за верхний край.
  function revealMeal(key) {
    const li = mealEl(key);
    if (!li) return;
    const top = barHeight() + 8;
    const row = li.getBoundingClientRect();
    if (row.top >= top && row.bottom <= window.innerHeight - 16) return;
    const head = li.closest(".day").querySelector(".day-head").getBoundingClientRect();
    const target = row.bottom - head.top <= window.innerHeight - top - 16 ? head.top : row.top;
    window.scrollBy({ top: target - top, behavior: "smooth" });
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
      // Новый приём пищи начинают с выбора блюда.
      if (!li.querySelector(".ed-item") && !(meal.added && !edits[key])) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }
    // Новый приём пищи мог встать выше экрана, раскрытая строка снизу могла уйти за край.
    const rect = li.getBoundingClientRect();
    const top = rect.top - barHeight() - 8;
    const overflow = rect.bottom - (window.innerHeight - 16);
    if (top < 0) window.scrollBy({ top, behavior: "smooth" });
    else if (overflow > 0) window.scrollBy({ top: Math.min(overflow, top), behavior: "smooth" });
  }

  // Черновик мог уже сохраниться при сворачивании, «Отмена» возвращает правку на момент открытия.
  function cancelEdit(key) {
    const meal = meals.get(key);
    const li = mealEl(key);
    const start = editStart && JSON.parse(editStart);
    const draft = meal.added && !start ? editorEntry(li) : null;
    li.querySelector(".editor").remove();
    ed = null;
    const reverted = editStart !== null && editSnapshot(key) !== editStart;
    if (reverted) {
      if (start) edits[key] = start;
      else delete edits[key];
      persist();
    }
    editStart = null;
    if (meal.added && !start) {
      // Новый приём пищи так и не добавили.
      openKey = null;
      document.body.classList.remove("is-editing");
      dropAdded(meal, null, draft);
      return;
    }
    if (reverted && meal.added) {
      meal.time = start.at;
      placeMeal(meal);
    }
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

  // «Сохранить» и «Добавить». Новый приём пищи без состава не добавляется.
  function saveEditor() {
    const meal = meals.get(openKey);
    if (meal.added && !edits[meal.key] && !$("[name=comp]", ed.li).value.trim()) {
      toast("Выберите блюдо или напишите состав");
      return;
    }
    closePanel(true);
  }

  const whatOf = (meal, edit) => `${edit?.n || labelOf(splitHead(edit ? edit.t : meal.text).code)}, ${dayShort(meal.day)}`;

  // Приём пищи из плана остаётся в дне с пометкой «убрано» и возвращается кнопкой «Как в плане».
  function removeMeal(key) {
    const meal = meals.get(key);
    const before = edits[key];
    closePanel();
    setEdit(meal, { t: "" });
    persist();
    rerender([key], key);
    toast(`Убрано: ${whatOf(meal, before)}`, "Отменить", () => {
      closePanel();
      if (before) edits[key] = before;
      else delete edits[key];
      persist();
      rerender([key], key);
    });
  }

  function deleteAdded(key) {
    const meal = meals.get(key);
    const record = edits[key];
    closePanel();
    delete edits[key];
    persist();
    dropAdded(meal, record);
  }

  // record: правка удалённого приёма пищи. draft: состав нового, которого не добавили. Оба возвращаются
  // кнопкой «Отменить» в тосте.
  function dropAdded(meal, record, draft) {
    dropMeal(meal);
    rerender([], null, [meal.day]);
    const back = record || (draft?.t ? draft : null);
    if (!back) return;
    toast(`${record ? "Удалено" : "Не добавлено"}: ${whatOf(meal, back)}`, "Отменить", () => {
      closePanel();
      const again = addMeal(meal.day, meal.key, back.at || meal.time);
      if (record) edits[meal.key] = record;
      else setEdit(again, back);
      persist();
      rerender([meal.key], meal.key);
    });
  }

  // Новый приём пищи сразу открывается в редакторе и попадает в день по «Добавить».
  function startNewMeal(day) {
    closePanel();
    const meal = addMeal(day, `${day.id}+${newId()}`, defaultTime());
    rerender([], null, [day]);
    openPanel(meal.key, true);
  }

  /* В мои блюда из редактора */

  // Кофе относится к приёму пищи, поэтому в моё блюдо не попадает.
  const dishBody = (li) => $("[name=comp]", li).value.replace(COFFEE_RE, "").replace(/\s*\n\s*/g, " ").trim();

  // У выбранного моего блюда подставляется его название, и сохранение обновляет это блюдо. Новому подставляется
  // свободное название, потому что у блюд из одних и тех же продуктов название по умолчанию совпадает.
  function toggleKeep(open) {
    const box = $(".ed-keep", ed.li);
    box.hidden = !open;
    if (open) {
      const picked = $("[name=code]", ed.li).value;
      const input = $("[name=keep-name]", box);
      input.value = picked.startsWith("dish:") ? myDishes[picked.slice(5)].n : freeName(recipes.get(picked)?.name || autoName(dishBody(ed.li)));
      input.focus();
      input.select();
    }
    refreshEditor();
  }

  // Название, которого ещё нет в моих блюдах: «Творог, банан 2».
  function freeName(name) {
    let candidate = name;
    for (let n = 2; dishByName(candidate); n++) candidate = `${name} ${n}`;
    return candidate;
  }

  // Блюдо с тем же названием обновляется. Свой состав приёма пищи становится этим блюдом, блюдо плана остаётся со своим кодом.
  function keepDish() {
    const body = dishBody(ed.li);
    if (!body) return;
    const name = $("[name=keep-name]", ed.li).value.trim() || autoName(body);
    const id = dishByName(name) || newId();
    const before = myDishes[id];
    myDishes[id] = { ...before, n: name, t: body };
    // Вписанный вес относится к прежнему составу блюда.
    delete myDishes[id].w;
    saveDishes();
    const select = $("[name=code]", ed.li);
    const code = select.value.startsWith("dish:") ? "" : select.value;
    select.innerHTML = codeOptions(code, code ? undefined : id);
    toggleKeep(false);
    if (!before) {
      toast(`Сохранено в мои блюда: ${name}`);
      return;
    }
    toast(`Блюдо обновлено: ${name}`, "Отменить", () => {
      myDishes[id] = before;
      saveDishes();
      renderDishes();
    });
  }

  /* Мои блюда */

  const sortedDishes = () => Object.entries(myDishes).sort(([, a], [, b]) => a.n.localeCompare(b.n, "ru"));
  const dishByName = (name) => Object.keys(myDishes).find((id) => myDishes[id].n.toLowerCase() === name.toLowerCase());
  const itemsOf = (body) => FOODS.parseBody(body).flatMap((p) => (p.item ? [{ item: p.item, qty: p.item.qty }] : []));

  function saveDishes() {
    if (!store(DISHES_KEY, myDishes)) toast("Не получилось сохранить блюдо на устройстве");
  }

  // Название по умолчанию: продукты состава через запятую.
  function autoName(body) {
    const names = [...new Set(itemsOf(body).map(({ item }) => item.name))];
    return cap(names.length ? names.join(", ") : body.replace(/[\s.;]+$/, ""));
  }

  function dishHtml(id, dish, table) {
    const body = dishView(dish.t);
    const { kcal, missing } = FOODS.delta([], itemsOf(body), table);
    const per100 = dish.p ? per100Of(dish, null, table) : null;
    return `<li class="recipe my-dish" data-dish="${esc(id)}">
      <button class="dish-row" type="button">
        <span class="r-head"><span class="r-name">${esc(dish.n)}</span><span class="r-kcal">${Math.round(kcal)}<small>ккал</small></span></span>
        <span class="r-comp">${nbspUnits(esc(body))}</span>
        ${dish.p ? `<span class="r-uses">Порцией${per100 !== null ? `, ${Math.round(per100)} ккал на 100\xa0г` : missing.length ? "" : ", нет веса"}</span>` : ""}
        ${missing.length ? `<span class="r-uses">Нет калорийности: ${esc(missing.map(foodName).join(", "))}</span>` : ""}
      </button>
    </li>`;
  }

  function renderDishes() {
    const table = kcalTable();
    $("#dish-list").innerHTML = sortedDishes().map(([id, dish]) => dishHtml(id, dish, table)).join("");
  }

  // Открытое моё блюдо: id, null у нового, undefined, если редактор закрыт. dishStart: блюдо на момент открытия.
  let dishOpen;
  let dishStart = null;

  function dishEditorHtml(dish) {
    const portion = Boolean(dish?.p);
    return `<div class="editor dish-editor">
      <label class="ed-field ed-dish-name">Название<input name="dish-name" value="${esc(dish?.n || "")}" autocomplete="off" enterkeyhint="done" maxlength="60"></label>
      <p class="ed-day" aria-live="polite"></p>
      <div class="ed-portion">
        <p class="ed-label">В приём пищи</p>
        <div class="seg" role="group" aria-label="В приём пищи">
          <button type="button" data-portion="items" aria-pressed="${!portion}">Продуктами</button>
          <button type="button" data-portion="portion" aria-pressed="${portion}">Порцией</button>
        </div>
        <div class="ed-weight"${portion ? "" : " hidden"}>
          <label class="ed-field">Вес готового блюда<span class="ed-add-qty"><input name="dish-weight" value="${dish?.w || ""}" inputmode="numeric" pattern="[0-9]*" maxlength="5" autocomplete="off" enterkeyhint="done"><span class="unit">г</span></span></label>
          <p class="ed-weight-note" hidden></p>
        </div>
      </div>
      <ul class="ed-items" aria-label="Количество продуктов"></ul>
      <p class="ed-hint">Смахните продукт влево, чтобы убрать его.</p>
      ${addFormHtml()}
      <div class="ed-missing" hidden></div>
      <label class="ed-label" for="comp-dish">Состав</label>
      <textarea id="comp-dish" name="comp" rows="3" enterkeyhint="done">${esc(dish ? dishView(dish.t) : "")}</textarea>
      <div class="p-actions">
        <button class="btn primary" type="button" data-dish-act="save">Сохранить</button>
        <button class="btn" type="button" data-dish-act="cancel">Отмена</button>
        ${dish ? `<button class="btn" type="button" data-dish-act="delete">Удалить</button>` : ""}
      </div>
    </div>`;
  }

  function openDish(id) {
    closeDish();
    const list = $("#dish-list");
    let li = id && $(`[data-dish="${CSS.escape(id)}"]`, list);
    if (!li) {
      list.insertAdjacentHTML("afterbegin", `<li class="recipe my-dish" data-dish=""></li>`);
      li = list.firstElementChild;
    }
    const dish = id ? myDishes[id] : null;
    li.classList.add("is-open");
    li.innerHTML = dishEditorHtml(dish);
    dishOpen = id;
    dishStart = dish;
    const ta = $("textarea", li);
    autosize(ta);
    ed = { dish: true, iso: null, li, parts: FOODS.parseBody(ta.value), qtys: [], base: { kcal: 0, parts: [] } };
    $(".ed-items", li).innerHTML = itemsHtml();
    refreshEditor();
    ed.initial = dishDraft();
    if (!id) $("[name=dish-name]", li).focus();
  }

  const portionPressed = () => $('[data-portion="portion"]', ed.li).getAttribute("aria-pressed") === "true";
  const typedWeight = () => Number($("[name=dish-weight]", ed.li).value.replace(/\D/g, ""));

  // «Продуктами / Порцией» в редакторе моего блюда.
  function setPortion(on) {
    for (const b of ed.li.querySelectorAll("[data-portion]")) b.setAttribute("aria-pressed", String((b.dataset.portion === "portion") === on));
    $(".ed-weight", ed.li).hidden = !on;
    refreshEditor();
  }

  // Поле веса у блюда порцией: в подсказке вес суммой продуктов, под полем продукты, которые в эту сумму не вошли.
  // Возвращает ккал на 100 г готового блюда (null у блюда продуктами и без веса). kcal: ккал всего блюда.
  function syncWeight(kcal) {
    const box = $(".ed-weight", ed.li);
    if (box.hidden) return null;
    const { grams, skipped } = FOODS.weightOf(currentItems().filter(({ qty }) => qty > 0));
    const typed = typedWeight();
    $("[name=dish-weight]", box).placeholder = grams ? String(Math.round(grams)) : "";
    const note = $(".ed-weight-note", box);
    note.textContent = !typed && skipped.length ? `Не вошли в вес: ${[...new Set(skipped.map(foodName))].join(", ")}` : "";
    note.hidden = !note.textContent;
    const weight = typed || grams;
    return weight ? (kcal * 100) / weight : null;
  }

  // Почему открытое блюдо порцией нельзя сохранить под названием name, пустая строка, если можно. Порция стоит
  // в составе приёма пищи под названием блюда, поэтому название разбирается как название продукта
  // и отличает блюдо от других блюд порцией.
  function portionNameIssue(name) {
    if (!nameOk(FOODS.portionName(name))) return BAD_NAME;
    const taken = Object.entries(myDishes).some(([id, d]) => id !== dishOpen && d.p && portionId(d.n) === portionId(name));
    return taken ? "Блюдо порцией с таким названием уже есть" : "";
  }

  // Название, состав, «Порцией» и вписанный вес, которые сохранит редактор блюда.
  const dishDraft = () => JSON.stringify([$("[name=dish-name]", ed.li).value.trim(), $("[name=comp]", ed.li).value.replace(/\s*\n\s*/g, " ").trim(), portionPressed(), typedWeight()]);

  // Как и у приёма пищи, черновик блюда сохраняется, когда уходишь из редактора. Без состава блюдо не сохраняется.
  function commitDish() {
    if (dishOpen === undefined) return;
    const draft = dishDraft();
    const [name, body, portion, weight] = JSON.parse(draft);
    if (!body || draft === ed.initial) return;
    if (!dishOpen) dishOpen = newId();
    myDishes[dishOpen] = { n: name || autoName(body), t: body, ...(portion && { p: true }), ...(weight && { w: weight }) };
    ed.initial = draft;
    saveDishes();
  }

  function closeDish(save) {
    if (dishOpen === undefined) return;
    const [name, body, portion] = JSON.parse(dishDraft());
    if (save && !body) {
      toast("Добавьте продукт или напишите состав");
      return;
    }
    const issue = save && portion ? portionNameIssue(name || autoName(body)) : "";
    if (issue) {
      toast(issue);
      $("[name=dish-name]", ed.li).focus();
      return;
    }
    commitDish();
    dishOpen = undefined;
    ed = null;
    renderDishes();
  }

  // Черновик мог уже сохраниться при сворачивании, «Отмена» возвращает блюдо на момент открытия.
  function cancelDish() {
    if (dishOpen) {
      if (dishStart) myDishes[dishOpen] = dishStart;
      else delete myDishes[dishOpen];
      saveDishes();
    }
    dishOpen = undefined;
    ed = null;
    renderDishes();
  }

  function deleteDish() {
    const id = dishOpen;
    const dish = myDishes[id];
    dishOpen = undefined;
    ed = null;
    delete myDishes[id];
    saveDishes();
    renderDishes();
    toast(`Удалено: ${dish.n}`, "Отменить", () => {
      closeDish();
      myDishes[id] = dish;
      saveDishes();
      renderDishes();
    });
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
    // Добавленный приём пищи не меняется местами, потому что у него нет места в плане.
    for (const li of feed.querySelectorAll(".meal:not(.is-added)")) {
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
    // «Менять ккал» и название моего блюда переезжают вместе с блюдом.
    setEdit(a, { t: textB, mode: snapshot[target]?.mode, n: snapshot[target]?.n }, fromB);
    setEdit(b, { t: textA, mode: snapshot[source]?.mode, n: snapshot[source]?.n }, fromA);
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

  const copyDay = (day, btn) => copyText(day.meals.map((m) => shownOf(m).text).filter(Boolean).join("\n"), btn, dayShort(day));

  function copyMeal(meal, btn) {
    const text = shownOf(meal).text;
    copyText(text, btn, `${labelOf(splitHead(text).code)}, ${dayShort(meal.day)}`);
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
    // «Отменить» в тосте относится к экрану, с которого ушли.
    hideToast();
    endSwap();
    closePanel();
    closeDish();
    // На экране продуктов могли поменять калорийность, а в моих блюдах состав и вес. От них зависят граммовка
    // и ккал в ленте.
    if (foodsChanged()) {
      renderFeed();
      renderBase();
    }
    view = next;
    document.body.dataset.view = next;
    for (const name of ["plan", "recipes", "info", "products"]) $(`#view-${name}`).hidden = name !== next;
    $("#sub-title").textContent = TITLES[next] || "";
    $("#to-today").hidden = true;
    if (next === "products") {
      toggleFoodForm(false);
      $("#food-search").value = "";
      renderFoods();
    }
    // В составе рецептов и моих блюд могли поменяться названия продуктов и уйти удалённые.
    if (next === "recipes") {
      renderRecipes();
      renderDishes();
    }
    if (next === "plan") showPlan();
    else window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", route);

  /* Копия данных */

  // В приложении с главного экрана iOS ссылка на скачивание открывает просмотр файла вместо сохранения
  // (WebKit bug 275288), поэтому там файл уходит в меню «Поделиться».
  function exportData() {
    const now = new Date();
    const name = `План питания ${isoOf(now)}.json`;
    const file = new File([BACKUP.pack(localStorage, DATA_KEYS, now)], name, { type: "application/json" });
    if (navigator.standalone && navigator.canShare?.({ files: [file] })) {
      navigator.share({ files: [file] }).catch((e) => {
        if (e.name !== "AbortError") toast("Не получилось выгрузить данные");
      });
      return;
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(file);
    link.download = name;
    link.click();
  }

  async function importData(file) {
    const backup = BACKUP.unpack(await file.text());
    if (!backup) {
      toast("В файле нет данных плана");
      return;
    }
    const when = backup.exported.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
    if (!confirm(`Заменить все данные на этом устройстве данными из файла от ${when}?`)) return;
    if (!BACKUP.restore(localStorage, DATA_KEYS, backup.data)) {
      toast("Не получилось сохранить данные на устройстве");
      return;
    }
    // Правки, калорийность и мои блюда читаются из хранилища при запуске, поэтому приложение перезапускается.
    // Состояние записи в истории переживает перезапуск, по нему после запуска появляется тост. Ленту после
    // перезапуска на вчера и сегодня ставит приложение, как при обычном запуске.
    history.replaceState({ loaded: true }, "", location.pathname);
    history.scrollRestoration = "manual";
    location.reload();
  }

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
    if (t.closest("#data-export")) {
      exportData();
      return;
    }
    if (t.closest("#data-import")) {
      $("#data-file").click();
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
    const portion = t.closest("[data-portion]");
    if (portion && ed) {
      setPortion(portion.dataset.portion === "portion");
      return;
    }
    const removeBtn = t.closest("[data-remove], [data-restore]");
    if (removeBtn && ed) {
      setRemoved(removeBtn.closest(".ed-item"), removeBtn.matches("[data-remove]"));
      if (removeBtn.matches("[data-remove]")) $("[data-restore]", removeBtn.closest(".ed-item")).focus();
      return;
    }
    const add = t.closest("[data-add]");
    if (add && ed) {
      if (add.dataset.add === "confirm") addProduct();
      else toggleAddForm(add.dataset.add === "open");
      return;
    }
    const keep = t.closest("[data-keep]");
    if (keep && ed) {
      if (keep.dataset.keep === "confirm") keepDish();
      else toggleKeep(keep.dataset.keep === "open");
      return;
    }
    const renameBtn = t.closest(".f-name");
    if (renameBtn) {
      startRename(renameBtn.closest(".f-item"));
      return;
    }
    const reset = t.closest(".f-reset");
    if (reset) {
      const row = reset.closest(".f-item");
      setFoodKcal(row.dataset.food, row.dataset.name, row.dataset.unit, null);
      renderFoods();
      return;
    }
    const del = t.closest(".f-del");
    if (del) {
      deleteFood(del.closest(".f-item"));
      return;
    }
    const foodBtn = t.closest("[data-food-form]");
    if (foodBtn) {
      if (foodBtn.dataset.foodForm === "add") addFood();
      else toggleFoodForm(foodBtn.dataset.foodForm === "open");
      return;
    }
    if (t.closest("[data-dish-new]")) {
      openDish(null);
      return;
    }
    const dishAct = t.closest("[data-dish-act]");
    if (dishAct) {
      const name = dishAct.dataset.dishAct;
      if (name === "save") closeDish(true);
      else if (name === "cancel") cancelDish();
      else if (name === "delete") deleteDish();
      return;
    }
    const dishRow = t.closest(".dish-row");
    if (dishRow) {
      openDish(dishRow.closest(".my-dish").dataset.dish);
      return;
    }
    const addMealBtn = t.closest("[data-add-meal]");
    if (addMealBtn) {
      startNewMeal(dayById.get(addMealBtn.closest(".day").dataset.day));
      return;
    }
    const mealCopy = t.closest(".m-copy");
    if (mealCopy) {
      copyMeal(meals.get(mealCopy.closest(".meal").dataset.key), mealCopy);
      return;
    }
    const row = t.closest(".meal-row");
    if (row && swapFrom) {
      const li = row.closest(".meal");
      if (feed.contains(row) && !li.classList.contains("is-added")) finishSwap(li.dataset.key);
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
      else if (name === "save") saveEditor();
      else if (name === "reset") resetEdit(key);
      else if (name === "remove") removeMeal(key);
      else if (name === "delete") deleteAdded(key);
      else if (name === "swap") startSwap(key);
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
        // Ккал вписаны руками: порции моих блюд подстраиваются под них, дальше считаем от них и от текущего состава.
        const kcal = t.value.replace(/\D/g, "");
        if (Number(kcal) > 0) fitPortionsTo(Number(kcal));
        ed.base = { kcal: kcal ? Number(kcal) : null, parts: FOODS.parseBody($("[name=comp]", ed.li).value) };
        refreshEditor();
      } else if (t.matches("[name=dish-weight]")) {
        refreshEditor();
      } else if (t.matches("[data-food]")) {
        // Калорийность, вписанная у прошедшего дня, действует с этого дня, чтобы приём пищи её увидел.
        const iso = ed.iso;
        const before = kcalTable(iso);
        setFoodKcal(t.dataset.food, t.dataset.name, t.dataset.unit, readNum(t.value), iso && iso < today ? iso : today);
        // Ккал точки отсчёта посчитаны без этой калорийности, добавляем её и для количества в точке отсчёта.
        if (ed.base.kcal != null) {
          const extra = (table) => FOODS.adapt(ed.base.parts, table, defaultKcal, false).extra;
          ed.base.kcal += extra(kcalTable(iso)) - extra(before);
        }
        refreshEditor();
      } else if (t.matches("[name=time]")) {
        // На своё место в дне строка переезжает после сохранения, а время в ней видно сразу.
        const time = readTime(t.value);
        if (time) $(".m-time", ed.li).innerHTML = `<span>${esc(time)}</span>`;
      }
      return;
    }
    if (t.matches("#food-search")) {
      renderFoods();
      return;
    }
    if (t.matches(".f-in input")) {
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

  /* Свайп продукта в редакторе, приёма пищи и продукта на экране продуктов */

  // Строка едет за пальцем влево. Дальше порога продукт или приём пищи убирается, ближе строка возвращается
  // на место. Вертикальное движение остаётся прокрутке (touch-action: pan-y у строки).
  let swipe = null;
  // Время события, которым закончился свайп (event.timeStamp), чтобы погасить следующее за ним нажатие.
  let swipedAt = null;

  // Пока открыт редактор, смахиваются только его продукты. Раскрытый и убранный приём пищи не смахиваются.
  function swipeRow(target) {
    if (target.closest("input")) return null;
    if (ed) return target.closest(".ed-item:not(.is-removed) > .ed-row");
    if (swapFrom) return null;
    return target.closest(".meal:not(.is-open):not(.is-empty) > .meal-row, .f-item > .f-row");
  }

  function swipeDone(box) {
    if (box.matches(".ed-item")) {
      if (ed) setRemoved(box, true);
    } else if (box.matches(".meal")) {
      const key = box.dataset.key;
      if (meals.get(key).added) deleteAdded(key);
      else removeMeal(key);
    } else deleteFood(box);
  }

  document.addEventListener("pointerdown", (e) => {
    const row = e.isPrimary && e.button === 0 && swipeRow(e.target);
    if (!row) return;
    swipe = { row, id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, active: false };
  });

  document.addEventListener("pointermove", (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (!swipe.active) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (dx > 0 || Math.abs(dy) > Math.abs(dx)) {
        swipe = null;
        return;
      }
      swipe.active = true;
      swipe.row.setPointerCapture?.(e.pointerId);
      swipe.row.parentElement.classList.add("is-swiping");
    }
    swipe.dx = Math.min(0, dx);
    swipe.row.style.transform = `translateX(${swipe.dx}px)`;
  });

  function endSwipe(e, cancelled) {
    if (!swipe || e.pointerId !== swipe.id) return;
    const { row, dx, active } = swipe;
    swipe = null;
    if (!active) return;
    swipedAt = e.timeStamp;
    const box = row.parentElement;
    const width = row.offsetWidth;
    const done = !cancelled && -dx > Math.min(110, width * 0.35);
    row.style.transition = "transform 180ms var(--ease)";
    row.style.transform = done ? `translateX(${-width}px)` : "";
    setTimeout(() => {
      row.style.transition = "";
      row.style.transform = "";
      box.classList.remove("is-swiping");
      if (done && box.isConnected) swipeDone(box);
    }, 180);
  }

  document.addEventListener("pointerup", (e) => endSwipe(e, false));
  document.addEventListener("pointercancel", (e) => endSwipe(e, true));
  // Нажатие, которым закончился свайп, не нажимает кнопки степпера и не раскрывает строку.
  document.addEventListener("click", (e) => {
    if (swipedAt === null) return;
    const late = e.timeStamp - swipedAt > 400;
    swipedAt = null;
    if (!late && e.target.closest(".ed-item, .meal, .f-item")) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  document.addEventListener("focusin", (e) => {
    if (ed && e.target.matches("[name=kcal]")) ed.fitFrom = [...ed.qtys];
  });

  // Новое название продукта сохраняется, когда уходишь из поля: нажатием «Готово» или в другое место.
  document.addEventListener("focusout", (e) => {
    if (e.target.matches(".f-rename")) renameFood(e.target.closest(".f-item"), e.target.value);
  });

  // Поле количества или калорийности после ввода показывает число в обычном виде.
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (ed && t.matches("[name=code]")) switchDish(t.value);
    if (ed && t.matches("[name=add-food], [name=add-unit]")) syncAddForm();
    if (ed && t.matches(".ed-item input")) t.value = numText(qtyOf(Number(t.closest(".ed-item").dataset.i)));
    if (ed && t.matches(".ed-missing input")) setTimeout(() => ed && refreshEditor());
    if (t.matches(".f-in input")) {
      const f = kcalTable().get(t.closest(".f-item").dataset.food);
      t.value = f?.kcal == null ? "" : numText(f.kcal);
    }
    if (t.matches("[name=food-unit]")) $(".f-per").textContent = UNIT_LABEL[t.value];
    if (t.matches("#data-file")) {
      const [file] = t.files;
      // Значение сбрасывается, чтобы повторный выбор того же файла тоже дал change.
      t.value = "";
      if (file) importData(file);
    }
  });

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t.matches(".ed-item input, .f-item input, [data-food], #food-search") && e.key === "Enter") {
      e.preventDefault();
      t.blur();
    } else if (t.matches(".f-rename") && e.key === "Escape") {
      t.value = t.defaultValue;
      t.blur();
    } else if (t.closest(".ed-add-form") && (e.key === "Enter" || e.key === "Escape")) {
      e.preventDefault();
      if (e.key === "Enter") addProduct();
      else {
        toggleAddForm(false);
        $(".ed-add-open", ed.li).focus();
      }
    } else if (t.closest(".ed-keep") && (e.key === "Enter" || e.key === "Escape")) {
      e.preventDefault();
      if (e.key === "Enter") keepDish();
      else toggleKeep(false);
    } else if (t.closest(".f-form") && (e.key === "Enter" || e.key === "Escape")) {
      e.preventDefault();
      if (e.key === "Escape") toggleFoodForm(false);
      else if (t.matches("[name=food-name]")) $("[name=food-kcal]").focus();
      else addFood();
    } else if (t.closest(".dish-editor")) {
      if (e.key === "Escape") cancelDish();
      else if (e.key === "Enter" && !e.shiftKey && t.matches("input, textarea")) {
        e.preventDefault();
        closeDish(true);
      }
    } else if (t.closest(".editor")) {
      if (e.key === "Escape") cancelEdit(t.closest(".meal").dataset.key);
      else if (e.key === "Enter" && !e.shiftKey && t.matches("input, textarea")) {
        e.preventDefault();
        saveEditor();
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
    if (document.visibilityState === "hidden") {
      commitEditor();
      commitDish();
    } else refreshDay();
  });
  window.addEventListener("pagehide", () => {
    commitEditor();
    commitDish();
  });
  setInterval(refreshDay, 60000);

  // Раньше поле «Блюдо» меняло только код, а состав оставался от прежнего блюда («B5» с гречкой из B6).
  // Такая правка получает состав выбранного блюда, как если бы его выбрали сейчас.
  function repairDishCodes() {
    let fixed = false;
    for (const [key, edit] of Object.entries(edits)) {
      const meal = meals.get(key);
      if (!meal || planTexts.has(edit.t) || edit.mode) continue;
      const { code, rest } = splitHead(edit.t);
      const origin = meals.get(edit.f)?.text || meal.text;
      if (!code || code === splitHead(origin).code) continue;
      const views = [origin, planView(meal, origin, "grams").text, planView(meal, origin, "kcal").text];
      if (!views.some((v) => splitHead(v).rest === rest)) continue;
      const text = dishText(code, rest);
      if (!text) continue;
      setEdit(meal, { t: text });
      fixed = true;
    }
    if (fixed) store(EDITS_KEY, edits);
  }

  /* Запуск */

  repairDishCodes();
  applyTheme();
  renderFeed();
  renderBase();
  renderRecipes();
  route();
  if (view === "plan") showPlan();
  if (history.state?.loaded) {
    history.replaceState(null, "");
    toast("Данные загружены");
  }
  // Шрифт меняет высоту строк, поэтому положение пересчитывается, если пользователь ещё не листал.
  document.fonts?.ready.then(() => {
    if (view === "plan" && Math.abs(window.scrollY - homeY) < 2) goHome(false);
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
