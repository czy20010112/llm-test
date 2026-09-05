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
