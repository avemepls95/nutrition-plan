// Тесты копии на Яндекс Диске: имя файла, загрузка в папку приложения и учёт правок, которых ещё нет на Диске.
// Запуск из корня репозитория: node --test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const DISK = require(path.join(__dirname, "..", "docs", "disk.js"));

// Ответ API Диска на запрос ссылки для загрузки, как в документации.
const LINK = {
  operation_id: "cbb77e87cc43bcdcdd2de397cd05b43368b9e2bda78eab1f94037c9c38a31e43",
  href: "https://uploader1d.dst.yandex.net:443/upload-target/20261107T080405.217.utd.52csloukwvq67nab1yc84a3xw-k1d.662",
  method: "PUT",
  templated: false,
};

const linkReply = () => new Response(JSON.stringify(LINK), { status: 200, headers: { "Content-Type": "application/json" } });
const errorReply = (status, error) =>
  new Response(JSON.stringify({ message: "Ошибка", description: error, error }), { status, headers: { "Content-Type": "application/json" } });

// fetch, который отвечает ответами replies по очереди и записывает запросы. Error бросается, как fetch при сбое сети.
function fetchOf(...replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  };
  fn.calls = calls;
  return fn;
}

test("fileName: время копии => имя файла с датой и временем по местному времени", () => {
  // Arrange
  const now = new Date(2026, 10, 7, 8, 4, 5);

  // Act
  const name = DISK.fileName(now);

  // Assert
  assert.equal(name, "План питания 2026-11-07 08-04-05.json");
});

test("upload: Диск выдал ссылку и принял файл => ok, ссылка запрошена с ключом в папку приложения, файл ушёл по ссылке без ключа", async () => {
  // Arrange
  const fetchMock = fetchOf(linkReply(), new Response(null, { status: 201 }));

  // Act
  const result = await DISK.upload("y0_token", "План питания 2026-11-07 08-04-05.json", '{"app":"nutrition-plan"}', fetchMock);

  // Assert
  assert.equal(result, "ok");
  const [link, file] = fetchMock.calls;
  const url = new URL(link.url);
  assert.equal(`${url.origin}${url.pathname}`, "https://cloud-api.yandex.net/v1/disk/resources/upload");
  assert.equal(url.searchParams.get("path"), "app:/План питания 2026-11-07 08-04-05.json");
  assert.equal(url.searchParams.get("overwrite"), "true");
  assert.equal(new Headers(link.init?.headers).get("Authorization"), "OAuth y0_token");
  assert.equal(file.url, LINK.href);
  assert.equal(file.init.method, "PUT");
  assert.equal(file.init.body, '{"app":"nutrition-plan"}');
  assert.equal(new Headers(file.init.headers).has("Authorization"), false);
});

test("upload: запросы к Диску => у обоих запросов сигнал отмены по таймауту", async () => {
  // Arrange
  const fetchMock = fetchOf(linkReply(), new Response(null, { status: 201 }));

  // Act
  await DISK.upload("y0_token", "План питания 2026-11-07 08-04-05.json", "{}", fetchMock);

  // Assert
  assert.deepEqual(
    fetchMock.calls.map((call) => call.init?.signal instanceof AbortSignal),
    [true, true],
  );
});

for (const [condition, replies, expected] of [
  ["загрузчик принял файл в обработку", [linkReply(), new Response(null, { status: 202 })], "ok"],
  ["ключ не подходит", [errorReply(401, "UnauthorizedError")], "auth"],
  ["Диск не выдал ссылку, потому что нет места", [errorReply(507, "InsufficientStorageError")], "space"],
  ["загрузчик не принял файл, потому что нет места", [linkReply(), errorReply(507, "InsufficientStorageError")], "space"],
  ["Диск временно недоступен", [errorReply(503, "ServiceUnavailableError")], 503],
  ["загрузчик не принял файл", [linkReply(), new Response(null, { status: 500 })], 500],
  ["нет связи с Диском", [new TypeError("Failed to fetch")], "network"],
  ["связь пропала во время загрузки файла", [linkReply(), new TypeError("Failed to fetch")], "network"],
  ["Диск не ответил вовремя", [new DOMException("The operation timed out.", "TimeoutError")], "network"],
]) {
  test(`upload: ${condition} => ${expected}`, async () => {
    // Arrange
    const fetchMock = fetchOf(...replies);

    // Act
    const result = await DISK.upload("y0_token", "План питания 2026-11-07 08-04-05.json", "{}", fetchMock);

    // Assert
    assert.equal(result, expected);
  });
}

for (const [condition, state, expected] of [
  ["ключа нет", { rev: 4, sent: 3 }, false],
  ["ключ есть, копий ещё не было", { token: "y0_token", rev: 1 }, true],
  ["последняя копия со всеми правками", { token: "y0_token", rev: 3, sent: 3, at: "2026-11-07T08:04:05.000Z" }, false],
  ["после последней копии была правка", { token: "y0_token", rev: 4, sent: 3, at: "2026-11-07T08:04:05.000Z" }, true],
]) {
  test(`due: ${condition} => ${expected ? "копия нужна" : "копия не нужна"}`, () => {
    // Act
    const result = DISK.due(state);

    // Assert
    assert.equal(result, expected);
  });
}

test("settle: копия ушла, а во время отправки была ещё правка => отправленной считается правка на момент сборки копии", () => {
  // Arrange
  const state = { token: "y0_token", rev: 5, sent: 3, at: "2026-11-06T20:10:00.000Z" };

  // Act
  const next = DISK.settle(state, 4, new Date("2026-11-07T08:04:05Z"), "ok");

  // Assert
  assert.deepEqual(next, { token: "y0_token", rev: 5, sent: 4, at: "2026-11-07T08:04:05.000Z" });
});

test("settle: копия ушла после неудачной попытки => ошибки прошлой попытки нет", () => {
  // Arrange
  const state = { token: "y0_token", rev: 2, sent: 1, at: "2026-11-06T20:10:00.000Z", error: "network" };

  // Act
  const next = DISK.settle(state, 2, new Date("2026-11-07T08:04:05Z"), "ok");

  // Assert
  assert.deepEqual(next, { token: "y0_token", rev: 2, sent: 2, at: "2026-11-07T08:04:05.000Z" });
});

test("settle: копия не ушла => время прошлой копии остаётся, ошибка записана", () => {
  // Arrange
  const state = { token: "y0_token", rev: 2, sent: 1, at: "2026-11-06T20:10:00.000Z" };

  // Act
  const next = DISK.settle(state, 2, new Date("2026-11-07T08:04:05Z"), 503);

  // Assert
  assert.deepEqual(next, { token: "y0_token", rev: 2, sent: 1, at: "2026-11-06T20:10:00.000Z", error: 503 });
});