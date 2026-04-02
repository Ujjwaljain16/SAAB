import { SEL, TARGET_SUBJECTS } from './config.js';
import { normalizeScalerUrl } from './scaler_url.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CURRICULUM_CACHE_PATH = path.join(process.cwd(), 'curriculum-cache.json');
const CURRICULUM_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const API_CACHE_PATH = path.join(process.cwd(), 'api-endpoints.json');
const API_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function parseProgressCount(text) {
  const match = text.replace(/\s+/g, ' ').trim().match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;

  const completed = Number(match[1]);
  const total = Number(match[2]);
  if (Number.isNaN(completed) || Number.isNaN(total)) return null;

  return { completed, total };
}

function loadApiCache() {
  try {
    if (!fs.existsSync(API_CACHE_PATH)) {
      return { version: 1, updatedAt: null, subjects: {} };
    }

    const raw = fs.readFileSync(API_CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      updatedAt: parsed.updatedAt || null,
      subjects: parsed.subjects && typeof parsed.subjects === 'object' ? parsed.subjects : {}
    };
  } catch {
    return { version: 1, updatedAt: null, subjects: {} };
  }
}

function saveApiCache(cache) {
  try {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      subjects: cache.subjects || {}
    };
    const tmp = API_CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, API_CACHE_PATH);
  } catch {
    // ignore cache write errors
  }
}

function isFreshApiCache(cache) {
  if (!cache.updatedAt) return false;
  const age = Date.now() - new Date(cache.updatedAt).getTime();
  return Number.isFinite(age) && age <= API_CACHE_TTL_MS;
}

function makeCurriculumCacheKey(subjects) {
  const payload = JSON.stringify({ subjects });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function readCurriculumCache() {
  try {
    if (!fs.existsSync(CURRICULUM_CACHE_PATH)) return null;
    const raw = fs.readFileSync(CURRICULUM_CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.queue) || typeof parsed.updatedAt !== 'string') return null;

    const age = Date.now() - new Date(parsed.updatedAt).getTime();
    if (!Number.isFinite(age) || age > CURRICULUM_CACHE_TTL_MS) return null;

    return parsed;
  } catch {
    return null;
  }
}

function writeCurriculumCache(subjects, queue) {
  try {
    const payload = {
      version: 1,
      cacheKey: makeCurriculumCacheKey(subjects),
      updatedAt: new Date().toISOString(),
      subjects,
      queue
    };
    const tmp = CURRICULUM_CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, CURRICULUM_CACHE_PATH);
  } catch {
    // ignore cache write errors
  }
}

function collectStrings(node, out = []) {
  if (node == null) return out;

  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    out.push(String(node));
    return out;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectStrings(item, out);
    }
    return out;
  }

  if (typeof node === 'object') {
    for (const value of Object.values(node)) {
      collectStrings(value, out);
    }
  }

  return out;
}

function extractCardFromObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const urlValue = obj.classUrl || obj.url || obj.href || obj.link || obj.path || obj.slug;
  const textValue = obj.title || obj.name || obj.className || obj.courseName || obj.label || obj.text;
  const urlText = String(urlValue || '');
  const text = String(textValue || '').trim();

  if (!text || !urlText) return null;
  if (!urlText.includes('/academy/mentee-dashboard/class/')) return null;

  const allStrings = collectStrings(obj, []);
  const assignmentText = allStrings.find((value) => /assignment/i.test(value) && /\d+\s*\/\s*\d+/.test(value)) || '';
  const homeworkText = allStrings.find((value) => /additional|homework/i.test(value) && /\d+\s*\/\s*\d+/.test(value)) || '';
  const rowText = allStrings.join(' ');

  return {
    title: text,
    classUrl: urlText.startsWith('http') ? urlText : `https://www.scaler.com${urlText}`,
    assignmentText,
    homeworkText,
    rowText
  };
}

function extractQueueFromPayload(payload) {
  const queue = [];
  const seen = new Set();

  function walk(node) {
    if (!node) return;

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }

    if (typeof node === 'object') {
      const card = extractCardFromObject(node);
      if (card && !seen.has(card.classUrl)) {
        const assignmentProgress = parseProgressCount(card.assignmentText) || parseProgressCount(card.rowText);
        const hasPendingAssignment = assignmentProgress ? assignmentProgress.completed < assignmentProgress.total : false;

        if (hasPendingAssignment) {
          seen.add(card.classUrl);
          queue.push({
            classUrl: card.classUrl,
            subject: '',
            pending: `Assignment ${assignmentProgress.completed}/${assignmentProgress.total}`
          });
        }
      }

      for (const value of Object.values(node)) {
        walk(value);
      }
    }
  }

  walk(payload);
  return queue;
}

async function fetchJsonWithSession(page, url) {
  return page.evaluate(async (targetUrl) => {
    const response = await fetch(targetUrl, {
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*'
      }
    });

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      text
    };
  }, url);
}

async function tryApiQueueForSubject(page, subjectName, cache) {
  const subjectCache = cache.subjects?.[subjectName];
  if (!subjectCache || !Array.isArray(subjectCache.endpoints) || subjectCache.endpoints.length === 0) {
    return null;
  }

  for (const endpoint of subjectCache.endpoints.slice(0, 3)) {
    try {
      const result = await fetchJsonWithSession(page, endpoint.url);
      if (!result) continue;
      if (result.status === 401) {
        console.error('  \u26a0 API returned 401 \u2014 session may have expired. Re-run: node auth.js');
        return null;
      }
      if (!result.ok || !/json/i.test(result.contentType)) continue;

      const payload = JSON.parse(result.text);
      const queue = extractQueueFromPayload(payload);
      if (queue.length > 0) {
        console.log(`  API cache hit for ${subjectName}: ${endpoint.url}`);
        return queue.map((item) => ({ ...item, subject: subjectName }));
      }
    } catch {
      continue;
    }
  }

  return null;
}

