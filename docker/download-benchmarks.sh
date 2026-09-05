#!/usr/bin/env bash
# Download all benchmark datasets (raw) into /mnt/d/AI/llm-test/benchmarks/raw via proxy.
set -uo pipefail
GW=$(ip route show default | awk '/default/ {print $3}' | head -1)
export http_proxy="http://$GW:12000" https_proxy="http://$GW:12000"
export HTTP_PROXY="http://$GW:12000" HTTPS_PROXY="http://$GW:12000"
export HF_HUB_ENABLE_HF_TRANSFER=0
# keep all HF cache under the project dir for unified management
export HF_HOME=/mnt/d/AI/llm-test/benchmarks/hf-cache

RAW=/mnt/d/AI/llm-test/benchmarks/raw
mkdir -p "$RAW"

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

grab() { # grab <repo> <name> <ext-regex-ish via python>
  local repo=$1 name=$2
  python3 - "$repo" "$name" <<'EOF'
import sys, os, shutil
from huggingface_hub import hf_hub_download, HfApi
api = HfApi()
repo, name = sys.argv[1], sys.argv[2]
files = api.list_repo_tree(repo, recursive=True, repo_type="dataset")
files = [f.path for f in files if f.type == "file"]
print("files:", files)
dst_dir = f"/mnt/d/AI/llm-test/benchmarks/raw/{name}"
os.makedirs(dst_dir, exist_ok=True)
for f in files:
    if f.endswith((".jsonl", ".parquet", ".json", ".csv")) and not f.startswith("."):
        p = hf_hub_download(repo_id=repo, filename=f, repo_type="dataset")
        shutil.copy2(p, os.path.join(dst_dir, os.path.basename(f)))
        print("OK", f)
EOF
}

echo "== LongBench v2 =="
dl THUDM/LongBench-v2 "data/train-00000-of-00001.parquet" longbench2 || echo "FAIL longbench2"

echo "== HumanEval+ =="
grab evalplus/humanevalplus humanevalplus || echo "FAIL humanevalplus"

echo "== MBPP+ =="
grab evalplus/mbppplus mbppplus || echo "FAIL mbppplus"

echo "== DS-1000 =="
grab xlangai/DS-1000 ds1000 || echo "FAIL ds1000"

echo "== LiveCodeBench lite (test6.jsonl = latest) =="
dl livecodebench/code_generation_lite "test6.jsonl" livecodebench || echo "FAIL lcb-test6"
dl livecodebench/code_generation_lite "test5.jsonl" livecodebench || echo "FAIL lcb-test5"

echo "== SWE-bench (full test split) =="
dl princeton-nlp/SWE-bench "data/test-00000-of-00001.parquet" swebench || echo "FAIL swebench-test"

echo "== SWE-bench Verified =="
grab princeton-nlp/SWE-bench_Verified swebench_verified || echo "FAIL swebench-verified"

echo "== done =="
du -sh /mnt/d/AI/llm-test/benchmarks/raw 2>/dev/null
find /mnt/d/AI/llm-test/benchmarks/raw -type f | head -50
