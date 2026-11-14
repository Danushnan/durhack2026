FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home minishop
COPY services ./services
COPY db ./db
ARG SERVICE
ENV SERVICE=${SERVICE}
USER 10001
EXPOSE 8000
CMD ["sh", "-c", "exec uvicorn services.${SERVICE}.app:app --host 0.0.0.0 --port 8000 --no-access-log"]
