/**
 * reference-engine.ts
 * Manages bundled, local, and remote reference answer datasets.
 */

import { ReferenceAnswer } from '../types';

class ReferenceEngine {
  private references: ReferenceAnswer[] = [];
  private isLoaded: boolean = false;
  private loadPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.isLoaded) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        // 1. Fetch bundled reference dataset
        let bundled: ReferenceAnswer[] = [];
        try {
          if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
            const url = chrome.runtime.getURL('data/bundled-references.json');
            const res = await fetch(url);
            if (res.ok) {
              bundled = await res.json();
            }
          }
        } catch (err) {
          console.warn('[ReferenceEngine] Could not load bundled references from chrome.runtime:', err);
        }

        // 2. Fetch custom user references from storage
        let custom: ReferenceAnswer[] = [];
        try {
          if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            const data = await chrome.storage.local.get(['custom_references']);
            if (Array.isArray(data.custom_references)) {
              custom = data.custom_references;
            }
          }
        } catch (err) {
          console.warn('[ReferenceEngine] Could not load custom references:', err);
        }

        this.references = [...bundled, ...custom];
        this.isLoaded = true;
      } catch (err) {
        console.error('[ReferenceEngine] Failed to initialize reference engine:', err);
      }
    })();

    return this.loadPromise;
  }

  setReferences(refs: ReferenceAnswer[]): void {
    this.references = refs;
    this.isLoaded = true;
  }

  getAll(): ReferenceAnswer[] {
    return this.references;
  }

  search(query: string, maxResults: number = 10): ReferenceAnswer[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.references.slice(0, maxResults);

    return this.references
      .filter((ref) => {
        return (
          ref.prompt.toLowerCase().includes(q) ||
          ref.correctAnswers.some((ans) => ans.toLowerCase().includes(q)) ||
          (ref.course && ref.course.toLowerCase().includes(q)) ||
          (ref.source && ref.source.toLowerCase().includes(q))
        );
      })
      .slice(0, maxResults);
  }

  async addCustomReferences(newRefs: ReferenceAnswer[]): Promise<number> {
    const valid = newRefs.filter((r) => r.prompt && r.correctAnswers?.length > 0);
    this.references.push(...valid);

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const data = await chrome.storage.local.get(['custom_references']);
      const current = Array.isArray(data.custom_references) ? data.custom_references : [];
      await chrome.storage.local.set({
        custom_references: [...current, ...valid]
      });
    }

    return valid.length;
  }

  async clearCustomReferences(): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.remove('custom_references');
    }
    // Re-initialize to keep only bundled references
    this.isLoaded = false;
    this.loadPromise = null;
    await this.init();
  }
}

export const referenceEngine = new ReferenceEngine();