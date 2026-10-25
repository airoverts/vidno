import hashlib
import json
import math
import re
from collections import Counter
from copy import deepcopy
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from urllib.parse import urlsplit

from brand_identity import IDENTITY_NORMALIZATION_VERSION, clean_name


ANALYSIS_VERSION = "perplexity-direct-v1"
MOSCOW = timezone(timedelta(hours=3))
PROVIDERS = {
    "gigachat": "GigaChat", "yandex": "Алиса AI", "openai": "ChatGPT",
    "gemini": "Gemini", "perplexity": "Perplexity", "deepseek": "DeepSeek",
}
METHODOLOGY = [
    "Видимость — доля полученных ответов с упоминанием бренда. SoV — доля веса бренда среди всех извлечённых брендов: каждое появление имеет вес 1 / позиция. Средняя позиция считается только по извлечённым спискам. Citation Rate — доля ответов со ссылкой на указанные домены бренда; при отсутствии доменов показатель не определён.",
    "Ошибки моделей и незавершённые проверки не считаются отрицательными ответами. Проверки с прежней версией анализа и результаты без разбивки по моделям исключены. Повторные проверки учитываются отдельно. Отчёт описывает выбранную выборку, а не все ответы AI.",
]


def _key(value):
    value = clean_name(value).lower().replace("ё", "е")
    value = re.sub(r"^https?://|^www\.", "", value)
    value = re.sub(r"^www\.", "", value)
    value = re.split(r"[/?#]", value)[0]
    value = re.sub(r"\.(?:ru|ру|рф|com|net|org|io|ai)$", "", value)
    return re.sub(r"[^a-zа-я0-9]", "", value)


def _host(value):
    try:
        return (urlsplit(str(value)).hostname or "").lower().removeprefix("www.").rstrip(".")
    except ValueError:
        return ""


def _domain(value):
    return _host(value if "://" in str(value) else f"https://{value}")


def _identity(value, identities):
    token = _key(value)
    domain = _domain(value) if "." in str(value) else ""
    return next((item for item in identities if
                 token in {_key(alias) for alias in [item["canonical_name"], *(item.get("aliases") or [])]}
                 or domain and domain in {_domain(part) for part in item.get("domains") or []}), None)


def _brand_key(value, identities):
    direct = next((item for item in identities if item["canonical_id"] == value), None)
    found = direct or _identity(value, identities)
    return found["canonical_id"] if found else f"auto:{_key(value)}"


def _snapshot(value):
    return value.get("identity_normalization_version") == IDENTITY_NORMALIZATION_VERSION


def _version(value):
    return value.get("analysis_version") or value.get("analysisVersion") or ""


def _mentions(values, identities, preserve=False):
    normalized = []
    for index, value in enumerate(values or []):
        if not isinstance(value, dict):
            continue
        observed = clean_name(value.get("observed_name") or value.get("name") or value.get("company") or value.get("brand"))
        observed = re.sub(r"^\d+\s*[.)-]\s*", "", observed)
        if not re.search(r"[a-zа-яё]", observed, re.I):
            continue
        saved = (preserve or _snapshot(value)) and value.get("canonical_id") and value.get("canonical_name")
        found = None if saved else _identity(value.get("canonical_name") or observed, identities)
        name = value["canonical_name"] if saved else found["canonical_name"] if found else clean_name(value.get("canonical_name") or observed)
        key = value["canonical_id"] if saved else found["canonical_id"] if found else f"auto:{_key(name)}"
        try:
            position = float(value.get("position") or index + 1)
            if not math.isfinite(position):
                position = index + 1
        except (ValueError, TypeError):
            position = index + 1
        normalized.append({**value, "name": name, "canonical_name": name, "canonical_id": key, "observed_name": observed, "position": position})
    seen = set()
    result = []
    for item in sorted(normalized, key=lambda item: item["position"]):
        if item["canonical_id"] not in seen:
            seen.add(item["canonical_id"])
            result.append({**item, "position": len(result) + 1})
    return result


def _listed(value, identities):
    if _snapshot(value):
        return [item["name"] for item in _mentions(value.get("ordered_mentions") or value.get("orderedMentions"), identities, True)
                if item["canonical_id"] != (value.get("canonical_id") or value.get("canonicalId"))]
    values = next((value[name] for name in ("competitors", "mentioned_brands", "mentionedBrands") if isinstance(value.get(name), list)), [])
    seen = set()
    result = []
    for item in values:
        name = clean_name(item if isinstance(item, str) else item.get("name") or item.get("company") or item.get("brand")) if isinstance(item, (str, dict)) else ""
        name = re.sub(r"^\d+\s*[.)-]\s*", "", name)
        key = _brand_key(name, identities)
        if re.search(r"[a-zа-яё]", name, re.I) and key not in seen:
            result.append(name)
            seen.add(key)
    return result


