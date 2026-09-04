import re
from urllib.parse import urlsplit


def clean_name(value: str) -> str:
    return " ".join(str(value or "").split())


def safe_key(value: str) -> str:
    normalized = clean_name(value).casefold()
    normalized = re.sub(r"^https?://", "", normalized)
    normalized = re.sub(r"^www\.", "", normalized)
    normalized = re.sub(r"[/?#].*$", "", normalized)
    normalized = re.sub(r"\.(?:ru|ру|рф|com|net|org|io|ai)$", "", normalized, flags=re.IGNORECASE)
    return "".join(char for char in normalized if char.isalnum())


def normalize_domain(value: str) -> str:
    raw = clean_name(value).casefold()
    if not raw:
        return ""
    parsed = urlsplit(raw if "://" in raw else f"//{raw}")
    host = (parsed.hostname or raw.split("/", 1)[0]).strip(".")
    return host.removeprefix("www.")


def identity_values(canonical_name: str, aliases: list[str] | None = None, domains: list[str] | None = None) -> list[str]:
    values = [canonical_name, *(aliases or []), *(normalize_domain(value) for value in (domains or []))]
    unique = []
    seen = set()
    for value in values:
        normalized = clean_name(value)
        key = safe_key(normalized)
        if normalized and key and key not in seen:
            seen.add(key)
            unique.append(normalized)
    return unique


def find_observed_alias(text: str, values: list[str]) -> tuple[str | None, int]:
    best = (None, -1)
    for value in values:
        tokens = re.findall(r"[\w]+", value.casefold(), flags=re.UNICODE)
        if not tokens:
            continue
        pattern = r"(?<![\w])" + r"[^\w]*".join(re.escape(token) for token in tokens) + r"(?![\w])"
        match = re.search(pattern, text, flags=re.IGNORECASE | re.UNICODE)
        if match and (best[1] < 0 or match.start() < best[1]):
            best = (text[match.start():match.end()], match.start())
    return best


def canonicalize_analysis(analysis: dict, raw_answer: str, brand: str, canonical_id: str = "", canonical_name: str = "", aliases: list[str] | None = None, domains: list[str] | None = None, strict_direct_options: bool = False) -> dict:
    display_name = clean_name(canonical_name) or clean_name(brand)
    identity_id = clean_name(canonical_id) or safe_key(display_name)
    values = identity_values(display_name, aliases, domains)
    target_keys = {safe_key(value) for value in values}
    observed_alias, target_index = find_observed_alias(raw_answer, values)
    normalized_mentions = []
    mention_keys = set()
    target_role = analysis.get("role") or "упоминание"

    for item in analysis.get("ordered_mentions") or []:
        observed_name = clean_name(item.get("observed_name") or item.get("name"))
        if not observed_name or not any(char.isalpha() for char in observed_name):
            continue
        observed_keys = {safe_key(observed_name), safe_key(normalize_domain(observed_name))}
        is_target = bool(observed_keys.intersection(target_keys))
        observed_match, _ = find_observed_alias(raw_answer, [observed_name])
        if not is_target and not observed_match:
            continue
        if observed_match:
            observed_name = observed_match
        key = f"canonical:{identity_id}" if is_target else f"observed:{safe_key(observed_name)}"
        if key in mention_keys:
            continue
        mention_keys.add(key)
        normalized_mentions.append({
            "name": display_name if is_target else observed_name,
            "position": len(normalized_mentions) + 1,
            "role": clean_name(item.get("role")) or "упоминание",
            "observed_name": observed_name,
            "canonical_id": identity_id if is_target else safe_key(observed_name),
            "canonical_name": display_name if is_target else observed_name,
        })

    target_key = f"canonical:{identity_id}"
    if observed_alias and target_key not in mention_keys and not strict_direct_options:
        insert_at = 0
        for item in normalized_mentions:
            _, mention_index = find_observed_alias(raw_answer, [item["observed_name"]])
            if 0 <= mention_index < target_index:
                insert_at += 1
        normalized_mentions.insert(insert_at, {
            "name": display_name,
            "position": insert_at + 1,
            "role": target_role if target_role != "не упомянут" else "упоминание",
            "observed_name": observed_alias,
            "canonical_id": identity_id,
            "canonical_name": display_name,
        })
    elif not observed_alias:
        normalized_mentions = [item for item in normalized_mentions if item["canonical_id"] != identity_id]

    for position, item in enumerate(normalized_mentions, start=1):
        item["position"] = position
    matching = [item for item in normalized_mentions if item["canonical_id"] == identity_id]
    analysis["ordered_mentions"] = normalized_mentions
    analysis["mentioned"] = bool(matching)
    analysis["position"] = matching[0]["position"] if matching else None
    analysis["observed_name"] = matching[0]["observed_name"] if matching else None
    analysis["canonical_id"] = identity_id
    analysis["canonical_name"] = display_name
    analysis["mentioned_brands"] = [item["canonical_name"] for item in normalized_mentions if item["canonical_id"] != identity_id]
    analysis["competitors"] = list(analysis["mentioned_brands"])
    if not matching:
        analysis["role"] = "не упомянут"
    elif analysis.get("role") == "не упомянут":
        analysis["role"] = matching[0]["role"]
    return analysis