export async function getQueue(page) {
  console.log('Navigating to dashboard to find specified subjects...');

  const cached = readCurriculumCache();
  if (cached && makeCurriculumCacheKey(TARGET_SUBJECTS) === cached.cacheKey) {
    console.log(`Using curriculum cache (${cached.queue.length} classes, refreshed ${cached.updatedAt}).`);
    return cached.queue;
  }

  await page.goto(normalizeScalerUrl('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/'));
  await page.waitForLoadState('networkidle').catch(() => {});

  const queue = [];
  const apiCache = loadApiCache();

  for (const subjectName of TARGET_SUBJECTS) {
    console.log(`\nLooking for subject: ${subjectName}`);
    const discoveredEndpoints = new Set();
    const responseHandler = async (response) => {
      try {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';
        if (!/json/i.test(contentType)) return;
        if (!/scaler\.com/i.test(url)) return;
        if (!/(api|graphql|curriculum|class|batch|course|module|assignment)/i.test(url)) return;

        const text = await response.text().catch(() => '');
        if (!text) return;

        if (/\/academy\/mentee-dashboard\/class\//.test(text) || /assignment/i.test(text) || /module/i.test(text)) {
          discoveredEndpoints.add(url);
        }
      } catch {
        // ignore individual response capture failures
      }
    };

    page.on('response', responseHandler);
    
    // Attempt 1: Normal locator search
    let subjectLink = page.locator(SEL.subjectItem, { hasText: new RegExp(subjectName, 'i') }).first();
    
    // Attempt 2: More aggressive search for any clickable with that text
    if (await subjectLink.count() === 0) {
      console.log(`  Target text not found in primary elements, searching all links...`);
      subjectLink = page.locator('a, div').filter({ hasText: new RegExp(subjectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).last();
    }
    
    if (await subjectLink.count() === 0) {
      console.log(`  Subject "${subjectName}" could not be located. Skipping.`);
      continue;
    }

    const href = await subjectLink.getAttribute('href');
    if (!href) {
       console.log(`  Could not find href for ${subjectName}. Clicking instead...`);
       await subjectLink.click();
    } else {
      const fullUrl = normalizeScalerUrl(href.startsWith('http') ? href : `https://www.scaler.com${href}`);
       console.log(`  Navigating to: ${fullUrl}`);
       await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
    }
    
    await page.waitForLoadState('networkidle').catch(() => {});

      if (isFreshApiCache(apiCache)) {
        const apiQueue = await tryApiQueueForSubject(page, subjectName, apiCache);
        if (apiQueue && apiQueue.length > 0) {
          console.log(`  Using cached API queue for ${subjectName} (${apiQueue.length} classes).`);
          queue.push(...apiQueue);
          await page.goto(normalizeScalerUrl('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/'));
          await page.waitForTimeout(1200);
          continue;
        }
      }

    const classCards = await page.$$eval(SEL.classTitleLink, (anchors) =>
      anchors
        .map((anchor) => {
          const href = anchor.getAttribute('href') || '';
          const text = (anchor.textContent || '').trim();
          if (!text || !href.includes('/academy/mentee-dashboard/class/') || href.includes('/assignment') || href.includes('/homework')) {
            return null;
          }

          let row = anchor.parentElement;
          while (row && !row.querySelector('a[href*="/assignment"]')) {
            row = row.parentElement;
          }

          const assignmentLink = row ? row.querySelector('a[href*="/assignment"]') : null;
          const homeworkLink = row ? row.querySelector('a[href*="/homework"]') : null;
          const assignmentText = (assignmentLink?.textContent || '').trim();
          const homeworkText = (homeworkLink?.textContent || '').trim();
          const rowText = (row?.textContent || '').trim();

          return {
            title: text,
            classUrl: href.startsWith('http') ? href : `https://www.scaler.com${href}`,
            assignmentText,
            homeworkText,
            rowText,
          };
        })
        .filter(Boolean)
        .reduce((uniqueCards, card) => {
          if (!uniqueCards.some(existingCard => existingCard.classUrl === card.classUrl)) {
            uniqueCards.push(card);
          }
          return uniqueCards;
        }, [])
    );

    console.log(`  Found ${classCards.length} potential class cards in this module.`);

    for (const card of classCards) {
      // Assignment-only mode: skip classes that are pending only in Additional/Homework.
      const assignmentProgress = parseProgressCount(card.assignmentText);
      const hasPendingAssignment = assignmentProgress ? assignmentProgress.completed < assignmentProgress.total : false;

      if (hasPendingAssignment) {
        const pending = `Assignment ${assignmentProgress.completed}/${assignmentProgress.total}`;
        console.log(`    Found pending: ${card.title} (${pending})`);
        queue.push({ classUrl: card.classUrl, subject: subjectName, pending });
      }
    }

    page.off('response', responseHandler);

    const subjectEndpoints = Array.from(discoveredEndpoints).map((url) => ({ url, discoveredAt: new Date().toISOString() }));
    if (subjectEndpoints.length > 0) {
      apiCache.subjects = apiCache.subjects || {};
      apiCache.subjects[subjectName] = {
        updatedAt: new Date().toISOString(),
        endpoints: subjectEndpoints
      };
      saveApiCache(apiCache);
      console.log(`  Cached ${subjectEndpoints.length} API endpoint(s) for ${subjectName}.`);
    }


    
    // Go back to dashboard for next subject
    await page.goto(normalizeScalerUrl('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/'));
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  console.log(`\nQueue generation complete. Found ${queue.length} target classes.`);

  writeCurriculumCache(TARGET_SUBJECTS, queue);
  return queue;
}
