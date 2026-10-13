// -----------------------------------------------------------------------------
// The languages a user reads this integration in.
//
// Every user-facing text is a multi-language object: the core renders it in
// the reader's language, falling back on `en`. Gladys speaks four languages,
// and a text missing one of them reaches a German or Spanish reader in English.
// This module is the one list of them, so a message built per language
// (`inEveryLanguage`) cannot forget one, and the few places that format a
// number or a date for ONE reader (the widgets) agree on what each language
// writes.
//
// Device names, scene outputs and the text states of a device are NOT built
// here: they are plain strings Gladys stores once, and they stay in French,
// the language of the data source.
// -----------------------------------------------------------------------------

/** The languages every user-facing text is written in. `en` is the fallback. */
export const LANGUAGES = ['en', 'fr', 'de', 'es'];

/**
 * The languages that write a decimal number with a comma (`1,699`): all of
 * Gladys' languages but English.
 */
const DECIMAL_COMMA = new Set(['fr', 'de', 'es']);

/**
 * Build a multi-language object, one entry per language.
 * @param {(language: string) => T} build
 * @returns {Record<string, T>}
 * @template T
 */
export function inEveryLanguage(build) {
  return Object.fromEntries(LANGUAGES.map((language) => [language, build(language)]));
}

/**
 * A language this integration writes, `en` for anything else — a core sending
 * a language it gained later, or none at all.
 * @param {unknown} language ISO 639-1 code
 * @returns {string}
 */
export function supportedLanguage(language) {
  return LANGUAGES.includes(language) ? language : 'en';
}

/**
 * Does this language write `1,699` rather than `1.699`?
 * @param {unknown} language ISO 639-1 code
 */
export function usesDecimalComma(language) {
  return DECIMAL_COMMA.has(language);
}
