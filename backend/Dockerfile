FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt uvicorn

COPY . .

RUN cp russian_trusted_root_ca_pem.crt /usr/local/share/ca-certificates/ && update-ca-certificates || true

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
