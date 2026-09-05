FROM python:3.10-slim
# DS-1000 targets the 2021-2023 scientific stack (numpy<2 era); newer scipy/sklearn
# break its test harnesses (removed private modules, ABI changes). Pillow is needed
# by the Matplotlib problems' image comparison.
RUN pip install --no-cache-dir "fastapi" "uvicorn[standard]" \
    "numpy==1.24.4" "pandas==1.5.3" "scipy==1.10.1" "scikit-learn==1.2.2" \
    "matplotlib==3.7.5" "seaborn==0.12.2" "pillow"
ENV MPLCONFIGDIR=/tmp/mplconfig
WORKDIR /judge
COPY app.py /judge/app.py
# unprivileged user; work happens in /tmp (writable by all)
USER nobody
EXPOSE 8901
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8901"]
