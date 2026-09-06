FROM python:3.10-slim
# DS-1000 targets the 2021-2023 scientific stack (numpy<2 era); newer scipy/sklearn
# break its test harnesses (removed private modules, ABI changes). Pillow is needed
# by the Matplotlib problems' image comparison.
# IFEval/IFBench verifiers need: nltk (+ its tokenizer data, baked in — the judge
# container has no egress), langdetect, emoji, syllapy, immutabledict, absl-py.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY
RUN pip install --no-cache-dir "fastapi" "uvicorn[standard]" \
    "numpy==1.24.4" "pandas==1.5.3" "scipy==1.10.1" "scikit-learn==1.2.2" \
    "matplotlib==3.7.5" "seaborn==0.12.2" "pillow" \
    "nltk==3.9.1" "langdetect==1.0.9" "emoji==2.12.1" "syllapy==0.7.2" \
    "immutabledict==0.2.0" "absl-py==2.1.0" \
 && python -m nltk.downloader -d /usr/share/nltk_data punkt punkt_tab stopwords averaged_perceptron_tagger_eng averaged_perceptron_tagger
ENV MPLCONFIGDIR=/tmp/mplconfig
ENV NLTK_DATA=/usr/share/nltk_data
WORKDIR /judge
COPY app.py /judge/app.py
# unprivileged user; work happens in /tmp (writable by all)
USER nobody
EXPOSE 8901
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8901"]
