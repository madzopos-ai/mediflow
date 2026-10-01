/**
 * Web Speech API speech-to-text helper.
 *
 * The UI treats transcripts as suggestions only: nothing here saves to the
 * chart. The caller decides whether to feed the transcript into the
 * deterministic dictation parser or attach the audio as a voice note.
 *
 * Browser support varies (Chrome/Edge best for Arabic + continuous). The module
 * fails gracefully by returning an error state rather than throwing at startup.
 */

export type SpeechLang = 'ar' | 'en';

export interface SpeechResult {
  text: string;
  isFinal: boolean;
}

export interface SpeechError {
  code: 'not-supported' | 'no-permission' | 'unknown';
  message: string;
}

export type SpeechListener = (result: SpeechResult) => void;
export type SpeechErrorListener = (error: SpeechError) => void;

export interface SpeechController {
  start(): void;
  stop(): void;
  isActive(): boolean;
}

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort?: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => RecognitionLike;
    webkitSpeechRecognition?: new () => RecognitionLike;
  }
}

function mapError(event: any): SpeechError {
  const code = event?.error;
  if (code === 'not-allowed' || code === 'permission-denied') {
    return { code: 'no-permission', message: 'Microphone permission denied' };
  }
  if (code === 'service-not-allowed' || code === 'network') {
    return { code: 'unknown', message: code ?? 'speech error' };
  }
  return { code: 'unknown', message: code ?? 'speech error' };
}

export function createSpeechRecognizer(options: {
  lang: SpeechLang;
  continuous?: boolean;
  interimResults?: boolean;
  onResult: SpeechListener;
  onError?: SpeechErrorListener;
  onEnd?: () => void;
}): SpeechController {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) {
    let errored = false;
    return {
      start() {
        if (errored) return;
        errored = true;
        options.onError?.({ code: 'not-supported', message: 'Web Speech API not supported' });
      },
      stop() {},
      isActive() {
        return false;
      },
    };
  }

  const recognition: RecognitionLike = new Recognition();
  recognition.lang = options.lang === 'ar' ? 'ar-SA' : 'en-US';
  recognition.interimResults = options.interimResults ?? true;
  recognition.continuous = options.continuous ?? true;
  recognition.maxAlternatives = 1;

  let active = false;

  recognition.onresult = (event: any): void => {
    let text = '';
    for (let i = 0; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (!result) continue;
      text += result[0]?.transcript ?? '';
    }
    if (text.length === 0) return;
    options.onResult({ text, isFinal: event.results[event.results.length - 1]?.isFinal ?? false });
  };

  recognition.onerror = (event: any): void => {
    options.onError?.(mapError(event));
  };

  recognition.onend = (): void => {
    active = false;
    options.onEnd?.();
  };

  return {
    start() {
      if (active) return;
      try {
        recognition.start();
        active = true;
      } catch (error) {
        options.onError?.({ code: 'unknown', message: error instanceof Error ? error.message : 'start failed' });
      }
    },
    stop() {
      if (!active) return;
      try {
        recognition.stop();
      } catch {
        recognition.abort?.();
      }
      active = false;
    },
    isActive() {
      return active;
    },
  };
}
