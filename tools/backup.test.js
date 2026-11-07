// Тесты копии данных: сборка файла, его разбор и запись данных из файла на устройство.
// Запуск из корня репозитория: node --test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const BACKUP = require(path.join(__dirname, "..", "docs", "backup.js"));

const KEYS = ["np.v1.edits", "np.v1.weights", "np.v1.kcal", "np.v1.dishes", "np.v1.theme"];

// Хранилище с методами localStorage. quota: предел общей длины ключей и значений. Запись сверх предела
// бросает исключение и оставляет прежнее значение, как QuotaExceededError у localStorage.
function storageOf(entries, quota = Infinity) {
  const items = new Map(Object.entries(entries));
  const size = () => [...items].reduce((n, [key, value]) => n + key.length + value.length, 0);
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem(key, value) {
      const before = items.get(key);
      items.set(key, String(value));
      if (size() <= quota) return;
      if (before === undefined) items.delete(key);
      else items.set(key, before);
      throw new Error("QuotaExceededError");
    },
    removeItem: (key) => {
      items.delete(key);
    },
    all: () => Object.fromEntries(items),
  };
}

test("pack: на устройстве правки, тема и ключ другого приложения => в файле правки и тема с датой выгрузки", () => {
  // Arrange
  const storage = storageOf({
    "np.v1.edits": '{"2026-11-07#0":{"t":"B1 · 340 ккал. Овсянка 40 г"}}',
    "np.v1.theme": '"dark"',
    "other.app": "1",
  });

  // Act
  const text = BACKUP.pack(storage, KEYS, new Date("2026-11-07T12:20:00Z"));

  // Assert
  assert.deepEqual(JSON.parse(text), {
    app: "nutrition-plan",
    version: 1,
    exported: "2026-11-07T12:20:00.000Z",
    data: {
      "np.v1.edits": { "2026-11-07#0": { t: "B1 · 340 ккал. Овсянка 40 г" } },
      "np.v1.theme": "dark",
    },
  });
});

test("unpack: файл копии => данные и время выгрузки", () => {
  // Arrange
  const text = '{"app":"nutrition-plan","version":1,"exported":"2026-11-07T12:20:00.000Z","data":{"np.v1.weights":{"8":"55,2"}}}';

  // Act
  const backup = BACKUP.unpack(text);

  // Assert
  assert.deepEqual(backup, { exported: new Date("2026-11-07T12:20:00.000Z"), data: { "np.v1.weights": { "8": "55,2" } } });
});

for (const [name, text] of [
  ["не JSON", "Овсянка 40 г"],
  ["JSON null", "null"],
  ["JSON другого приложения", '{"version":1,"data":{"np.v1.weights":{"8":"55,2"}}}'],
  ["копия другой версии", '{"app":"nutrition-plan","version":2,"exported":"2026-11-07T12:20:00.000Z","data":{}}'],
]) {
  test(`unpack: ${name} => null`, () => {
    // Act
    const backup = BACKUP.unpack(text);

    // Assert
    assert.equal(backup, null);
  });
}

test("restore: в файле правки и тема => на устройстве правки и тема из файла, веса нет, ключ другого приложения на месте", () => {
  // Arrange
  const storage = storageOf({
    "np.v1.edits": '{"2026-11-01#0":{"t":"старое"}}',
    "np.v1.weights": '{"8":"55,2"}',
    "other.app": "1",
  });
  const data = { "np.v1.edits": { "2026-11-07#0": { t: "новое" } }, "np.v1.theme": "auto" };

  // Act
  const saved = BACKUP.restore(storage, KEYS, data);

  // Assert
  assert.equal(saved, true);
  assert.deepEqual(storage.all(), {
    "np.v1.edits": '{"2026-11-07#0":{"t":"новое"}}',
    "np.v1.theme": '"auto"',
    "other.app": "1",
  });
});

test("restore: на устройстве не хватило места => на устройстве прежние данные, false", () => {
  // Arrange
  // Правки из файла короче прежних, освободившееся место занимает вес из файла, на моих блюдах место кончается.
  const storage = storageOf({ "np.v1.edits": JSON.stringify({ a: "x".repeat(30) }), "np.v1.dishes": '{"d":1}', "other.app": "1" }, 80);
  const data = { "np.v1.edits": { b: 2 }, "np.v1.weights": { 8: "y".repeat(5) }, "np.v1.dishes": { d: "z".repeat(40) } };

  // Act
  const saved = BACKUP.restore(storage, KEYS, data);

  // Assert
  assert.equal(saved, false);
  assert.deepEqual(storage.all(), { "np.v1.edits": JSON.stringify({ a: "x".repeat(30) }), "np.v1.dishes": '{"d":1}', "other.app": "1" });
});
