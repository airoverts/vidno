import logging
import re
from urllib.parse import urlparse
from ddgs import DDGS
import requests
from bs4 import BeautifulSoup
from sumy.parsers.plaintext import PlaintextParser
from sumy.nlp.tokenizers import Tokenizer
from sumy.summarizers.text_rank import TextRankSummarizer
from sumy.nlp.stemmers import Stemmer
from sumy.utils import get_stop_words
import nltk

logger = logging.getLogger(__name__)

AUTHORITY_DOMAINS = {
    "forbes.com": 10, "forbes.ru": 10,
    "rbc.ru": 9, "vedomosti.ru": 9, "kommersant.ru": 9,
    "tass.ru": 9, "ria.ru": 9, "interfax.ru": 9,
    "habr.com": 8, "vc.ru": 8, "tjournal.ru": 8,
    "3dnews.ru": 7, "ixbt.com": 7, "ferra.ru": 7,
    "cnews.ru": 7, "xakep.ru": 7,
    "lenta.ru": 8, "gazeta.ru": 8, "iz.ru": 7,
    "techcrunch.com": 9, "theverge.com": 9, "wired.com": 9,
    "arstechnica.com": 8, "engadget.com": 8,
}

HIGH_AUTHORITY_PATTERNS = [
    "news", "media", "journal", "magazine", "review",
    "expert", "analytics", "research", "gov", "edu",
]

LANGUAGE = "russian"
SENTENCES_COUNT = 6
PAGE_TIMEOUT = 8


def _ensure_nltk_data():
    try:
        nltk.data.find("tokenizers/punkt")
    except LookupError:
        nltk.download("punkt", quiet=True)
    try:
        nltk.data.find("tokenizers/punkt_tab")
    except LookupError:
        nltk.download("punkt_tab", quiet=True)


_ensure_nltk_data()


def estimate_authority(url: str) -> tuple[int, str]:
    try:
        domain = urlparse(url).netloc.lower()
        domain = re.sub(r"^www\.", "", domain)
    except Exception:
        return 3, "низкая"

    for known_domain, score in AUTHORITY_DOMAINS.items():
        if known_domain in domain:
            label = "высокая" if score >= 8 else "средняя"
            return score, label

    for pattern in HIGH_AUTHORITY_PATTERNS:
        if pattern in domain:
            return 6, "средняя"

    if any(domain.endswith(tld) for tld in [".gov", ".edu", ".ac.ru", ".org"]):
        return 7, "средняя"

    return 3, "низкая"


def extract_page_text(url: str) -> str:
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
        resp = requests.get(url, headers=headers, timeout=PAGE_TIMEOUT)
        resp.raise_for_status()
        resp.encoding = resp.apparent_encoding or "utf-8"

        soup = BeautifulSoup(resp.text, "html.parser")

        for tag in soup(["script", "style", "nav", "footer", "header", "aside", "iframe", "noscript"]):
            tag.decompose()

        paragraphs = soup.find_all("p")
        text_parts = []
        for p in paragraphs:
            t = p.get_text(strip=True)
            if len(t) > 20:
                text_parts.append(t)

        if not text_parts:
            body = soup.find("body")
            if body:
                text_parts = [body.get_text(separator="\n", strip=True)]

        full_text = "\n".join(text_parts)
        full_text = re.sub(r"\n{3,}", "\n\n", full_text)
        full_text = re.sub(r" {2,}", " ", full_text)

        return full_text.strip()

    except Exception as e:
        logger.warning(f"[Search] Не удалось извлечь текст с {url}: {e}")
        return ""


def summarize_text(text: str, sentences_count: int = SENTENCES_COUNT) -> str:
    if not text or len(text) < 100:
        return text or ""

    try:
        parser = PlaintextParser.from_string(text, Tokenizer(LANGUAGE))
        stemmer = Stemmer(LANGUAGE)
        summarizer = TextRankSummarizer(stemmer)
        try:
            summarizer.stop_words = get_stop_words(LANGUAGE)
        except Exception:
            summarizer.stop_words = set()

        sentence_count = min(sentences_count, len(list(parser.document.sentences)))
        if sentence_count < 1:
            return text[:500]

        summary_sentences = summarizer(parser.document, sentence_count)
        summary = " ".join(str(s) for s in summary_sentences)
        return summary

    except Exception as e:
        logger.warning(f"[Search] Ошибка суммаризации: {e}")
        return text[:500]


def collect_search_results(query: str, max_results: int = 10) -> list[dict]:
    logger.info(f"[Search] Сбор результатов из DuckDuckGo для запроса: {query}")

    results = []
    try:
        with DDGS() as ddgs:
            search_results = list(ddgs.text(query, max_results=max_results))

            for i, result in enumerate(search_results, 1):
                url = result.get("href", "")
                snippet = result.get("body", "")

                page_text = extract_page_text(url)
                summary = summarize_text(page_text) if page_text else snippet

                auth_score, auth_label = estimate_authority(url)

                results.append({
                    "index": i,
                    "title": result.get("title", ""),
                    "url": url,
                    "snippet": snippet,
                    "summary": summary,
                    "authority_score": auth_score,
                    "authority_label": auth_label,
                })

        logger.info(f"[Search] Собрано {len(results)} источников")

    except Exception as e:
        logger.error(f"[Search] Ошибка при сборе данных: {e}")

    return results


def format_context(search_results: list[dict]) -> str:
    if not search_results:
        return ""

    context_parts = []
    for result in search_results:
        summary = result.get("summary", result.get("snippet", ""))
        auth_score = result.get("authority_score", 3)
        auth_label = result.get("authority_label", "низкая")

        part = f"""Источник {result['index']}: {result['title']}
URL: {result['url']}
Авторитетность: {auth_label} ({auth_score}/10)
Сниппет: {result.get('snippet', '')}
Выжимка: {summary}"""
        context_parts.append(part)

    return "\n\n".join(context_parts)


def collect_and_format(query: str, max_results: int = 10) -> tuple[str, list[dict]]:
    results = collect_search_results(query, max_results)
    context = format_context(results)
    return context, results
