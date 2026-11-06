// Тесты пересчёта состава под свою калорийность продуктов и истории калорийности.
// Запуск из корня репозитория: node --test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const FOODS = require(path.join(__dirname, "..", "docs", "foods.js"));

const defaults = new Map(FOODS.DEFAULTS.map(([key, , unit, kcal]) => [FOODS.keyOf(key), { unit, kcal }]));
const tableWith = (values) => {
  const table = new Map([...defaults].map(([id, entry]) => [id, { ...entry }]));
  for (const [id, kcal] of Object.entries(values)) table.set(id, { ...table.get(id), kcal });
  return table;
};

test("adapt: своя калорийность кефира, держим ккал => граммовка кефира меняется, ккал те же", () => {
  // Arrange
  const parts = FOODS.parseBody("кефир 1,5% 200 мл.");
  const table = tableWith({ "кефир 1,5%": 50 });

  // Act
  const result = FOODS.adapt(parts, table, defaults, true);

  // Assert
  assert.deepEqual(result, { qtys: [172], extra: 0 });
});

test("adapt: своя калорийность яиц, держим ккал => штуки округляются до десятых", () => {
  // Arrange
  const parts = FOODS.parseBody("яйца 2 шт.; масло 3 г");
  const table = tableWith({ "яйца": 90 });

  // Act
  const result = FOODS.adapt(parts, table, defaults, true);

  // Assert
  assert.equal(result.qtys[0], 1.7);
  assert.equal(result.qtys[1], undefined);
  assert.ok(Math.abs(result.extra - 3) < 1e-9);
});

test("adapt: своя калорийность хлеба, держим ккал => граммы округляются до целых, ккал отходят на остаток", () => {
  // Arrange
  const parts = FOODS.parseBody("хлеб 25 г");
  const table = tableWith({ "хлеб": 265 });

  // Act
  const result = FOODS.adapt(parts, table, defaults, true);

  // Assert
  assert.equal(result.qtys[0], 24);
  assert.ok(Math.abs(result.extra - 1.1) < 1e-9);
});

test("adapt: граммовка уходит почти в ноль, держим ккал => остаётся хотя бы 1 г", () => {
  // Arrange
  const parts = FOODS.parseBody("масло 3 г");
  const table = tableWith({ "масло": 6000 });

  // Act
  const result = FOODS.adapt(parts, table, defaults, true);

  // Assert
  assert.equal(result.qtys[0], 1);
});

test("adapt: своя калорийность кефира, держим граммовку => граммовка та же, ккал растут на разницу", () => {
  // Arrange
  const parts = FOODS.parseBody("кефир 1,5% 200 мл.");
  const table = tableWith({ "кефир 1,5%": 50 });

  // Act
  const result = FOODS.adapt(parts, table, defaults, false);

  // Assert
  assert.equal(result.qtys.length, 0);
  assert.ok(Math.abs(result.extra - 14) < 1e-9);
});

test("adapt: своей калорийности нет => состав и ккал как были", () => {
  // Arrange
  const parts = FOODS.parseBody("овсянка 45 г; молоко 3% 140 мл; банан 100 г.");

  // Act
  const result = FOODS.adapt(parts, defaults, defaults, true);

  // Assert
  assert.deepEqual(result, { qtys: [], extra: 0 });
});

test("adapt: кофе, калорийность по умолчанию => ккал кофе целиком в добавке", () => {
  // Arrange
  const parts = FOODS.parseBody("овсянка 45 г; банан 100 г. Кофе + 20 мл молока 3%.");

  // Act
  const result = FOODS.adapt(parts, defaults, defaults, true);

  // Assert
  assert.deepEqual(result, { qtys: [], extra: 12 });
});

test("adapt: кофе, своя калорийность молока, держим ккал => объём молока в кофе тот же, ккал кофе по своей калорийности", () => {
  // Arrange
  const parts = FOODS.parseBody("Кофе + 20 мл молока 3%.");
  const table = tableWith({ "молоко 3%": 64 });

  // Act
  const result = FOODS.adapt(parts, table, defaults, true);

  // Assert
  assert.equal(result.qtys.length, 0);
  assert.ok(Math.abs(result.extra - 12.8) < 1e-9);
});

test("adapt: свой продукт с калорийностью, держим ккал => граммовка та же, ккал продукта целиком в добавке", () => {
  // Arrange
  const parts = FOODS.parseBody("ряженка 200 мл");
  const table = tableWith({ "ряженка|г": 60 });

  // Act
  const result = FOODS.adapt(parts, table, defaults, true);

  // Assert
  assert.equal(result.qtys.length, 0);
  assert.ok(Math.abs(result.extra - 120) < 1e-9);
});

test("adapt: свой продукт без калорийности => добавки нет", () => {
  // Arrange
  const parts = FOODS.parseBody("ряженка 200 мл");

  // Act
  const result = FOODS.adapt(parts, defaults, defaults, false);

  // Assert
  assert.deepEqual(result, { qtys: [], extra: 0 });
});

