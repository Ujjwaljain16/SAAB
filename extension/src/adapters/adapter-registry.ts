/**
 * adapter-registry.ts
 * Manages platform adapter detection and registration.
 */

import { PlatformAdapter } from './platform-interface';
import { CourseraAdapter } from './coursera-adapter';
import { ScalerAdapter } from './scaler-adapter';
import { PlatformStatus } from '../types';

class AdapterRegistry {
  private adapters: PlatformAdapter[] = [
    new CourseraAdapter(),
    new ScalerAdapter()
  ];

  getAdapterForUrl(url: string): PlatformAdapter | null {
    return this.adapters.find((a) => a.isMatchingUrl(url)) || null;
  }

  detectCurrentPlatform(): PlatformAdapter | null {
    if (typeof window === 'undefined') return null;
    return this.getAdapterForUrl(window.location.href);
  }

  getStatus(): PlatformStatus {
    const adapter = this.detectCurrentPlatform();
    if (!adapter) {
      return {
        platform: 'unknown',
        isSupportedPage: false,
        pageTitle: typeof document !== 'undefined' ? document.title : '',
        detectedQuestionsCount: 0,
        url: typeof window !== 'undefined' ? window.location.href : ''
      };
    }

    const meta = adapter.getPageMetadata();
    const isSupported = adapter.isSupportedPage();
    let count = 0;
    try {
      if (isSupported) {
        count = adapter.extractQuestions().length;
      }
    } catch {
      count = 0;
    }

    return {
      platform: adapter.platform,
      isSupportedPage: isSupported,
      pageTitle: meta.title,
      currentActivity: meta.activity,
      detectedQuestionsCount: count,
      url: meta.url
    };
  }
}

export const adapterRegistry = new AdapterRegistry();
