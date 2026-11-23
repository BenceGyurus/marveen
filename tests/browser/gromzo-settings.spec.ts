import { test, expect, type Page } from '@playwright/test'

async function openSettings(page: Page, lang: 'hu' | 'en') {
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.route('**/api/settings', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ settings: [] }) }))
  await page.route('**/api/auth/status', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ method: 'session', authenticated: true, user: 'owner', setup_required: false, login_available: true }) }))
  await page.route('**/api/gromzo/status', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true, running: true, linked: true }) }))
  await page.addInitScript((l) => {
    try { localStorage.setItem('marveen.lang', l); localStorage.setItem('marveen-dashboard-token', 'a'.repeat(64)) } catch { /* ignore */ }
  }, lang)
  await page.goto('/index.html')
  await page.evaluate((l) => { ;(window as unknown as { _lang: string })._lang = l }, lang)
  await page.evaluate(async () => {
    const w = window as unknown as { switchPage: (p: string) => void, loadSettings: () => Promise<void> }
    w.switchPage('settings')
    await w.loadSettings()
  })
}

for (const lang of ['hu', 'en'] as const) {
  test(`Gromzo settings in ${lang} show link status and direct phone pairing to Bridge`, async ({ page }) => {
    await openSettings(page, lang)
    const card = page.locator('#gromzoCard')
    await expect(card.locator('#gromzoStatus')).toBeHidden()
    await card.locator('summary').click()
    await expect(card.locator('#gromzoStatus')).toContainText(lang === 'hu' ? 'össze van kapcsolva' : 'is linked')
    await expect(card.locator('[data-i18n="gromzo.card.desc"]')).toContainText('Marveen Bridge')
    await expect(card.locator('#gromzoAddPhoneBtn')).toHaveCount(0)
  })
}