const kefir = FOODS.parseBody("кефир 1,5% 172 мл.")[0].item;
const eggs = FOODS.parseBody("яйца 1,7 шт.")[0].item;

test("stepQty: шаг вниз проходит через количество точки отсчёта => останавливается на нём", () => {
  // Act
  const qty = FOODS.stepQty(kefir, 180, -1, 172);

  // Assert
  assert.equal(qty, 172);
});

test("stepQty: шаг вверх от количества точки отсчёта => следующее по сетке", () => {
  // Act
  const qty = FOODS.stepQty(kefir, 172, 1, 172);

  // Assert
  assert.equal(qty, 180);
});

test("stepQty: количество точки отсчёта за пределами шага => обычный шаг по сетке", () => {
  // Act
  const qty = FOODS.stepQty(kefir, 165, 1, 172);

  // Assert
  assert.equal(qty, 170);
});

test("stepQty: штуки, шаг вниз через количество точки отсчёта => останавливается на нём", () => {
  // Act
  const qty = FOODS.stepQty(eggs, 2, -1, 1.7);

  // Assert
  assert.equal(qty, 1.7);
});

const hist = [["2026-10-25", 50], ["2026-11-01", 45]];

test("valueAt: день раньше первой записи => своего значения нет", () => {
  // Act
  const value = FOODS.valueAt(hist, "2026-10-24");

  // Assert
  assert.equal(value, undefined);
});

test("valueAt: день записи => значение с этого дня", () => {
  // Act
  const value = FOODS.valueAt(hist, "2026-10-25");

  // Assert
  assert.equal(value, 50);
});

test("valueAt: день между записями => значение предыдущей записи", () => {
  // Act
  const value = FOODS.valueAt(hist, "2026-10-31");

  // Assert
  assert.equal(value, 50);
});

test("valueAt: день после последней записи => последнее значение", () => {
  // Act
  const value = FOODS.valueAt(hist, "2026-11-05");

  // Assert
  assert.equal(value, 45);
});

test("withValue: второе значение в тот же день => запись дня заменяется", () => {
  // Act
  const result = FOODS.withValue([["2026-11-01", 50]], "2026-11-01", 45);

  // Assert
  assert.deepEqual(result, [["2026-11-01", 45]]);
});

test("withValue: значение в следующий день => новая запись, старая остаётся для прошлых дней", () => {
  // Act
  const result = FOODS.withValue([["2026-10-25", 50]], "2026-11-01", 45);

  // Assert
  assert.deepEqual(result, [["2026-10-25", 50], ["2026-11-01", 45]]);
});

test("withValue: возврат к умолчанию в день записи => истории нет", () => {
  // Act
  const result = FOODS.withValue([["2026-11-01", 50]], "2026-11-01", null);

  // Assert
  assert.deepEqual(result, []);
});

test("withValue: возврат к умолчанию в следующий день => запись null с этого дня", () => {
  // Act
  const result = FOODS.withValue([["2026-10-25", 50]], "2026-11-01", null);

  // Assert
  assert.deepEqual(result, [["2026-10-25", 50], ["2026-11-01", null]]);
});

test("withValue: то же значение, что уже действует => история не меняется", () => {
  // Act
  const result = FOODS.withValue([["2026-10-25", 50]], "2026-11-01", 50);

  // Assert
  assert.deepEqual(result, [["2026-10-25", 50]]);
});

test("withValue: значение в прошлый день перед записью с тем же значением => записи сливаются", () => {
  // Act
  const result = FOODS.withValue([["2026-11-01", 60]], "2026-10-30", 60);

  // Assert
  assert.deepEqual(result, [["2026-10-30", 60]]);
});

test("segmentText: одно яйцо => «яйцо 1 шт.»", () => {
  // Act
  const result = FOODS.segmentText("яйца", 1, "шт.");

  // Assert
  assert.equal(result, "яйцо 1 шт.");
});

test("segmentText: полпачки попкорна => «½ пачки»", () => {
  // Act
  const result = FOODS.segmentText("попкорн Just a Moment", 0.5, "пачка");

  // Assert
  assert.equal(result, "попкорн Just a Moment ½ пачки");
});

test("addSegment: состав с кофе в конце => продукт встаёт перед кофе", () => {
  // Act
  const result = FOODS.addSegment("овсянка 45 г; банан 100 г. Кофе + 20 мл молока 3%.", "огурец 100 г");

  // Assert
  assert.equal(result, "овсянка 45 г; банан 100 г; огурец 100 г. Кофе + 20 мл молока 3%.");
});

test("addSegment: пояснение после «шт.» => предложение заканчивается после нового продукта", () => {
  // Act
  const result = FOODS.addSegment("банан 100 г; батончик Nestlé Fitness 1 шт. За 1–1,5 часа до тренировки.", "хлеб 25 г");

  // Assert
  assert.equal(result, "банан 100 г; батончик Nestlé Fitness 1 шт.; хлеб 25 г. За 1–1,5 часа до тренировки.");
});

