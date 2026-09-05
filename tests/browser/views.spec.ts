import { test, expect } from '@playwright/test';

test('navigation switches views', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  for (const label of ['新建评测', '运行队列', '历史记录', '对比分析', '协议与基线', '环境设置']) {
    await page.getByRole('button', { name: label }).click();
    await expect(page.getByRole('button', { name: label })).toHaveClass(/active/);
  }
});

test('composer shows models fetch and benchmark task cards', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '新建评测' }).click();
  await expect(page.getByRole('button', { name: '获取模型' })).toBeVisible();
  await expect(page.getByText('HumanEval+（代码生成）')).toBeVisible();
  await expect(page.getByText('LiveCodeBench（竞赛编程）')).toBeVisible();
  await expect(page.getByText('DS-1000（数据科学编程）')).toBeVisible();
  await expect(page.getByText('LongBench v2（长上下文）')).toBeVisible();
});

test('history and queue list real runs', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '运行队列' }).click();
  await expect(page.locator('.run-card').first()).toBeVisible();
  await page.getByRole('button', { name: '历史记录' }).click();
  await expect(page.locator('.run-card').first()).toBeVisible();
  await expect(page.locator('table').first()).toBeVisible();
});