def _cited(value, identity):
    if _snapshot(value) and isinstance(value.get("brand_cited"), bool):
        return value["brand_cited"]
    domains = [_domain(item) for item in identity.get("domains") or []]
    if not domains:
        return False
    for name in ("brand_cited", "brandCited"):
        if isinstance(value.get(name), bool):
            return value[name]
    for source in value.get("sources") or []:
        if isinstance(source, dict) and source.get("cited_in_answer") is False:
            continue
        host = _host(source if isinstance(source, str) else source.get("url"))
        if host and any(domain and (host == domain or host.endswith(f".{domain}")) for domain in domains):
            return True
    return False


def _normalize_result(value, identity, identities):
    value = deepcopy(value)
    preserve = _snapshot(value)
    ordered = _mentions(value.get("ordered_mentions") or value.get("orderedMentions"), identities, preserve)
    competitors = [name for name in _listed(value, identities) if _brand_key(name, identities) != identity["canonical_id"]]
    if not preserve and any(isinstance(value.get(name), list) for name in ("competitors", "mentioned_brands", "mentionedBrands")):
        allowed = {identity["canonical_id"], *(_brand_key(name, identities) for name in competitors)}
        ordered = [{**item, "position": index + 1} for index, item in enumerate(item for item in ordered if item["canonical_id"] in allowed)]
    value["ordered_mentions"] = ordered
    value["competitors"] = competitors
    if not preserve:
        value["canonical_id"] = identity["canonical_id"]
        value["canonical_name"] = identity["canonical_name"]
        value["position"] = next((item["position"] for item in ordered if item["canonical_id"] == identity["canonical_id"]), None)
    value["cited"] = _cited(value, identity)
    return value


def _ordered_for(value, identity, identities):
    supplied = value.get("ordered_mentions") or value.get("orderedMentions") or []
    if supplied:
        return _mentions(supplied, identities, _snapshot(value))
    names = _listed(value, identities)
    if value.get("mentioned"):
        index = max(0, min(len(names), int(value.get("position") or len(names) + 1) - 1))
        names.insert(index, identity["canonical_name"])
    return _mentions([{"name": name, "position": index + 1} for index, name in enumerate(names)], identities)


