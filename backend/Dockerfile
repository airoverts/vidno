FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt uvicorn

COPY admin_cli.py answer_options.py auth.py auth_limits.py brand_identity.py cache.py database.py deepseek_client.py gemini_client.py gigachat_client.py http_boundary.py input_models.py main.py openai_client.py perplexity_client.py prompt_suggestions.py rag_analysis.py report_documents.py reports.py search_collector.py security_config.py storage.py text_analysis.py vouchers.py yandex_client.py ./
COPY report_assets/ ./report_assets/
COPY migrations/ ./migrations/
COPY russian_trusted_root_ca_pem.crt ./

RUN cp russian_trusted_root_ca_pem.crt /usr/local/share/ca-certificates/ && update-ca-certificates || true

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers"]
