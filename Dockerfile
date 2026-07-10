FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

COPY app ./app
COPY static ./static

ENV HOST=0.0.0.0 \
    PORT=8787 \
    PATH="/app/.venv/bin:$PATH"

EXPOSE 8787
VOLUME ["/app/data"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8787"]
