// Продукты в составе приёма пищи: разбор на продукт и количество, пересчёт ккал при смене количества,
// пересчёт состава под свою калорийность и история своей калорийности по дням.
(function (root) {
  "use strict";

  // Калорийность по умолчанию: ккал на 100 г, на 100 мл, на 1 шт. или на 1 пачку.
  // Подобрана по справке и рецептам плана: сумма продуктов каждого блюда отличается от его ккал не больше чем на 1,5.
  const DEFAULTS = [
    ["батат", "Батат", "г", 86, "сырой"],
    ["батончик Nestlé Fitness", "Батончик Nestlé Fitness", "шт.", 78],
    ["банан", "Банан", "г", 89],
    ["гречка", "Гречка", "г", 342, "сухая"],
    ["грибной порошок", "Грибной порошок", "г", 300],
    ["йогурт 1,5%", "Йогурт 1,5%", "г", 73],
    ["йогуртовый соус", "Йогуртовый соус", "г", 74, "SA1"],
    ["картофель", "Картофель", "г", 77, "сырой"],
    ["кефир 1,5%", "Кефир 1,5%", "мл", 43],
    ["кетчуп", "Кетчуп", "г", 100],
    ["козья гауда", "Козья гауда", "г", 405],
    ["курица", "Курица", "г", 119, "сырая"],
    ["кускус", "Кускус", "г", 370, "сухой"],
    ["макароны", "Макароны", "г", 355, "сухие"],
    ["масло", "Масло", "г", 900],
    ["мёд", "Мёд", "г", 304],
    ["молоко 3%", "Молоко 3%", "мл", 60],
    ["овсянка", "Овсянка", "г", 370],
    ["огурец", "Огурец", "г", 15],
    ["пельмени «Сибирские» с индейкой", "Пельмени «Сибирские» с индейкой", "г", 204, "замороженные"],
    ["печенье Gullón María", "Печенье Gullón María", "шт.", 27.7],
    ["пита", "Пита", "г", 250, "цельнозерновая"],
    ["помидор", "Помидор", "г", 19],
    ["попкорн Just a Moment", "Попкорн Just a Moment", "пачка", 380],
    ["Pringles Sour Cream & Onion", "Pringles Sour Cream & Onion", "г", 535],
    ["рис", "Рис", "г", 360, "сухой"],
    ["сметана 15%", "Сметана 15%", "г", 160],
    ["тахини", "Тахини", "г", 600],
    ["творог", "Творог", "г", 121, "5%"],
    ["тёмный шоколад 70%", "Тёмный шоколад 70%", "г", 580],
    ["хлеб", "Хлеб", "г", 250, "цельнозерновой"],
    ["яблоко", "Яблоко", "г", 52],
    ["яйца", "Яйца", "шт.", 75, "размер M"],
  ];

  const ALIASES = { "яйцо": "яйца", "чай + печенье gullón maría": "печенье gullón maría" };

  const FRACTIONS = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };
  const NUM = "(\\d+(?:[.,]\\d+)?|[½¼¾⅓⅔])";
  // Первое число с единицей измерения в части состава: «молоко 3% 140 мл» → 140 мл, «Кофе+20 мл» → 20 мл.
  const QTY_RE = new RegExp(`(^|[\\s(+])${NUM}(\\s*)(кг|г|мл|л|шт\\.?|пач(?:ка|ки|ку|ек))(?=$|[\\s.,;:)])`, "u");
  // Пояснение после количества («сырая / ≈90 г готовая», «(≈20 шт.)») заканчивается там, где начинается новое предложение.
  const SENTENCE_RE = /^\s+(?=[А-ЯЁA-Z])|\.\s+(?=[А-ЯЁA-Z])|\.\s*$/u;
  const ANNOT_RE = new RegExp(`(≈\\s*)?${NUM}(\\s*)(г|мл|шт\\.?|ч\\.\\s?л\\.|ст\\.\\s?л\\.)`, "gu");
  const UNITS = {
    г: ["г", 1], кг: ["г", 1000], мл: ["мл", 1], л: ["мл", 1000],
    "шт.": ["шт.", 1], шт: ["шт.", 1], пачка: ["пачка", 1], пачки: ["пачка", 1], пачку: ["пачка", 1], пачек: ["пачка", 1],
  };

  // Кофе после завтрака и обеда пишется отдельным предложением: «Кофе + 20 мл молока 3%.» Его ккал считаются
  // по молоку. Объём молока и жирность в правках могут быть любыми.
  const COFFEE = "кофе\\s*\\+\\s*(?<ml>\\d+(?:[.,]\\d+)?)\\s*мл\\s+молока(?:\\s+(?<fat>\\d+(?:[.,]\\d+)?)\\s*%)?";
  const COFFEE_RE = new RegExp(`\\s*${COFFEE}\\.?`, "giu");
  const COFFEE_START_RE = new RegExp(`^\\s*${COFFEE}`, "iu");
  // Ключ кофе в составе: «кофе|молоко 3%». Калорийность у него как у молока.
  const COFFEE_KEY = "кофе|";

  const num = (s) => FRACTIONS[s] ?? Number(s.replace(",", "."));

  function fmt(n) {
    if (Math.abs(n - 0.5) < 1e-9) return "½";
    return String(Math.round(n * 10) / 10).replace(".", ",");
  }

  const keyOf = (name) => {
    const k = name.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").replace(/^[\s+,.:;—-]+|[\s,.:;—-]+$/g, "");
    const alias = Object.keys(ALIASES).find((a) => a.replace(/ё/g, "е") === k);
    return alias ? ALIASES[alias].replace(/ё/g, "е") : k;
  };

  function packWord(n) {
    if (!Number.isInteger(n)) return "пачки";
    if (n % 10 === 1 && n % 100 !== 11) return "пачка";
    if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return "пачки";
    return "пачек";
  }

  // Часть состава: продукт с количеством или просто текст.
  function parseSegment(text) {
    const m = text.match(QTY_RE);
    if (!m) return { text };
    const numStart = m.index + m[1].length;
    const name = text.slice(0, numStart).trim();
    if (!/\p{L}/u.test(name)) return { text };
    const unitEnd = numStart + m[0].length - m[1].length;
    const rest = text.slice(unitEnd);
    const cut = rest.search(SENTENCE_RE);
    const [unit, factor] = UNITS[m[4]] || UNITS[m[4].replace(/\.$/, "")];
    const item = {
      name,
      key: keyOf(name),
      qty: num(m[2]),
      unit,
      factor,
      head: text.slice(0, numStart),
      space: m[3],
      unitWord: m[4],
      annot: cut < 0 ? rest : rest.slice(0, cut),
      tail: cut < 0 ? "" : rest.slice(cut),
    };
    // Количество у кофе это объём молока.
    const coffee = text.match(COFFEE_START_RE);
    if (coffee) {
      item.milk = coffee.groups.fat ? `молоко ${coffee.groups.fat}%` : "молоко";
      item.name = `кофе с ${item.milk.replace(/^молоко/, "молоком")}`;
      item.key = COFFEE_KEY + keyOf(item.milk);
    }
    return { text, item };
  }

  // Состав без кода и ккал: «овсянка 45 г; молоко 3% 140 мл; банан 100 г. Кофе + 20 мл молока 3%.»
  // Продукты разделены «;», кофе становится отдельной частью.
  function parseBody(body) {
    const pieces = body.split(/(;\s*|\s+(?=кофе\s*\+))/iu);
    const parts = [];
    for (let i = 0; i < pieces.length; i += 2) parts.push({ sep: i ? pieces[i - 1] : "", ...parseSegment(pieces[i]) });
    return parts;
  }

  function scaleAnnot(annot, ratio) {
    return annot.replace(ANNOT_RE, (all, approx, n, space, unit) => {
      const exact = num(n) * ratio;
      const step = /^(г|мл)$/.test(unit) ? 1 : 0.5;
      const value = Math.round(exact / step) * step;
      if (value <= 0) return all;
      const sign = approx || Math.abs(value - exact) > 1e-9 ? "≈" : "";
      return `${sign}${fmt(value)}${space}${unit}`;
    });
  }

  function segmentWith(item, qty) {
    let head = item.head;
    if (item.key === "яйца") head = head.replace(/^(\s*)(я)(йц[оа])/iu, (_, s, y) => `${s}${y}${qty === 1 ? "йцо" : "йца"}`);
    const unit = item.unit === "пачка" ? packWord(qty) : item.unitWord;
    return `${head}${fmt(qty)}${item.space}${unit}${scaleAnnot(item.annot, qty / item.qty)}${item.tail}`;
  }

  // Часть состава для нового продукта: «огурец 100 г», «яйцо 1 шт.», «попкорн Just a Moment ½ пачки».
  function segmentText(name, qty, unit) {
    let text = name.trim();
    if (keyOf(text) === "яйца") text = text.replace(/^(я)(йц[оа])/iu, (_, y) => `${y}${qty === 1 ? "йцо" : "йца"}`);
    return `${text} ${fmt(qty)} ${unit === "пачка" ? packWord(qty) : unit}`;
  }

  // Кофе для добавления в состав: «Кофе + 20 мл молока 3%».
  const coffeeText = (milk, qty) => `Кофе + ${fmt(qty)} мл ${milk.replace(/^молоко/, "молока")}`;

  // Добавляет часть в конец состава, после последнего продукта и перед тем, что идёт за ним:
  // «; огурец 100 г. Кофе + 20 мл молока 3%.» или «; огурец 100 г. За 1–1,5 часа до тренировки.»
  // Кофе встаёт в самый конец отдельным предложением.
  function addSegment(body, segment) {
    const text = body.trim();
    if (COFFEE_START_RE.test(segment)) return text ? `${text.replace(/[\s.;]+$/, "")}. ${segment}.` : `${segment}.`;
    const parts = parseBody(text);
    let i = parts.length - 1;
    while (i >= 0 && (!parts[i].item || parts[i].item.milk)) i--;
    if (i < 0) {
      if (!text) return `${segment}.`;
      // Остался только кофе или пояснение: продукт встаёт перед ним.
      if (/^[А-ЯЁA-Z]/u.test(text) || COFFEE_START_RE.test(text)) return `${segment}. ${text}`;
      return `${text.replace(/[\s.]+$/, "")}; ${segment}.`;
    }
    const { item } = parts[i];
    const head = parts[i].text.slice(0, parts[i].text.length - item.tail.length);
    // «1 шт. Десерт-вечер: …» и «2 шт. Кофе + …»: точка стояла в «шт.», после нового продукта предложение
    // заканчивается заново.
    const next = parts[i + 1];
    const endsSentence = /^\s+\S/u.test(item.tail) || (!item.tail && /\.$/.test(head) && next && !next.sep.includes(";"));
    const tail = endsSentence ? `.${item.tail}` : item.tail;
    parts[i] = { ...parts[i], text: `${head}; ${segment}${tail}` };
    return parts.map((p, j) => (j ? p.sep : "") + p.text).join("");
  }

  // Собирает состав заново. qtys: новое количество для каждой части (undefined, если не менялось).
  // Продукт с количеством 0 убирается, его пояснение после точки остаётся.
  function compose(parts, qtys) {
    let out = "";
    let first = true;
    parts.forEach((part, i) => {
      const q = qtys[i];
      if (!part.item || q === undefined || q === part.item.qty) {
        out += (first ? "" : part.sep) + part.text;
        first = false;
      } else if (q > 0) {
        out += (first ? "" : part.sep) + segmentWith(part.item, q);
        first = false;
      } else if (part.item.tail.trim()) {
        // Пояснение после убранного продукта («. Десерт-вечер: …») переходит к соседу. Точка могла стоять
        // в «шт.» убранного продукта, поэтому предложение заканчивается заново.
        const tail = part.item.tail.replace(/^[\s.]+/, "");
        out = out ? `${out.replace(/[\s.]+$/, "")}.${tail ? ` ${tail}` : ""}` : tail;
        if (out) first = false;
      }
    });
    return out;
  }

  // Граммы и миллилитры считаются один к одному, штуки и пачки отдельно.
  const unitKind = (unit) => (unit === "г" || unit === "мл" ? "г" : unit);
  const defaultUnits = new Map(DEFAULTS.map(([key, , unit]) => [keyOf(key), unit]));

  // Ключ в таблице калорийности: продукт плана в его единицах или «продукт|единица»
  // для своих продуктов и для продукта плана в других единицах («банан 1 шт.»). У кофе ключ его молока.
  function foodId(key, unit) {
    const food = key.startsWith(COFFEE_KEY) ? key.slice(COFFEE_KEY.length) : key;
    const def = defaultUnits.get(food);
    return def && unitKind(def) === unitKind(unit) ? food : `${food}|${unitKind(unit)}`;
  }

  // Ккал количества продукта: на 100 г или 100 мл, на штуку или на пачку.
  function kcalOf(key, qty, unit, factor, kcalTable) {
    const entry = kcalTable.get(foodId(key, unit));
    if (!entry || entry.kcal == null) return null;
    const amount = qty * factor;
    return unitKind(unit) === "г" ? (amount * entry.kcal) / 100 : amount * entry.kcal;
  }

  // Сколько ккал добавляет смена состава: продукты, которых стало больше или меньше.
  // missing: продукты без калорийности, у которых поменялось количество.
  function delta(beforeParts, afterItems, kcalTable) {
    const sums = new Map();
    const add = (item, qty, sign) => {
      const id = `${item.key}|${unitKind(item.unit)}`;
      const s = sums.get(id) || { item, qty: 0 };
      s.qty += sign * qty * item.factor;
      sums.set(id, s);
    };
    for (const p of beforeParts) if (p.item) add(p.item, p.item.qty, -1);
    for (const { item, qty } of afterItems) add(item, qty, 1);
    let kcal = 0;
    const missing = [];
    for (const { item, qty } of sums.values()) {
      if (Math.abs(qty) < 1e-9) continue;
      const k = kcalOf(item.key, qty, item.unit, 1, kcalTable);
      if (k === null) missing.push(item);
      else kcal += k;
    }
    return { kcal, missing };
  }

  // Граммы и миллилитры до целых, штуки, пачки, килограммы и литры до десятых, как числа пишутся в составе.
  function roundQty(item, qty) {
    const whole = item.factor === 1 && unitKind(item.unit) === "г";
    const q = whole ? Math.round(qty) : Math.round(qty * 10) / 10;
    return Math.max(whole ? 1 : 0.1, q);
  }

  // Состав под свою калорийность продуктов. table: калорийность в этот день, defaults: по умолчанию.
  // keepKcal: граммовка продукта меняется так, чтобы его ккал остались как по калорийности по умолчанию,
  // иначе граммовка прежняя. qtys: новое количество по номеру части. extra: сколько прибавить к ккал из текста
  // состава. Они посчитаны по калорийности по умолчанию без своих продуктов и без кофе, поэтому ккал своего
  // продукта и кофе целиком входят в extra, а граммовка кофе не подстраивается.
  function adapt(parts, table, defaults, keepKcal) {
    const qtys = [];
    let extra = 0;
    parts.forEach(({ item }, i) => {
      if (!item) return;
      const kcal = (qty, t) => kcalOf(item.key, qty, item.unit, item.factor, t);
      const def = item.milk ? null : kcal(item.qty, defaults);
      const now = kcal(item.qty, table);
      let qty = item.qty;
      if (keepKcal && def && now && now !== def) {
        qty = roundQty(item, (item.qty * def) / now);
        qtys[i] = qty;
      }
      extra += (kcal(qty, table) ?? 0) - (def ?? 0);
    });
    return { qtys, extra };
  }

  // Своя калорийность на день по истории [[дата, ккал или null], ...] в порядке дат.
  // undefined: своей калорийности на этот день ещё нет. null: с этого дня калорийность по умолчанию.
  function valueAt(hist, iso) {
    let value;
    for (const [from, k] of hist) {
      if (from > iso) break;
      value = k;
    }
    return value;
  }

  // История после того, как с дня from вписали value (null: калорийность по умолчанию).
  // Запись с тем же значением, что действует до неё, ничего не меняет и убирается.
  function withValue(hist, from, value) {
    const entries = [...hist.filter(([d]) => d !== from), [from, value]].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out = [];
    let prev = null;
    for (const [d, k] of entries) {
      if (k === prev) continue;
      out.push([d, k]);
      prev = k;
    }
    return out;
  }

  function stepOf(item, qty, down) {
    const q = down ? qty - 1e-6 : qty;
    if (item.unit === "шт." || item.unit === "пачка") return q < 1 ? 0.5 : 1;
    // Килограммы и литры по 100 г или 100 мл.
    if (item.factor !== 1) return 0.1;
    if (q < 10) return 1;
    if (q < 50) return 5;
    return 10;
  }

  // base: количество в точке отсчёта. Подстроенная граммовка не лежит на сетке шагов, поэтому шаг через неё
  // останавливается на ней.
  function stepQty(item, qty, dir, base) {
    const step = stepOf(item, qty, dir < 0);
    const next = dir > 0 ? Math.floor(qty / step + 1e-9) * step + step : Math.ceil(qty / step - 1e-9) * step - step;
    const value = Math.max(0, Math.round(next * 10) / 10);
    return base !== undefined && (base - qty) * (base - value) < 0 ? base : value;
  }

  const api = { DEFAULTS, COFFEE_RE, keyOf, unitKind, foodId, parseBody, segmentText, coffeeText, addSegment, compose, kcalOf, delta, adapt, valueAt, withValue, stepQty, fmt, num };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FOODS = api;
})(typeof window !== "undefined" ? window : globalThis);
