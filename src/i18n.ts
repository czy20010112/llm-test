import { ref } from 'vue';

// 语言：localStorage 记忆 > 浏览器语言（zh* → 中文，其余 → English）
const stored = localStorage.getItem('llm-lang');
export const lang = ref<'zh' | 'en'>(
  stored === 'en' || stored === 'zh'
    ? stored
    : (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en',
);

export function t(zh: string, en: string): string {
  return lang.value === 'zh' ? zh : en;
}

function applyTitle() {
  document.title = lang.value === 'zh' ? '模型测评台' : 'Model Eval Lab';
  document.documentElement.lang = lang.value === 'zh' ? 'zh-CN' : 'en';
}
applyTitle();

export function setLang(l: 'zh' | 'en') {
  lang.value = l;
  localStorage.setItem('llm-lang', l);
  applyTitle();
}
