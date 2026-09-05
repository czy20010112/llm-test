#!/usr/bin/env bash
# Download the remaining benchmark datasets (explicit file names). Resumable.
set -uo pipefail
GW=$(ip route show default | awk '/default/ {print $3}' | head -1)
export http_proxy="http://$GW:12000" https_proxy="http://$GW:12000"
export HTTP_PROXY="http://$GW:12000" HTTPS_PROXY="http://$GW:12000"
export NO_PROXY="localhost,127.0.0.1,172.16.0.0/12,192.168.0.0/16"
export no_proxy="$NO_PROXY"
export HF_HOME=/mnt/d/AI/llm-test/benchmarks/hf-cache

dl() { # dl <repo> <file> <name>
  local repo=$1 file=$2 name=$3
  python3 - "$repo" "$file" "$name" <<'EOF'
import sys, os, shutil
from huggingface_hub import hf_hub_download
repo, file, name = sys.argv[1], sys.argv[2], sys.argv[3]
p = hf_hub_download(repo_id=repo, filename=file, repo_type="dataset")
dst_dir = f"/mnt/d/AI/llm-test/benchmarks/raw/{name}"
os.makedirs(dst_dir, exist_ok=True)
dst = os.path.join(dst_dir, os.path.basename(file))
shutil.copy2(p, dst)
print(f"OK {repo}/{file} -> {dst}")
EOF
}

echo "== LongBench v2 (data.json) =="
dl THUDM/LongBench-v2 "data.json" longbench2 || echo "FAIL longbench2"

echo "== HumanEval+ (test.jsonl) =="
dl evalplus/humanevalplus "test.jsonl" humanevalplus || echo "FAIL humanevalplus"

echo "== MBPP+ (parquet) =="
dl evalplus/mbppplus "data/test-00000-of-00001-d5781c9c51e02795.parquet" mbppplus || echo "FAIL mbppplus"

echo "== DS-1000 (test.jsonl) =="
dl xlangai/DS-1000 "test.jsonl" ds1000 || echo "FAIL ds1000"

echo "== SWE-bench Verified (parquet) =="
dl princeton-nlp/SWE-bench_Verified "data/test-00000-of-00001.parquet" swebench_verified || echo "FAIL swebench-verified"

echo "== done =="
du -sh /mnt/d/AI/llm-test/benchmarks/raw 2>/dev/null
find /mnt/d/AI/llm-test/benchmarks/raw -type f -exec ls -lh {} \; | awk '{print $5, $9}'
