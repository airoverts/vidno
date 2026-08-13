import logging
import ipaddress
import re
import socket
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urljoin, urlparse
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
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_REDIRECTS = 4

_nltk_ready = None
_nltk_lock = threading.Lock()


def _ensure_nltk_data():
    global _nltk_ready
    if _nltk_ready is not None:
        return _nltk_ready
    with _nltk_lock:
        if _nltk_ready is not None:
            return _nltk_ready
        try:
            nltk.data.find("tokenizers/punkt")
            nltk.data.find("tokenizers/punkt_tab")
            _nltk_ready = True
        except LookupError:
            logger.warning("[Search] Данные NLTK punkt не установлены, используется сокращение текста")
            _nltk_ready = False
    return _nltk_ready


def _is_public_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return False
        if parsed.username or parsed.password:
            return False
        if parsed.port and parsed.port not in {80, 443}:
            return False
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
        return bool(addresses) and all(ipaddress.ip_address(item[4][0]).is_global for item in addresses)
    except (OSError, ValueError):
        return False


def estimate_authority(url: str) -> tuple[int, str]:
    try:
        domain = urlparse(url).netloc.lower()
        domain = re.sub(r"^www\.", "", domain)
    except Exception:
        return 3, "низкая"

    for known_domain, score in AUTHORITY_DOMAINS.items():
        if domain == known_domain or domain.endswith(f".{known_domain}"):
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
        if not _is_public_url(url):
            logger.warning(f"[Search] Небезопасный или некорректный URL пропущен: {url}")
            return ""

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
        current_url = url
        for _ in range(MAX_REDIRECTS + 1):
            if not _is_public_url(current_url):
                logger.warning(f"[Search] Небезопасное перенаправление заблокировано: {current_url}")
                return ""
            with requests.get(
                current_url,
                headers=headers,
                timeout=(3, PAGE_TIMEOUT),
                allow_redirects=False,
                stream=True
            ) as resp:
                if resp.is_redirect or resp.is_permanent_redirect:
                    location = resp.headers.get("Location")
                    if not location:
                        return ""
                    current_url = urljoin(current_url, location)
                    continue
                resp.raise_for_status()
                content_type = resp.headers.get("Content-Type", "").lower()
                if content_type and not any(t in content_type for t in ("text/html", "text/plain", "application/xhtml+xml")):
                    return ""
                chunks = []
                total = 0
                for chunk in resp.iter_content(chunk_size=65536):
                    total += len(chunk)
                    if total > MAX_PAGE_BYTES:
                        logger.warning(f"[Search] Страница превышает лимит размера: {current_url}")
                        return ""
                    chunks.append(chunk)
                page_html = b"".join(chunks)
                break
        else:
            logger.warning(f"[Search] Слишком много перенаправлений: {url}")
            return ""

        soup = BeautifulSoup(page_html, "html.parser")

        for tag in soup(["script", "style", "nav", "footer", "header", "aside", "iframe", "noscript"]):
            tag.decompose()

        content = soup.find("article") or soup.find("main") or soup.find("body")
        full_text = content.get_text(separator="\n", strip=True) if content else ""
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
        if not _ensure_nltk_data():
            return text[:1000]
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


def find_brand_mentions(text: str, brand: str) -> list[str]:
    if not text or not brand:
        return []

    def normalized(value: str) -> str:
        value = unicodedata.normalize("NFKC", value).casefold().replace("ё", "е")
        value = re.sub(r"[\W_]+", " ", value, flags=re.UNICODE)
        return " ".join(value.split())

    normalized_brand = normalized(brand)
    normalized_text = normalized(text)
    if not normalized_brand or not re.search(rf"(?<!\w){re.escape(normalized_brand)}(?!\w)", normalized_text):
        return []

    brand_tokens = [re.escape(token) for token in normalized_brand.split()]
    original_pattern = re.compile(rf"(?<!\w){r'[\W_]+'.join(brand_tokens)}(?!\w)", re.IGNORECASE | re.UNICODE)
    matches = []
    for match in original_pattern.finditer(unicodedata.normalize("NFKC", text).replace("ё", "е").replace("Ё", "Е")):
        start = max(0, match.start() - 120)
        end = min(len(text), match.end() + 120)
        excerpt = " ".join(text[start:end].split())
        if excerpt and excerpt not in matches:
            matches.append(excerpt)
        if len(matches) == 3:
            break
    return matches or [brand]


def apply_brand_evidence(sources: list[dict], brand: str) -> list[dict]:
    for source in sources:
        page_text = source.get("page_text", "")
        fallback_text = "\n".join(filter(None, [source.get("title", ""), source.get("snippet", "")]))
        evidence_text = "\n".join(filter(None, [fallback_text, page_text]))
        matches = find_brand_mentions(evidence_text, brand)
        source["brand_check_status"] = "found" if matches else ("not_found" if page_text else "unavailable")
        source["brand_matches"] = matches
        source["brand_check_basis"] = "page" if page_text else ("search_snippet" if matches else "unavailable")
    return sources


def collect_search_results(query: str, max_results: int = 10) -> list[dict]:
    logger.info(f"[Search] Сбор результатов из DuckDuckGo для запроса: {query[:120]!r}")

    results = []
    try:
        with DDGS() as ddgs:
            search_results = list(ddgs.text(query, max_results=max_results))
            unique_results = []
            seen_urls = set()
            for result in search_results:
                url = result.get("href", "")
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    unique_results.append(result)

            def process_result(index, result):
                url = result.get("href", "")
                snippet = result.get("body", "")
                page_text = extract_page_text(url)
                summary = summarize_text(page_text) if page_text else snippet
                auth_score, auth_label = estimate_authority(url)
                return {
                    "index": index,
                    "title": result.get("title", ""),
                    "url": url,
                    "snippet": snippet,
                    "summary": summary,
                    "page_text": page_text,
                    "authority_score": auth_score,
                    "authority_label": auth_label,
                }

            workers = min(5, len(unique_results))
            if workers:
                with ThreadPoolExecutor(max_workers=workers) as executor:
                    futures = {
                        executor.submit(process_result, i, result): i
                        for i, result in enumerate(unique_results, 1)
                    }
                    for future in as_completed(futures):
                        try:
                            results.append(future.result())
                        except Exception as e:
                            logger.warning(f"[Search] Источник {futures[future]} пропущен: {e}")
                results.sort(key=lambda item: item["index"])

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
        brand_matches = result.get("brand_matches", [])
        brand_evidence = "\nФрагменты с брендом: " + " | ".join(brand_matches) if brand_matches else ""

        part = f"""Источник {result['index']}: {result['title']}
URL: {result['url']}
Авторитетность: {auth_label} ({auth_score}/10)
Сниппет: {result.get('snippet', '')}
Выжимка: {summary}{brand_evidence}"""
        context_parts.append(part)

    return "\n\n".join(context_parts)


def collect_and_format(query: str, max_results: int = 10) -> tuple[str, list[dict]]:
    results = collect_search_results(query, max_results)
    context = format_context(results)
    return context, results
