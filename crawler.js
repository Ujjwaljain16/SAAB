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
  } catch {}
}

function isFreshApiCache(cache) {
  if (!cache.updatedAt) return false;
  const age = Date.now() - new Date(cache.updatedAt).getTime();
  return Number.isFinite(age) && age <= API_CACHE_TTL_MS;
}

function makeCurriculumCacheKey(term, subjects) {
  const payload = JSON.stringify({ term, subjects });
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

function writeCurriculumCache(term, subjects, queue) {
  if (!queue || queue.length === 0) return;
  try {
    const payload = {
      version: 1,
      cacheKey: makeCurriculumCacheKey(term, subjects),
      updatedAt: new Date().toISOString(),
      term,
      subjects,
      queue
    };
    const tmp = CURRICULUM_CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, CURRICULUM_CACHE_PATH);
  } catch {}
}

export async function getQueue(page) {
  if (!page.url().includes('/core-curriculum')) {
    console.log('Navigating to Scaler Core Curriculum dashboard...');
    await page.goto(normalizeScalerUrl('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/'), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(async () => {
      await page.goto(normalizeScalerUrl('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/'), { waitUntil: 'commit', timeout: 45000 });
    });
  }
  await page.waitForTimeout(2000);

  // Detect current active term
  const activeTerm = await page.evaluate(() => {
    const termEl = document.querySelector('.dropdown__title, .me-cc-header__main, [class*="term-title"]');
    return (termEl?.innerText || '').trim().replace(/\s+/g, ' ');
  }).catch(() => 'Current Term');

  console.log(`\n============================================================`);
  console.log(`Academic Term: ${activeTerm || 'Active Term'}`);
  console.log(`============================================================`);

  // Auto-discover all subjects in the active term
  const discoveredSubjects = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/core-curriculum/m/"][href*="/classes"]'));
    const seen = new Set();
    const list = [];
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const text = (a.innerText || '').trim().replace(/\s+/g, ' ');
      if (text && !seen.has(href)) {
        seen.add(href);
        const cleanName = text.replace(/^SUBJECT\s*-\s*\d+\s*/i, '').trim();
        list.push({
          name: cleanName || text,
          fullName: text,
          url: href.startsWith('http') ? href : `https://www.scaler.com${href}`
        });
      }
    }
    return list;
  });

  if (discoveredSubjects.length === 0) {
    console.log('No subjects found in core curriculum. Checking if already on classes list...');
  }

  // Filter subjects if user defined TARGET_SUBJECTS in .env
  let targetSubjects = discoveredSubjects;
  if (TARGET_SUBJECTS.length > 0) {
    targetSubjects = discoveredSubjects.filter(sub =>
      TARGET_SUBJECTS.some(t => new RegExp(t, 'i').test(sub.name) || new RegExp(t, 'i').test(sub.fullName))
    );
    console.log(`Filtered subjects by TARGET_SUBJECTS: ${targetSubjects.map(s => s.name).join(', ')}`);
  }

  console.log(`\nFound ${targetSubjects.length} subject(s) in ${activeTerm}:`);
  targetSubjects.forEach((sub, i) => {
    console.log(`  ${i + 1}. ${sub.fullName}`);
  });

  // Check cache
  const cached = readCurriculumCache();
  const cacheKey = makeCurriculumCacheKey(activeTerm, targetSubjects.map(s => s.name));
  if (cached && cached.cacheKey === cacheKey && cached.queue.length > 0 && !process.argv.includes('--refresh-curriculum')) {
    console.log(`\nUsing cached curriculum queue (${cached.queue.length} classes, refreshed ${cached.updatedAt}).`);
    return cached.queue;
  }

  const queue = [];

  for (const subject of targetSubjects) {
    console.log(`\n------------------------------------------------------------`);
    console.log(`Scanning classes in: ${subject.fullName}`);
    console.log(`URL: ${subject.url}`);
    console.log(`------------------------------------------------------------`);

    await page.goto(subject.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(SEL.classTitleLink, { timeout: 10000 }).catch(() => {});

    const classCards = await page.$$eval(SEL.classTitleLink, (anchors) =>
      anchors
        .map((anchor) => {
          const href = anchor.getAttribute('href') || '';
          const text = (anchor.textContent || '').trim();
          if (!text || !href.includes('/academy/mentee-dashboard/class/') || href.includes('/assignment') || href.includes('/homework')) {
            return null;
          }

          const match = href.match(/\/class\/(\d+)/);
          const classId = match ? match[1] : '';

          // Look for assignment and homework link specifically tied to THIS class ID
          let assignmentLink = classId ? document.querySelector(`a[href*="/class/${classId}/assignment"]`) : null;
          let homeworkLink = classId ? document.querySelector(`a[href*="/class/${classId}/homework"]`) : null;

          // Fallback to row search if class ID not present in href
          if (!assignmentLink) {
            let row = anchor.parentElement;
            let depth = 0;
            while (row && depth < 4 && row.tagName !== 'BODY') {
              if (row.querySelectorAll('a[href*="/academy/mentee-dashboard/class/"]:not([href*="/assignment"])').length > 1) {
                break; // Don't escape class card boundary
              }
              const found = row.querySelector('a[href*="/assignment"]');
              if (found) {
                assignmentLink = found;
                break;
              }
              row = row.parentElement;
              depth++;
            }
          }

          const assignmentText = (assignmentLink?.textContent || '').trim();
          const homeworkText = (homeworkLink?.textContent || '').trim();

          return {
            title: text,
            classUrl: href.startsWith('http') ? href : `https://www.scaler.com${href}`,
            assignmentText,
            homeworkText,
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

    console.log(`  Found ${classCards.length} class(es) in this subject.`);

    for (const card of classCards) {
      const assignmentProgress = parseProgressCount(card.assignmentText);
      const hasPendingAssignment = assignmentProgress ? assignmentProgress.completed < assignmentProgress.total : false;

      if (hasPendingAssignment) {
        const pending = `Assignment ${assignmentProgress.completed}/${assignmentProgress.total}`;
        console.log(`    → Unsolved: ${card.title} (${pending})`);
        queue.push({
          classUrl: card.classUrl,
          subject: subject.name,
          pending
        });
      }
    }
  }

  console.log(`\n============================================================`);
  console.log(`Queue generation complete. Found ${queue.length} pending class(es) to solve.`);
  console.log(`============================================================\n`);

  writeCurriculumCache(activeTerm, targetSubjects.map(s => s.name), queue);
  return queue;
}
