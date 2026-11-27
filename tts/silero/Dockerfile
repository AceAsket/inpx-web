FROM python:3.11-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir numpy==2.2.6 num2words==0.5.14 silero-stress==1.5
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin silero \
    && mkdir -p /app /models \
    && chown -R silero:silero /app /models
WORKDIR /app
COPY --chown=silero:silero server.py /app/server.py
COPY --chown=silero:silero speech_options.py /app/speech_options.py
COPY --chown=silero:silero accentuation.py /app/accentuation.py
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh
ENV PYTHONUNBUFFERED=1 SILERO_MODEL_DIR=/models SILERO_THREADS=4 SILERO_STRESS_ENABLED=true
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"
ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "server.py"]
