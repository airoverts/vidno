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


def normalize_suggested_prompts(values, brand: str, limit: int = 10, require_brand_intent: bool = True) -> list[str]:
    if not isinstance(values, list):
        return []
    brand_name = " ".join(brand.split()).casefold()
    blocked = re.compile(r"\b(?:сравни|сравните|сравнение|против|versus|vs|купить)\b|\bв каком магазине\b", re.IGNORECASE)
    instructional = re.compile(r"\b(?:как\s+(?:правильно\s+)?(?:выбрать|подобрать)|на\s+что\s+обратить\s+внимание|зачем|почему)\b", re.IGNORECASE)
    brand_discovery = re.compile(r"\b(?:бренд\w*|производител\w*|марок|марки)\b", re.IGNORECASE)
    prompts = []
    seen = set()
    topic_exclusions = BRAND_TOPIC_EXCLUSIONS.get(brand_name, [])
    for value in values:
        if not isinstance(value, str):
            continue
        prompt = " ".join(value.strip().strip("«»\"'").split())
        key = prompt.casefold()
        if not 10 <= len(prompt) <= 240 or not any(char.isalpha() for char in prompt):
            continue
        if (brand_name and brand_name in key) or blocked.search(prompt) or (require_brand_intent and (instructional.search(prompt) or not brand_discovery.search(prompt))) or any(pattern.search(prompt) for pattern in topic_exclusions) or key in seen:
            continue
        seen.add(key)
        prompts.append(prompt)
    return prompts[:max(1, limit)]
