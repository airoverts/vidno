import re


def analyze_answer(brand: str, answer: str) -> dict:
    pattern = re.compile(rf"(?<!\w){re.escape(brand)}(?!\w)", re.IGNORECASE)
    sentences = [sentence.strip() for sentence in re.split(r"[.!?]+", answer) if sentence.strip()]
    context = None
    position = None

    for index, sentence in enumerate(sentences, 1):
        if pattern.search(sentence):
            position = index
            context = sentence
            break

    role = "не упомянут"
    if context:
        normalized = context.casefold()
        if any(word in normalized for word in ["рекомендую", "советую", "лучший", "топ", "стоит обратить"]):
            role = "рекомендация"
        elif any(word in normalized for word in ["альтернатива", "вместо", "конкурент", "сравн"]):
            role = "сравнение"
        elif any(word in normalized for word in ["например", "такие как", "включая"]):
            role = "упоминание в списке"
        else:
            role = "упоминание"

    return {
        "mentioned": context is not None,
        "position": position,
        "total_sentences": len(sentences),
        "context": context,
        "role": role,
    }
