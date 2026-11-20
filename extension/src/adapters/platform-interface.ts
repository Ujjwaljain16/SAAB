/**
 * platform-interface.ts
 * Common contract for learning platform adapters.
 */

import { ExtractedQuestion, PlatformType } from '../types';

export interface PlatformMetadata {
  title: string;
  activity?: string;
  url: string;
}

export interface PlatformAdapter {
  readonly platform: PlatformType;
  readonly name: string;

  /**
   * Checks if this adapter handles the given URL.
   */
  isMatchingUrl(url: string): boolean;

  /**
   * Checks if the current page contains an active assessment or quiz.
   */
  isSupportedPage(): boolean;

  /**
   * Scrapes and parses all visible questions from the current DOM.
   */
  extractQuestions(): ExtractedQuestion[];

  /**
   * Highlights suggested option(s) non-destructively in the live DOM.
   * Does NOT click submit or alter submission records.
   */
  highlightOption(questionId: string, optionIndices: number[]): boolean;

  /**
   * Automatically clicks and selects the specified option(s) in the live page.
   * Dispatches genuine DOM input/change events for React/Coursera/Scaler forms.
   */
  selectOptions(questionId: string, optionIndices: number[]): boolean;

  /**
   * Automatically checks the platform honor code agreement checkbox if present.
   */
  agreeHonorCode(): boolean;

  /**
   * Clicks the assessment submit button.
   */
  submitAssessment(): boolean;

  /**
   * Extracts page activity and metadata.
   */
  getPageMetadata(): PlatformMetadata;
}
