import { chromium, Browser, Page } from 'playwright'
import { logger } from './logger.js'

let browser: Browser | null = null

export interface BrowserOptions {
  headless?: boolean
  timeout?: number
}

export async function initBrowser(options: BrowserOptions = {}): Promise<void> {
  if (browser) return
  
  try {
    const headless = options.headless !== undefined ? options.headless : true
    browser = await chromium.launch({
      headless,
      // args to make it more stealthy or robust in a worker environment
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    })
    logger.info({ headless }, 'Browser service initialized successfully')
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Browser service')
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close()
    browser = null
    logger.info('Browser service closed')
  }
}

/**
 * Tool for agents to extract text from a webpage.
 * The browser runs independently and can be headed (visible) or headless.
 */
export async function scrapeWebpage(url: string, waitForSelector?: string): Promise<string> {
  if (!browser) {
    await initBrowser()
  }
  
  if (!browser) throw new Error('Browser is not initialized')

  let page: Page | null = null
  try {
    page = await browser.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 10000 })
    }

    // A simple readable extraction (could be enhanced with readability.js or similar)
    const textContent = await page.evaluate(() => {
      // Remove scripts, styles, nav, etc. before extraction
      const elementsToRemove = document.querySelectorAll('script, style, noscript, nav, footer, header')
      elementsToRemove.forEach(el => el.remove())
      return document.body.innerText || ''
    })

    return textContent.trim()
  } catch (err: any) {
    logger.error({ err, url }, 'Error scraping webpage')
    throw new Error(`Failed to scrape ${url}: ${err.message}`)
  } finally {
    if (page) await page.close()
  }
}

/**
 * Tool for agents to take a screenshot of a webpage.
 */
export async function captureScreenshot(url: string, savePath: string): Promise<void> {
  if (!browser) await initBrowser()
  if (!browser) throw new Error('Browser is not initialized')

  let page: Page | null = null
  try {
    page = await browser.newPage()
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    await page.screenshot({ path: savePath, fullPage: true })
    logger.info({ url, savePath }, 'Saved screenshot')
  } catch (err: any) {
    logger.error({ err, url }, 'Error capturing screenshot')
    throw err
  } finally {
    if (page) await page.close()
  }
}
