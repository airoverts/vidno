import json
import re


BRAND_TOPIC_EXCLUSIONS = {
    "demix": [
        re.compile(r"\b(?:спортивн\w*\s+)?(?:штаны|брюки)\b", re.IGNORECASE),
        re.compile(r"\b(?:недорог\w*\s+)?спортивн\w*\s+одежд\w*\b", re.IGNORECASE),
        re.compile(r"\b(?:йог\w*|пилатес\w*|леггинс\w*)\b", re.IGNORECASE),
        re.compile(r"\b(?:спортивн\w*|дорожн\w*)\s+сумк\w*\b", re.IGNORECASE),
    ],
}

BRAND_CURATED_PROMPTS = {
    "demix": [
        "Какой бренд кроссовок лучше выбрать для бега по асфальту?",
        "Бутсы какого производителя лучше подходят для игры на искусственном газоне?",
        "Какой бренд спортивных костюмов стоит выбрать для активного отдыха?",
    ],
}


def excluded_topics(brand: str) -> list[str]:
    if " ".join(brand.split()).casefold() != "demix":
        return []
    return ["спортивные штаны и брюки", "общая или недорогая спортивная одежда", "одежда для йоги и пилатеса, леггинсы", "спортивные и дорожные сумки"]


def curated_prompts(brand: str) -> list[str]:
    return list(BRAND_CURATED_PROMPTS.get(" ".join(brand.split()).casefold(), []))


def parse_prompt_payload(value: str) -> dict:
    text = str(value or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text).strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict) and isinstance(parsed.get("prompts"), list):
            return parsed
    except json.JSONDecodeError:
        pass
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            parsed, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and isinstance(parsed.get("prompts"), list):
            return parsed
    raise ValueError("GigaChat не вернул JSON с промптами")


def _mentions_excluded_name(prompt: str, names) -> bool:
    for name in names:
        if not isinstance(name, str):
            continue
        name = re.sub(r"^https?://(?:www\.)?|^www\.", "", name.strip(), flags=re.IGNORECASE).rstrip("/")
        letters = re.sub(r"[\W_]", "", name)
        if not letters:
            continue
        pattern = r"(?<!\w)" + r"[\W_]*".join(re.escape(char) for char in letters) + r"(?!\w)"
        if re.search(pattern, prompt, flags=re.IGNORECASE):
            return True
    return False


def _has_named_shortlist(prompt: str) -> bool:
    category_acronyms = {"CRM", "ERP", "API", "SMM", "SEO", "VPN", "VPS", "VDS", "СБП", "ЖК", "ИП", "ООО", "ИИ", "AI"}
    named = r"[A-ZА-ЯЁ][\w-]*(?:\s+[A-ZА-ЯЁ][\w-]*)*"
    for match in re.finditer(rf"\b(?i:чем|например|вместо|наподобие|такой\s+как|такие\s+как)\s*[,:]?\s*[«\"']?({named})\b", prompt):
        if any(part not in category_acronyms for part in match.group(1).split()):
            return True
    for match in re.finditer(rf"\b({named})\s*(?:,\s*|\s+(?:или|и|либо)\s+)({named})\b", prompt):
        names = [word for part in match.groups() for word in part.split() if word not in {"Какие", "Какая", "Какой", "Что"}]
        selection_context = re.search(r"(?:\b(?:из|между|среди|например|выбрать|лучше|подойдут)|[:,])\s*$", prompt[:match.start()], re.IGNORECASE)
        if selection_context and any(part not in category_acronyms for part in names):
            return True
    return False


def _visible_recommendation(prompt: str) -> str:
    prompt = re.sub(r"(?<=[?.!])\s+Назови\s+(?:3\s*[–—-]\s*5|(?:ровно\s+)?5|пять)\s+конкретных вариантов и кратко объясни, чем подходит каждый\.?$", "", prompt, flags=re.IGNORECASE).strip()
    if re.search(r"\b(?:\d+(?:\s*[–—-]\s*\d+)?|три|четыре|пять)\s+(?:конкретн\w*\s+)?(?:вариант\w*|предложени\w*|рекомендаци\w*|банков|компани\w*|сервис\w*|производител\w*|решени\w*|бренд\w*)\b", prompt, re.IGNORECASE):
        return ""
    return prompt


def normalize_suggested_prompts(values, brand: str, limit: int = 10, require_brand_intent: bool = True, *, clarify_recommendations: bool = False, excluded_names=None) -> list[str]:
    if not isinstance(values, list):
        return []
    brand_name = " ".join(brand.split()).casefold()
    blocked = re.compile(r"\b(?:сравни|сравните|сравнение|против|versus|vs|купить)\b|\bв каком магазине\b", re.IGNORECASE)
    instructional = re.compile(r"\b(?:как\s+(?:правильно\s+)?(?:выбрать|подобрать)|на\s+что\s+обратить\s+внимание|зачем|почему)\b", re.IGNORECASE)
    instruction_only = re.compile(r"^(?:как\s+(?:правильно\s+)?(?:выбрать|подобрать)|на\s+что\s+обратить\s+внимание|зачем|почему)\b", re.IGNORECASE)
    brand_discovery = re.compile(r"\b(?:бренд\w*|производител\w*|марок|марки)\b", re.IGNORECASE)
    prompts = []
    seen = set()
    topic_exclusions = BRAND_TOPIC_EXCLUSIONS.get(brand_name, [])
    for value in values:
        if not isinstance(value, str):
            continue
        prompt = " ".join(value.strip().strip("«»\"'").split())
        if clarify_recommendations:
            prompt = _visible_recommendation(prompt)
        key = prompt.casefold()
        if not 10 <= len(prompt) <= 240 or not any(char.isalpha() for char in prompt):
            continue
        if (not clarify_recommendations and brand_name and brand_name in key) or blocked.search(prompt) or (require_brand_intent and (instructional.search(prompt) or not brand_discovery.search(prompt))) or any(pattern.search(prompt) for pattern in topic_exclusions):
            continue
        if clarify_recommendations:
            if instruction_only.search(prompt) or _mentions_excluded_name(prompt, [brand, *(excluded_names or [])]) or _has_named_shortlist(prompt):
                continue
        key = prompt.casefold()
        if key in seen:
            continue
        seen.add(key)
        prompts.append(prompt)
    return prompts[:max(1, limit)]