def _timestamp(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if not isinstance(value, datetime):
        raise ValueError("Дата проверки не сохранена")
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _percent(value, total):
    return math.floor(value / total * 100 + 0.5) if total else 0


def validate_filters(providers=None, start=None, end=None):
    selected = list(PROVIDERS) if providers is None else providers
    if not selected or any(value not in PROVIDERS for value in selected):
        raise ValueError("Выберите хотя бы одну корректную AI-модель")
    if bool(start) != bool(end) or start and start > end:
        raise ValueError("Выберите корректные даты: начало не позднее конца периода")
    return [name for name in PROVIDERS if name in selected]


def build_visibility_report(brand, checks, providers=None, start=None, end=None, identities=None, now=None):
    start = date.fromisoformat(start) if isinstance(start, str) else start
    end = date.fromisoformat(end) if isinstance(end, str) else end
    selected = validate_filters(providers, start, end)
    identities = identities or [brand]
    own_key = brand["canonical_id"]
    lower = datetime.combine(start, time.min, MOSCOW) if start else None
    upper = datetime.combine(end, time.min, MOSCOW) + timedelta(days=1) if end and end != date.max else None
    records = []
    for record in checks:
        value = record.get("result") if isinstance(record.get("result"), dict) else {}
        saved_identity = next((item for item in identities if str(item["id"]) == str(record.get("brand_id"))), None)
        saved_key = value.get("canonical_id") or (saved_identity or {}).get("canonical_id")
        belongs = saved_key == own_key if _snapshot(value) else _brand_key(record.get("brand"), identities) == own_key
        if not belongs:
            continue
        created = _timestamp(record["created_at"])
        provider = value.get("provider") or record.get("provider") or "all"
        if (lower and created < lower) or (upper and created >= upper) or provider != "all" and provider not in selected:
            continue
        records.append((record, value, provider))
    coverage = {"records": len(records), "answers": 0, "partial": 0, "errors": 0, "failed": 0, "running": 0, "excluded": 0, "excluded_answers": 0}
    answers = []
    for record, value, provider in records:
        status = record.get("status")
        for key in ("partial", "failed", "running"):
            coverage[key] += int(status == key)
        errors = value.get("provider_errors") or (record.get("error") if isinstance(record.get("error"), list) else [])
        coverage["errors"] += sum(1 for error in errors if isinstance(error, dict) and error.get("provider") in selected)
        if status not in {"completed", "partial"}:
            continue
        children = value.get("provider_results") or []
        children = [{**child, "analysis_version": _version(child) or _version(value)} if not _snapshot(value) else child for child in children if isinstance(child, dict)]
        current = [child for child in children if _version(child) == ANALYSIS_VERSION]
        if _version(value) != ANALYSIS_VERSION or provider == "all" and not current:
            coverage["excluded"] += 1
            continue
        coverage["excluded_answers"] += sum(1 for child in children if child.get("provider") in selected and _version(child) != ANALYSIS_VERSION)
        normalized = [_normalize_result(child, brand, identities) for child in current if child.get("provider") in selected] if provider == "all" else [_normalize_result({**value, "provider": provider}, brand, identities)]
        if provider == "all" and not normalized:
            continue
        answers.extend(normalized)
    coverage["answers"] = len(answers)
    rows = {own_key: {"name": brand["canonical_name"], "mentions": 0, "weight": 0, "positions": [], "variants": Counter(), "order": {}}}
    sources = Counter()
    own_mentions = sum(bool(value.get("mentioned")) for value in answers)
    citations = sum(bool(value.get("cited")) for value in answers)
    rows[own_key]["mentions"] = own_mentions
    for answer in answers:
        for mention in _ordered_for(answer, brand, identities):
            key = mention["canonical_id"]
            row = rows.setdefault(key, {"name": mention["name"], "mentions": 0, "weight": 0, "positions": [], "variants": Counter(), "order": {}})
            if key != own_key:
                row["mentions"] += 1
            row["weight"] += 1 / mention["position"]
            row["positions"].append(mention["position"])
            row["order"].setdefault(mention["name"], len(row["order"]))
            row["variants"][mention["name"]] += 1
        hosts = set()
        for source in answer.get("sources") or []:
            url = source if isinstance(source, str) else source.get("url", "")
            try:
                parsed = urlsplit(url)
                if parsed.scheme in {"http", "https"} and parsed.hostname:
                    hosts.add(parsed.hostname.removeprefix("www."))
            except ValueError:
                pass
        sources.update(hosts)
    total_weight = sum(row["weight"] for row in rows.values())
    total = len(answers)
    citation_measured = bool(brand.get("domains") or any(_snapshot(answer) and (answer.get("citation_domains") or answer.get("brand_cited") is True) for answer in answers))
    brand_rows = []
    for key, row in sorted(rows.items(), key=lambda item: (-item[1]["weight"], -item[1]["mentions"])):
        name = row["name"] if key == own_key else max(row["variants"], key=lambda name: (row["variants"][name], -row["order"][name]), default=row["name"])
        average = float(Decimal.from_float(sum(row["positions"]) / len(row["positions"])).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)) if row["positions"] else None
        brand_rows.append({"name": name, "own": key == own_key, "sov": _percent(row["weight"], total_weight) if total_weight else None, "visibility": _percent(row["mentions"], total), "position": average})
    own = next(row for row in brand_rows if row["own"])
    model_rows = []
    for provider in selected:
        group = [answer for answer in answers if answer.get("provider") == provider]
        mentions = sum(bool(answer.get("mentioned")) for answer in group)
        model_rows.append({"provider": provider, "name": PROVIDERS[provider], "answers": len(group), "mentions": mentions, "visibility": _percent(mentions, len(group)) if group else None})
    report = {
        "brand": {"id": brand["id"], "name": brand["canonical_name"]},
        "period": {"start": start.isoformat() if start else None, "end": end.isoformat() if end else None, "label": f"{start:%d.%m.%Y} — {end:%d.%m.%Y} · даты по Москве" if start else "Всё время · даты по Москве"},
        "providers": [{"id": provider, "name": PROVIDERS[provider]} for provider in selected],
        "metrics": {"sov": own["sov"] if total else None, "visibility": own["visibility"] if total else None, "citation": _percent(citations, total) if total and citation_measured else None, "position": own["position"]},
        "coverage": coverage, "models": model_rows,
        "brands": [own, *[row for row in brand_rows if not row["own"]][:5]] if total else [],
        "sources": [{"name": name, "answers": count, "share": _percent(count, total)} for name, count in sorted(sources.items(), key=lambda item: (-item[1], item[0]))[:5]],
        "citation": {"measured": citation_measured, "count": citations},
        "own_mentions": own_mentions, "methodology": METHODOLOGY,
    }
    revision_data = {"report": report, "records": [record for record, _, _ in records], "identities": identities}
    report["revision"] = hashlib.sha256(json.dumps(revision_data, ensure_ascii=False, sort_keys=True, default=str, separators=(",", ":")).encode()).hexdigest()
    report["generated_at"] = (now or datetime.now(MOSCOW)).astimezone(MOSCOW).isoformat()
    return report
