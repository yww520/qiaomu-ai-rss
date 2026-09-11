import { vi } from 'vitest';
export const requestUrl = vi.fn();
export const arrayBufferToBase64 = (buffer: ArrayBuffer) => Buffer.from(buffer).toString('base64');
export const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '') || '/';
export const moment = () => ({ format: (format: string) => format === 'YYYY-MM-DD' ? '2026-09-07' : format });
export const setTooltip = vi.fn((el: HTMLElement, tooltip: string) => {
  el.setAttribute('aria-label', tooltip);
});

