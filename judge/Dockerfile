FROM python:3.12-slim
RUN pip install --no-cache-dir "fastapi" "uvicorn[standard]"
WORKDIR /judge
COPY app.py /judge/app.py
# unprivileged user; work happens in /tmp (writable by all)
USER nobody
EXPOSE 8901
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8901"]
