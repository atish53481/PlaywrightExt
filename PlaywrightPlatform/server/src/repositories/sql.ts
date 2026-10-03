/** Escapes LIKE wildcards so user text matches literally. Pairs with `escape '\'` in the query. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}
