// Копия данных на Яндекс Диске: имя файла копии, загрузка файла в папку приложения и учёт правок, которых ещё нет на Диске.
(function (root) {
  "use strict";

  const UPLOAD = "https://cloud-api.yandex.net/v1/disk/resources/upload";
  // Подвисшая отправка через минуту прерывается, и копия уходит при следующей попытке.
  const TIMEOUT = 60000;
  const pad = (n) => String(n).padStart(2, "0");

  // Имя файла копии по местному времени с точностью до секунды.
  function fileName(now) {
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    return `План питания ${date} ${time}.json`;
  }

  // Загружает text в файл name в папке приложения. Результат: "ok", "auth", если ключ не подходит, "space", если
  // на Диске нет места, "network", если до Диска не достучаться, иначе код ответа Диска.
  async function upload(token, name, text, fetchFn = (url, init) => fetch(url, init)) {
    const signal = AbortSignal.timeout(TIMEOUT);
    // Копия, собранная в ту же секунду, что и прошлая, получает то же имя и заменяет её.
    const url = `${UPLOAD}?path=${encodeURIComponent(`app:/${name}`)}&overwrite=true`;
    let res;
    try {
      res = await fetchFn(url, { headers: { Authorization: `OAuth ${token}` }, signal });
      if (res.ok) {
        const link = await res.json();
        // Перед PUT браузер спрашивает загрузчик о CORS, и заголовок Authorization тот не разрешает (ключ ему
        // и не нужен). Тело строкой уходит с Content-Type text/plain, этот заголовок разрешать не требуется.
        res = await fetchFn(link.href, { method: link.method, body: text, signal });
      }
    } catch {
      return "network";
    }
    if (res.ok) return "ok";
    if (res.status === 401) return "auth";
    if (res.status === 507) return "space";
    return res.status;
  }

  // Состояние копии: { token: ключ, rev: номер последней правки данных, sent: номер правки, с которой ушла последняя
  // копия, at: время последней копии, error: результат последней попытки, если она не удалась }.
  function due(state) {
    return Boolean(state.token) && state.sent !== state.rev;
  }

  // Состояние после попытки отправить копию, собранную в момент at с правкой rev. Правки, сделанные во время
  // отправки, в эту копию не попали и остаются неотправленными.
  function settle(state, rev, at, result) {
    if (result !== "ok") return { ...state, error: result };
    const { error, ...rest } = state;
    return { ...rest, sent: rev, at: at.toISOString() };
  }

  const api = { fileName, upload, due, settle };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DISK = api;
})(typeof window !== "undefined" ? window : globalThis);