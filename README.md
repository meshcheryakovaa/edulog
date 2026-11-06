# EduLOG — План и расписание

Рабочий стол диспетчера учебной части: недельный план нагрузки по группам,
преподавателям и аудиториям и сетка расписания. Приложение работает целиком
в браузере и распространяется как **один HTML-файл** без сервера.

## Открыть онлайн

Сайт: **https://meshcheryakovaa.github.io/edulog/** — обновляется
автоматически после каждого push в `main`.

## Скачать

Готовый файл `edulog.html` прикладывается к каждому
[релизу](https://github.com/meshcheryakovaa/edulog/releases/latest). Достаточно открыть его в браузере.

## Структура

```
src/
  index.html                 разметка страницы
  styles.css                 стили
  app.js                     логика приложения
  data/
    sample-plan.txt          встроенный пример плана (выгрузка .txt)
    sample-schedule.json     встроенный пример расписания (.json)
scripts/
  build.mjs                  сборка в один файл (без зависимостей)
.github/workflows/
  release.yml                CI: сборка, GitHub Pages и релизы
```

## Сборка

Нужен Node.js 18+, больше ничего устанавливать не надо.

```sh
npm run build        # или: node scripts/build.mjs
```

Результат: `dist/edulog.html`. Скрипт подставляет внутрь страницы стили,
`app.js` и примеры данных (JSON сжимается). Шрифты Google Fonts остаются
внешней ссылкой; без интернета используются системные шрифты.

Для разработки можно открыть `src/` через любой статический сервер
(`npm run dev`); встроенные примеры в этом режиме не подгружаются,
файлы плана и расписания открываются кнопкой «Открыть файлы…».

## Релиз

```sh
git tag v1.0.0
git push origin v1.0.0
```

Workflow `Build & Release` соберёт `edulog.html` и создаст GitHub Release
с этим файлом. На каждый push в `main` и на pull request файл тоже собирается
и доступен в артефактах запуска, а push в `main` публикует его на GitHub Pages.

Для работы Pages один раз включите в настройках репозитория
**Settings → Pages → Build and deployment → Source: GitHub Actions**.
