(() => {
  "use strict";

  const PLAN = window.PLAN;
  const EDITS_KEY = "np.v1.edits";
  const WEIGHTS_KEY = "np.v1.weights";

  const MON_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const WD = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
  const WD_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const LABELS = { B: "завтрак", M: "обед", S: "перекус", D: "ужин", E: "вечер", F: "десерт", K: "кино" };
  const PRE_TRAINING = new Set(["S4", "F4"]);
  // По справке плана «Кофе × 2 ≈24 ккал».
  const COFFEE_KCAL = 12;

  const CODE_RE = /^\s*([A-Z]{1,2}\d{1,2})\s*·\s*/;
  const KCAL_RE = /^≈?\s*(\d+)\s*ккал\.?\s*/;
  // Объём молока и жирность в правках могут быть любыми.
  const COFFEE_RE = /\s*Кофе\s*\+\s*(\d+(?:[.,]\d+)?)\s*мл\s+молока(?:\s+(\d+(?:[.,]\d+)?)\s*%)?\.?/giu;
  // В тексте из плана после состава идут пояснения с заглавной буквы: «За 1–1,5 часа до тренировки.»
  const NOTE_RE = /\.\s+(?=[А-ЯЁA-Z])/;
  const HEBREW_RE = /\p{Script=Hebrew}+(?:\s+\p{Script=Hebrew}+)*/gu;
  const UNIT_RE = /(\d)\s+(г|мл|шт\.|ч\. л\.|ст\. л\.|кг|л)(?=[\s.,;)]|$)/g;
  const PLAIN_COFFEE = "20 мл 3%";

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const icon = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;

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

  function parse(text, withNote) {
    const { code, kcal, rest: head } = splitHead(text);
    const coffee = [...head.matchAll(COFFEE_RE)].map((m) => `${m[1]} мл${m[2] ? ` ${m[2]}%` : ""}`);
    let rest = head.replace(COFFEE_RE, "").trim();
    let note = "";
    if (withNote) {
      const cut = rest.search(NOTE_RE);
      if (cut >= 0) {
        note = rest.slice(cut + 1).trim();
        rest = rest.slice(0, cut + 1);
      }
    }
    return { code, kcal, body: rest, coffee, note };
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

  // Ккал правки без числа считаются как в плане, убранный приём пищи даёт 0.
  function dishKcal(meal) {
    const plan = splitHead(meal.text).kcal || 0;
    const edit = edits[meal.key];
    if (!edit) return plan;
    if (!edit.t.trim()) return 0;
    return splitHead(edit.t).kcal ?? plan;
  }

  const cupsKcal = (text) => COFFEE_KCAL * (text.match(COFFEE_RE) || []).length;

  // Итог из PDF уже включает кофе, поэтому к нему прибавляется только разница с планом.
  const dayTotal = (day) => day.kcal + day.meals.reduce(
    (sum, m) => sum + dishKcal(m) + cupsKcal(current(m)) - (splitHead(m.text).kcal || 0) - cupsKcal(m.text),
    0,
  );

  function relLabel(iso) {
    if (iso === today) return "сегодня";
    if (iso === shift(today, -1)) return "вчера";
    if (iso === shift(today, 1)) return "завтра";
    return "";
  }

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

  /* Разметка */

  let nextKey = null;
  const expanded = new Set();
  const withHebrew = (s) => esc(s).replace(HEBREW_RE, (m) => `<bdi lang="he" dir="rtl">${m}</bdi>`);
  // «100 г» не разрывается на две строки.
  const nbspUnits = (html) => html.replace(UNIT_RE, (_, n, unit) => `${n}\xa0${unit.replace(". ", ".\xa0")}`);

  function mealHtml(meal) {
    const edit = edits[meal.key];
    const text = current(meal);
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
    // Обычный кофе стоит значком под ккал и не занимает строку текста, другой объём молока виден в тексте.
    let cup = "";
    for (const c of p.coffee) {
      if (c === PLAIN_COFFEE && !cup) cup = `<span class="coffee">${icon("i-cup")}<span class="visually-hidden">кофе, молоко ${esc(c)}</span></span>`;
      else body += ` <span class="coffee">${icon("i-cup")}<span class="visually-hidden">кофе, молоко </span>${esc(c)}</span>`;
    }
    const source = edit?.f && meals.get(edit.f);
    if (edit) body += `<span class="m-from">${source ? `из ${esc(dayShort(source.day))}` : "правка"}</span>`;
    const name = empty ? "убрано" : plain && recipe ? recipe.name : p.body;

    let price = "";
    const planKcal = splitHead(meal.text).kcal;
    if (edit && planKcal != null && dishKcal(meal) !== planKcal) {
      price += `<s class="m-was"><span class="visually-hidden">в плане </span>${planKcal}</s>`;
    }
    if (p.kcal != null && !empty) price += `<b>${p.kcal}</b><span class="visually-hidden"> ккал</span>`;
    if (price) price = `<span class="m-kcal">${price}</span>`;

    return `<li class="${cls.join(" ")}" data-key="${esc(meal.key)}">
      <button class="meal-row" type="button" aria-expanded="false">
        <span class="m-time"><span>${esc(t1)}</span>${t2 ? `<span class="alt">${esc(t2)}</span>` : ""}</span>
        <span class="m-text"><span class="m-body">${body}</span><span class="m-name">${esc(name)}</span></span>
        <span class="m-price">${price}${cup}</span>
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
      date = `<span class="d-date"><span class="d-num">${d.getDate()}</span><span class="d-mon">${MON_SHORT[d.getMonth()]}</span></span>`;
      title = rel ? `<span>${rel}</span><span class="d-wd">${WD_SHORT[d.getDay()]}</span>` : `<span>${WD[d.getDay()]}</span>`;
    }
    if (past) title += `<svg class="d-more" aria-hidden="true"><use href="#i-down"/></svg>`;

    const sub = day.load === "Отдых"
      ? `Отдых${day.note ? ` · ${withHebrew(day.note)}` : ""}`
      : `<span class="badge">${esc(day.load)} ${esc(day.time)}</span>`;
    const main = `${date}<span class="d-main"><span class="d-title">${title}</span><span class="d-sub">${sub}</span></span>`;
    const id = past
      ? `<button class="d-id" type="button" data-toggle aria-expanded="${!brief}">${main}</button>`
      : `<div class="d-id${isBase ? " no-date" : ""}">${main}</div>`;

    const total = dayTotal(day);
    const changed = total !== day.kcal;
    const what = isBase ? day.name.toLowerCase() : dayShort(day);

    return `<section class="${cls.join(" ")}" data-day="${esc(day.id)}" aria-label="${esc(cap(what))}">
      <header class="day-head">
        ${id}
        <span class="d-total${changed ? " is-changed" : ""}">
          <span class="d-kcal">${changed ? `<s class="d-was"><span class="visually-hidden">в плане </span>${day.kcal}</s>` : ""}<b>${total}</b><small>ккал</small></span>
          <span class="d-water">${day.water} стаканов воды</span>
        </span>
        <button class="copy" type="button" aria-label="Скопировать состав: ${esc(what)}">${icon("i-copy")}</button>
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
    const p = parse(current(meal), isPlain(meal));
    const recipe = p.code && recipes.get(p.code);
    const parts = [];
    if (recipe) parts.push(`<p class="p-title"><span class="m-sku">${esc(recipe.code)}</span>${esc(recipe.name)}</p>`);
    if (p.note) parts.push(`<p class="p-note">${esc(p.note)}</p>`);
    if (recipe) for (const step of recipe.steps) parts.push(`<p>${esc(step)}</p>`);
    if (edit) parts.push(`<p class="p-orig"><b>В плане</b>${esc(meal.text)}</p>`);
    const actions = [`<button class="btn" type="button" data-act="edit">Изменить</button>`];
    if (meal.day.iso) actions.push(`<button class="btn" type="button" data-act="swap">Поменять</button>`);
    if (edit) actions.push(`<button class="btn" type="button" data-act="reset">Как в плане</button>`);
    return `<div class="meal-panel">${parts.join("")}<div class="p-actions">${actions.join("")}</div></div>`;
  }

  function editorHtml(meal) {
    const text = current(meal);
    // У убранного приёма пищи код и ккал подставляются из плана.
    const { code, kcal } = splitHead(text.trim() ? text : meal.text);
    const rest = text.trim() ? splitHead(text).rest : "";
    const options = mealCodes.some((r) => r.code === code) || !code ? mealCodes : [{ code, name: "" }, ...mealCodes];
    const select = options
      .map((r) => `<option value="${esc(r.code)}"${r.code === code ? " selected" : ""}>${esc(r.code)}${r.name ? ` · ${esc(r.name)}` : ""}</option>`)
      .join("");
    return `<div class="meal-panel editor">
      <div class="ed-fields">
        <label class="ed-field ed-code">Код<select name="code"><option value="">без кода</option>${select}</select></label>
        <label class="ed-field">Ккал<input name="kcal" value="${kcal ?? ""}" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" enterkeyhint="done"></label>
      </div>
      <textarea name="comp" rows="3" enterkeyhint="done" aria-label="Состав">${esc(rest)}</textarea>
      <div class="p-actions">
        <button class="btn primary" type="button" data-act="save">Сохранить</button>
        <button class="btn" type="button" data-act="cancel">Отмена</button>
      </div>
    </div>`;
  }

  function editorValue(li) {
    const kcal = $("[name=kcal]", li).value.replace(/\D/g, "");
    return compose($("[name=code]", li).value, kcal, $("[name=comp]", li).value);
  }

  /* Отрисовка */

  const feed = $("#feed");
  const dayEl = (day) => document.querySelector(`[data-day="${CSS.escape(day.id)}"]`);
  const mealEl = (key) => document.querySelector(`[data-key="${CSS.escape(key)}"]`);
  const barHeight = () => $(".bar").offsetHeight;

  function renderFeed() {
    nextKey = nextMeal()?.key ?? null;
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

  function noAnim(li, fn) {
    const row = li.querySelector(".meal-row");
    row.classList.add("no-anim");
    fn();
    void row.offsetWidth;
    row.classList.remove("no-anim");
  }

  // Наклейка ложится на новую правку и снимается при возврате к плану.
  function animate(keys) {
    for (const key of keys) {
      const li = mealEl(key);
      if (!li) continue;
      if (edits[key]) noAnim(li, () => li.classList.remove("is-edited"));
      else noAnim(li, () => li.classList.add("is-edited"));
      requestAnimationFrame(() => li.classList.toggle("is-edited", Boolean(edits[key])));
    }
  }

  function rerender(keys, anchorKey) {
    const anchor = anchorKey && mealEl(anchorKey);
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    const touched = new Set(keys.map((k) => meals.get(k).day));
    for (const day of touched) {
      const el = dayEl(day);
      if (el) el.outerHTML = dayHtml(day);
    }
    if (anchor) {
      const after = mealEl(anchorKey);
      if (after) window.scrollBy(0, after.getBoundingClientRect().top - before);
    }
    if ([...touched].some((d) => d.iso === today)) observeToday();
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

  function setEdit(meal, text, from) {
    const t = text.replace(/\s*\n\s*/g, " ").trim();
    if (t === meal.text) {
      delete edits[meal.key];
      return;
    }
    edits[meal.key] = from && from !== meal.key ? { t, f: from } : { t };
  }

  let openKey = null;
  // Текст приёма пищи на момент открытия редактора.
  let editStart = null;

  // Как в заметках iOS: черновик сохраняется, когда уходишь из редактора или сворачиваешь приложение.
  function commitEditor() {
    const li = openKey && mealEl(openKey);
    if (!li || !$(".editor", li)) return;
    const meal = meals.get(openKey);
    const before = current(meal);
    setEdit(meal, editorValue(li), edits[openKey]?.f);
    if (current(meal) !== before) persist();
  }

  function closePanel() {
    if (!openKey) return;
    commitEditor();
    const key = openKey;
    const li = mealEl(key);
    const changed = editStart !== null && current(meals.get(key)) !== editStart;
    openKey = null;
    editStart = null;
    document.body.classList.remove("is-editing");
    if (!li) return;
    li.classList.remove("is-open");
    li.querySelector(".meal-row").setAttribute("aria-expanded", "false");
    li.querySelector(".meal-panel")?.remove();
    if (changed) rerender([key], key);
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
      editStart = current(meal);
      const ta = $("textarea", li);
      autosize(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    const rect = li.getBoundingClientRect();
    const overflow = rect.bottom - (window.innerHeight - 16);
    if (overflow > 0) window.scrollBy({ top: Math.min(overflow, rect.top - barHeight() - 8), behavior: "smooth" });
  }

  // Черновик мог уже сохраниться при сворачивании, «Отмена» возвращает текст на момент открытия.
  function cancelEdit(key) {
    const meal = meals.get(key);
    mealEl(key).querySelector(".editor").remove();
    if (editStart !== null && current(meal) !== editStart) {
      setEdit(meal, editStart, edits[key]?.f);
      persist();
    }
    editStart = null;
    openPanel(key, false);
  }

  function autosize(ta) {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 3}px`;
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
    setEdit(a, textB, fromB);
    setEdit(b, textA, fromA);
    const saved = persist();
    rerender([source, target], target);
    if (!saved) return;
    toast("Приёмы пищи поменялись местами", "Отменить", () => {
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

  async function copyDay(day, btn) {
    const text = day.meals.map((m) => copyLine(current(m))).filter(Boolean).join("\n");
    if (!(await writeClipboard(text))) {
      toast("Не получилось скопировать");
      return;
    }
    const use = $("use", btn);
    btn.classList.add("is-done");
    use.setAttribute("href", "#i-check");
    setTimeout(() => {
      btn.classList.remove("is-done");
      use.setAttribute("href", "#i-copy");
    }, 1600);
    toast(`Скопировано: ${dayShort(day)}`);
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
    homeY = Math.round(el.getBoundingClientRect().top + window.scrollY - barHeight());
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

  let view = "plan";
  // План ещё не показывался, если приложение открыли сразу на рецептах или справке.
  let planScroll = null;

  function showPlan() {
    if (planScroll === null) goHome(false);
    else window.scrollTo(0, planScroll);
    syncWeek();
    observeToday();
  }

  function route() {
    const next = location.hash === "#recipes" ? "recipes" : location.hash === "#info" ? "info" : "plan";
    if (next === view) return;
    if (view === "plan" && homeY >= 0) planScroll = window.scrollY;
    endSwap();
    closePanel();
    view = next;
    document.body.dataset.view = next;
    for (const name of ["plan", "recipes", "info"]) $(`#view-${name}`).hidden = name !== next;
    $("#sub-title").textContent = next === "recipes" ? "Рецепты" : next === "info" ? "Справка" : "";
    $("#to-today").hidden = true;
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
    const jump = t.closest("[data-jump]");
    if (jump) {
      document.getElementById(jump.dataset.jump).scrollIntoView();
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
      else if (name === "save") closePanel();
      else if (name === "reset") resetEdit(key);
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
    if (t.matches(".editor textarea")) autosize(t);
    if (t.matches("[data-week]")) {
      const value = t.value.trim();
      if (value) weights[t.dataset.week] = value;
      else delete weights[t.dataset.week];
      if (!store(WEIGHTS_KEY, weights)) toast("Не получилось сохранить вес на устройстве");
    }
  });

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t.closest(".editor")) {
      if (e.key === "Escape") cancelEdit(t.closest(".meal").dataset.key);
      else if (e.key === "Enter" && !e.shiftKey && t.matches("input, textarea")) {
        e.preventDefault();
        closePanel();
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
  window.addEventListener("pagehide", commitEditor);
  setInterval(refreshDay, 60000);

  /* Запуск */

  renderFeed();
  renderBase();
  renderRecipes();
  route();
  if (view === "plan") showPlan();
  // Шрифт цифр меняет высоту строк, поэтому положение пересчитывается, если пользователь ещё не листал.
  document.fonts?.ready.then(() => {
    if (view === "plan" && Math.abs(window.scrollY - homeY) < 2) goHome(false);
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
