// src/lang/helpers.ts
import { moment } from 'obsidian';
import de from './locale/de';
import en from './locale/en';

const localeMap: { [k: string]: Partial<typeof de> } = {
    en,
    de,
};

const locale = window.localStorage.getItem('language') || 'de';
const lang = localeMap[locale] || de;

export function t(key: keyof typeof de, params?: { [k: string]: string | number }): string {
    let text = (lang as any)[key] || (de as any)[key] || key;

    if (params) {
        Object.entries(params).forEach(([param, value]) => {
            text = text.replace(`{${param}}`, String(value));
        });
    }

    return text;
}
