# tg-assistant — Telegram Mini App: ИИ-ассистент

Личный ИИ-ассистент внутри Telegram. Gemini 2.0 Flash (бесплатно, 1500 запросов/день) + Google Search + обстановка с заправками на М-12 (gdebenz.ru). Хостинг — Vercel free.

## Деплой

1. Получи ключ Gemini: https://aistudio.google.com/app/apikey
2. Vercel → New Project → Import этого репозитория → Environment Variables: `GEMINI_KEY` = твой ключ → Deploy.
3. Получишь URL вида `https://tg-assistant-xxx.vercel.app`.

## Подключение к Telegram

В @BotFather:

```
/mybots → выбрать бота → Bot Settings → Menu Button → Configure menu button
URL: https://tg-assistant-xxx.vercel.app
Текст: Ассистент
```

После этого в боте появится кнопка — открывает мини-апп.

## Структура

```
tg-assistant/
├── public/index.html   — чат-интерфейс (Telegram WebApp SDK, темы Telegram)
├── api/chat.js         — serverless backend (Gemini + googleSearch + get_fuel_status)
├── package.json
└── vercel.json
```

## Примечания

- `vercel.json` без rewrites: Vercel сам раздаёт `public/` с корня.
- Если Gemini API отклонит комбинацию googleSearch + functionDeclarations, backend автоматически повторит запрос только с инструментом заправок (fallback в коде).
