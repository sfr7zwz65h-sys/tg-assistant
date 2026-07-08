// Serverless backend: Gemini (новый SDK @google/genai, поддерживает auth-ключи AQ.*)
const { GoogleGenAI } = require("@google/genai");

const MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"];

const SYSTEM_PROMPT = `Ты личный ИИ-ассистент. Отвечаешь по-русски, кратко и по делу.
Инструменты:
• google_search — встроенный поиск Google: используй для вопросов "где купить", "адрес", "погода", "новости", "маршрут"
• get_fuel_status — заправки на трассах России (источник: gdebenz.ru)
Для поиска мест, магазинов, адресов — всегда используй google_search.
Для заправок на трассе — используй get_fuel_status.
Для остальных вопросов — отвечай напрямую.
Будь краток. Эмодзи умеренно.`;

const FUEL_DECL = {
  name: "get_fuel_status",
  description:
    "Получить обстановку с бензином/дизелем на АЗС по трассе России (данные от водителей, gdebenz.ru). Вызывай для вопросов о заправках, бензине, топливе на трассе.",
  parameters: {
    type: "OBJECT",
    properties: {
      route: { type: "STRING", description: "Трасса. Поддерживается: м-12" },
      from_city: { type: "STRING", description: "Начальный город (необязательно)" },
      to_city: { type: "STRING", description: "Конечный город (необязательно)" },
    },
    required: ["route"],
  },
};

const ROUTES = {
  "м-12": {
    name: "М-12 «Восток»",
    waypoints: [
      ["Москва", 55.800, 37.950],
      ["Балашиха", 55.800, 38.100],
      ["Электросталь", 55.790, 38.460],
      ["Ногинск", 55.870, 38.630],
      ["Орехово-Зуево", 55.810, 38.990],
      ["Покров", 55.920, 39.180],
      ["Владимир", 56.120, 40.390],
      ["Муром", 55.580, 42.060],
      ["Арзамас", 55.390, 43.830],
      ["Ядрин", 55.940, 46.200],
      ["Шумерля", 55.490, 46.410],
      ["Чебоксары", 56.140, 47.250],
      ["Казань", 55.800, 49.100],
    ],
  },
};

const STATUS_LABEL = {
  yes: "✅ есть",
  queue: "⏳ очередь",
  low: "⚠️ мало",
  no: "❌ нет",
};

async function getFuelStatus(route, fromCity, toCity) {
  const key = String(route || "").toLowerCase().replace(/\s+/g, "").replace("m", "м");
  const r = ROUTES[key] || ROUTES["м-12"];

  let waypoints = r.waypoints;
  const idxOf = (city) =>
    city
      ? waypoints.findIndex((w) => w[0].toLowerCase().includes(String(city).toLowerCase()))
      : -1;
  const i1 = idxOf(fromCity);
  const i2 = idxOf(toCity);
  if (i1 >= 0 && i2 >= 0) {
    waypoints = waypoints.slice(Math.min(i1, i2), Math.max(i1, i2) + 1);
  }

  const results = await Promise.allSettled(
    waypoints.map(([name, lat, lon]) =>
      fetch(`https://gdebenz.ru/api/nearby?lat=${lat}&lon=${lon}&radius_km=45`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => ({ zone: name, data }))
    )
  );

  const seen = new Set();
  const zones = [];
  for (const res of results) {
    if (res.status !== "fulfilled" || !res.value.data) continue;
    const { zone, data } = res.value;
    const stations = (data.stations || []).filter((s) => {
      if (!s.osm_id || seen.has(s.osm_id)) return false;
      seen.add(s.osm_id);
      return true;
    });
    stations.sort((a, b) => (a.lon || 0) - (b.lon || 0));
    if (stations.length) zones.push({ zone, stations });
  }

  if (!zones.length) return `По трассе ${r.name} данных о заправках сейчас нет.`;

  const lines = [`⛽ Обстановка на ${r.name} (по данным водителей, gdebenz.ru):`];
  for (const z of zones) {
    lines.push(`\n📍 Зона: ${z.zone}`);
    for (const s of z.stations.slice(0, 8)) {
      const status = STATUS_LABEL[s.status] || "❓ нет данных";
      const fuels = Array.isArray(s.fuels_now) && s.fuels_now.length ? ` (${s.fuels_now.join(", ")})` : "";
      lines.push(`  • ${s.brand || s.name || "АЗС"}: ${status}${fuels}`);
    }
  }
  return lines.join("\n");
}

async function runChat(ai, model, tools, history, message) {
  const contents = [...history, { role: "user", parts: [{ text: message }] }];
  for (let i = 0; i < 4; i++) {
    const resp = await ai.models.generateContent({
      model,
      contents,
      config: { systemInstruction: SYSTEM_PROMPT, tools },
    });
    const calls = resp.functionCalls || [];
    if (!calls.length) return resp.text || "";
    contents.push(resp.candidates[0].content);
    const parts = [];
    for (const call of calls) {
      if (call.name === "get_fuel_status") {
        const { route, from_city, to_city } = call.args || {};
        const report = await getFuelStatus(route, from_city, to_city);
        parts.push({ functionResponse: { name: call.name, response: { report } } });
      }
    }
    if (!parts.length) return resp.text || "";
    contents.push({ role: "user", parts });
  }
  return "Не удалось получить ответ, попробуйте ещё раз.";
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { message, history = [] } = req.body || {};
    if (!message) return res.status(400).json({ error: "message is required" });

    const apiKey = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY || process.env.geminikey;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_KEY не настроен" });

    const ai = new GoogleGenAI({ apiKey });

    let lastError;
    for (const model of MODELS) {
      for (const tools of [
        [{ googleSearch: {} }, { functionDeclarations: [FUEL_DECL] }],
        [{ functionDeclarations: [FUEL_DECL] }],
      ]) {
        try {
          const text = await runChat(ai, model, tools, history, message);
          return res.status(200).json({ response: text });
        } catch (e) {
          lastError = e;
          const msg = String(e.message || e);
          if (/not found|NOT_FOUND|404/i.test(msg)) break;
        }
      }
    }
    throw lastError;
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Ошибка сервера: " + (err.message || err) });
  }
};
