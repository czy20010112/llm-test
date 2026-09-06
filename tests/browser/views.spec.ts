import { test, expect } from '@playwright/test';

test('navigation switches views', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  for (const label of ['新建评测', '运行队列', '历史记录', '对比分析', '协议与基线', '环境设置']) {
    await page.getByRole('button', { name: label }).click();
    await expect(page.getByRole('button', { name: label })).toHaveClass(/active/);
  }
});

test('composer: model dropdown rows and benchmark task table', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '新建评测' }).click();
  // 模型逐栏下拉：默认一行，选中后自动出现第二行（无添加按钮）
  const first = page.getByRole('combobox').first();
  await expect(first).toBeVisible();
  await expect(page.getByRole('button', { name: /添加模型/ })).toHaveCount(0);
  const n0 = await page.getByRole('combobox').count();
  const value = await first.locator('option:not([value=""])').first().getAttribute('value');
  if (value) {
    await first.selectOption(value);
    await expect(page.getByRole('combobox')).toHaveCount(n0 + 1);
  }
  // 测试项目下拉（打开后能看到全部基准与备注）
  await page.getByRole('button', { name: '选择测试项目…' }).click();
  await expect(page.getByText('HumanEval+（代码生成）')).toBeVisible();
  await expect(page.getByText('LiveCodeBench（竞赛编程）')).toBeVisible();
  await expect(page.getByText('DS-1000（数据科学编程）')).toBeVisible();
  await expect(page.getByText('LongBench v2（长上下文）')).toBeVisible();
  await page.getByText('LongBench v2（长上下文）').click();
  // 选中后表单里只显示名称，备注列显示领域与沙箱信息；第二行自动出现
  await expect(page.locator('.task-table tbody tr:first-child .dd-toggle')).toContainText('LongBench v2');
  await expect(page.locator('.task-table td.c-note').first()).toContainText('超长上下文');
  await expect(page.locator('.task-table tbody tr')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /添加测试项目/ })).toHaveCount(0);
  // 端点设置不在新建评测里
  await expect(page.locator('[data-view="new"]')).not.toContainText('推理端点');
});

test('history offers per-run delete', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '历史记录' }).click();
  const card = page.locator('.run-card').first();
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: '删除' })).toBeVisible();
  page.once('dialog', (d) => d.dismiss());
  await card.getByRole('button', { name: '删除' }).click();
});

test('settings offers endpoint + model fetch', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '环境设置' }).click();
  await expect(page.getByRole('button', { name: /重新获取模型/ })).toBeVisible();
});

test('queue shows only running runs; history lists finished runs', async ({ page }) => {
  // mock the runs feed so live status transitions cannot race the assertions
  await page.route('**/api/runs', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 'r1', name: '运行中的评测', status: 'running', models: ['m1'], tasks: ['t1'], progress: { modelIndex: 0 }, log: ['line1'], rows: [] },
      { id: 'r2', name: '已完成的评测', status: 'done', models: ['m1'], tasks: ['t1'], log: [], rows: [{ model: 'm1', task: 'GPQA Diamond（缓存题库）', repeat: 1, average: { score: 0.5, correct: 1, total: 2 }, log: [] }] },
    ]),
  }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '运行队列' }).click();
  await expect(page.getByText('运行中的评测')).toBeVisible();
  await expect(page.getByText('已完成的评测')).toBeHidden();
  await page.getByRole('button', { name: '历史记录' }).click();
  await expect(page.getByText('已完成的评测')).toBeVisible();
  await expect(page.getByText('运行中的评测')).toBeHidden();
});

test('completion on another view shows a dismissible toast', async ({ page }) => {
  let done = false;
  const run = (status: string) => ({
    id: 'r1', name: '速度对比', status, models: ['m1'], tasks: ['t1'],
    progress: { modelIndex: 0 }, log: [],
    rows: status === 'running' ? [] : [{ model: 'm1', task: '连通性与吐字速度', repeat: 1, average: { ok: 1, firstMs: 320, tokens: 512, tokPerSec: 42.5 }, log: [] }],
  });
  await page.route('**/api/runs', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([run(done ? 'done' : 'running')]) }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2400); // 首轮轮询种下 running 状态
  done = true;
  await page.waitForTimeout(2600); // 下一次轮询应弹出 toast
  const toast = page.locator('.toast');
  await expect(toast).toContainText('速度对比 · 测试完成');
  await toast.getByRole('button', { name: '关闭通知' }).click();
  await expect(page.locator('.toast')).toHaveCount(0);
});

test('completion while watching the queue jumps to history with logs expanded', async ({ page }) => {
  let done = false;
  await page.route('**/api/runs', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{
      id: 'r1', name: '跳转测试', status: done ? 'done' : 'running', models: ['m1'], tasks: ['t1'],
      progress: { modelIndex: 0 }, log: ['line1', 'line2'],
      rows: done ? [{ model: 'm1', task: '连通性与吐字速度', repeat: 1, average: { ok: 1, firstMs: 320, tokens: 512, tokPerSec: 42.5 }, log: [] }] : [],
    }]),
  }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '运行队列' }).click();
  await expect(page.getByText('跳转测试')).toBeVisible();
  await page.waitForTimeout(2400);
  done = true;
  await page.waitForTimeout(3400); // 轮询检测 + 跳转动画 + 日志展开
  await expect(page.locator('.view-title')).toHaveText('历史记录');
  const card = page.locator('.run-card[data-run-id="r1"]');
  await expect(card).toBeVisible();
  await expect(card.locator('details')).toHaveJSProperty('open', true);
});

test('compare view: radar chart with selectable series and old-name normalization', async ({ page }) => {
  await page.route('**/api/runs', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{
      id: 'r1', name: '结果A', status: 'done', models: ['m1', 'm2'], tasks: ['t1'], log: [],
      rows: ['GPQA Diamond（缓存题库）', 'AIME 2025（缓存题库）', 'MMLU-Pro（缓存题库）'].flatMap((task, i) => [
        { model: 'm1', task, repeat: 1, average: { score: 0.9 - i * 0.1, correct: 9 - i, total: 10 }, log: [] },
        { model: 'm2', task, repeat: 1, average: { score: 0.6 - i * 0.1, correct: 6 - i, total: 10 }, log: [] },
      ]),
    }]),
  }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '历史记录' }).click();
  await page.getByRole('button', { name: '选入对比' }).click();
  await page.getByRole('button', { name: '对比分析' }).click();
  await expect(page.locator('.radar-panel')).toBeVisible();
  // 旧名称（缓存题库）在对比表中按新口径显示
  await expect(page.locator('.table.compare')).toContainText('GPQA Diamond（科学推理）');
  // 默认不绘制任何曲线，勾选图例后逐条出现
  await expect(page.locator('svg .series')).toHaveCount(0);
  await page.locator('.legend-chip').first().click();
  await expect(page.locator('svg .series')).toHaveCount(1);
  await page.locator('.legend-chip').nth(1).click();
  await expect(page.locator('svg .series')).toHaveCount(2);
});
