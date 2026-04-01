import { SEL, TARGET_SUBJECTS } from './config.js';
import { normalizeScalerUrl } from './scaler_url.js';

function parseProgressCount(text) {
  const match = text.replace(/\s+/g, ' ').trim().match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;

  const completed = Number(match[1]);
  const total = Number(match[2]);
  if (Number.isNaN(completed) || Number.isNaN(total)) return null;

  return { completed, total };
}

export async function getQueue(page) {
  console.log('Navigating to dashboard to find specified subjects...');
  await page.goto(normalizeScalerUrl('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/'));
  await page.waitForTimeout(2000); // Wait for modules to load

  const queue = [];

  for (const subjectName of TARGET_SUBJECTS) {
    console.log(`\nLooking for subject: ${subjectName}`);
    
    // Attempt 1: Normal locator search
    let subjectLink = page.locator(SEL.subjectItem, { hasText: new RegExp(subjectName, 'i') }).first();
    
    // Attempt 2: More aggressive search for any clickable with that text
    if (await subjectLink.count() === 0) {
      console.log(`  Target text not found in primary elements, searching all links...`);
      subjectLink = page.locator(`a:has-text("${subjectName}"), div:has-text("${subjectName}")`).last();
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
    
    await page.waitForTimeout(3000); // let the class table load

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
      const assignmentProgress = parseProgressCount(card.assignmentText) || parseProgressCount(card.rowText);
      const homeworkProgress = parseProgressCount(card.homeworkText);
      const hasPendingAssignment = assignmentProgress ? assignmentProgress.completed < assignmentProgress.total : false;
      const hasPendingHomework = homeworkProgress ? homeworkProgress.completed < homeworkProgress.total : false;

      if (hasPendingAssignment || hasPendingHomework) {
        const pendingParts = [];
        if (hasPendingAssignment) pendingParts.push(`Assignment ${assignmentProgress.completed}/${assignmentProgress.total}`);
        if (hasPendingHomework) pendingParts.push(`Additional ${homeworkProgress.completed}/${homeworkProgress.total}`);
        const pending = pendingParts.join(', ');

        console.log(`    Found pending: ${card.title} (${pending})`);
        queue.push({ classUrl: card.classUrl, subject: subjectName, pending });
      }
    }
    
    // Go back to dashboard for next subject
    await page.goto(normalizeScalerUrl('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/'));
    await page.waitForTimeout(2000);
  }

  console.log(`\nQueue generation complete. Found ${queue.length} target classes.`);
  return queue;
}
