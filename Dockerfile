FROM python:3.13-slim-bookworm

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY accbot/ /app/accbot/
COPY tests/ /app/tests/

VOLUME ["/data"]
CMD ["python", "-m", "accbot.main"]
