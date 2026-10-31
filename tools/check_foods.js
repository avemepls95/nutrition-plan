// Проверяет калорийность продуктов в docs/foods.js: сумма продуктов каждого блюда плана
// должна отличаться от ккал блюда не больше чем на 1,5.
// Запуск: node tools/check_foods.js
"use strict";

const path = require("path");

global.window = {};
require(path.join(__dirname, "..", "docs", "plan.js"));
const FOODS = require(path.join(__dirname, "..", "docs", "foods.js"));

const HEAD_RE = /^\s*([A-Z]{1,2}\d{1,2})\s*·\s*≈?\s*(\d+)\s*ккал\.?\s*/;
const LIMIT = 1.5;

const table = new Map(FOODS.DEFAULTS.map(([key, , unit, kcal]) => [FOODS.keyOf(key), { unit, kcal }]));
const seen = new Set();
let failed = 0;

for (const text of window.PLAN.texts) {
  const head = text.match(HEAD_RE);
  if (!head || seen.has(text)) continue;
  seen.add(text);
  let sum = 0;
  const unknown = [];
  for (const { item } of FOODS.parseBody(text.slice(head[0].length))) {
    if (!item) continue;
    const kcal = FOODS.kcalOf(item.key, item.qty, item.unit, item.factor, table);
    if (kcal === null) unknown.push(item.name);
    else sum += kcal;
  }
  const diff = sum - Number(head[2]);
  const bad = unknown.length > 0 || Math.abs(diff) > LIMIT;
  if (bad) failed++;
  const note = unknown.length ? ` нет калорийности: ${unknown.join(", ")}` : "";
  console.log(`${bad ? "✗" : "✓"} ${head[1]} ${head[2]} ккал, сумма продуктов ${sum.toFixed(1)} (${diff >= 0 ? "+" : ""}${diff.toFixed(1)})${note}`);
}

if (failed) {
  console.log(`\nНе сходится блюд: ${failed}`);
  process.exit(1);
}
console.log("\nВсе блюда сходятся.");
