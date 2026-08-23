import re


def normalize_suggested_prompts(values, brand: str) -> list[str]:
    if not isinstance(values, list):
        return []
    brand_name = " ".join(brand.split()).casefold()
    blocked = re.compile(r"\b(?:сравни|сравните|сравнение|против|versus|vs)\b|\bгде\s+(?:можно\s+)?купить\b|\bв каком магазине\b", re.IGNORECASE)
    prompts = []
    seen = set()
    for value in values:
        if not isinstance(value, str):
            continue
        prompt = " ".join(value.strip().strip("«»\"'").split())
        key = prompt.casefold()
        if not 10 <= len(prompt) <= 240 or not any(char.isalpha() for char in prompt):
            continue
        if (brand_name and brand_name in key) or blocked.search(prompt) or key in seen:
            continue
        seen.add(key)
        prompts.append(prompt)
    return prompts[:10]
