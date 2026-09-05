import json
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent
SOURCE = Path(__file__).resolve().parents[1] / 'data'
OUT = ROOT / 'data'
OUT.mkdir(parents=True, exist_ok=True)

gpqa = pd.read_parquet(SOURCE / 'gpqa_diamond_mc__test-00000-of-00001.parquet')
with (OUT / 'gpqa_diamond_mc.jsonl').open('w', encoding='utf-8') as f:
    for row in gpqa.to_dict('records'):
        answer = str(row['solution']).split('{')[-1].split('}')[0].strip()
        f.write(json.dumps({'problem': str(row['problem']), 'answer': answer}, ensure_ascii=False) + '\n')

aime = pd.read_parquet(SOURCE / 'aime_2025__train-00000-of-00001.parquet')
with (OUT / 'aime_2025.jsonl').open('w', encoding='utf-8') as f:
    for row in aime.to_dict('records'):
        f.write(json.dumps({'problem': str(row['problem']), 'answer': str(int(row['answer']))}, ensure_ascii=False) + '\n')

mmlu = pd.read_parquet(SOURCE / 'MMLU-Pro__test-00000-of-00001.parquet')
with (OUT / 'MMLU-Pro.jsonl').open('w', encoding='utf-8') as f:
    for row in mmlu.to_dict('records'):
        options = [str(x) for x in list(row['options'])]
        options_text = '\\n'.join(f'{"ABCDEFGHIJ"[i]}) {x}' for i, x in enumerate(options))
        f.write(json.dumps({'question': str(row['question']), 'options': options, 'options_text': options_text, 'answer': str(row['answer'])}, ensure_ascii=False) + '\n')

print('prepared', len(gpqa), len(aime), len(mmlu))
