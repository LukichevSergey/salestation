# SaleStation 🎮

Агрегатор скидок PlayStation Store (Индия 🇮🇳, Украина 🇺🇦, Турция 🇹🇷) — статический сайт на чистом HTML/CSS/JS для GitHub Pages.

- Поиск, фильтры PS4/PS5, сортировка, избранное (wishlist)
- История цены каждой игры (копится автоматически)
- RU / EN интерфейс
- Email-рассылка о новых скидках через Buttondown
- Данные обновляются каждые 6 часов через GitHub Actions (бесплатно)

## Запуск на GitHub Pages

1. Создайте репозиторий на GitHub и запушьте этот проект:
   ```bash
   git init
   git add .
   git commit -m "init: SaleStation"
   git branch -M main
   git remote add origin https://github.com/<ваш-логин>/<репозиторий>.git
   git push -u origin main
   ```
2. В репозитории: **Settings → Pages → Source: Deploy from a branch → Branch: main / (root)** → Save.
3. Через минуту сайт будет доступен по адресу `https://<ваш-логин>.github.io/<репозиторий>/`.
4. Workflow `Update PS Store deals` запустится сам по расписанию. Первый запуск можно сделать вручную: **Actions → Update PS Store deals → Run workflow**.

## Настройка рассылки (Buttondown)

1. Зарегистрируйтесь на [buttondown.com](https://buttondown.com) (бесплатно до 100 подписчиков).
2. Впишите свой логин в `js/config.js`:
   ```js
   window.APP_CONFIG = { buttondownUsername: 'ваш-логин' };
   ```
3. В Buttondown: **Settings → Programming/API** — скопируйте API-ключ.
4. В репозитории: **Settings → Secrets and variables → Actions → New repository secret**:
   - Имя: `BUTTONDOWN_API_KEY`
   - Значение: ваш ключ
5. Готово. При каждом обновлении данных скрипт найдёт новые скидки и отправит письмо подписчикам выбранного региона (подписчики сегментируются тегом `psdeals-in` / `psdeals-ua` / `psdeals-tr`).

## Локальный запуск

```bash
python3 -m http.server 8080
# откройте http://localhost:8080
```

Обновить данные вручную:

```bash
node scripts/fetch-deals.mjs
```

## Как добавить страну

Допишите одну строку в массив `REGIONS` в `scripts/fetch-deals.mjs` (locale PS Store, флаг, валюта) и запустите сборщик. Больше ничего менять не нужно — сайт подхватит регион из `data/regions.json`.

## Если данные перестали обновляться

Sony иногда меняет внутренний GraphQL-запрос каталога. Тогда в логах Actions будет ошибка `Query ... not whitelisted`. Лечение:

1. Откройте `https://store.playstation.com/en-in/category/3f772501-f6f8-49b7-abac-874a88ca4897/1` в браузере.
2. DevTools → Network → найдите запрос `categoryGridRetrieve`.
3. Скопируйте значение `extensions.persistedQuery.sha256Hash` из URL запроса.
4. Замените `QUERY_HASH` в `scripts/fetch-deals.mjs`.

## Структура

```
index.html              — сайт
css/style.css           — стили
js/config.js            — логин Buttondown
js/i18n.js              — словари RU/EN
js/app.js               — логика интерфейса
data/*.json             — данные по регионам (генерируются)
scripts/fetch-deals.mjs — сборщик цен + рассылка
.github/workflows/      — автообновление каждые 6 часов
```

---

Не аффилирован с Sony Interactive Entertainment. Данные из открытого API веб-стора PlayStation.