test("addSegment: состав без точки в конце => продукт через точку с запятой", () => {
  // Act
  const result = FOODS.addSegment("яйца 2 шт.; масло 3 г", "хлеб 25 г");

  // Assert
  assert.equal(result, "яйца 2 шт.; масло 3 г; хлеб 25 г");
});

test("addSegment: остался только кофе => продукт перед кофе", () => {
  // Act
  const result = FOODS.addSegment("Кофе + 20 мл молока 3%.", "банан 100 г");

  // Assert
  assert.equal(result, "банан 100 г. Кофе + 20 мл молока 3%.");
});

test("addSegment: пустой состав => один продукт с точкой", () => {
  // Act
  const result = FOODS.addSegment("", "кефир 1,5% 200 мл");

  // Assert
  assert.equal(result, "кефир 1,5% 200 мл.");
});

test("addSegment: добавленный продукт разбирается как продукт с количеством", () => {
  // Act
  const parts = FOODS.parseBody(FOODS.addSegment("банан 100 г. Кофе + 20 мл молока 3%.", "огурец 100 г"));

  // Assert
  assert.deepEqual(parts.filter((p) => p.item).map((p) => [p.item.key, p.item.qty]), [["банан", 100], ["огурец", 100], ["кофе|молоко 3%", 20]]);
});

test("addSegment: «шт.» перед кофе => после нового продукта точка перед кофе", () => {
  // Act
  const result = FOODS.addSegment("яйца 2 шт. Кофе + 20 мл молока 3%.", "огурец 100 г");

  // Assert
  assert.equal(result, "яйца 2 шт.; огурец 100 г. Кофе + 20 мл молока 3%.");
});

test("addSegment: «шт.» перед частью через «;» => новый продукт без точки", () => {
  // Act
  const result = FOODS.addSegment("яйца 2 шт.; соль по вкусу", "хлеб 25 г");

  // Assert
  assert.equal(result, "яйца 2 шт.; хлеб 25 г; соль по вкусу");
});

test("addSegment: кофе => встаёт в конец отдельным предложением", () => {
  // Act
  const result = FOODS.addSegment("овсянка 45 г; яйца 2 шт.", FOODS.coffeeText("молоко 3%", 20));

  // Assert
  assert.equal(result, "овсянка 45 г; яйца 2 шт. Кофе + 20 мл молока 3%.");
});

test("parseBody: кофе после состава => отдельный продукт, количество это объём молока", () => {
  // Act
  const parts = FOODS.parseBody("банан 100 г. Кофе + 20 мл молока 3%.");

  // Assert
  const { name, key, qty, unit, milk } = parts[1].item;
  assert.deepEqual({ sep: parts[1].sep, name, key, qty, unit, milk }, { sep: " ", name: "кофе с молоком 3%", key: "кофе|молоко 3%", qty: 20, unit: "мл", milk: "молоко 3%" });
});

test("parseBody: кофе без пробелов и с дробной жирностью => тоже продукт", () => {
  // Act
  const parts = FOODS.parseBody("Кофе+30мл молока 1,5%.");

  // Assert
  assert.deepEqual([parts[0].item.qty, parts[0].item.milk], [30, "молоко 1,5%"]);
});

test("foodId: кофе с молоком плана => калорийность молока плана", () => {
  // Act
  const id = FOODS.foodId("кофе|молоко 3%", "мл");

  // Assert
  assert.equal(id, "молоко 3%");
});

test("foodId: кофе с молоком не из плана => своё молоко", () => {
  // Act
  const id = FOODS.foodId("кофе|молоко 1%", "мл");

  // Assert
  assert.equal(id, "молоко 1%|г");
});

test("compose: у кофе стало больше молока => фраза кофе с новым объёмом", () => {
  // Arrange
  const parts = FOODS.parseBody("банан 100 г. Кофе + 20 мл молока 3%.");

  // Act
  const result = FOODS.compose(parts, [undefined, 30]);

  // Assert
  assert.equal(result, "банан 100 г. Кофе + 30 мл молока 3%.");
});

test("compose: кофе убран => состав заканчивается точкой", () => {
  // Arrange
  const parts = FOODS.parseBody("овсянка 45 г; банан 100 г. Кофе + 20 мл молока 3%.");

  // Act
  const result = FOODS.compose(parts, [undefined, undefined, 0]);

  // Assert
  assert.equal(result, "овсянка 45 г; банан 100 г.");
});

test("delta: у кофе стало больше молока => ккал растут по молоку", () => {
  // Arrange
  const before = FOODS.parseBody("Кофе + 20 мл молока 3%.");

  // Act
  const result = FOODS.delta(before, [{ item: before[0].item, qty: 30 }], defaults);

  // Assert
  assert.deepEqual(result, { kcal: 6, missing: [] });
});
