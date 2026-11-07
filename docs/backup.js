// Копия данных приложения в файле: сборка из хранилища, разбор файла и запись данных из него на устройство.
(function (root) {
  "use strict";

  const APP = "nutrition-plan";
  const VERSION = 1;

  // Текст файла: значения ключей keys из хранилища и время выгрузки. Ключа без значения в файле нет.
  function pack(storage, keys, now) {
    const data = {};
    for (const key of keys) {
      const raw = storage.getItem(key);
      if (raw !== null) data[key] = JSON.parse(raw);
    }
    return JSON.stringify({ app: APP, version: VERSION, exported: now.toISOString(), data }, null, 2);
  }

  // Данные и время выгрузки из текста файла. null, если это не копия этого приложения или копия другой версии.
  function unpack(text) {
    let backup;
    try {
      backup = JSON.parse(text);
    } catch {
      return null;
    }
    if (backup?.app !== APP || backup.version !== VERSION) return null;
    return { exported: new Date(backup.exported), data: backup.data };
  }

  // Записывает в хранилище данные из файла вместо прежних, ключа без значения в файле на устройстве не остаётся.
  // Если записать не получилось, в хранилище возвращаются прежние данные.
  function restore(storage, keys, data) {
    const before = keys.map((key) => storage.getItem(key));
    try {
      for (const key of keys) {
        if (key in data) storage.setItem(key, JSON.stringify(data[key]));
        else storage.removeItem(key);
      }
      return true;
    } catch {
      // Прежние значения записываются после удаления всех ключей, вместе они помещались и до загрузки.
      for (const key of keys) storage.removeItem(key);
      keys.forEach((key, i) => {
        if (before[i] !== null) storage.setItem(key, before[i]);
      });
      return false;
    }
  }

  const api = { pack, unpack, restore };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BACKUP = api;
})(typeof window !== "undefined" ? window : globalThis);
