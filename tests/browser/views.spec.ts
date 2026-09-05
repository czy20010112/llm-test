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
  // 模型逐栏下拉
  await expect(page.getByRole('combobox').first()).toBeVisible();
  // 测试项目下拉（打开后能看到全部基准与备注）
  await page.getByRole('button', { name: '选择测试项目…' }).click();
  await expect(page.getByText('HumanEval+（代码生成）')).toBeVisible();
  await expect(page.getByText('LiveCodeBench（竞赛编程）')).toBeVisible();
  await expect(page.getByText('DS-1000（数据科学编程）')).toBeVisible();
  await expect(page.getByText('LongBench v2（长上下文）')).toBeVisible();
  await page.getByText('LongBench v2（长上下文）').click();
  // 选中后表单里只显示名称，备注列显示领域与沙箱信息
  await expect(page.locator('.dd-toggle')).toContainText('LongBench v2');
  await expect(page.locator('.task-table td.c-note').first()).toContainText('超长上下文');
  // 端点设置不在新建评测里
  await expect(page.locator('[data-view="new"]')).not.toContainText('推理端点');
});

test('settings offers endpoint + model fetch', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '环境设置' }).click();
  await expect(page.getByRole('button', { name: /重新获取模型/ })).toBeVisible();
});

test('queue shows only running runs; history lists finished runs', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '历史记录' }).click();
  await expect(page.locator('.run-card').first()).toBeVisible();
  await page.getByRole('button', { name: '运行队列' }).click();
  const cards = page.locator('.run-card');
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    await expect(cards.nth(i).locator('.badge')).toHaveClass(/running/);
  }
});
