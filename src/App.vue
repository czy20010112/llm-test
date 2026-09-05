<script setup lang="ts">
import { computed, ref } from 'vue';

const views = [
  { id: 'overview', label: '总览' },
  { id: 'new', label: '新建评测' },
  { id: 'queue', label: '运行队列' },
  { id: 'history', label: '历史记录' },
  { id: 'compare', label: '对比分析' },
  { id: 'protocols', label: '协议与基线' },
  { id: 'settings', label: '环境设置' },
] as const;

type ViewId = (typeof views)[number]['id'];

const active = ref<ViewId>('overview');
const activeView = computed(() => views.find((v) => v.id === active.value)!);

function select(id: ViewId) {
  active.value = id;
}
</script>

<template>
  <div class="shell">
    <aside class="sidenav">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">测</span>
        <div class="brand-text">
          <strong>模型测评台</strong>
          <small>Precision Lab</small>
        </div>
      </div>
      <nav class="nav" aria-label="主导航">
        <button
          v-for="v in views"
          :key="v.id"
          type="button"
          class="nav-item"
          :class="{ active: active === v.id }"
          :aria-current="active === v.id ? 'page' : undefined"
          @click="select(v.id)"
        >
          {{ v.label }}
        </button>
      </nav>
      <div class="sidenav-foot">
        <a href="/legacy/">旧版控制台</a>
      </div>
    </aside>
    <main class="content">
      <header class="content-head">
        <h1 class="view-title">{{ activeView.label }}</h1>
      </header>
      <section class="view-body" :data-view="active">
        <p class="placeholder">该视图将在后续任务中实现。</p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 232px 1fr;
  min-height: 100vh;
}

.sidenav {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px 14px;
  background: var(--color-teal);
  color: var(--color-teal-on);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px 16px;
  border-bottom: 1px solid var(--color-teal-line);
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  background: var(--color-coral);
  color: #fff;
  font-family: var(--font-display);
  font-size: 18px;
}

.brand-text strong {
  display: block;
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 15px;
  line-height: 1.2;
}

.brand-text small {
  color: var(--color-teal-on-soft);
  font-size: 11px;
  letter-spacing: 0.08em;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--color-teal-on);
  text-align: left;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  font: 500 14px/1.4 var(--font-body);
  cursor: pointer;
  transition: background var(--motion-fast);
}

.nav-item:hover {
  background: var(--color-teal-hover);
}

.nav-item.active {
  background: var(--color-teal-active);
}

.nav-item:focus-visible {
  outline: 2px solid var(--color-coral);
  outline-offset: 2px;
}

.sidenav-foot {
  margin-top: auto;
  padding: 12px 8px 0;
  border-top: 1px solid var(--color-teal-line);
  font-size: 12px;
}

.sidenav-foot a {
  color: var(--color-teal-on-soft);
  text-decoration: none;
}

.sidenav-foot a:hover {
  color: var(--color-teal-on);
  text-decoration: underline;
}

.content {
  padding: 28px 36px 48px;
  background: var(--color-paper);
  color: var(--color-ink);
  min-width: 0;
}

.view-title {
  margin: 0 0 20px;
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 26px;
  line-height: 1.25;
}

.placeholder {
  color: var(--color-ink-soft);
  font-size: 14px;
}
</style>
