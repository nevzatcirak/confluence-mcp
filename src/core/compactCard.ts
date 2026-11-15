/**
 * compact-card output format: raw Confluence payloads are never forwarded to
 * the LLM. Each list/detail projection declares a small field spec and the
 * result is a flat, token-cheap JSON card.
 */

import { getPath, truncateString } from "./json.js";

export interface CardFieldSpec {
  /** Field name in the emitted card. */
  readonly card: string;
  /** Dot path into the raw payload, e.g. "version.number". */
  readonly path: string;
  /** Truncate extracted strings to this many characters. */
  readonly maxChars?: number;
}

export type Card = Record<string, unknown>;

export function projectCard(record: unknown, fields: readonly CardFieldSpec[]): Card {
  const card: Card = {};
  for (const field of fields) {
    const raw: unknown = getPath(record, field.path);
    card[field.card] =
      typeof raw === "string" && field.maxChars !== undefined
        ? truncateString(raw, field.maxChars)
        : (raw ?? null);
  }
  return card;
}

export function projectCards(records: readonly unknown[], fields: readonly CardFieldSpec[]): Card[] {
  return records.map((record) => projectCard(record, fields));
}

/** Convenience builder: ["cardField", "dot.path", maxChars?] tuples. */
export function defineCardFields(
  specs: readonly (readonly [card: string, path: string, maxChars?: number])[],
): CardFieldSpec[] {
  return specs.map(([card, path, maxChars]) => (maxChars === undefined ? { card, path } : { card, path, maxChars }));
}
