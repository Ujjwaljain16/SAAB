/**
 * Core type definitions for SAAB Academic Workflow Extension
 */

export type PlatformType = 'coursera' | 'scaler' | 'unknown';

export type QuestionType = 'single_choice' | 'multiple_choice' | 'text' | 'code';

export interface ExtractedOption {
  id: string;
  index: number;
  label?: string;
  text: string;
  isSelected?: boolean;
}

export interface ExtractedQuestion {
  id: string;
  number?: number;
  prompt: string;
  options: ExtractedOption[];
  isMultiSelect: boolean;
  questionType: QuestionType;
  points?: string;
  rawHtml?: string;
}

export interface ReferenceAnswer {
  id: string;
  platform: PlatformType;
  course?: string;
  prompt: string;
  correctAnswers: string[];
  source?: string;
  explanation?: string;
}

export interface MatchResult {
  matched: boolean;
  selectedIndices: number[];
  bestOptionIndex?: number;
  confidence: number;
  source?: string;
  reasoning: string;
  matchType: 'exact' | 'dice_fuzzy' | 'option_fallback' | 'none';
}

export interface AiAnalysisResult {
  suggestedIndices: number[];
  suggestedAnswers: string[];
  explanation: string;
  confidence: number;
  model: string;
  timestamp: number;
}

export interface QuestionAnalysis {
  question: ExtractedQuestion;
  referenceMatch: MatchResult | null;
  aiAnalysis: AiAnalysisResult | null;
  status: 'pending' | 'analyzing' | 'matched' | 'ai_suggested' | 'unresolved' | 'error';
  error?: string;
}

export interface UserSettings {
  geminiApiKey: string;
  geminiModel: string;
  autoAnalyze: boolean;
  showConfidence: boolean;
  autoHighlightInPage: boolean;
  enabledPlatforms: {
    coursera: boolean;
    scaler: boolean;
  };
  customReferencesUrl?: string;
}

export interface PlatformStatus {
  platform: PlatformType;
  isSupportedPage: boolean;
  pageTitle: string;
  currentActivity?: string;
  detectedQuestionsCount: number;
  url: string;
}

export interface SessionStats {
  totalQuestions: number;
  referenceMatches: number;
  aiSuggestions: number;
  unresolved: number;
}

export type AutomationMode = 'assist' | 'autofill' | 'autosubmit';

// Runtime messaging contract
export type ExtensionMessage =
  | { type: 'GET_PLATFORM_STATUS' }
  | { type: 'START_ANALYSIS'; forceAi?: boolean; mode?: AutomationMode }
  | { type: 'AUTO_FILL_ALL'; submitAfterFill?: boolean }
  | { type: 'SUBMIT_ASSESSMENT' }
  | { type: 'HIGHLIGHT_OPTION'; questionId: string; optionIndices: number[] }
  | { type: 'TEST_GEMINI_KEY'; apiKey: string; model?: string }
  | { type: 'SAVE_SETTINGS'; settings: Partial<UserSettings> }
  | { type: 'GET_SETTINGS' }
  | { type: 'GET_ALL_REFERENCES' }
  | { type: 'ANALYSIS_UPDATED'; analyses: QuestionAnalysis[]; stats: SessionStats };
