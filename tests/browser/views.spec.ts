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
  // 测试项目下拉（打开后能看到全部基准与说明）
  await page.getByRole('button', { name: '选择测试项目…' }).click();
  await expect(page.getByText('HumanEval+（代码生成）')).toBeVisible();
  await expect(page.getByText('LiveCodeBench（竞赛编程）')).toBeVisible();
  await expect(page.getByText('DS-1000（数据科学编程）')).toBeVisible();
  await expect(page.getByText('LongBench v2（长上下文）')).toBeVisible();
  await page.getByText('LongBench v2（长上下文）').click();
  // 选中后表单里只显示名称；说明留在下拉菜单，表格不再重复显示备注列
  await expect(page.locator('.task-table tbody tr:first-child .dd-toggle')).toContainText('LongBench v2');
  await expect(page.locator('.task-table .c-note')).toHaveCount(0);
  await expect(page.locator('.task-table input[type="checkbox"]').first()).not.toBeChecked();
  await expect(page.locator('.task-table tbody tr:first-child select')).toBeDisabled();
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

test('completion while watching the queue jumps to history with logs collapsed', async ({ page }) => {
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
  await page.waitForTimeout(3400); // 轮询检测 + 跳转动画
  await expect(page.locator('.view-title')).toHaveText('历史记录');
  const card = page.locator('.run-card[data-run-id="r1"]');
  await expect(card).toBeVisible();
  await expect(card.locator('details')).toHaveJSProperty('open', false);
  await card.locator('summary').click();
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

test('history offers rename between delete and resume; note shows in parentheses', async ({ page }) => {
  await page.route('**/api/runs', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 'r1', name: '原始名', note: 'kvq4', status: 'partial', models: ['m1'], tasks: ['t1'], donePairs: 1, log: [], rows: [] },
      { id: 'r2', name: '无备注', note: '', status: 'done', models: ['m1'], tasks: ['t1'], donePairs: 1, log: [], rows: [] },
    ]),
  }));
  await page.route('**/api/results/r1', (route, req) => {
    if (req.method() === 'PATCH') {
      const body = route.request().postDataJSON();
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, ...body }) });
    }
    return route.continue();
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '历史记录' }).click();
  const card = page.locator('.run-card[data-run-id="r1"]');
  // 备注括号显示在名称后
  await expect(card.locator('header strong')).toHaveText('原始名（kvq4）');
  // 无备注则无括号
  await expect(page.locator('.run-card[data-run-id="r2"] header strong')).toHaveText('无备注');
  // 按钮顺序：删除 → 改名 → 继续 → 选入对比
  const btns = card.locator('.head-actions button');
  await expect(btns.nth(0)).toHaveText('删除');
  await expect(btns.nth(1)).toHaveText('改名');
  await expect(btns.nth(2)).toHaveText('继续');
  await expect(btns.nth(3)).toContainText('选入对比');
  // 改名弹窗：改名称与备注后保存
  await btns.nth(1).click();
  const modal = page.locator('.modal');
  await expect(modal).toBeVisible();
  await modal.locator('input').first().fill('新名称');
  await modal.locator('input').nth(1).fill('');
  await modal.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.notice.ok')).toContainText('已更新名称与备注');
});

test('settings: fetch protocol selector and fetched-models modal', async ({ page }) => {
  await page.route('**/api/models', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ protocol: 'llama-swap', models: [{ id: 'm-a', name: 'Model A' }, { id: 'm-b' }] }),
  }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '环境设置' }).click();
  // 协议下拉存在且可指定 llama-swap
  const proto = page.getByRole('combobox');
  await expect(proto).toBeVisible();
  await proto.selectOption('llama-swap');
  // 服务端缓存里已有模型列表，按钮可用且计数正确
  const viewBtn = page.getByRole('button', { name: /查看已获取模型/ });
  await expect(viewBtn).toBeEnabled();
  await expect(viewBtn).toContainText('15');
  await page.getByRole('button', { name: /重新获取模型/ }).click();
  await expect(page.locator('.notice.ok')).toContainText('已获取 2 个模型');
  // 获取后计数刷新
  await expect(page.getByRole('button', { name: /查看已获取模型/ })).toContainText('2');
  // 点开列表弹窗：显示全部模型
  await page.getByRole('button', { name: /查看已获取模型/ }).click();
  const modal = page.locator('.modal-wide');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.model-list li')).toHaveCount(2);
  await expect(modal).toContainText('m-a');
  await expect(modal).toContainText('Model A');
  await modal.getByRole('button', { name: '关闭' }).click();
  await expect(modal).toBeHidden();
});
