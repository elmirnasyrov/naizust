"""Сборщик чарта для «Наизусть».

Что делает:
1. Берёт топ-25 песен России из открытого чарта Apple Music (без ключа).
2. Для каждой песни спрашивает базу текстов LRCLIB, есть ли текст со временем строк
   (значит, приложение сможет нарезать музыку по фрагментам).
3. Сохраняет всё в data.json вместе с датой обновления.

Если чарт не ответил или ответил ерундой, data.json НЕ трогаем: в приложении
останется вчерашний чарт, ничего не сломается.

Запуск: python3 fetch.py (нужен только стандартный Python, без установки пакетов).
Тексты песен в data.json не попадают: только названия, исполнители и отметка «можно учить».
"""

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

CHART_URL = "https://rss.applemarketingtools.com/api/v2/ru/music/most-played/25/songs.json"
LRCLIB_URL = "https://lrclib.net/api/search"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")
HEADERS = {"User-Agent": "chart-fetcher/1.0"}
MSK = timezone(timedelta(hours=3))


def get_json(url, timeout=20, tries=3):
    """Скачать JSON. Если сеть сбоит, пробуем ещё раз через пару секунд."""
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # сеть, таймаут, битый ответ
            last = e
            time.sleep(2 * (i + 1))
    raise last


def main_artist(artist):
    """«VILLIAN & madk1d» → «VILLIAN»: в базе текстов соавторов пишут по-разному."""
    # «x» режем только между двумя именами («A x B»), иначе «МАЯК X» превратится в «МАЯК»
    return re.split(r"\s*(?:&|,|\bfeat\.?|\bft\.?)\s*|\s+[x×]\s+(?=\S)", artist, flags=re.I)[0].strip() or artist


def clean_title(title):
    """«Песня (feat. Кто-то)» → «Песня»."""
    return re.sub(r"\s*[\(\[](?:feat|ft|with)\.?[^\)\]]*[\)\]]", "", title, flags=re.I).strip() or title


def has_synced(artist, title):
    """True: в LRCLIB есть текст со временем строк. False: нет. None: база не ответила."""
    try:
        params = urllib.parse.urlencode({"track_name": clean_title(title), "artist_name": main_artist(artist)})
        found = get_json(f"{LRCLIB_URL}?{params}", timeout=15, tries=2)
        if not any(r.get("syncedLyrics") for r in found):
            # Запасной вопрос одной строкой: база иначе пишет соавторов
            params = urllib.parse.urlencode({"q": f"{main_artist(artist)} {clean_title(title)}"})
            found = get_json(f"{LRCLIB_URL}?{params}", timeout=15, tries=2)
        return any(r.get("syncedLyrics") for r in found)
    except Exception:
        return None


def main():
    try:
        feed = get_json(CHART_URL)["feed"]
        results = feed["results"]
        if len(results) < 5:
            raise ValueError(f"в чарте всего {len(results)} песен")
    except Exception as e:
        # ::warning:: GitHub покажет жёлтой плашкой в отчёте о запуске
        print(f"::warning::Чарт Apple не ответил ({e}). data.json оставлен прежним.")
        return 0

    songs = []
    for i, r in enumerate(results, 1):
        artist, title = r.get("artistName", "").strip(), r.get("name", "").strip()
        if not artist or not title:
            continue
        songs.append({
            "position": i,
            "artist": artist,
            "title": title,
            "query": f"{main_artist(artist)} {clean_title(title)}",  # что подставить в поиск приложения
            "synced": has_synced(artist, title),
        })
        time.sleep(0.3)  # не дёргаем базу текстов слишком часто

    now = datetime.now(timezone.utc)
    data = {
        "updated": now.isoformat(timespec="seconds"),
        "updated_msk": now.astimezone(MSK).strftime("%d.%m.%Y %H:%M"),
        "source": "Чарт Apple Music, Россия: самые прослушиваемые песни",
        "songs": songs,
    }
    # Пишем во временный файл и подменяем: обрыв на середине не оставит битый data.json
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, OUT)

    ok = sum(1 for s in songs if s["synced"])
    print(f"Готово: {len(songs)} песен, со временем строк {ok}. Обновлено {data['updated_msk']} МСК.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
