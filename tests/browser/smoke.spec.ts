import { test, expect } from '@playwright/test';

test('loads the Vue shell and primary navigation', async ({ page }) => {
  await page.goto('http://127.0.0.1:3000/');
  await expect(page.getByRole('navigation')).toContainText('总览');
  await expect(page.getByRole('button', { name: '新建评测' })).toBeVisible();
});
