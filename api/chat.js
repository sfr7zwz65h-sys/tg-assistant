const { GoogleGenerativeAI } = require("@google/generative-ai");

const genai = new GoogleGenerativeAI(process.env.GEMINI_KEY);

const ROUTES = {
  "м-12": {
    name: "М-12 «Восток»",
    waypoints: [
      ["Москва",        55.800, 37.950],
      ["Балашиха",      55.800, 38.100],
      ["Электросталь",  55.790, 38.460],
      ["Ногинск",       55.870, 38.630],
      ["Орехово-Зуево", 55.810, 38.990],
      ["Покров",        55.920, 39.180],
      ["Владимир",      56.120, 40.390],
      ["Муром",         55.580, 42.060],
      ["Арзамас",       55.390, 43.830],
      ["Ядрин",         55.940, 46.200],
      ["Шумерля",       55.490, 46.410],
      ["Чебоксары",     56.140, 47.250],
      ["Казань",        55.800, 49.100],
    ],
  },
};

async function getFuelStatus(route, fromCity, toCity) {
  route = (route || "м-12").toLowerCase().replace(/м\s*12|m\s*12/g, "м-12").trim();
  const routeData = ROUTES[route];
  if (!routeData) return `Трасса '${route}' не поддерживается. Доступна: м-12.`;

  const wps = routeData.waypoints;
  let fromIdx = 0, toIdx = wps.length - 1;
  if (fromCity) { const i = wps.findIndex(([n]) => n.toLowerCase().includes(fromCity.toLowerCase())); if (i >= 0) fromIdx = i; }
  if (toCity)   { const i = wps.findIndex(([n]) => n.toLowerCase().includes(toCity.toLowerCase()));   if (i >= 0) toIdx = i; }
  if (fromIdx > toIdx) [fromIdx, toIdx] = [toIdx, fromIdx];

  const segment = wps.slice(fromIdx, toIdx + 1);
  const responses = await Promise.allSettled(
    segment.map(([, lat, lon]) =>
      fetch(`https://gdebenz.ru/api/nearby?lat=${lat}&lon=${lon}&radius_km=45`).then(r => r.json())
    )
  );

  const seen = new Set();
  const stations = [];
  for (let i = 0; i < segment.length; i++) {
    if (responses[i].status !== "fulfilled") continue;
    for (const s of (responses[i].value.stations || [])) {
      if (!seen.has(s.osm_id)) { seen.add(s.osm_id); stations.push({ ...s, _zone: segment[i][0] }); }
    }
  }
  stations.sort((a, b) => (a.lon || 0) - (b.lon || 0));

  const cnt = { yes: 0, queue: 0, low: 0, no: 0, unknown: 0 };
  for (const s of stations) { const st = s.status; cnt[st in cnt ? st : "unknown"]++; }

  const now = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const lines = [
    `Маршрут: ${routeData.name}, ${segment[0][0]} → ${segment.at(-1)[0]}`,
    `Данные на: ${now}`,
    `АЗС всего: ${stations.length} | есть:${cnt.yes} очередь:${cnt.queue} мало:${cnt.low} нет:${cnt.no}`,
    "", "По зонам:",
  ];
  for (const [wpName] of segment) {
    const zone = stations.filter(s => s._zone === wpName && s.status);
    if (!zone.length) { lines.push(`  ${wpName}: нет данных`); continue; }
    const z = { yes: 0, queue: 0, low: 0, no: 0 };
    const okBrands = [];
    for (const s of zone) {
      if (s.status in z) z[s.status]++;
      if (["yes", "queue"].includes(s.status) && (s.brand || s.name)) okBrands.push(s.brand || s.name);
    }
    const parts = Object.entries(z).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`);
    const top = [...new Set(okBrands)].slice(0, 4).join(", ");
    lines.push(`  ${wpName}: ${parts.join(", ")} | топливо: ${top || "нет данных"}`);
  }
  return lines.join("\n");
}

const FUEL_DECL = {
  name: "get_fuel_status",
  description: "Получить обстановку с бензином/дизелем на АЗС по трассе России (gdebenz.ru). Вызывай для вопросов о заправках, бензине, топливе на трассе.",
  parameters: {
    type: "OBJECT",
    properties: {
      route:     { type: "STRING", description: "Трасса. Поддерживается: м-12" },
      from_city: { type: "STRING", description: "Начальный город (необязательно)" },
      to_city:   { type: "STRING", description: "Конечный город (необязательно)" },
    },
    required: ["route"],
  },
};

const SYSTEM_PROMPT = `Ты личный ИИ-ассистент. Отвечаешь по-русски, кратко и по делу.
Сегодня: ${new Date().toLocaleDateString("ru-RU")}.

Инструменты:
• google_search — встроенный поиск Google: используй для вопросов "где купить", "адрес", "погода", "новости", "маршрут" и т.д.
• get_fuel_status — заправки на трассах России (источник: gdebenz.ru).

Для поиска мест, магазинов, адресов — всегда используй google_search.
Для заправок на трассе — используй get_fuel_status.
Для остальных вопросов — отвечай напрямую.

Будь краток. Эмодзи умеренно.`;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { message, history = [] } = req.body || {};
  if (!message) return res.status(400).json({ error: "Нет сообщения" });

  try {
    const model = genai.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: SYSTEM_PROMPT,
      tools: [
        { googleSearch: {} },
        { functionDeclarations: [FUEL_DECL] },
      ],
    });
    const chat = model.startChat({ history });
    let result = await chat.sendMessage(message);
    let response = result.response;

    const calls = response.functionCalls?.() || [];
    for (const call of calls) {
      if (call.name === "get_fuel_status") {
        const toolResult = await getFuelStatus(call.args.route, call.args.from_city || "", call.args.to_city || "");
        result = await chat.sendMessage([{ functionResponse: { name: call.name, response: { result: toolResult } } }]);
        response = result.response;
      }
    }
    return res.json({ response: response.text() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message?.slice(0, 200) || "Внутренняя ошибка" });
  }
};